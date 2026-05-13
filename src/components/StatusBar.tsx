/**
 * Bottom status bar. Reports the names of currently-connected profiles,
 * the active tab's identifier, and the app version. Intentionally
 * minimal so it stays out of the way.
 */

import { useConnections } from "@/stores/connections";
import { useTabs } from "@/stores/tabs";

export function StatusBar() {
  const active = useConnections((s) => s.active);
  const profiles = useConnections((s) => s.profiles);
  const activeTab = useTabs((s) => s.tabs.find((t) => t.id === s.activeId));

  const activeNames = Array.from(active)
    .map((id) => profiles.find((p) => p.id === id)?.name)
    .filter(Boolean)
    .join(", ");

  return (
    <div className="flex h-6 items-center justify-between border-t border-border bg-card/60 px-3 text-[11px] text-muted-foreground">
      <div className="flex items-center gap-3">
        <span
          className={`flex items-center gap-1 ${
            active.size > 0 ? "text-emerald-400" : ""
          }`}
        >
          <span
            className={`h-1.5 w-1.5 rounded-full ${
              active.size > 0 ? "bg-emerald-400" : "bg-muted-foreground/40"
            }`}
          />
          {active.size > 0 ? `Connected: ${activeNames}` : "Disconnected"}
        </span>
        {activeTab && (
          <span>
            {activeTab.kind === "table"
              ? `${activeTab.schema ? activeTab.schema + "." : ""}${activeTab.table}`
              : activeTab.title}
          </span>
        )}
      </div>
      <div className="flex items-center gap-3">
        <span>Huginn 0.1.0</span>
      </div>
    </div>
  );
}
