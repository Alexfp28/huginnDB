/**
 * View definition editor (issue #86). Unlike HeidiSQL's bare SQL box, this
 * pairs a full-size Monaco editor for the view's SELECT body with a live,
 * debounced "preview results" grid — running the draft body with a `LIMIT`
 * so the columns/rows a JOIN-heavy view produces are visible immediately,
 * instead of read from the SQL text alone. A read-only DDL pane at the
 * bottom (same pattern as `StructureEditorTab`) shows the exact
 * `CREATE OR REPLACE VIEW` / drop+recreate statements Apply will run.
 *
 * Like `StructureEditorTab`, the component never builds SQL itself for the
 * DDL: it sends the desired `ViewDefinition` (plus the original snapshot
 * when editing) to the backend, which diffs and generates the statements.
 *
 * State lives in local React state — ephemeral per tab (dockview keeps the
 * panel mounted; view tabs are excluded from `persistedTabs`, same as
 * structure tabs, since this is an editing session rather than a browsing
 * one worth restoring on relaunch).
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { RefreshCw } from "lucide-react";
import { notify } from "@/lib/notify";
import Editor, { type Monaco } from "@monaco-editor/react";
import { Panel, PanelGroup, PanelResizeHandle } from "react-resizable-panels";
import { useDebouncedPreview } from "@/lib/useDebouncedPreview";
import { RefreshButton } from "@/components/common/RefreshButton";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { DataGrid } from "@/components/grid/DataGrid";
import { api } from "@/lib/tauri";
import { useSchema } from "@/stores/session/schema";
import { useTabs } from "@/stores/session/tabs";
import { useConnectionDriver } from "@/lib/connection/useConnectionDriver";
import { usePreferences, selectEditorPrefs } from "@/stores/preferences/preferences";
import { resolveMonacoTheme } from "@/lib/monaco/monaco-themes";
import { keywordsFor } from "@/lib/sql/sqlKeywords";
import { buildCompletions } from "@/lib/sql/sqlCompletions";
import {
  ensureSqlProviders,
  registerSqlEditor,
} from "@/lib/monaco/monacoSql";
import { registerEditorActionRedispatch } from "@/lib/monaco/monacoKeybindings";
import { useCommandPalette } from "@/stores/dialogs/commandPalette";
import { useTabSwitcher } from "@/components/shell/TabSwitcher";
import type { QueryResult, StructureMode, ViewDefinition } from "@/types";
import { useReloadable } from "@/lib/useReloadable";
import { DdlPreviewPane } from "@/components/schema/DdlPreviewPane";
import { joinStatements } from "@/lib/sql/formatStatements";
import { editorOptionsFromPrefs } from "@/lib/monaco/editorOptions";

interface Props {
  tabId: string;
  connectionId: string;
  schema?: string;
  view?: string;
  mode: StructureMode;
}

/** Wraps the draft SELECT so a live preview can run against any driver
 *  without parsing/rewriting the user's SQL (no LIMIT-clause juggling
 *  around an existing ORDER BY, subqueries, etc.). */
const PREVIEW_ALIAS = "__huginn_view_preview";
function previewSql(query: string): string {
  return `SELECT * FROM (${query.trim().replace(/;\s*$/, "")}) AS ${PREVIEW_ALIAS} LIMIT 100`;
}

export function ViewEditorTab({ tabId, connectionId, schema, view, mode }: Props) {
  const { t } = useTranslation();
  const editorPrefs = usePreferences(selectEditorPrefs);
  const refreshSchema = useSchema((s) => s.refresh);
  const closeTab = useTabs((s) => s.close);
  const schemaState = useSchema((s) => s.byConnection[connectionId]);

  const driver = useConnectionDriver(connectionId);

  const completionSuggestions = useMemo(
    () =>
      buildCompletions({
        tables: schemaState?.tables ?? [],
        columns: schemaState?.columns ?? {},
        keywords: keywordsFor(driver),
      }),
    [schemaState, driver],
  );
  // Read through a ref inside the completion provider closure (registered
  // once on mount) so it always sees the freshest suggestions, same
  // rationale as QueryEditorTab's `completionsRef`.
  const completionsRef = useRef(completionSuggestions);
  useEffect(() => {
    completionsRef.current = completionSuggestions;
  }, [completionSuggestions]);

  /** Disposer returned by `registerSqlEditor`; removes this editor's entry
   *  from the shared provider registry on unmount. */
  const sqlEditorDisposeRef = useRef<(() => void) | null>(null);
  /** Disposer for the customizable-shortcuts redispatch registered in
   *  `handleMount` (see `registerEditorActionRedispatch`). */
  const editorShortcutsDisposeRef = useRef<(() => void) | null>(null);
  useEffect(() => {
    return () => {
      sqlEditorDisposeRef.current?.();
      sqlEditorDisposeRef.current = null;
      editorShortcutsDisposeRef.current?.();
      editorShortcutsDisposeRef.current = null;
    };
  }, []);

  const [original, setOriginal] = useState<ViewDefinition | null>(null);
  const [name, setName] = useState(view ?? "");
  const [query, setQuery] = useState("");

  const [ddl, setDdl] = useState("");
  const [dropAndRecreate, setDropAndRecreate] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [applying, setApplying] = useState(false);

  const [dataPreview, setDataPreview] = useState<QueryResult | null>(null);
  const [dataPreviewError, setDataPreviewError] = useState<string | null>(null);
  const [dataPreviewLoading, setDataPreviewLoading] = useState(false);
  const [dataFilter, setDataFilter] = useState("");

  // (Re)load the existing definition. Runs on mount and from the manual
  // refresh button (same rationale as StructureEditorTab's `reload`).
  const load = useCallback(async () => {
    if (!view) return;
    const v = await api.getViewDefinition(connectionId, schema, view);
    setOriginal(v);
    setName(v.name);
    setQuery(v.query);
  }, [connectionId, schema, view]);
  const {
    loading,
    error: loadError,
    reload,
  } = useReloadable(mode === "edit" ? load : null);

  const desired = useMemo<ViewDefinition>(
    () => ({ schema: schema ?? null, name: name.trim(), query }),
    [schema, name, query],
  );

  // Both previews (DDL diff + live data) share one debounce timer: they're
  // triggered by the same edits and there's no reason to re-run one without
  // the other.
  const desiredRef = useRef(desired);
  desiredRef.current = desired;

  const runDdlPreview = useCallback(() => {
    if (!desiredRef.current.name || !desiredRef.current.query.trim()) {
      setDdl("");
      setPreviewError(null);
      return;
    }
    api
      .previewViewChange({ connectionId, original, desired: desiredRef.current })
      .then((p) => {
        setDdl(joinStatements(p.statements));
        setDropAndRecreate(p.dropAndRecreate);
        setPreviewError(null);
      })
      .catch((e) => {
        setDdl("");
        setPreviewError(String(e));
      });
  }, [connectionId, original]);

  const runDataPreview = useCallback(() => {
    const q = desiredRef.current.query.trim();
    if (!q) {
      setDataPreview(null);
      setDataPreviewError(null);
      return;
    }
    setDataPreviewLoading(true);
    api
      .executeQuery(connectionId, previewSql(q))
      .then((r) => {
        setDataPreview(r);
        setDataPreviewError(null);
      })
      .catch((e) => {
        setDataPreview(null);
        setDataPreviewError(String(e));
      })
      .finally(() => setDataPreviewLoading(false));
  }, [connectionId]);

  const runBothPreviews = useCallback(() => {
    runDdlPreview();
    runDataPreview();
  }, [runDdlPreview, runDataPreview]);

  useDebouncedPreview(desired, runBothPreviews);

  // Ref for the same reason as QueryEditorTab's `runQueryRef`: Monaco's
  // `addCommand` (Ctrl+Enter) and the shared SQL provider registry both keep
  // long-lived closures registered once in `handleMount`, so they need to
  // read the latest callback through a ref rather than closing over it.
  const runBothPreviewsRef = useRef(runBothPreviews);
  useEffect(() => {
    runBothPreviewsRef.current = runBothPreviews;
  }, [runBothPreviews]);

  async function doApply() {
    setApplying(true);
    setPreviewError(null);
    try {
      await api.applyViewChange({ connectionId, original, desired });
      await refreshSchema(connectionId);
      if (mode === "new") {
        closeTab(tabId);
      } else {
        const v = await api.getViewDefinition(connectionId, schema, desired.name);
        setOriginal(v);
        setQuery(v.query);
      }
    } catch (e) {
      // Same dual surfacing as StructureEditorTab's applyFailed handling —
      // the DDL pane alone is easy to miss on a rejected apply.
      const message = String(e);
      setPreviewError(message);
      notify.error(t("view.applyFailed", { message }));
    } finally {
      setApplying(false);
    }
  }

  function handleMount(_editor: unknown, monaco: Monaco) {
    const editor = _editor as {
      addCommand: (keybinding: number, handler: () => void) => string | null;
      getModel: () => { uri: { toString: () => string } } | null;
      onKeyDown: (
        fn: (e: { browserEvent: KeyboardEvent }) => void,
      ) => { dispose: () => void };
    };
    ensureSqlProviders(monaco);
    const uri = editor.getModel?.()?.uri.toString();
    if (uri) {
      sqlEditorDisposeRef.current?.();
      sqlEditorDisposeRef.current = registerSqlEditor(uri, {
        getCompletions: () => completionsRef.current,
        getLenses: () => [],
        runStatement: () => runBothPreviewsRef.current(),
      });
    }
    // Ctrl+Enter forces an immediate preview refresh, bypassing the 400ms
    // debounce — bound through Monaco's command system since it swallows
    // the keypress inside its focus area (gotcha #9). Not one of the
    // customizable actions (issue #75), so it stays a fixed `addCommand`.
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.Enter, () => {
      runBothPreviewsRef.current();
    });

    // toggleCommandPalette / toggleTabSwitcher ARE customizable and Monaco
    // swallows them here too (gotcha #9) — same onKeyDown-based redispatch
    // as QueryEditorTab.
    editorShortcutsDisposeRef.current?.();
    editorShortcutsDisposeRef.current = registerEditorActionRedispatch(editor, [
      {
        id: "toggleCommandPalette",
        run: () => useCommandPalette.getState().toggle(),
      },
      {
        id: "openCommandActions",
        run: () => useCommandPalette.getState().openWith(">"),
      },
      {
        id: "toggleTabSwitcher",
        run: () => useTabSwitcher.getState().toggle(),
      },
    ]);
  }

  if (loading) {
    return (
      <div className="p-4 text-xs text-muted-foreground">
        {t("view.loading")}
      </div>
    );
  }
  if (loadError) {
    return <div className="p-4 text-xs text-destructive">{loadError}</div>;
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* Header */}
      <div className="flex items-center gap-2 border-b border-border px-3 py-2">
        <span className="text-xs text-muted-foreground">
          {t("view.viewName")}
        </span>
        <Input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder={t("view.viewNamePlaceholder")}
          className="h-7 w-64 text-xs"
          // Renaming an existing view goes through the dedicated "Rename
          // view…" context-menu dialog (api.renameView), same convention as
          // StructureEditorTab's table-name field — one rename path, not two.
          disabled={mode === "edit"}
        />
        <div className="ml-auto flex items-center gap-2">
          {mode === "edit" && (
            <RefreshButton
              className="h-7 w-7"
              onClick={() => void reload()}
              loading={loading}
              disabled={applying}
              title={t("view.refresh")}
            />
          )}
          <Button
            size="sm"
            onClick={() => void doApply()}
            disabled={applying || !name.trim() || !query.trim() || !!previewError}
          >
            {applying ? t("view.applying") : t("view.apply")}
          </Button>
        </div>
      </div>

      {/* Body: SQL editor + live data preview (resizable), DDL pane fixed at
          the bottom. */}
      <div className="flex min-h-0 flex-1 flex-col">
        <PanelGroup direction="vertical" className="min-h-0 flex-1">
          <Panel defaultSize={55} minSize={20}>
            <Editor
              height="100%"
              language="sql"
              theme={resolveMonacoTheme(editorPrefs.theme)}
              value={query}
              onChange={(v) => setQuery(v ?? "")}
              onMount={handleMount}
              options={{
                ...editorOptionsFromPrefs(editorPrefs),
                formatOnPaste: editorPrefs.formatOnPaste,
              }}
            />
          </Panel>
          <PanelResizeHandle className="h-1 bg-border hover:bg-primary/30" />
          <Panel defaultSize={45} minSize={15}>
            <div className="flex h-full flex-col">
              <div className="flex items-center gap-2 border-b border-border px-3 py-1 text-[11px] text-muted-foreground">
                {dataPreviewLoading && (
                  <RefreshCw className="h-3 w-3 animate-spin" />
                )}
                {t("view.previewTitle")}
              </div>
              {dataPreviewError ? (
                <div className="overflow-auto bg-destructive/10 p-3 font-mono text-xs text-destructive">
                  {dataPreviewError}
                </div>
              ) : dataPreview ? (
                <DataGrid
                  result={dataPreview}
                  tabId={`${tabId}-preview`}
                  globalFilter={dataFilter}
                  onGlobalFilterChange={setDataFilter}
                />
              ) : (
                <div className="flex flex-1 items-center justify-center text-xs text-muted-foreground">
                  {t("view.previewEmptyQuery")}
                </div>
              )}
            </div>
          </Panel>
        </PanelGroup>

        <DdlPreviewPane
          title={t("view.ddlPreview")}
          ddl={ddl}
          error={previewError}
          warning={dropAndRecreate ? t("view.dropRecreateNote") : null}
          prefs={editorPrefs}
        />
      </div>
    </div>
  );
}
