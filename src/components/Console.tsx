/**
 * Console panel — in-app SQL log, HeidiSQL-style.
 *
 * Mounts a virtualized list of [`LogEntry`] (driven by `useLogs`) plus a
 * detail pane that renders the currently-selected entry's SQL in a
 * Monaco read-only viewer. The list captures every backend command that
 * crossed the Tauri bridge: SQL execution, connection open/close, and
 * test_connection. Failed entries get a red border + error message.
 *
 * Filtering is intentionally derived inside the component (via
 * `useMemo`) and not from a Zustand selector — selectors that return
 * fresh arrays would re-render the panel on every push and break the
 * reference-stability rule called out in CLAUDE.md.
 */

import { useMemo, useState } from "react";
import { Virtuoso } from "react-virtuoso";
import Editor from "@monaco-editor/react";
import { Pause, Play, Trash2, Search } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { useLogs, type LogKindFilter } from "@/stores/logs";
import { useThemeStore, selectActiveTheme } from "@/stores/theme";
import type { LogEntry } from "@/types";

/** `HH:MM:SS.mmm` — fixed-width clock used by every console row so the
 *  column stays vertically aligned. */
function formatTime(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number, w = 2) => String(n).padStart(w, "0");
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`;
}

/** Collapse whitespace so a multi-line SQL statement renders on a single
 *  row in the list. The full statement still shows up in the detail
 *  pane / tooltip — this is purely cosmetic for the preview. */
function previewSql(sql: string): string {
  return sql.replace(/\s+/g, " ").trim();
}

/** Visual "tag" used both by the list rows and the detail header. */
function Chip({
  className,
  children,
}: {
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <span
      className={cn(
        "shrink-0 rounded px-1 py-0.5 text-[9px] uppercase",
        className,
      )}
    >
      {children}
    </span>
  );
}

export function Console() {
  const entries = useLogs((s) => s.entries);
  const paused = useLogs((s) => s.paused);
  const query = useLogs((s) => s.query);
  const kinds = useLogs((s) => s.kinds);
  const clear = useLogs((s) => s.clear);
  const setPaused = useLogs((s) => s.setPaused);
  const setQuery = useLogs((s) => s.setQuery);
  const toggleKind = useLogs((s) => s.toggleKind);
  const theme = useThemeStore(selectActiveTheme);
  const [selectedId, setSelectedId] = useState<number | null>(null);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return entries.filter((e) => {
      if (!kinds[e.kind as LogKindFilter]) return false;
      if (!q) return true;
      const haystack =
        (e.sql ?? "") +
        " " +
        (e.message ?? "") +
        " " +
        (e.driver ?? "") +
        " " +
        (e.error ?? "");
      return haystack.toLowerCase().includes(q);
    });
  }, [entries, query, kinds]);

  const selected: LogEntry | null = useMemo(() => {
    if (selectedId == null) return null;
    return entries.find((e) => e.id === selectedId) ?? null;
  }, [entries, selectedId]);

  const selectedDetailValue =
    selected?.sql ?? selected?.message ?? selected?.error ?? "";

  return (
    <div className="flex h-full flex-col bg-background text-foreground">
      {/* Toolbar */}
      <div className="flex items-center gap-1 border-b border-border px-2 py-1">
        <Button
          size="icon"
          variant="ghost"
          className="h-7 w-7"
          onClick={() => setPaused(!paused)}
          title={paused ? "Resume" : "Pause"}
        >
          {paused ? <Play className="h-3.5 w-3.5" /> : <Pause className="h-3.5 w-3.5" />}
        </Button>
        <Button
          size="icon"
          variant="ghost"
          className="h-7 w-7"
          onClick={() => {
            clear();
            setSelectedId(null);
          }}
          title="Clear"
        >
          <Trash2 className="h-3.5 w-3.5" />
        </Button>
        <div className="mx-1 h-5 w-px bg-border" />
        <label className="flex items-center gap-1 text-[11px] text-muted-foreground">
          <input
            type="checkbox"
            checked={kinds.sql}
            onChange={() => toggleKind("sql")}
            className="h-3 w-3"
          />
          SQL
        </label>
        <label className="flex items-center gap-1 text-[11px] text-muted-foreground">
          <input
            type="checkbox"
            checked={kinds.connection}
            onChange={() => toggleKind("connection")}
            className="h-3 w-3"
          />
          Connection
        </label>
        <div className="mx-1 h-5 w-px bg-border" />
        <div className="relative flex-1">
          <Search className="pointer-events-none absolute left-2 top-1/2 h-3 w-3 -translate-y-1/2 text-muted-foreground" />
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Filter SQL, error, driver…"
            className="h-7 w-full rounded border border-border bg-background pl-6 pr-2 font-mono text-[11px] outline-none focus:ring-1 focus:ring-ring"
          />
        </div>
        <div className="px-1 text-[10px] tabular-nums text-muted-foreground">
          {filtered.length}/{entries.length}
        </div>
      </div>

      {/* List */}
      <div className="flex-1 overflow-hidden">
        {filtered.length === 0 ? (
          <div className="flex h-full items-center justify-center px-4 text-center text-xs text-muted-foreground">
            {entries.length === 0
              ? "No backend activity yet. Run a query or open a connection."
              : "No entries match the current filter."}
          </div>
        ) : (
          <Virtuoso
            data={filtered}
            followOutput={paused ? false : "smooth"}
            itemContent={(_index, entry) => (
              <ConsoleRow
                entry={entry}
                selected={selectedId === entry.id}
                onClick={() => setSelectedId(entry.id)}
              />
            )}
          />
        )}
      </div>

      {/* Detail pane */}
      {selected && (
        <div className="flex h-48 flex-col border-t border-border">
          <div className="flex items-center gap-2 border-b border-border bg-card/40 px-2 py-1 font-mono text-[10px] text-muted-foreground">
            <span>{formatTime(selected.timestamp_ms)}</span>
            {selected.driver && (
              <Chip className="bg-muted text-muted-foreground">
                {selected.driver}
              </Chip>
            )}
            <Chip className="bg-muted text-muted-foreground">
              {selected.kind}
            </Chip>
            {selected.duration_ms != null && (
              <span>{selected.duration_ms} ms</span>
            )}
            {selected.rows_affected != null && (
              <span>{selected.rows_affected} rows</span>
            )}
            {selected.connection_id && (
              <span className="truncate">conn {selected.connection_id}</span>
            )}
          </div>
          {selected.error && (
            <div className="border-b border-destructive/40 bg-destructive/10 px-2 py-1 font-mono text-[11px] text-destructive">
              {selected.error}
            </div>
          )}
          <div className="flex-1">
            <Editor
              height="100%"
              language={selected.kind === "sql" ? "sql" : "plaintext"}
              theme={theme.mode === "dark" ? "vs-dark" : "vs-light"}
              value={selectedDetailValue}
              options={{
                readOnly: true,
                domReadOnly: true,
                minimap: { enabled: false },
                wordWrap: "on",
                fontSize: 12,
                lineNumbers: "off",
                scrollBeyondLastLine: false,
                automaticLayout: true,
                renderLineHighlight: "none",
                folding: false,
              }}
            />
          </div>
        </div>
      )}
    </div>
  );
}

interface ConsoleRowProps {
  entry: LogEntry;
  selected: boolean;
  onClick: () => void;
}

function ConsoleRow({ entry, selected, onClick }: ConsoleRowProps) {
  const preview = entry.sql
    ? previewSql(entry.sql)
    : (entry.message ?? "");
  const isError = entry.error != null;

  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "flex w-full items-center gap-2 border-b border-border/40 px-2 py-1 text-left font-mono text-[11px] hover:bg-accent/30",
        selected && "bg-accent/40",
        isError && "border-l-2 border-l-destructive",
      )}
    >
      <span className="shrink-0 text-muted-foreground">
        {formatTime(entry.timestamp_ms)}
      </span>
      {entry.driver && (
        <Chip className="bg-muted text-muted-foreground">{entry.driver}</Chip>
      )}
      <Chip
        className={
          entry.kind === "sql"
            ? "bg-primary/10 text-primary"
            : "bg-muted text-muted-foreground"
        }
      >
        {entry.kind}
      </Chip>
      {entry.duration_ms != null && (
        <span className="shrink-0 tabular-nums text-muted-foreground">
          {entry.duration_ms}ms
        </span>
      )}
      {entry.rows_affected != null && (
        <span className="shrink-0 tabular-nums text-muted-foreground">
          {entry.rows_affected}r
        </span>
      )}
      <span
        className={cn("min-w-0 flex-1 truncate", isError && "text-destructive")}
        title={preview}
      >
        {preview}
      </span>
    </button>
  );
}
