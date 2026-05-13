/**
 * Bottom status bar. Displays live connection status, query execution stats
 * for the active tab, database encoding, connected server version, and the
 * total number of queries in the history ring buffer.
 */

import { useConnections } from "@/stores/connections";
import { useTabs } from "@/stores/tabs";
import { useQueryHistory } from "@/stores/queryHistory";
import { cn } from "@/lib/utils";

/** Thin vertical divider between status bar sections. */
function Sep() {
  return <span className="text-muted-foreground/30">|</span>;
}

export function StatusBar() {
  // Stable Set — safe to subscribe directly (not derived).
  const active = useConnections((s) => s.active);
  // Stable array reference — only changes on profile add/remove.
  const profiles = useConnections((s) => s.profiles);
  // Stable Record — keys added/deleted on connect/disconnect only.
  const versions = useConnections((s) => s.versions);

  // .find() returns a stable reference to an existing tab object;
  // does not create a new object each call, so no infinite re-render.
  const activeTab = useTabs((s) => s.tabs.find((t) => t.id === s.activeId));

  // Scalar — no selector derivation issue.
  const historyCount = useQueryHistory((s) => s.entries.length);

  const activeNames = Array.from(active)
    .map((id) => profiles.find((p) => p.id === id)?.name)
    .filter(Boolean)
    .join(", ");

  const stats = activeTab?.lastQueryStats;
  const serverVersion = activeTab ? versions[activeTab.connectionId] : undefined;

  return (
    <div className="flex h-6 items-center justify-between border-t border-border bg-card/60 px-3 text-[11px] text-muted-foreground">
      {/* Left: connection status + query stats */}
      <div className="flex items-center gap-2">
        <span
          className={cn(
            "flex items-center gap-1",
            active.size > 0 && "text-emerald-400",
          )}
        >
          <span
            className={cn(
              "h-1.5 w-1.5 rounded-full",
              active.size > 0 ? "bg-emerald-400" : "bg-muted-foreground/40",
            )}
          />
          {active.size > 0 ? activeNames : "disconnected"}
        </span>

        {stats && (
          <>
            <Sep />
            <span>{stats.rows.toLocaleString()} rows</span>
            <Sep />
            <span>executed in {stats.elapsed_ms} ms</span>
          </>
        )}
      </div>

      {/* Right: encoding · server version · history count */}
      <div className="flex items-center gap-2">
        <span>utf-8</span>
        {serverVersion && (
          <>
            <span className="text-muted-foreground/30">·</span>
            <span>{serverVersion}</span>
          </>
        )}
        <span className="text-muted-foreground/30">·</span>
        <span>history: {historyCount}</span>
      </div>
    </div>
  );
}
