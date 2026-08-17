/**
 * The MongoDB aggregation editor — and, because a MongoDB view *is* a stored
 * pipeline, the MongoDB view editor too.
 *
 * `commands/view.rs` rejects MongoDB on purpose: there is no `CREATE VIEW` to
 * diff, so `ViewEditorTab`'s "two SELECT bodies and a DDL preview" model has
 * nothing to work with. This tab is the parallel surface. It opens over a
 * collection as a scratch pipeline, or over an existing view with that view's
 * pipeline already loaded, and "Save as view" / "Update view" is what turns one
 * into the other (`create` / `collMod`).
 *
 * Two modes over one pipeline:
 *
 * - **Stages** — a card per stage, each showing *its own* output (the pipeline
 *   truncated after it). This is the mode that makes a long `$lookup` chain
 *   readable, and it is why the backend has a per-stage preview command rather
 *   than just a "run it" one.
 * - **Text** — the whole array in one editor, with the pipeline's output beside
 *   it. Faster for pasting a pipeline in, or for editing one that is already
 *   understood.
 *
 * The two are the same pipeline, so switching between them is a *conversion*,
 * and it goes through the backend (`formatMongoPipeline`): splitting an array
 * literal into stages needs the relaxed grammar (a stage body is full of
 * commas), and only Rust has a parser for it. The frontend never parses a
 * pipeline — see `lib/mongo/pipeline.ts`.
 *
 * State is local and the tab is not persisted (like the structure and view
 * editors): an editing session, not a browsing one worth restoring.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import {
  Braces,
  Code2,
  Database,
  Loader2,
  Plus,
  RefreshCw,
  Save,
  Share2,
  Wand2,
} from "lucide-react";
import { Panel, PanelGroup, PanelResizeHandle } from "react-resizable-panels";
import { Button } from "@/components/ui/button";
import { Segmented } from "@/components/ui/segmented";
import { Switch } from "@/components/ui/switch";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown";
import { PipelineEditor } from "@/components/aggregation/PipelineEditor";
import { PipelineOutput } from "@/components/aggregation/PipelineOutput";
import { StageCard } from "@/components/aggregation/StageCard";
import { StageRail } from "@/components/aggregation/StageRail";
import { SaveViewDialog } from "@/components/aggregation/dialogs/SaveViewDialog";
import { ExportPipelineDialog } from "@/components/aggregation/dialogs/ExportPipelineDialog";
import {
  newStage,
  stagesFromBodies,
  toStageInputs,
  type PipelineStage,
} from "@/lib/mongo/pipeline";
import { api } from "@/lib/tauri";
import { useSchema } from "@/stores/session/schema";
import { useTabs } from "@/stores/session/tabs";
import { cn } from "@/lib/utils";
import type { QueryResult, StagePreview, StructureMode } from "@/types";

interface Props {
  tabId: string;
  connectionId: string;
  /** Database (the explorer's "schema" axis for MongoDB). Display only — the
   *  connection is already scoped to it. */
  schema?: string;
  /** The collection the pipeline reads from. For a view tab this is filled in
   *  from the view's own `viewOn` once it loads. */
  collection?: string;
  /** The view being edited, when the tab was opened from one. */
  view?: string;
  mode: StructureMode;
}

/** How many documents each preview samples. Kept small by default because
 *  every stage runs its own aggregation on every debounce. */
const SAMPLE_SIZES = [5, 10, 25, 50];
const PREVIEW_DEBOUNCE_MS = 500;

export function AggregationTab({
  tabId,
  connectionId,
  schema,
  collection,
  view,
  mode,
}: Props) {
  const { t } = useTranslation();
  const refreshSchema = useSchema((s) => s.refresh);
  const renameTab = useTabs((s) => s.rename);

  const [editorMode, setEditorMode] = useState<"stages" | "text">("stages");
  const [source, setSource] = useState(collection ?? "");
  const [boundView, setBoundView] = useState<string | undefined>(
    mode === "edit" ? view : undefined,
  );

  const [stages, setStages] = useState<PipelineStage[]>(() => [newStage("$match")]);
  const [text, setText] = useState("[\n  { $match: {} }\n]");
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());

  const [loading, setLoading] = useState(mode === "edit");
  const [loadError, setLoadError] = useState<string | null>(null);

  const [showPreview, setShowPreview] = useState(true);
  const [sampleSize, setSampleSize] = useState(10);
  const [previewing, setPreviewing] = useState(false);
  /** Previews keyed by **stage id**, never by index. A preview run is aligned
   *  to the stage list as it was when the request left; reorder or delete a
   *  stage while one is in flight and an index-keyed map would paint the wrong
   *  card's output for a beat (CLAUDE.md gotcha #7, one surface over). Keying
   *  by identity means a stale entry simply doesn't match. */
  const [stagePreviews, setStagePreviews] = useState<Map<string, StagePreview>>(
    () => new Map(),
  );
  const [textResult, setTextResult] = useState<QueryResult | null>(null);
  /** A failure that belongs to the pipeline as a whole rather than to one
   *  stage — a bad source collection, a server refusal, a text-mode syntax
   *  error. Per-stage problems ride on their own `StagePreview.error`. */
  const [pipelineError, setPipelineError] = useState<string | null>(null);

  const [saveOpen, setSaveOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [exportOpen, setExportOpen] = useState(false);
  const [exportText, setExportText] = useState<string | null>(null);
  const [exportError, setExportError] = useState<string | null>(null);

  const [dragIndex, setDragIndex] = useState<number | null>(null);
  const [dropIndex, setDropIndex] = useState<number | null>(null);

  const cardRefs = useRef<(HTMLDivElement | null)[]>([]);

  // ---------------------------------------------------------------------
  // Load an existing view
  // ---------------------------------------------------------------------

  const reload = useCallback(async () => {
    if (mode !== "edit" || !view) return;
    setLoading(true);
    try {
      const def = await api.getMongoView(connectionId, view);
      setSource(def.viewOn);
      setBoundView(def.name);
      setStages(
        def.stages.length ? stagesFromBodies(def.stages) : [newStage("$match")],
      );
      setText(def.pipeline || "[]");
      setLoadError(null);
    } catch (e) {
      setLoadError(String(e));
    } finally {
      setLoading(false);
    }
  }, [mode, view, connectionId]);

  useEffect(() => {
    void reload();
  }, [reload]);

  // ---------------------------------------------------------------------
  // Preview
  // ---------------------------------------------------------------------

  /** Live values for the debounced runner, which is registered once and must
   *  not close over the first render's pipeline (same ref pattern the query
   *  editor uses for its Monaco commands). */
  const previewInput = useMemo(
    () => ({ editorMode, stages, text, source, sampleSize, showPreview }),
    [editorMode, stages, text, source, sampleSize, showPreview],
  );
  const previewRef = useRef(previewInput);
  previewRef.current = previewInput;

  /** Guards against an out-of-order response overwriting a newer one: the
   *  per-stage preview of a 16-stage pipeline can easily outlive the next
   *  keystroke's. */
  const runSeq = useRef(0);

  const runPreview = useCallback(() => {
    const input = previewRef.current;
    if (!input.source) return;
    const seq = ++runSeq.current;
    setPreviewing(true);

    const finish = () => {
      if (seq === runSeq.current) setPreviewing(false);
    };

    if (input.editorMode === "stages") {
      const ids = input.stages.map((s) => s.id);
      api
        .previewMongoStages({
          connectionId,
          source: input.source,
          stages: toStageInputs(input.stages),
          limit: input.sampleSize,
        })
        .then((previews) => {
          if (seq !== runSeq.current) return;
          setStagePreviews(
            new Map(
              previews
                .filter((p) => ids[p.index] !== undefined)
                .map((p) => [ids[p.index], p]),
            ),
          );
          setPipelineError(null);
        })
        .catch((e) => {
          if (seq !== runSeq.current) return;
          setStagePreviews(new Map());
          setPipelineError(String(e));
        })
        .finally(finish);
      return;
    }

    api
      .runMongoPipeline({
        connectionId,
        source: input.source,
        text: input.text,
        limit: input.sampleSize,
      })
      .then((result) => {
        if (seq !== runSeq.current) return;
        setTextResult(result);
        setPipelineError(null);
      })
      .catch((e) => {
        if (seq !== runSeq.current) return;
        setTextResult(null);
        setPipelineError(String(e));
      })
      .finally(finish);
  }, [connectionId]);

  useEffect(() => {
    if (loading) return;
    if (!showPreview) {
      // Drop what was on screen rather than leaving it: the rail's per-stage
      // counts would otherwise keep answering "how many documents does this
      // stage emit" with numbers from a pipeline that has since been edited.
      setStagePreviews(new Map());
      setTextResult(null);
      return;
    }
    const id = setTimeout(runPreview, PREVIEW_DEBOUNCE_MS);
    return () => clearTimeout(id);
  }, [previewInput, runPreview, showPreview, loading]);

  // ---------------------------------------------------------------------
  // Stage editing
  // ---------------------------------------------------------------------

  const updateStage = useCallback((id: string, body: string) => {
    setStages((prev) => prev.map((s) => (s.id === id ? { ...s, body } : s)));
  }, []);

  const addStage = useCallback(() => {
    const stage = newStage("$match");
    setStages((prev) => [...prev, stage]);
    // Let the card mount before scrolling to it.
    requestAnimationFrame(() => {
      const last = cardRefs.current[cardRefs.current.length - 1];
      last?.scrollIntoView({ behavior: "smooth", block: "nearest" });
    });
  }, []);

  const moveStage = useCallback((from: number, to: number) => {
    setStages((prev) => {
      if (from === to || from < 0 || from >= prev.length) return prev;
      const next = [...prev];
      const [moved] = next.splice(from, 1);
      next.splice(to > from ? to - 1 : to, 0, moved);
      return next;
    });
  }, []);

  function scrollToStage(index: number) {
    cardRefs.current[index]?.scrollIntoView({
      behavior: "smooth",
      block: "start",
    });
  }

  // ---------------------------------------------------------------------
  // Mode switching / formatting
  // ---------------------------------------------------------------------

  /**
   * Switch modes by converting the pipeline through the backend.
   *
   * Going to text drops disabled stages, and says so: a text pipeline has
   * nowhere to record "this stage is off", and silently promoting a disabled
   * stage to an active one would change what the pipeline returns.
   */
  async function switchMode(next: "stages" | "text") {
    if (next === editorMode) return;
    try {
      if (next === "text") {
        const dropped = stages.filter((s) => !s.enabled).length;
        const formatted = await api.formatMongoPipeline({
          stages: stages.filter((s) => s.enabled).map((s) => s.body),
        });
        setText(formatted.text);
        if (dropped > 0) {
          toast.info(t("aggregation.disabledDropped", { count: dropped }));
        }
      } else {
        const formatted = await api.formatMongoPipeline({ text });
        setStages(
          formatted.stages.length
            ? stagesFromBodies(formatted.stages)
            : [newStage("$match")],
        );
      }
      setEditorMode(next);
    } catch (e) {
      // The pipeline has to parse before it can be re-shaped, so a syntax
      // error blocks the switch rather than silently discarding stages.
      toast.error(t("aggregation.switchFailed", { message: String(e) }));
    }
  }

  async function formatPipeline() {
    try {
      if (editorMode === "text") {
        const formatted = await api.formatMongoPipeline({ text });
        setText(formatted.text);
      } else {
        const formatted = await api.formatMongoPipeline({
          stages: stages.map((s) => s.body),
        });
        setStages((prev) =>
          prev.map((stage, i) => ({
            ...stage,
            body: formatted.stages[i] ?? stage.body,
          })),
        );
      }
    } catch (e) {
      toast.error(t("aggregation.formatFailed", { message: String(e) }));
    }
  }

  // ---------------------------------------------------------------------
  // Export / save
  // ---------------------------------------------------------------------

  async function openExport() {
    setExportOpen(true);
    setExportText(null);
    setExportError(null);
    try {
      const formatted =
        editorMode === "text"
          ? await api.formatMongoPipeline({ text })
          : await api.formatMongoPipeline({
              stages: stages.filter((s) => s.enabled).map((s) => s.body),
            });
      setExportText(formatted.text);
    } catch (e) {
      setExportError(String(e));
    }
  }

  async function saveView(name: string) {
    setSaving(true);
    try {
      await api.saveMongoView({
        connectionId,
        name,
        viewOn: source,
        ...(editorMode === "text"
          ? { text }
          : { stages: toStageInputs(stages) }),
        // Redefining only applies to the view this tab is already bound to;
        // any other name is a new view, even from a tab that has one.
        create: name !== boundView,
      });
      setBoundView(name);
      renameTab(tabId, `${name} (${t("tabs.aggregationSuffix")})`);
      await refreshSchema(connectionId);
      toast.success(t("aggregation.saveView.saved", { name }));
      setSaveOpen(false);
    } catch (e) {
      toast.error(t("aggregation.saveView.failed", { message: String(e) }));
    } finally {
      setSaving(false);
    }
  }

  // ---------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------

  if (loading) {
    return (
      <div className="flex h-full items-center justify-center gap-2 text-xs text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" />
        {t("aggregation.loading")}
      </div>
    );
  }
  if (loadError) {
    return <div className="p-4 text-xs text-destructive">{loadError}</div>;
  }

  const finalPreview = stages.length
    ? stagePreviews.get(stages[stages.length - 1].id)
    : undefined;

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* Toolbar */}
      <div className="flex flex-wrap items-center gap-2 border-b border-border px-3 py-2">
        <Database className="h-3.5 w-3.5 text-muted-foreground" />
        <span className="font-mono text-xs">
          {schema && <span className="text-muted-foreground">{schema}.</span>}
          {source || t("aggregation.noSource")}
        </span>
        {boundView && (
          <span className="rounded-sm bg-brand/15 px-1.5 py-0.5 text-[10px] uppercase tracking-wider text-brand">
            {t("aggregation.boundToView", { name: boundView })}
          </span>
        )}

        <div className="ml-auto flex items-center gap-2">
          <Button
            variant="ghost"
            size="sm"
            className="h-7 text-xs"
            onClick={() => void formatPipeline()}
            title={t("aggregation.format")}
          >
            <Wand2 className="mr-1.5 h-3.5 w-3.5" />
            {t("aggregation.format")}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            className="h-7 text-xs"
            onClick={() => void openExport()}
          >
            <Share2 className="mr-1.5 h-3.5 w-3.5" />
            {t("aggregation.export.action")}
          </Button>

          {boundView ? (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button size="sm" className="h-7 text-xs" disabled={saving}>
                  <Save className="mr-1.5 h-3.5 w-3.5" />
                  {t("aggregation.save")}
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem
                  className="text-xs"
                  onSelect={() => void saveView(boundView)}
                >
                  {t("aggregation.saveView.submitUpdate")}
                </DropdownMenuItem>
                <DropdownMenuItem
                  className="text-xs"
                  onSelect={() => setSaveOpen(true)}
                >
                  {t("aggregation.saveView.titleCreate")}
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          ) : (
            <Button
              size="sm"
              className="h-7 text-xs"
              onClick={() => setSaveOpen(true)}
              disabled={!source}
            >
              <Save className="mr-1.5 h-3.5 w-3.5" />
              {t("aggregation.saveView.titleCreate")}
            </Button>
          )}
        </div>
      </div>

      {/* Mode + preview controls */}
      <div className="flex flex-wrap items-center gap-3 border-b border-border px-3 py-1.5">
        <Segmented
          value={editorMode}
          onValueChange={(v) => void switchMode(v)}
          size="sm"
          aria-label={t("aggregation.mode")}
          options={[
            {
              value: "stages",
              label: t("aggregation.modeStages"),
              icon: <Braces className="h-3.5 w-3.5" />,
            },
            {
              value: "text",
              label: t("aggregation.modeText"),
              icon: <Code2 className="h-3.5 w-3.5" />,
            },
          ]}
        />

        <div className="ml-auto flex items-center gap-3">
          {previewing && (
            <RefreshCw className="h-3 w-3 animate-spin text-muted-foreground" />
          )}
          <label className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
            {t("aggregation.sampleSize")}
            <Select
              value={String(sampleSize)}
              onValueChange={(v) => setSampleSize(Number(v))}
            >
              <SelectTrigger className="h-6 w-16 text-[11px]">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {SAMPLE_SIZES.map((n) => (
                  <SelectItem key={n} value={String(n)} className="text-[11px]">
                    {n}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </label>
          <label className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
            <Switch
              checked={showPreview}
              onCheckedChange={setShowPreview}
              className="h-4 w-7"
            />
            {t("aggregation.preview")}
          </label>
        </div>
      </div>

      {editorMode === "stages" && (
        <StageRail
          stages={stages}
          previews={stagePreviews}
          onSelect={scrollToStage}
          onAdd={addStage}
        />
      )}

      {/* A pipeline error that isn't tied to one stage (a bad source, a server
          refusal) has nowhere else to surface in stage mode. */}
      {editorMode === "stages" && pipelineError && (
        <div className="border-b border-destructive/40 bg-destructive/10 px-3 py-1.5 font-mono text-[11px] text-destructive">
          {pipelineError}
        </div>
      )}

      {/* Body */}
      {editorMode === "stages" ? (
        <div className="min-h-0 flex-1 space-y-2 overflow-auto p-2">
          {stages.map((stage, i) => (
            <div
              key={stage.id}
              ref={(el) => {
                cardRefs.current[i] = el;
              }}
            >
              <StageCard
                stage={stage}
                index={i}
                preview={stagePreviews.get(stage.id)}
                previewing={previewing}
                showPreview={showPreview}
                collapsed={collapsed.has(stage.id)}
                dragging={dragIndex === i}
                dropTarget={dropIndex === i && dragIndex !== null && dragIndex !== i}
                onChange={(body) => updateStage(stage.id, body)}
                onToggleEnabled={() =>
                  setStages((prev) =>
                    prev.map((s) =>
                      s.id === stage.id ? { ...s, enabled: !s.enabled } : s,
                    ),
                  )
                }
                onToggleCollapsed={() =>
                  setCollapsed((prev) => {
                    const next = new Set(prev);
                    if (next.has(stage.id)) next.delete(stage.id);
                    else next.add(stage.id);
                    return next;
                  })
                }
                onDelete={() =>
                  setStages((prev) => prev.filter((s) => s.id !== stage.id))
                }
                onRun={runPreview}
                onDragStart={() => setDragIndex(i)}
                onDragOver={() => setDropIndex(i)}
                onDragEnd={() => {
                  if (dragIndex !== null && dropIndex !== null) {
                    moveStage(dragIndex, dropIndex);
                  }
                  setDragIndex(null);
                  setDropIndex(null);
                }}
              />
            </div>
          ))}

          <button
            onClick={addStage}
            className={cn(
              "flex w-full items-center justify-center gap-1.5 rounded-lg border border-dashed border-border",
              "py-3 text-xs text-muted-foreground transition-colors hover:border-brand/50 hover:text-brand",
            )}
          >
            <Plus className="h-3.5 w-3.5" />
            {t("aggregation.addStage")}
          </button>

          {/* The last stage's output IS the pipeline's output, so stage mode
              needs no separate "final result" panel — but it does need to say
              so when the pipeline is empty. */}
          {stages.length === 0 && (
            <div className="py-8 text-center text-xs text-muted-foreground">
              {t("aggregation.emptyPipeline")}
            </div>
          )}
          {finalPreview?.error && (
            <div className="rounded-lg bg-destructive/10 p-3 font-mono text-[11px] text-destructive">
              {finalPreview.error}
            </div>
          )}
        </div>
      ) : (
        <PanelGroup direction="horizontal" className="min-h-0 flex-1">
          <Panel defaultSize={showPreview ? 55 : 100} minSize={30}>
            <PipelineEditor
              value={text}
              onChange={setText}
              onRun={runPreview}
              height="100%"
              lineNumbers
            />
          </Panel>
          {showPreview && (
            <>
              <PanelResizeHandle className="w-px bg-border transition-colors hover:bg-brand/40" />
              <Panel defaultSize={45} minSize={20}>
                <div className="flex h-full flex-col">
                  <div className="border-b border-border px-3 py-1 text-[10px] uppercase tracking-wider text-muted-foreground">
                    {t("aggregation.outputTitle")}
                  </div>
                  <PipelineOutput
                    className="min-h-0 flex-1"
                    result={textResult}
                    error={pipelineError}
                    loading={previewing}
                    emptyLabel={t("aggregation.previewPending")}
                  />
                </div>
              </Panel>
            </>
          )}
        </PanelGroup>
      )}

      <SaveViewDialog
        open={saveOpen}
        onOpenChange={setSaveOpen}
        source={source}
        boundView={boundView}
        saving={saving}
        onSubmit={(name) => void saveView(name)}
      />
      <ExportPipelineDialog
        open={exportOpen}
        onOpenChange={setExportOpen}
        pipelineText={exportText}
        error={exportError}
        source={source}
        viewName={boundView}
      />
    </div>
  );
}
