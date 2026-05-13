/**
 * Tree-style explorer of databases / schemas / tables / columns for the
 * currently selected connection. Columns are lazy-loaded the first time
 * a table node is expanded. Single-click on a table opens it in a data
 * tab.
 */

import { useEffect } from "react";
import { ChevronDown, ChevronRight, Database, RefreshCw, Table as TableIcon, Eye, KeyRound } from "lucide-react";
import { useSchema, tableKey } from "@/stores/schema";
import { useTabs } from "@/stores/tabs";
import { Button } from "@/components/ui/button";
import type { TableInfo } from "@/types";

export function SchemaExplorer({ connectionId }: { connectionId: string }) {
  const cs = useSchema((s) => s.byConnection[connectionId]);
  const refresh = useSchema((s) => s.refresh);
  const toggleNode = useSchema((s) => s.toggleNode);
  const loadColumns = useSchema((s) => s.loadColumns);
  const openTab = useTabs((s) => s.open);

  useEffect(() => {
    if (!cs) refresh(connectionId);
  }, [connectionId, cs, refresh]);

  if (!cs) {
    return (
      <div className="px-3 py-3 text-xs text-muted-foreground">Loading schema…</div>
    );
  }

  const tablesBySchema: Record<string, TableInfo[]> = {};
  for (const t of cs.tables) {
    tablesBySchema[t.schema] = tablesBySchema[t.schema] ?? [];
    tablesBySchema[t.schema].push(t);
  }
  const schemas = Object.keys(tablesBySchema).sort();

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between px-3 py-2">
        <div className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
          Schema
        </div>
        <Button
          size="icon"
          variant="ghost"
          onClick={() => refresh(connectionId)}
          disabled={cs.loading}
          title="Refresh"
        >
          <RefreshCw className={`h-3.5 w-3.5 ${cs.loading ? "animate-spin" : ""}`} />
        </Button>
      </div>
      {cs.error && (
        <div className="px-3 py-2 text-xs text-destructive">{cs.error}</div>
      )}
      <div className="flex-1 overflow-y-auto py-1 text-sm">
        {schemas.map((schema) => {
          const nodeKey = `schema:${schema}`;
          const isOpen = cs.expanded.has(nodeKey);
          return (
            <div key={schema}>
              <button
                className="flex w-full items-center gap-1 px-2 py-1 hover:bg-accent/40"
                onClick={() => toggleNode(connectionId, nodeKey)}
              >
                {isOpen ? (
                  <ChevronDown className="h-3 w-3" />
                ) : (
                  <ChevronRight className="h-3 w-3" />
                )}
                <Database className="h-3.5 w-3.5 text-muted-foreground" />
                <span className="truncate text-xs">{schema}</span>
                <span className="ml-auto text-[10px] text-muted-foreground">
                  {tablesBySchema[schema].length}
                </span>
              </button>
              {isOpen && (
                <div>
                  {tablesBySchema[schema].map((t) => {
                    const k = tableKey(t.schema, t.name);
                    const tableNodeKey = `table:${k}`;
                    const tableOpen = cs.expanded.has(tableNodeKey);
                    const cols = cs.columns[k];
                    return (
                      <div key={k}>
                        <div className="flex items-center pl-4 pr-2 hover:bg-accent/30">
                          <button
                            onClick={() => {
                              toggleNode(connectionId, tableNodeKey);
                              if (!cols) loadColumns(connectionId, t.schema, t.name);
                            }}
                            className="flex flex-1 items-center gap-1 py-1"
                          >
                            {tableOpen ? (
                              <ChevronDown className="h-3 w-3" />
                            ) : (
                              <ChevronRight className="h-3 w-3" />
                            )}
                            {t.kind === "view" ? (
                              <Eye className="h-3.5 w-3.5 text-muted-foreground" />
                            ) : (
                              <TableIcon className="h-3.5 w-3.5 text-muted-foreground" />
                            )}
                            <span
                              className="truncate text-xs"
                              onDoubleClick={(e) => {
                                e.stopPropagation();
                                openTab({
                                  kind: "table",
                                  title: t.name,
                                  connectionId,
                                  schema: t.schema,
                                  table: t.name,
                                });
                              }}
                              onClick={(e) => {
                                e.stopPropagation();
                                openTab({
                                  kind: "table",
                                  title: t.name,
                                  connectionId,
                                  schema: t.schema,
                                  table: t.name,
                                });
                              }}
                            >
                              {t.name}
                            </span>
                          </button>
                        </div>
                        {tableOpen && (
                          <div className="ml-6 border-l border-border/50 pl-2">
                            {cols ? (
                              cols.map((c) => (
                                <div
                                  key={c.name}
                                  className="flex items-center gap-1 py-0.5 text-[11px] text-muted-foreground"
                                >
                                  {c.is_primary_key && (
                                    <KeyRound className="h-2.5 w-2.5 text-amber-400" />
                                  )}
                                  <span className="truncate">{c.name}</span>
                                  <span className="ml-auto pl-2 text-[10px] uppercase">
                                    {c.data_type}
                                  </span>
                                </div>
                              ))
                            ) : (
                              <div className="py-0.5 text-[11px] italic text-muted-foreground">
                                loading…
                              </div>
                            )}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
