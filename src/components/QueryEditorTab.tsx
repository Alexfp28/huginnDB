/**
 * Tab body for ad-hoc SQL queries. Hosts a Monaco editor on top and a
 * `DataGrid` of results below, separated by a vertical resize handle.
 * `Ctrl+Enter` runs the query; the history sidebar lists prior runs
 * (filtered to the current connection) and can re-load any of them.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Editor, { type Monaco } from "@monaco-editor/react";
import { Bookmark, History, Play, Trash2 } from "lucide-react";
import { Panel, PanelGroup, PanelResizeHandle } from "react-resizable-panels";
import { api } from "@/lib/tauri";
import { useSchema } from "@/stores/schema";
import { useTabs } from "@/stores/tabs";
import { useThemeStore, selectActiveTheme } from "@/stores/theme";
import { useQueryHistory } from "@/stores/queryHistory";
import type { QueryResult } from "@/types";
import { DataGrid } from "@/components/DataGrid";
import { Button } from "@/components/ui/button";
import { SaveQueryDialog } from "@/components/SaveQueryDialog";

interface Props {
  tabId: string;
  connectionId: string;
}

export function QueryEditorTab({ tabId, connectionId }: Props) {
  const tab = useTabs((s) => s.tabs.find((t) => t.id === tabId));
  const updateQuery = useTabs((s) => s.updateQuery);
  const theme = useThemeStore(selectActiveTheme);
  const schemaState = useSchema((s) => s.byConnection[connectionId]);
  const addHistory = useQueryHistory((s) => s.add);
  const allHistory = useQueryHistory((s) => s.entries);
  const clearHistory = useQueryHistory((s) => s.clear);
  const history = useMemo(
    () => allHistory.filter((e) => e.connectionId === connectionId),
    [allHistory, connectionId],
  );

  const [result, setResult] = useState<QueryResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const [showHistory, setShowHistory] = useState(false);
  const [saveDialogOpen, setSaveDialogOpen] = useState(false);
  const [filter, setFilter] = useState("");
  const editorRef = useRef<unknown>(null);

  const sql = tab?.query ?? "";

  const completionSuggestions = useMemo(() => {
    if (!schemaState) return [];
    const tableSet = new Set<string>();
    schemaState.tables.forEach((t) => tableSet.add(t.name));
    const colSet = new Set<string>();
    Object.values(schemaState.columns).forEach((cols) =>
      cols.forEach((c) => colSet.add(c.name)),
    );
    return [
      ...Array.from(tableSet).map((name) => ({ name, kind: "Class" as const })),
      ...Array.from(colSet).map((name) => ({ name, kind: "Field" as const })),
    ];
  }, [schemaState]);

  const runQuery = useCallback(async () => {
    if (!sql.trim() || running) return;
    setRunning(true);
    setError(null);
    try {
      const r = await api.executeQuery(connectionId, sql);
      setResult(r);
      addHistory({
        sql,
        connectionId,
        elapsedMs: r.elapsed_ms,
        rowsAffected: r.rows_affected,
      });
    } catch (e) {
      setError(String(e));
      addHistory({
        sql,
        connectionId,
        elapsedMs: 0,
        rowsAffected: 0,
        error: String(e),
      });
    } finally {
      setRunning(false);
    }
  }, [sql, connectionId, running, addHistory]);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.ctrlKey && e.key === "Enter") {
        e.preventDefault();
        runQuery();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [runQuery]);

  function handleMount(_editor: unknown, monaco: Monaco) {
    editorRef.current = _editor;
    monaco.languages.registerCompletionItemProvider("sql", {
      provideCompletionItems: (model, position) => {
        const word = model.getWordUntilPosition(position);
        const range = {
          startLineNumber: position.lineNumber,
          endLineNumber: position.lineNumber,
          startColumn: word.startColumn,
          endColumn: word.endColumn,
        };
        return {
          suggestions: completionSuggestions.map((s) => ({
            label: s.name,
            kind:
              s.kind === "Class"
                ? monaco.languages.CompletionItemKind.Class
                : monaco.languages.CompletionItemKind.Field,
            insertText: s.name,
            range,
          })),
        };
      },
    });
  }

  return (
    <PanelGroup direction="vertical" className="h-full">
      <Panel defaultSize={45} minSize={15}>
        <div className="flex h-full flex-col">
          <div className="flex items-center gap-2 border-b border-border bg-background px-3 py-1.5 text-xs">
            <Button size="sm" onClick={runQuery} disabled={running || !sql.trim()}>
              <Play className="mr-1 h-3 w-3" /> Run
              <span className="ml-2 rounded bg-primary-foreground/10 px-1 text-[10px]">
                Ctrl+Enter
              </span>
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => setSaveDialogOpen(true)}
              disabled={!sql.trim()}
              title="Save query"
            >
              <Bookmark className="h-3 w-3" />
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => setShowHistory((v) => !v)}
              title="Query history"
            >
              <History className="h-3 w-3" />
            </Button>
            {showHistory && (
              <Button size="sm" variant="ghost" onClick={clearHistory} title="Clear history">
                <Trash2 className="h-3 w-3" />
              </Button>
            )}
            <span className="ml-auto text-muted-foreground">
              {result && `${result.rows_affected} rows · ${result.elapsed_ms} ms`}
            </span>
          </div>
          <div className="flex flex-1 overflow-hidden">
            <div className="flex-1">
              <Editor
                height="100%"
                language="sql"
                theme={theme.mode === "dark" ? "vs-dark" : "vs-light"}
                value={sql}
                onChange={(v) => updateQuery(tabId, v ?? "")}
                onMount={handleMount}
                options={{
                  minimap: { enabled: false },
                  wordWrap: "on",
                  fontSize: 13,
                  scrollBeyondLastLine: false,
                  automaticLayout: true,
                }}
              />
            </div>
            {showHistory && (
              <div className="w-72 border-l border-border bg-card/40">
                <div className="border-b border-border px-3 py-1.5 text-[10px] uppercase tracking-wider text-muted-foreground">
                  History
                </div>
                <div className="h-full overflow-y-auto pb-12">
                  {history.length === 0 && (
                    <div className="px-3 py-3 text-xs text-muted-foreground">
                      No queries yet.
                    </div>
                  )}
                  {history.map((h) => (
                    <button
                      key={h.id}
                      onClick={() => updateQuery(tabId, h.sql)}
                      className="block w-full border-b border-border/40 px-3 py-2 text-left text-xs hover:bg-accent/30"
                    >
                      <div className="line-clamp-2 font-mono text-[11px]">{h.sql}</div>
                      <div className="mt-1 flex items-center gap-2 text-[10px] text-muted-foreground">
                        <span>
                          {new Date(h.ranAt).toLocaleTimeString()}
                        </span>
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
        </div>
      </Panel>
      <PanelResizeHandle className="h-1 bg-border hover:bg-primary/30" />
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
              Run a query to see results.
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
