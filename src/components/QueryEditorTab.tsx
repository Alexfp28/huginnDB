/**
 * Tab body for ad-hoc SQL queries. Hosts a Monaco editor on top and a
 * `DataGrid` of results below, separated by a vertical resize handle.
 *
 * Editor features:
 *  - `Ctrl+Enter` runs the entire buffer. Bound through Monaco's command
 *    system (not a `window` listener) because Monaco swallows the
 *    keypress inside the editor focus area — see gotcha #9 in CLAUDE.md.
 *  - A CodeLens "▶ Run" appears on the first line of every `;`-delimited
 *    statement and runs just that fragment. Useful when the editor
 *    holds a scratch pad of multiple queries.
 *  - Autocomplete blends tables, columns and SQL keywords (the latter
 *    driver-aware: `RETURNING` on Postgres, `ON DUPLICATE KEY` on
 *    MySQL, etc.). Suggestions are ranked tables → columns → keywords
 *    via `sortText` prefixes; see `lib/sqlCompletions.ts`.
 *
 * An info bar at the bottom of the editor panel mirrors VS Code's status
 * bar style, showing the keyboard shortcut hint, connected database name,
 * current line/character count, and encoding.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import Editor, { type Monaco } from "@monaco-editor/react";
import { Bookmark, History, Trash2 } from "lucide-react";
import { Panel, PanelGroup, PanelResizeHandle } from "react-resizable-panels";
import { api } from "@/lib/tauri";
import { useConnections } from "@/stores/connections";
import { useSchema } from "@/stores/schema";
import { useTabs } from "@/stores/tabs";
import { usePreferences, selectEditorPrefs } from "@/stores/preferences";
import { resolveMonacoTheme } from "@/lib/monaco-themes";
import { useQueryHistory } from "@/stores/queryHistory";
import { useCommandPalette } from "@/components/CommandPalette";
import type { QueryResult } from "@/types";
import { DataGrid } from "@/components/DataGrid";
import { Button } from "@/components/ui/button";
import { SaveQueryDialog } from "@/components/SaveQueryDialog";
import { splitSql } from "@/lib/sqlSplit";
import { keywordsFor } from "@/lib/sqlKeywords";
import { buildCompletions } from "@/lib/sqlCompletions";
import {
  ensureSqlProviders,
  registerSqlEditor,
  fireSqlLensChange,
} from "@/lib/monacoSql";

interface Props {
  tabId: string;
  connectionId: string;
}

export function QueryEditorTab({ tabId, connectionId }: Props) {
  const { t } = useTranslation();
  const tab = useTabs((s) => s.tabs.find((t) => t.id === tabId));
  const updateQuery = useTabs((s) => s.updateQuery);
  const updateQueryStats = useTabs((s) => s.updateQueryStats);
  const editorPrefs = usePreferences(selectEditorPrefs);
  const schemaState = useSchema((s) => s.byConnection[connectionId]);
  const addHistory = useQueryHistory((s) => s.add);
  const allHistory = useQueryHistory((s) => s.entries);
  const clearHistory = useQueryHistory((s) => s.clear);
  // Stable array; filter is derived in component body with useMemo (not in the selector).
  const profiles = useConnections((s) => s.profiles);

  const history = useMemo(
    () => allHistory.filter((e) => e.connectionId === connectionId),
    [allHistory, connectionId],
  );

  /** Short display name for the connected database shown in the info bar. */
  const dbName = useMemo(() => {
    const p = profiles.find((pr) => pr.id === connectionId);
    if (!p) return connectionId;
    if (p.driver === "sqlite")
      return p.database.split(/[/\\]/).pop() ?? p.database;
    return p.database;
  }, [profiles, connectionId]);

  const [result, setResult] = useState<QueryResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const [showHistory, setShowHistory] = useState(false);
  const [saveDialogOpen, setSaveDialogOpen] = useState(false);
  const [filter, setFilter] = useState("");
  /** Line and character counts updated live by Monaco. */
  const [editorStats, setEditorStats] = useState({ lines: 1, chars: 0 });

  // Typed loosely to avoid importing the heavy monaco-editor types at compile
  // time. The subset we need is stable across Monaco versions.
  const editorRef = useRef<{
    getModel: () => {
      getLineCount: () => number;
      getValueLength: () => number;
      getValue: () => string;
      uri: { toString: () => string };
    } | null;
    onDidChangeModelContent: (fn: () => void) => { dispose: () => void };
    addCommand: (keybinding: number, handler: () => void) => string | null;
  } | null>(null);

  /** Disposer returned by `registerSqlEditor`; removes this editor's entry
   *  from the shared provider registry on unmount. */
  const sqlEditorDisposeRef = useRef<(() => void) | null>(null);
  useEffect(() => {
    return () => {
      sqlEditorDisposeRef.current?.();
      sqlEditorDisposeRef.current = null;
    };
  }, []);

  const sql = tab?.query ?? "";

  /** Driver for the active connection — drives the keyword overlay and
   *  the dollar-quote handling in [[splitSql]]. */
  const driver = useConnections((s) => {
    const direct = s.profiles.find((p) => p.id === connectionId);
    if (direct) return direct.driver;
    const sep = connectionId.indexOf("::db::");
    if (sep > 0) {
      const parent = s.profiles.find((p) => p.id === connectionId.slice(0, sep));
      if (parent) return parent.driver;
    }
    return undefined;
  });

  /**
   * Pre-built suggestion list. Recomputes when the schema cache changes
   * for this connection or when the driver flips (keyword overlay).
   * Empty schemas still produce keyword suggestions so the autocomplete
   * is useful before the user expands the explorer.
   */
  const completionSuggestions = useMemo(() => {
    return buildCompletions({
      tables: schemaState?.tables ?? [],
      columns: schemaState?.columns ?? {},
      keywords: keywordsFor(driver),
    });
  }, [schemaState, driver]);

  /**
   * Run a fragment of SQL. Defaults to the entire editor buffer when no
   * text is passed in. We support the optional argument so the
   * per-statement CodeLens can execute just the statement under the
   * gutter icon without juggling editor selection state.
   */
  const runQuery = useCallback(
    async (override?: string) => {
      const toRun = (override ?? sql).trim();
      if (!toRun || running) return;
      setRunning(true);
      setError(null);
      try {
        const r = await api.executeQuery(connectionId, toRun);
        setResult(r);
        // Propagate stats to the tab store so StatusBar can display them.
        updateQueryStats(tabId, { rows: r.rows_affected, elapsed_ms: r.elapsed_ms });
        addHistory({
          sql: toRun,
          connectionId,
          elapsedMs: r.elapsed_ms,
          rowsAffected: r.rows_affected,
        });
      } catch (e) {
        setError(String(e));
        addHistory({
          sql: toRun,
          connectionId,
          elapsedMs: 0,
          rowsAffected: 0,
          error: String(e),
        });
      } finally {
        setRunning(false);
      }
    },
    [sql, connectionId, running, addHistory, updateQueryStats, tabId],
  );

  /**
   * Ref pointing at the latest `runQuery`. Monaco's `addCommand` runs
   * its handler in a long-lived closure that we register exactly once
   * inside `handleMount`; capturing the runQuery callback there
   * directly would freeze the closure to the first render's values
   * (stale `sql`, stale `running`). Bouncing through this ref lets us
   * keep one registration while still hitting the live callback.
   */
  const runQueryRef = useRef(runQuery);
  useEffect(() => {
    runQueryRef.current = runQuery;
  }, [runQuery]);

  /**
   * Ref to the live completion list for the same reason as `runQueryRef`:
   * `registerCompletionItemProvider` keeps the handler closure for the
   * lifetime of the editor and we want it to see the freshest
   * suggestions every time the user opens the popup.
   */
  const completionsRef = useRef(completionSuggestions);
  useEffect(() => {
    completionsRef.current = completionSuggestions;
  }, [completionSuggestions]);

  /**
   * Live CodeLens cache. We re-parse the SQL whenever the buffer changes and
   * fire the shared lens emitter so Monaco refreshes the gutter. The (single,
   * app-wide) provider reads this editor's lenses from the registry, so we
   * only have to keep the cache fresh and ping the emitter.
   */
  const lensesRef = useRef<ReturnType<typeof splitSql>>([]);

  function recomputeLenses() {
    lensesRef.current = splitSql(sql);
    fireSqlLensChange();
  }

  // Keep the CodeLens cache in sync with the buffer. The provider itself
  // uses the ref, so we only have to invalidate on each edit.
  useEffect(() => {
    recomputeLenses();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sql]);

  function handleMount(_editor: unknown, monaco: Monaco) {
    const editor = _editor as typeof editorRef.current;
    editorRef.current = editor;

    // Seed initial stats.
    const model = editor?.getModel();
    if (model) {
      setEditorStats({ lines: model.getLineCount(), chars: model.getValueLength() });
    }

    // Keep stats in sync as the user types.
    editor?.onDidChangeModelContent(() => {
      const m = editor.getModel();
      if (m) setEditorStats({ lines: m.getLineCount(), chars: m.getValueLength() });
    });

    // Ctrl/Cmd + Enter → run the full buffer. Bound through Monaco's
    // command system so the editor's own keybinding layer doesn't
    // swallow the event (the previous window-level listener was
    // racing Monaco and the run only fired when the editor was
    // not focused — i.e. never, when the user actually needed it).
    editor?.addCommand(
      // KeyMod.CtrlCmd | KeyCode.Enter — using the Monaco enum
      // values directly avoids importing them at compile time.
      monaco.KeyMod.CtrlCmd | monaco.KeyCode.Enter,
      () => {
        void runQueryRef.current();
      },
    );

    // Ctrl/Cmd+K toggles the command palette. Monaco swallows the keystroke
    // inside its focus area, so the window-level listener in App never sees
    // it — register the editor-scoped command too (gotcha #9). `addCommand`
    // IS per-editor, so this one is correctly bound here.
    editor?.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyK, () => {
      useCommandPalette.getState().toggle();
    });

    // The SQL completion + per-statement "▶ Run" CodeLens providers are
    // GLOBAL to the language, so they're installed exactly once for the
    // Monaco instance and dispatch per model. We just register this editor's
    // live data (read through the existing refs) and keep the disposer for
    // unmount — registering the providers per editor is what produced the
    // duplicate "▶ Run" lenses when several query tabs were open.
    ensureSqlProviders(monaco);
    const uri = model?.uri.toString();
    if (uri) {
      sqlEditorDisposeRef.current?.();
      sqlEditorDisposeRef.current = registerSqlEditor(uri, {
        getCompletions: () => completionsRef.current,
        getLenses: () => lensesRef.current,
        runStatement: (text) => void runQueryRef.current(text),
      });
    }
  }

  return (
    <PanelGroup direction="vertical" className="h-full">
      {/* Editor panel */}
      <Panel defaultSize={45} minSize={15}>
        <div className="flex h-full flex-col">
          {/* Compact action row: save + history only (Run is Ctrl+Enter) */}
          <div className="flex items-center gap-1 border-b border-border bg-background px-2 py-1">
            <Button
              size="sm"
              variant="ghost"
              onClick={() => setSaveDialogOpen(true)}
              disabled={!sql.trim()}
              title={t("query.saveQuery")}
            >
              <Bookmark className="h-3.5 w-3.5" />
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => setShowHistory((v) => !v)}
              title={t("query.history")}
            >
              <History className="h-3.5 w-3.5" />
            </Button>
            {showHistory && (
              <Button
                size="sm"
                variant="ghost"
                onClick={clearHistory}
                title={t("query.clearHistory")}
              >
                <Trash2 className="h-3.5 w-3.5" />
              </Button>
            )}
            {running && (
              <span className="ml-2 text-[11px] text-muted-foreground">
                {t("query.running")}
              </span>
            )}
          </div>

          {/* Monaco + optional history sidebar */}
          <div className="flex flex-1 overflow-hidden">
            <div className="flex-1">
              <Editor
                height="100%"
                language="sql"
                // `theme.mode` (app theme) used to be the only signal;
                // now Editor prefs own the Monaco theme so users can
                // pick One Dark Pro / GitHub / Monokai / Solarized
                // independently of the app chrome. `resolveMonacoTheme`
                // falls back to one-dark-pro if `prefs.json` carries an
                // unknown id.
                theme={resolveMonacoTheme(editorPrefs.theme)}
                value={sql}
                onChange={(v) => updateQuery(tabId, v ?? "")}
                onMount={handleMount}
                options={{
                  minimap: { enabled: editorPrefs.minimap },
                  wordWrap: editorPrefs.wordWrap ? "on" : "off",
                  fontFamily: editorPrefs.fontFamily,
                  fontSize: editorPrefs.fontSize,
                  tabSize: editorPrefs.tabSize,
                  lineNumbers: editorPrefs.lineNumbers ? "on" : "off",
                  formatOnPaste: editorPrefs.formatOnPaste,
                  scrollBeyondLastLine: false,
                  automaticLayout: true,
                }}
              />
            </div>
            {showHistory && (
              <div className="w-72 border-l border-border bg-card/40">
                <div className="border-b border-border px-3 py-1.5 text-[10px] uppercase tracking-wider text-muted-foreground">
                  {t("query.historyTitle")}
                </div>
                <div className="h-full overflow-y-auto pb-12">
                  {history.length === 0 && (
                    <div className="px-3 py-3 text-xs text-muted-foreground">
                      {t("query.noQueries")}
                    </div>
                  )}
                  {history.map((h) => (
                    <button
                      key={h.id}
                      onClick={() => updateQuery(tabId, h.sql)}
                      className="block w-full border-b border-border/40 px-3 py-2 text-left text-xs hover:bg-accent/30"
                    >
                      <div className="line-clamp-2 font-mono text-[11px]">
                        {h.sql}
                      </div>
                      <div className="mt-1 flex items-center gap-2 text-[10px] text-muted-foreground">
                        <span>{new Date(h.ranAt).toLocaleTimeString()}</span>
                        {h.error ? (
                          <span className="text-destructive">error</span>
                        ) : (
                          <span>
                            {h.rowsAffected} rows · {h.elapsedMs} ms
                          </span>
                        )}
                      </div>
                    </button>
                  ))}
                </div>
              </div>
            )}
          </div>

          {/* Editor info bar: keyboard hint · db name · line/char count · encoding */}
          <div className="flex items-center gap-0 border-t border-border bg-card px-3 py-1 text-[11px] text-muted-foreground">
            <span className="flex items-center gap-1">
              <kbd className="rounded bg-muted px-1 font-mono text-[10px]">
                Ctrl
              </kbd>
              <span>+</span>
              <kbd className="rounded bg-muted px-1 font-mono text-[10px]">
                Enter
              </kbd>
              <span className="ml-1 text-muted-foreground/70">{t("query.run")}</span>
            </span>
            <span className="mx-3 text-muted-foreground/30">|</span>
            <span className="truncate">{dbName}</span>
            <span className="mx-3 text-muted-foreground/30">|</span>
            <span>
              {editorStats.lines} line{editorStats.lines !== 1 ? "s" : ""}
              {" · "}
              {editorStats.chars} chars
            </span>
            <span className="mx-3 text-muted-foreground/30">|</span>
            <span>sql · utf-8</span>
          </div>
        </div>
      </Panel>

      <PanelResizeHandle className="h-1 bg-border hover:bg-primary/30" />

      {/* Results panel */}
      <Panel defaultSize={55} minSize={20}>
        <div className="flex h-full flex-col">
          {error ? (
            <div className="overflow-auto bg-destructive/10 p-3 font-mono text-xs text-destructive">
              {error}
            </div>
          ) : result ? (
            <DataGrid
              result={result}
              globalFilter={filter}
              onGlobalFilterChange={setFilter}
            />
          ) : (
            <div className="flex flex-1 items-center justify-center text-xs text-muted-foreground">
              {t("query.noResults")}
            </div>
          )}
        </div>
      </Panel>

      <SaveQueryDialog
        open={saveDialogOpen}
        onOpenChange={setSaveDialogOpen}
        sql={sql}
        connectionId={connectionId}
      />
    </PanelGroup>
  );
}
