/**
 * Tree-style explorer of databases / schemas / tables / columns for the
 * currently selected connection. Columns are lazy-loaded the first time
 * a table node is expanded. Single-click on a table opens it in a data tab.
 *
 * Tree structure:
 *   schema
 *   ├─ tables  (expandable section)
 *   │   ├─ table_name  <row_count>
 *   │   │   └─ column_name  TYPE
 *   │   └─ …
 *   ├─ views   (expandable section)
 *   └─ indexes (expandable section — headers only for now)
 */

import { useEffect } from "react";
import {
  ChevronDown,
  ChevronRight,
  Database,
  RefreshCw,
  Table as TableIcon,
  Eye,
  KeyRound,
  LayoutList,
} from "lucide-react";
import { useSchema, tableKey } from "@/stores/schema";
import { useTabs } from "@/stores/tabs";
import { Button } from "@/components/ui/button";
import { formatCount } from "@/lib/utils";
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
      <div className="px-3 py-3 text-xs text-muted-foreground">
        Loading schema…
      </div>
    );
  }

  // Group tables by schema, then by kind within each schema.
  const bySchema: Record<string, { tables: TableInfo[]; views: TableInfo[] }> =
    {};
  for (const t of cs.tables) {
    bySchema[t.schema] ??= { tables: [], views: [] };
    if (t.kind === "view") {
      bySchema[t.schema].views.push(t);
    } else {
      bySchema[t.schema].tables.push(t);
    }
  }
  const schemas = Object.keys(bySchema).sort();

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
          <RefreshCw
            className={`h-3.5 w-3.5 ${cs.loading ? "animate-spin" : ""}`}
          />
        </Button>
      </div>
      {cs.error && (
        <div className="px-3 py-2 text-xs text-destructive">{cs.error}</div>
      )}
      <div className="flex-1 overflow-y-auto py-1 text-sm">
        {schemas.map((schema) => {
          const schemaNodeKey = `schema:${schema}`;
          const schemaOpen = cs.expanded.has(schemaNodeKey);
          const { tables, views } = bySchema[schema];

          return (
            <div key={schema}>
              {/* Schema / database header */}
              <button
                className="flex w-full items-center gap-1 px-2 py-1 hover:bg-accent/40"
                onClick={() => toggleNode(connectionId, schemaNodeKey)}
              >
                {schemaOpen ? (
                  <ChevronDown className="h-3 w-3" />
                ) : (
                  <ChevronRight className="h-3 w-3" />
                )}
                <Database className="h-3.5 w-3.5 text-muted-foreground" />
                <span className="truncate text-xs">{schema}</span>
                <span className="ml-auto text-[10px] text-muted-foreground">
                  {tables.length + views.length}
                </span>
              </button>

              {schemaOpen && (
                <div>
                  {/* Tables section */}
                  <TableSection
                    label="tables"
                    icon={<TableIcon className="h-3 w-3 text-muted-foreground/70" />}
                    items={tables}
                    sectionKey={`${schemaNodeKey}:tables`}
                    connectionId={connectionId}
                    cs={cs}
                    toggleNode={toggleNode}
                    loadColumns={loadColumns}
                    openTab={openTab}
                  />

                  {/* Views section */}
                  {views.length > 0 && (
                    <TableSection
                      label="views"
                      icon={<Eye className="h-3 w-3 text-muted-foreground/70" />}
                      items={views}
                      sectionKey={`${schemaNodeKey}:views`}
                      connectionId={connectionId}
                      cs={cs}
                      toggleNode={toggleNode}
                      loadColumns={loadColumns}
                      openTab={openTab}
                    />
                  )}

                  {/* Indexes section header — content is per-table */}
                  <IndexesSectionHeader
                    sectionKey={`${schemaNodeKey}:indexes`}
                    connectionId={connectionId}
                    expanded={cs.expanded}
                    toggleNode={toggleNode}
                  />
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Sub-components (not exported — internal to this module)
// ---------------------------------------------------------------------------

interface SectionProps {
  label: string;
  icon: React.ReactNode;
  items: TableInfo[];
  sectionKey: string;
  connectionId: string;
  cs: ReturnType<typeof useSchema.getState>["byConnection"][string];
  toggleNode: (connectionId: string, key: string) => void;
  loadColumns: (
    connectionId: string,
    schema: string | undefined,
    table: string,
  ) => Promise<void>;
  openTab: ReturnType<typeof useTabs.getState>["open"];
}

/** Expandable section listing a set of tables or views within a schema. */
function TableSection({
  label,
  icon,
  items,
  sectionKey,
  connectionId,
  cs,
  toggleNode,
  loadColumns,
  openTab,
}: SectionProps) {
  const isOpen = cs.expanded.has(sectionKey);

  return (
    <div>
      <button
        className="flex w-full items-center gap-1 py-0.5 pl-5 pr-2 hover:bg-accent/30"
        onClick={() => toggleNode(connectionId, sectionKey)}
      >
        {isOpen ? (
          <ChevronDown className="h-3 w-3 text-muted-foreground/60" />
        ) : (
          <ChevronRight className="h-3 w-3 text-muted-foreground/60" />
        )}
        {icon}
        <span className="text-[11px] text-muted-foreground">{label}</span>
        <span className="ml-auto text-[10px] text-muted-foreground/60">
          {items.length}
        </span>
      </button>

      {isOpen &&
        items.map((t) => {
          const k = tableKey(t.schema, t.name);
          const tableNodeKey = `table:${k}`;
          const tableOpen = cs.expanded.has(tableNodeKey);
          const cols = cs.columns[k];

          return (
            <div key={k}>
              <div className="flex items-center pl-8 pr-2 hover:bg-accent/30">
                <button
                  onClick={() => {
                    toggleNode(connectionId, tableNodeKey);
                    if (!cols) loadColumns(connectionId, t.schema, t.name);
                  }}
                  className="flex flex-1 items-center gap-1 py-0.5"
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
                  {/* Approximate row count from engine statistics */}
                  {t.row_count !== undefined && (
                    <span className="ml-auto shrink-0 pl-2 text-[10px] text-muted-foreground">
                      {formatCount(t.row_count)}
                    </span>
                  )}
                </button>
              </div>

              {tableOpen && (
                <div className="ml-10 border-l border-border/50 pl-2">
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
  );
}

/** Collapsible "indexes" section header within a schema node. */
function IndexesSectionHeader({
  sectionKey,
  connectionId,
  expanded,
  toggleNode,
}: {
  sectionKey: string;
  connectionId: string;
  expanded: Set<string>;
  toggleNode: (connectionId: string, key: string) => void;
}) {
  const isOpen = expanded.has(sectionKey);
  return (
    <button
      className="flex w-full items-center gap-1 py-0.5 pl-5 pr-2 hover:bg-accent/30"
      onClick={() => toggleNode(connectionId, sectionKey)}
    >
      {isOpen ? (
        <ChevronDown className="h-3 w-3 text-muted-foreground/60" />
      ) : (
        <ChevronRight className="h-3 w-3 text-muted-foreground/60" />
      )}
      <LayoutList className="h-3 w-3 text-muted-foreground/70" />
      <span className="text-[11px] text-muted-foreground">indexes</span>
    </button>
  );
}
