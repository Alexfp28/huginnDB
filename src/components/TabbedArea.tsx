/**
 * Tab strip + active-tab body for the main workspace. Holds either a
 * `TableDataTab` or a `QueryEditorTab` depending on the active tab's
 * `kind`.
 */

import { Plus, X } from "lucide-react";
import { useTabs } from "@/stores/tabs";
import { Button } from "@/components/ui/button";
import { TableDataTab } from "@/components/TableDataTab";
import { QueryEditorTab } from "@/components/QueryEditorTab";
import { cn } from "@/lib/utils";

interface Props {
  connectionId: string | null;
}

export function TabbedArea({ connectionId }: Props) {
  const tabs = useTabs((s) => s.tabs);
  const activeId = useTabs((s) => s.activeId);
  const open = useTabs((s) => s.open);
  const close = useTabs((s) => s.close);
  const setActive = useTabs((s) => s.setActive);

  const activeTab = tabs.find((t) => t.id === activeId);

  function newQueryTab() {
    if (!connectionId) return;
    open({
      kind: "query",
      title: "query.sql",
      connectionId,
      query: "-- write a SQL query and press Ctrl+Enter\n",
    });
  }

  return (
    <div className="flex h-full flex-col">
      {/* Tab strip */}
      <div className="flex items-stretch border-b border-border bg-card/40">
        <div className="flex flex-1 items-stretch overflow-x-auto">
          {tabs.map((t) => {
            const isActive = t.id === activeId;
            return (
              <div
                key={t.id}
                className={cn(
                  "group relative flex h-8 cursor-pointer items-center gap-2 border-r border-border px-3 text-xs transition-colors",
                  isActive
                    ? "bg-background text-foreground after:absolute after:bottom-0 after:left-0 after:right-0 after:h-[2px] after:bg-primary"
                    : "text-muted-foreground/70 hover:bg-accent/20 hover:text-muted-foreground",
                )}
                onClick={() => setActive(t.id)}
              >
                <span className="truncate max-w-[180px]">{t.title}</span>
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
                  title="Close tab"
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
          title="New query (uses current connection)"
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
                ? "Open a table from the schema explorer, or create a new query tab."
                : "Select or create a connection to begin."}
            </div>
            {connectionId && (
              <Button variant="outline" size="sm" onClick={newQueryTab}>
                New query
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
