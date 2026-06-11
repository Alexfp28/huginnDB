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
import { Bookmark, Check, Database, History, Play, Trash2, X } from "lucide-react";
import { Panel, PanelGroup, PanelResizeHandle } from "react-resizable-panels";
import { api } from "@/lib/tauri";
import { useConnections } from "@/stores/connections";
import { useSchema } from "@/stores/schema";
import { useTabs } from "@/stores/tabs";
import { usePreferences, selectEditorPrefs } from "@/stores/preferences";
import { resolveMonacoTheme } from "@/lib/monaco-themes";
import { useQueryHistory } from "@/stores/queryHistory";
import { useCommandPalette } from "@/components/CommandPalette";
import type { BatchResult, DatabaseInfo, QueryResult } from "@/types";
import { DataGrid } from "@/components/DataGrid";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
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

const DB_SEP = "::db::";
/** Radix Select can't carry an empty value, so the parent / default-database
 *  option uses this sentinel. */
const DEFAULT_DB = "__default__";

export function QueryEditorTab({ tabId, connectionId }: Props) {
  const { t } = useTranslation();
  const tab = useTabs((s) => s.tabs.find((t) => t.id === tabId));
  const updateQuery = useTabs((s) => s.updateQuery);
  const updateQueryStats = useTabs((s) => s.updateQueryStats);
  const editorPrefs = usePreferences(selectEditorPrefs);
  const addHistory = useQueryHistory((s) => s.add);
  const allHistory = useQueryHistory((s) => s.entries);
  const clearHistory = useQueryHistory((s) => s.clear);
  // Stable array; filter is derived in component body with useMemo (not in the selector).
  const profiles = useConnections((s) => s.profiles);

  /** Parent connection id (a query tab may be opened against a `::db::`
   *  child already). Database listing / switching always works off the parent. */
  const parentId = useMemo(() => {
    const sep = connectionId.indexOf(DB_SEP);
    return sep > 0 ? connectionId.slice(0, sep) : connectionId;
  }, [connectionId]);

  /** The id the query actually runs against. Starts as the tab's connection
   *  and is repointed to a `parent::db::<name>` child when the user picks a
   *  database from the selector — `execute_query` / `execute_batch` and the
   *  autocomplete schema all key off this, so switching it is all it takes to
   *  scope the tab to another database without typing it into the SQL. */
  const [effectiveId, setEffectiveId] = useState(connectionId);
  useEffect(() => setEffectiveId(connectionId), [connectionId]);

  /** Database currently targeted, parsed back out of `effectiveId`. */
  const selectedDb = useMemo(() => {
    const sep = effectiveId.indexOf(DB_SEP);
    return sep > 0 ? effectiveId.slice(sep + DB_SEP.length) : "";
  }, [effectiveId]);

  const schemaState = useSchema((s) => s.byConnection[effectiveId]);

  const history = useMemo(
    () => allHistory.filter((e) => e.connectionId === parentId),
    [allHistory, parentId],
  );

  /** Short display name for the connected database shown in the info bar. */
  const dbName = useMemo(() => {
    const p = profiles.find((pr) => pr.id === parentId);
    if (!p) return parentId;
    if (p.driver === "sqlite")
      return p.database.split(/[/\\]/).pop() ?? p.database;
    return selectedDb || p.database || t("query.defaultDatabase");
  }, [profiles, parentId, selectedDb, t]);

  const [result, setResult] = useState<QueryResult | null>(null);
  const [batchSummary, setBatchSummary] = useState<BatchResult | null>(null);
  const [databases, setDatabases] = useState<DatabaseInfo[]>([]);
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

  /** Driver for the active connection — drives the keyword overlay, the
   *  dollar-quote handling in [[splitSql]], and whether the database selector
   *  is shown (SQLite is single-file, so it isn't). */
  const driver = useConnections(
    (s) => s.profiles.find((p) => p.id === parentId)?.driver,
  );

  /** Parsed statements of the current buffer. Drives both the per-statement
   *  CodeLens count and the "Run all" affordance. */
  const statements = useMemo(() => splitSql(sql), [sql]);
  const multiStatement = statements.length > 1;

  /** Databases available on the parent connection. Fetched once per parent
   *  for the selector; SQLite reports a single "main" so we skip it there. */
  useEffect(() => {
    if (driver === "sqlite") {
      setDatabases([]);
      return;
    }
    let cancelled = false;
    void api
      .listDatabases(parentId)
      .then((dbs) => {
        if (!cancelled) setDatabases(dbs);
      })
      .catch(() => {
        if (!cancelled) setDatabases([]);
      });
    return () => {
      cancelled = true;
    };
  }, [parentId, driver]);

  /** Repoint the tab at another database. Opens (idempotently) the child pool
   *  for `name`, switches `effectiveId` to it, and warms its schema so the
   *  autocomplete reflects the new database. `DEFAULT_DB` returns to the
   *  parent (the connect-time / maintenance database). */
  const switchDatabase = useCallback(
    async (name: string) => {
      if (name === DEFAULT_DB) {
        setEffectiveId(parentId);
        return;
      }
      try {
        const id = await api.openDatabaseView(parentId, name);
        setEffectiveId(id);
        void useSchema.getState().refresh(id);
      } catch (e) {
        setError(String(e));
      }
    },
    [parentId],
  );

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
      setBatchSummary(null);
      try {
        const r = await api.executeQuery(effectiveId, toRun);
        setResult(r);
        // Propagate stats to the tab store so StatusBar can display them.
        updateQueryStats(tabId, { rows: r.rows_affected, elapsed_ms: r.elapsed_ms });
        addHistory({
          sql: toRun,
          connectionId: parentId,
          elapsedMs: r.elapsed_ms,
          rowsAffected: r.rows_affected,
        });
      } catch (e) {
        setError(String(e));
        addHistory({
          sql: toRun,
          connectionId: parentId,
          elapsedMs: 0,
          rowsAffected: 0,
          error: String(e),
        });
      } finally {
        setRunning(false);
      }
    },
    [sql, effectiveId, parentId, running, addHistory, updateQueryStats, tabId],
  );

  /**
   * Run every statement in the buffer in order, on a single connection.
   * This is the multi-statement path: a lone `executeQuery` over a
   * `;`-joined buffer hits the prepared protocol, which rejects multiple
   * commands. The summary lists each statement's outcome; the last SELECT's
   * rows land in the grid.
   */
  const runBatch = useCallback(async () => {
    if (running || statements.length === 0) return;
    setRunning(true);
    setError(null);
    try {
      const r = await api.executeBatch(
        effectiveId,
        statements.map((s) => s.text),
      );
      setBatchSummary(r);
      setResult(r.last_result);
      const failed = r.statements.find((s) => s.error);
      updateQueryStats(tabId, { rows: r.total_affected, elapsed_ms: 0 });
      addHistory({
        sql: statements.map((s) => s.text).join(";\n"),
        connectionId: parentId,
        elapsedMs: 0,
        rowsAffected: r.total_affected,
        error: failed?.error ?? undefined,
      });
    } catch (e) {
      setError(String(e));
    } finally {
      setRunning(false);
    }
  }, [
    running,
    statements,
    effectiveId,
    parentId,
    updateQueryStats,
    tabId,
    addHistory,
  ]);

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
   * Ctrl+Enter dispatcher, kept in a ref for the same long-lived-closure
   * reason as `runQueryRef`. Routes the whole buffer to the batch runner when
   * it holds more than one statement (so a paste of N statements no longer
   * trips the prepared-protocol "cannot insert multiple commands" error), and
   * to the single-statement runner otherwise.
   */
  const runDefaultRef = useRef<() => void>(() => {});
  useEffect(() => {
    runDefaultRef.current = () => {
      if (multiStatement) void runBatch();
      else void runQuery();
    };
  }, [multiStatement, runBatch, runQuery]);

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

  // Keep the CodeLens cache in sync with the buffer (reusing the already-parsed
  // `statements` memo). The provider reads this ref, so we only have to
  // refresh it and ping the shared emitter on each edit.
  useEffect(() => {
    lensesRef.current = statements;
    fireSqlLensChange();
  }, [statements]);

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

    // Ctrl/Cmd + Enter → run the full buffer (batch when it holds several
    // statements). Bound through Monaco's command system so the editor's own
    // keybinding layer doesn't swallow the event (the previous window-level
    // listener was racing Monaco and the run only fired when the editor was
    // not focused — i.e. never, when the user actually needed it).
    editor?.addCommand(
      // KeyMod.CtrlCmd | KeyCode.Enter — using the Monaco enum
      // values directly avoids importing them at compile time.
      monaco.KeyMod.CtrlCmd | monaco.KeyCode.Enter,
      () => {
        runDefaultRef.current();
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
          {/* Compact action row: save + history (Run is Ctrl+Enter) and,
              for multi-DB servers, a database selector that scopes the tab. */}
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

            {driver !== "sqlite" && databases.length > 0 && (
              <div className="ml-1 flex items-center gap-1">
                <Database className="h-3.5 w-3.5 text-muted-foreground" />
                <Select
                  value={selectedDb || DEFAULT_DB}
                  onValueChange={(v) => void switchDatabase(v)}
                >
                  <SelectTrigger
                    className="h-6 w-44 text-xs"
                    title={t("query.database")}
                  >
                    <SelectValue placeholder={t("query.defaultDatabase")} />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={DEFAULT_DB} className="text-xs">
                      {t("query.defaultDatabase")}
                    </SelectItem>
                    {databases.map((db) => (
                      <SelectItem key={db.name} value={db.name} className="text-xs">
                        {db.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            )}

            {multiStatement && (
              <Button
                size="sm"
                variant="ghost"
                className="ml-auto h-6 gap-1 px-2 text-[11px] text-primary hover:text-primary"
                onClick={() => void runBatch()}
                disabled={running}
                title={t("query.runAllTitle")}
              >
                <Play className="h-3 w-3" />
                {t("query.runAll", { count: statements.length })}
              </Button>
            )}
            {running && (
              <span
                className={`text-[11px] text-muted-foreground ${multiStatement ? "ml-2" : "ml-auto"}`}
              >
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
          {/* Batch summary: one line per statement, last SELECT shown below. */}
          {batchSummary && <BatchSummary summary={batchSummary} />}
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
              {batchSummary ? null : t("query.noResults")}
            </div>
          )}
        </div>
      </Panel>

      <SaveQueryDialog
        open={saveDialogOpen}
        onOpenChange={setSaveDialogOpen}
        sql={sql}
        connectionId={parentId}
      />
    </PanelGroup>
  );
}

/**
 * Compact, scrollable summary of a multi-statement batch run. One row per
 * statement with a status glyph, a monospace preview and its affected-row
 * count; a header line tallies the whole batch (or flags where it stopped).
 * Deliberately understated — the grid below holds the actual data.
 */
function BatchSummary({ summary }: { summary: BatchResult }) {
  const { t } = useTranslation();
  const failedAt = summary.statements.findIndex((s) => s.error);
  const ok = failedAt === -1;
  return (
    <div className="shrink-0 border-b border-border bg-card/40">
      <div
        className={`px-3 py-1 text-[11px] ${ok ? "text-muted-foreground" : "text-destructive"}`}
      >
        {ok
          ? t("query.batchOk", {
              count: summary.statements.length,
              rows: summary.total_affected,
            })
          : t("query.batchFailed", {
              index: failedAt + 1,
              total: summary.statements.length,
            })}
      </div>
      <div className="max-h-28 overflow-y-auto">
        {summary.statements.map((s) => (
          <div
            key={s.index}
            className="flex items-center gap-2 px-3 py-0.5 text-[11px]"
          >
            {s.error ? (
              <X className="h-3 w-3 shrink-0 text-destructive" />
            ) : (
              <Check className="h-3 w-3 shrink-0 text-primary" />
            )}
            <span className="min-w-0 flex-1 truncate font-mono text-muted-foreground">
              {s.preview}
            </span>
            <span
              className={`shrink-0 tabular-nums ${s.error ? "text-destructive" : "text-muted-foreground/70"}`}
            >
              {s.error
                ? s.error
                : s.is_select
                  ? `${s.rows_affected} rows`
                  : `${s.rows_affected} affected`}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}
