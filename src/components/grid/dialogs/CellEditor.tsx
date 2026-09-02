/**
 * Cell editor — HuginnDB's star feature. A full Monaco editor with
 * auto-detected JSON / XML / SQL highlighting, format/beautify, and live JSON
 * validation. Presented either inside a dialog (`CellEditor`, the default) or
 * as a docked right-side panel (`SideEditorPanel`, JetBrains-style); both share
 * the `CellEditorBody` below so the Monaco wiring lives in one place.
 *
 * The editor is read-only when no `onSave` callback is provided; when one is
 * provided, the user's content is passed back to it as a string on save.
 */

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  Braces,
  Code2,
  Database,
  Maximize2,
  Minimize2,
  PanelRight,
  Type,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { IconButton } from "@/components/ui/icon-button";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import Editor from "@monaco-editor/react";
import {
  detectLanguage,
  tryFormat,
  type ContentLanguage,
} from "@/lib/grid/detectContentType";
import {
  usePreferences,
  selectEditorPrefs,
} from "@/stores/preferences/preferences";
import { resolveMonacoTheme } from "@/lib/monaco/monaco-themes";
import {
  useCellEditor,
  type CellBindingContext,
} from "@/stores/grid/cellEditor";
import { SchemaBindingBadge } from "@/components/jsonSchema/SchemaBindingBadge";
import { cellModelPath, bindSchemaToModel } from "@/lib/monaco/monacoJson";
import { useJsonSchemas, relationKey, schemaUri } from "@/stores/jsonSchemas";
import { useSessionPanelLayout } from "@/stores/session/panelLayout";
import { cn, formatNumber } from "@/lib/utils";
import { formatForDisplay } from "@/lib/keybindings";
import { useFullscreenToggle } from "@/lib/useFullscreenToggle";
import { Kbd } from "@/components/ui/kbd";
import { editorOptionsFromPrefs } from "@/lib/monaco/editorOptions";
import { useEditorOptions } from "@/lib/monaco/useEditorOptions";

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  initialValue: string;
  columnName?: string;
  /** Id of the owning tab, forwarded to the side panel on "move to side" so it
   *  can close itself when that tab is closed. */
  ownerId?: string;
  readonly?: boolean;
  onSave?: (value: string) => Promise<void> | void;
  /**
   * Coordinates for the JSON Schema cascade. Absent for an ad-hoc query result,
   * which has no column identity — a binding created there would be an
   * accidental wildcard, so the badge hides itself instead.
   */
  binding?: CellBindingContext;
}

/**
 * Reusable editor body: language picker, format button, JSON badge and the
 * Monaco surface. Stateless about its presentation (dialog vs side panel) —
 * the parent owns the buffer and the layout chrome.
 */
export function CellEditorBody({
  value,
  onChange,
  language,
  onLanguageChange,
  readonly,
  onSubmit,
  surface,
  binding,
  editorKey,
}: {
  value: string;
  onChange: (v: string) => void;
  language: ContentLanguage;
  onLanguageChange: (l: ContentLanguage) => void;
  readonly?: boolean;
  /** Save/commit action bound to Ctrl/Cmd+S and Ctrl/Cmd+Enter inside Monaco. */
  onSubmit?: () => void;
  /** Which surface is hosting this body. Part of the Monaco model path, because
   *  the modal and the docked panel can be open at once and two editors sharing a
   *  path share a model — whichever unmounts first would destroy it under the
   *  other. */
  surface: "modal" | "side";
  /** Coordinates for the schema badge; omitted where there is no column
   *  identity. */
  binding?: CellBindingContext;
  /**
   * Identity of the *cell/session* currently loaded. When it changes we remount
   * Monaco (via React `key`) so it builds a fresh model with an empty undo
   * stack — otherwise the persistent side panel reuses one model across cells
   * and Ctrl+Z bleeds back into a previously-edited row's value. Typing does
   * NOT change this (only `value` does), so in-session undo still works.
   */
  editorKey?: string | number;
}) {
  const { t } = useTranslation();
  const editorPrefs = usePreferences(selectEditorPrefs);
  const resolvedAll = useJsonSchemas((s) => s.resolved);
  const revision = useJsonSchemas((s) => s.revision);

  // A stable, suffixed model path is what lets a schema attach at all: Monaco
  // associates schemas by `fileMatch` against the model URI, and the default
  // auto-generated `inmemory://model/N` matches nothing we register. Keyed on
  // `editorKey` so the path and the React `key` change in the same render.
  const modelPath = useMemo(
    () => cellModelPath(surface, editorKey ?? 0),
    [surface, editorKey],
  );

  // Derive from raw state (gotcha #1); never a selector that indexes.
  const resolved = useMemo(() => {
    if (!binding) return undefined;
    const key = relationKey(
      binding.connectionId,
      binding.dbSchema,
      binding.table,
    );
    return resolvedAll[key]?.[binding.column];
    // `revision` is in the deps so a freshly created binding lights up without
    // reopening the cell.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [binding, resolvedAll, revision]);

  // `useLayoutEffect` so the association is registered before the child effect
  // that creates the model runs; the cleanup removes it again.
  useLayoutEffect(() => {
    if (!resolved || language !== "json") return;
    return bindSchemaToModel(modelPath, schemaUri(resolved.schemaId));
  }, [modelPath, resolved, language]);
  // Ctrl+S / Ctrl+Enter must be bound through Monaco's addCommand: Monaco
  // swallows them inside its focus area, so a window keydown listener never
  // sees them (CLAUDE.md gotcha #9). The command reads a ref so the handler
  // never freezes to the first render's `onSubmit`.
  const onSubmitRef = useRef(onSubmit);
  onSubmitRef.current = onSubmit;

  const handleEditorChange = useCallback(
    (v: string | undefined) => onChange(v ?? ""),
    [onChange],
  );
  const editorOptions = useEditorOptions(
    () => ({
      ...editorOptionsFromPrefs(editorPrefs),
      readOnly: !!readonly,
      formatOnPaste: editorPrefs.formatOnPaste,
      folding: true,
    }),
    [editorPrefs, readonly],
  );

  return (
    <div className="flex h-full min-h-0 flex-col gap-2">
      <div className="flex items-center gap-2">
        <Select
          value={language}
          onValueChange={(v) => onLanguageChange(v as ContentLanguage)}
        >
          <SelectTrigger className="w-32">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="plaintext">
              {t("cellEditor.langPlain")}
            </SelectItem>
            <SelectItem value="json">JSON</SelectItem>
            <SelectItem value="xml">XML</SelectItem>
            <SelectItem value="sql">SQL</SelectItem>
          </SelectContent>
        </Select>
        <Button
          size="sm"
          variant="outline"
          onClick={() => onChange(tryFormat(value, language))}
        >
          {t("cellEditor.format")}
        </Button>
        {language === "json" && <JsonValidationBadge value={value} />}
        <SchemaBindingBadge
          binding={binding}
          value={value}
          language={language}
          className="ml-auto"
        />
      </div>
      <div
        className="min-h-0 flex-1 overflow-hidden rounded-md border border-border"
        data-kb-scope="editor"
      >
        <Editor
          key={editorKey}
          height="100%"
          path={modelPath}
          value={value}
          language={language}
          theme={resolveMonacoTheme(editorPrefs.theme)}
          onChange={handleEditorChange}
          onMount={(editor, monacoNs) => {
            const save = () => onSubmitRef.current?.();
            editor.addCommand(
              monacoNs.KeyMod.CtrlCmd | monacoNs.KeyCode.KeyS,
              save,
            );
            editor.addCommand(
              monacoNs.KeyMod.CtrlCmd | monacoNs.KeyCode.Enter,
              save,
            );
          }}
          options={editorOptions}
        />
      </div>
    </div>
  );
}

export function CellEditor({
  open,
  onOpenChange,
  initialValue,
  columnName,
  ownerId,
  readonly,
  onSave,
  binding,
}: Props) {
  const { t } = useTranslation();
  const [value, setValue] = useState(initialValue);
  const detected = useMemo(
    () => detectLanguage(initialValue ?? ""),
    [initialValue],
  );
  const [language, setLanguage] = useState<ContentLanguage>(detected);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [fullscreen, setFullscreen] = useFullscreenToggle(() => open);
  /** Bumped whenever a new value is loaded so Monaco remounts with an empty
   *  undo stack (mirrors the side panel; defensive even though the dialog
   *  usually unmounts between opens). */
  const [editorKey, setEditorKey] = useState(0);
  const openInSide = useCellEditor((s) => s.open);
  const canSave = !readonly && !!onSave;
  // Derive from raw state (gotcha #1), mirroring `CellEditorBody`'s own
  // `resolved` — `binding` alone is just coordinates (connection/schema/
  // table/column) and is truthy for almost any real-table cell, whether or
  // not a schema is actually bound to this column.
  const resolvedAll = useJsonSchemas((s) => s.resolved);
  const revision = useJsonSchemas((s) => s.revision);
  const hasResolvedSchema = useMemo(() => {
    if (!binding) return false;
    const key = relationKey(
      binding.connectionId,
      binding.dbSchema,
      binding.table,
    );
    return !!resolvedAll[key]?.[binding.column];
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [binding, resolvedAll, revision]);
  // Modifier label for the save-shortcut chip (⌘ on macOS, Ctrl elsewhere).
  // Through `formatForDisplay`, which is the one place that decides how a
  // combo is spelled for the user.
  // Still a fixed `addCommand` above, so this is still a literal — but a
  // literal in the catalogue's own spelling, rendered by the catalogue's own
  // formatter. Making it a real bindable action means making that
  // `addCommand` dynamic, which travels with `SideEditorPanel`'s Mod+S
  // arbitration rather than alone.
  const saveHint = formatForDisplay("Mod+S");
  // Content-type badge label: the auto-detected / selected language.
  const typeLabel = language === "plaintext" ? "TEXT" : language.toUpperCase();
  // …and its glyph. The brief allows a little more branding in this editor
  // than anywhere else, and the data type is the one fact worth an icon:
  // it's what decides highlighting, formatting and JSON validation.
  const TypeIcon =
    language === "json"
      ? Braces
      : language === "xml"
        ? Code2
        : language === "sql"
          ? Database
          : Type;
  const bytes = useMemo(() => new TextEncoder().encode(value).length, [value]);

  useEffect(() => {
    if (open) {
      setValue(initialValue);
      // A *resolved* schema binding is the signal that this column holds
      // JSON, so it wins over the heuristic — see the same call in
      // `SideEditorPanel.loadFresh`. The mere presence of `binding`
      // (coordinates only, no confirmed schema) is not enough — that used to
      // force JSON mode on almost every cell of a real table.
      setLanguage(
        hasResolvedSchema ? "json" : detectLanguage(initialValue ?? ""),
      );
      setSaveError(null);
      setEditorKey((k) => k + 1);
    }
  }, [open, initialValue]);

  async function handleSave() {
    if (!onSave) return;
    setSaving(true);
    setSaveError(null);
    try {
      await onSave(value);
      onOpenChange(false);
    } catch (e) {
      // Tauri blocks window.alert, so surface the error inline instead.
      setSaveError(t("cellEditor.saveFailed", { message: String(e) }));
    } finally {
      setSaving(false);
    }
  }

  /** Hand the (live) buffer to the docked side panel and close the modal. */
  function moveToSidePanel() {
    openInSide({
      ownerId,
      columnName: columnName ?? "",
      value,
      readonly,
      onSave,
      // Easy to forget, and the symptom is subtle: without it "move to side
      // panel" silently drops the schema.
      binding,
    });
    useSessionPanelLayout.getState().openSideEditor();
    onOpenChange(false);
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className={cn(
          "flex flex-col gap-0 overflow-hidden p-0",
          fullscreen
            ? "left-0 top-0 h-screen w-screen max-w-none translate-x-0 translate-y-0 rounded-none border-0"
            : "h-[80vh] max-w-5xl",
        )}
      >
        {/* Edge-to-edge header rail, same convention as SettingsDialog /
            WhatsNewDialog: a `border-b` on the surface itself, not a second
            bordered card floating inside it — that double outline (plus the
            card's own shadow) is what made the rail read as "meaningless
            borders" and pushed the dialog's built-in close button into the
            gap between the two, over low-contrast background. `pr-10`
            reserves room for that button instead. */}
        <DialogHeader className="flex-row items-center gap-2 space-y-0 border-b border-border px-4 py-2.5 pr-10">
          <DialogTitle className="flex min-w-0 flex-1 items-center gap-2 text-sm">
            <span className="truncate font-mono font-semibold">
              {columnName ?? t("cellEditor.title")}
            </span>
            {/* The one deliberate flourish on this rail: the data type is what
                decides highlighting, formatting and JSON validation, so it's
                the one fact worth an icon + brand tint. Everything else here
                stays plainly functional. */}
            <span className="flex shrink-0 items-center gap-1 rounded-full bg-brand/10 px-2 py-0.5 text-2xs font-medium uppercase tracking-wide text-brand">
              <TypeIcon className="h-3 w-3" aria-hidden />
              {typeLabel}
            </span>
            <span className="hidden shrink-0 items-center gap-1 text-2xs tabular-nums text-muted-foreground sm:flex">
              <span className="rounded-sm bg-muted px-1.5 py-0.5">
                {t("cellEditor.chars", { count: value.length })}
              </span>
              <span className="rounded-sm bg-muted px-1.5 py-0.5">
                {formatNumber(bytes)} B
              </span>
            </span>
          </DialogTitle>
          <div className="flex shrink-0 items-center gap-1">
            <IconButton
              icon={PanelRight}
              label={t("cellEditor.moveToSide")}
              onClick={moveToSidePanel}
            />
            {/* Fullscreen reads as a small sticker chip carrying its own
                shortcut rather than an anonymous icon button: F11 is already
                bound here (see the keydown handler above), and the key was
                discoverable only by trying it. */}
            <button
              type="button"
              onClick={() => setFullscreen((v) => !v)}
              title={
                fullscreen
                  ? t("cellEditor.exitFullscreen")
                  : t("cellEditor.fullscreen")
              }
              className="brand-sticker flex h-7 shrink-0 items-center gap-1 rounded-lg bg-background px-2 text-2xs font-semibold text-muted-foreground transition-colors duration-150 hover:text-brand focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/40"
            >
              {fullscreen ? (
                <Minimize2 className="h-3.5 w-3.5" />
              ) : (
                <Maximize2 className="h-3.5 w-3.5" />
              )}
              F11
            </button>
          </div>
        </DialogHeader>
        <div className="min-h-0 flex-1 p-3">
          <CellEditorBody
            value={value}
            onChange={setValue}
            language={language}
            onLanguageChange={setLanguage}
            readonly={readonly}
            onSubmit={canSave ? handleSave : undefined}
            surface="modal"
            binding={binding}
            editorKey={editorKey}
          />
        </div>
        {saveError && (
          <div className="mx-4 mb-3 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-1.5 text-xs text-destructive">
            {saveError}
          </div>
        )}
        <DialogFooter className="items-center border-t border-border px-4 py-3 sm:justify-between">
          {canSave && (
            <span className="mr-auto flex items-center gap-1 text-2xs text-muted-foreground">
              <Kbd>{saveHint}</Kbd>
              {t("common.save")}
            </span>
          )}
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            {readonly ? t("common.close") : t("cellEditor.discard")}
          </Button>
          {canSave && (
            <Button onClick={handleSave} disabled={saving}>
              {saving ? t("cellEditor.saving") : t("common.save")}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function JsonValidationBadge({ value }: { value: string }) {
  const { t } = useTranslation();
  if (!value.trim()) return null;
  try {
    JSON.parse(value);
    return (
      <span className="rounded-sm bg-success/10 px-1.5 py-0.5 text-2xs font-medium text-success">
        {t("cellEditor.jsonValid")}
      </span>
    );
  } catch (e) {
    // Compact badge; the full parser message goes to the tooltip rather than
    // being dumped raw into the toolbar row.
    return (
      <span
        className="rounded-sm bg-destructive/10 px-1.5 py-0.5 text-2xs font-medium text-destructive"
        title={(e as Error).message}
      >
        {t("cellEditor.jsonInvalidShort")}
      </span>
    );
  }
}
