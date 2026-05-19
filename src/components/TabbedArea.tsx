/**
 * Tab strip + active-tab body for the main workspace. Holds either a
 * `TableDataTab` or a `QueryEditorTab` depending on the active tab's
 * `kind`.
 */

import { useMemo, useState } from "react";
import { Plus, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useTabs } from "@/stores/tabs";
import { useConnections } from "@/stores/connections";
import { Button } from "@/components/ui/button";
import { TableDataTab } from "@/components/TableDataTab";
import { QueryEditorTab } from "@/components/QueryEditorTab";
import { cn } from "@/lib/utils";

interface Props {
  connectionId: string | null;
}

export function TabbedArea({ connectionId }: Props) {
  const { t: tt } = useTranslation();
  const tabs = useTabs((s) => s.tabs);
  const activeId = useTabs((s) => s.activeId);
  const open = useTabs((s) => s.open);
  const close = useTabs((s) => s.close);
  const setActive = useTabs((s) => s.setActive);
  const reorder = useTabs((s) => s.reorder);
  const profiles = useConnections((s) => s.profiles);
  const [dragOverIndex, setDragOverIndex] = useState<number | null>(null);

  const activeTab = tabs.find((t) => t.id === activeId);

  // Resolve the display label for each tab. We prefix the connection name
  // when there are tabs from 2+ different connections, so the user can tell
  // apart tabs that share a table name across e.g. cliente1 vs cliente2.
  // The tooltip always carries the full path (connection / schema / table).
  //
  // Synthetic connection ids (multi-DB browsing — see `open_database_view`)
  // have the form `<parentId>::db::<db>`. They aren't in `profiles`, so we
  // resolve them by parsing the suffix and looking up the parent name.
  const tabMeta = useMemo(() => {
    const profileById = new Map(profiles.map((p) => [p.id, p.name]));
    const resolveConn = (cid: string): string => {
      const direct = profileById.get(cid);
      if (direct) return direct;
      const sep = cid.indexOf("::db::");
      if (sep > 0) {
        const parent = profileById.get(cid.slice(0, sep));
        const db = cid.slice(sep + "::db::".length);
        if (parent) return `${parent} · ${db}`;
      }
      return cid;
    };
    const uniqueConns = new Set(tabs.map((t) => t.connectionId));
    const showConn = uniqueConns.size > 1;
    return tabs.map((t) => {
      const connName = resolveConn(t.connectionId);
      const label = showConn ? `${connName} · ${t.title}` : t.title;
      const path =
        t.kind === "table"
          ? `${connName} / ${t.schema ?? ""}${t.schema ? "." : ""}${t.table ?? ""}`
          : `${connName} / ${t.title}`;
      return { id: t.id, label, tooltip: path };
    });
  }, [tabs, profiles]);

  function newQueryTab() {
    if (!connectionId) return;
    open({
      kind: "query",
      title: tt("tabs.queryFileName"),
      connectionId,
      query: "-- write a SQL query and press Ctrl+Enter\n",
    });
  }

  return (
    <div className="flex h-full flex-col">
      {/* Tab strip */}
      <div className="flex items-stretch border-b border-border bg-card/40">
        <div className="flex flex-1 items-stretch overflow-x-auto">
          {tabs.map((t, i) => {
            const isActive = t.id === activeId;
            const meta = tabMeta[i];
            return (
              <div
                key={t.id}
                draggable
                onDragStart={(e) => {
                  e.dataTransfer.setData("text/plain", t.id);
                  e.dataTransfer.effectAllowed = "move";
                }}
                onDragOver={(e) => {
                  e.preventDefault();
                  e.dataTransfer.dropEffect = "move";
                  if (dragOverIndex !== i) setDragOverIndex(i);
                }}
                onDragLeave={() => {
                  if (dragOverIndex === i) setDragOverIndex(null);
                }}
                onDrop={(e) => {
                  e.preventDefault();
                  const draggedId = e.dataTransfer.getData("text/plain");
                  setDragOverIndex(null);
                  if (!draggedId || draggedId === t.id) return;
                  reorder(draggedId, i);
                }}
                onDragEnd={() => setDragOverIndex(null)}
                className={cn(
                  "group relative flex h-8 cursor-pointer items-center gap-2 border-r border-border px-3 text-xs transition-colors",
                  isActive
                    ? "bg-background text-foreground after:absolute after:bottom-0 after:left-0 after:right-0 after:h-[2px] after:bg-primary"
                    : "text-muted-foreground/70 hover:bg-accent/20 hover:text-muted-foreground",
                  dragOverIndex === i && "before:absolute before:bottom-0 before:left-0 before:top-0 before:w-[2px] before:bg-primary",
                )}
                onClick={() => setActive(t.id)}
                title={meta.tooltip}
              >
                <span className="truncate max-w-[220px]">{meta.label}</span>
                <button
                  className={cn(
                    "transition-opacity",
                    isActive
                      ? "opacity-60 hover:opacity-100"
                      : "opacity-0 group-hover:opacity-60 group-hover:hover:opacity-100",
                  )}
                  onClick={(e) => {
                    e.stopPropagation();
                    close(t.id);
                  }}
                  title={tt("tabs.closeTab")}
                >
                  <X className="h-3 w-3" />
                </button>
              </div>
            );
          })}
        </div>
        <Button
          variant="ghost"
          size="icon"
          className="h-8 w-8 shrink-0 rounded-none border-l border-border text-muted-foreground/60 hover:text-muted-foreground"
          onClick={newQueryTab}
          disabled={!connectionId}
          title={tt("tabs.newQueryTooltip")}
        >
          <Plus className="h-3.5 w-3.5" />
        </Button>
      </div>

      {/* Active tab body */}
      <div className="flex-1 overflow-hidden">
        {!activeTab && (
          <div className="flex h-full flex-col items-center justify-center gap-2 text-sm text-muted-foreground">
            <div className="font-mono text-lg font-semibold text-foreground">
              huginndb
            </div>
            <div>
              {connectionId
                ? tt("tabs.emptyOpenSomething")
                : tt("tabs.emptyConnectFirst")}
            </div>
            {connectionId && (
              <Button variant="outline" size="sm" onClick={newQueryTab}>
                {tt("tabs.newQuery")}
              </Button>
            )}
          </div>
        )}
        {/*
         * `key={activeTab.id}` forces React to mount a fresh component
         * instance per tab. Without it, switching between two table tabs
         * reuses the same `TableDataTab` and its `useState` hooks
         * (filter input, server filters, draft row) leak across tabs.
         */}
        {activeTab && activeTab.kind === "table" && (
          <TableDataTab
            key={activeTab.id}
            connectionId={activeTab.connectionId}
            schema={activeTab.schema}
            table={activeTab.table!}
          />
        )}
        {activeTab && activeTab.kind === "query" && (
          <QueryEditorTab
            key={activeTab.id}
            tabId={activeTab.id}
            connectionId={activeTab.connectionId}
          />
        )}
      </div>
    </div>
  );
}
