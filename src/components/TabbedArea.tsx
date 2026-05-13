import { Plus, X } from "lucide-react";
import { useTabs } from "@/stores/tabs";
import { Button } from "@/components/ui/button";
import { TableDataTab } from "@/components/TableDataTab";
import { QueryEditorTab } from "@/components/QueryEditorTab";

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
      title: "Query",
      connectionId,
      query: "-- write a SQL query and press Ctrl+Enter\n",
    });
  }

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-0.5 border-b border-border bg-card/40 px-1">
        <div className="flex flex-1 items-center overflow-x-auto">
          {tabs.map((t) => {
            const isActive = t.id === activeId;
            return (
              <div
                key={t.id}
                className={`group flex h-8 items-center gap-2 border-r border-border px-3 text-xs ${
                  isActive
                    ? "bg-background text-foreground"
                    : "text-muted-foreground hover:bg-accent/30"
                }`}
              >
                <button onClick={() => setActive(t.id)} className="truncate max-w-[180px]">
                  <span className="opacity-60">
                    {t.kind === "query" ? "» " : ""}
                  </span>
                  {t.title}
                </button>
                <button
                  className="opacity-50 hover:opacity-100"
                  onClick={() => close(t.id)}
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
          onClick={newQueryTab}
          disabled={!connectionId}
          title="New query (uses current connection)"
        >
          <Plus className="h-4 w-4" />
        </Button>
      </div>
      <div className="flex-1 overflow-hidden">
        {!activeTab && (
          <div className="flex h-full flex-col items-center justify-center gap-2 text-sm text-muted-foreground">
            <div className="text-lg font-semibold text-foreground">Huginn</div>
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
        {activeTab && activeTab.kind === "table" && (
          <TableDataTab
            connectionId={activeTab.connectionId}
            schema={activeTab.schema}
            table={activeTab.table!}
          />
        )}
        {activeTab && activeTab.kind === "query" && (
          <QueryEditorTab
            tabId={activeTab.id}
            connectionId={activeTab.connectionId}
          />
        )}
      </div>
    </div>
  );
}
