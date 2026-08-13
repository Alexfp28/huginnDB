/**
 * Connection-pool preferences, plus a live view of what HuginnDB is currently
 * holding.
 *
 * The live counters are the point of the section as much as the knobs are.
 * "Too many connections" is only an actionable error if the user can see their
 * own contribution to it — and HuginnDB's contribution used to be both
 * unbounded and completely invisible, which is how a database shared with a
 * JetBrains data source, an application backend and a couple of `huginndb-mcp`
 * sidecars ended up over its limit with no way to tell who was responsible.
 *
 * Reads/writes live against `usePreferences`; the counters poll
 * `connection_pool_stats` while the dialog is open.
 */

import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import {
  usePreferences,
  selectConnectionPrefs,
} from "@/stores/preferences/preferences";
import { api } from "@/lib/tauri";
import type { PoolStats } from "@/types";
import { PrefRow } from "./PrefRow";

/** How often the live counters refresh while the dialog is open. */
const STATS_POLL_MS = 3000;

export function ConnectionsSection() {
  const connections = usePreferences(selectConnectionPrefs);
  const updateConnections = usePreferences((s) => s.updateConnections);
  const { t } = useTranslation();

  const [stats, setStats] = useState<PoolStats | null>(null);
  const [releasing, setReleasing] = useState(false);

  const refreshStats = useCallback(() => {
    api
      .connectionPoolStats()
      .then(setStats)
      // Non-fatal: the counters are informational, and a failure here must not
      // take the rest of the preferences dialog down with it.
      .catch(() => setStats(null));
  }, []);

  useEffect(() => {
    refreshStats();
    const id = setInterval(refreshStats, STATS_POLL_MS);
    return () => clearInterval(id);
  }, [refreshStats]);

  async function release() {
    setReleasing(true);
    try {
      const closed = await api.releaseIdlePools();
      toast.success(t("schema.releasedIdlePools", { count: closed }));
      refreshStats();
    } catch (e) {
      toast.error(String(e));
    } finally {
      setReleasing(false);
    }
  }

  /** Commit a numeric field, ignoring the intermediate garbage a
   *  partially-typed number produces. `min` of 0 is meaningful for the fields
   *  where 0 is the documented "disabled" value. */
  const numeric =
    (apply: (n: number) => void, min: number, max: number) =>
    (raw: string) => {
      const n = Number.parseInt(raw, 10);
      if (Number.isFinite(n) && n >= min && n <= max) apply(n);
    };

  return (
    <div className="space-y-1">
      <PrefRow
        label={t("settings.connections.live.label")}
        description={t("settings.connections.live.desc")}
      >
        <div className="flex flex-col items-end gap-2">
          <div className="flex items-center gap-3">
            <span className="font-mono text-xs tabular-nums text-muted-foreground">
              {stats
                ? t("settings.connections.live.value", {
                    connections: stats.connections,
                    views: stats.databaseViews,
                  })
                : "—"}
            </span>
            <Button
              variant="outline"
              size="sm"
              className="h-8 text-xs"
              disabled={releasing || !stats || stats.databaseViews === 0}
              onClick={() => void release()}
            >
              {t("schema.releaseIdlePools")}
            </Button>
          </div>
          {/* Per-server rows. The two counts above are per *pool*, and one
              server can back several of them — this is the breakdown that
              matches what the server's own `max_connections` is counting. */}
          {stats && stats.endpoints.length > 0 && (
            <ul className="space-y-0.5 text-right">
              {stats.endpoints.map((e) => (
                <li
                  key={e.label}
                  className="font-mono text-[11px] tabular-nums text-muted-foreground"
                >
                  {e.label}
                  {" · "}
                  {t("settings.connections.live.endpoint", {
                    inUse: e.inUse,
                    budget: connections.maxConnections,
                  })}
                </li>
              ))}
            </ul>
          )}
        </div>
      </PrefRow>

      <PrefRow
        label={t("settings.connections.maxConnections.label")}
        prefId="connections.maxConnections"
        description={t("settings.connections.maxConnections.desc")}
        htmlFor="prefs-conn-max"
      >
        <Input
          id="prefs-conn-max"
          type="number"
          min={2}
          max={64}
          value={connections.maxConnections}
          onChange={(e) =>
            numeric((n) => updateConnections({ maxConnections: n }), 2, 64)(
              e.target.value,
            )
          }
          className="h-8 w-24 text-right font-mono text-xs"
        />
      </PrefRow>

      <PrefRow
        label={t("settings.connections.childMaxConnections.label")}
        prefId="connections.childMaxConnections"
        description={t("settings.connections.childMaxConnections.desc")}
        htmlFor="prefs-conn-child-max"
      >
        <Input
          id="prefs-conn-child-max"
          type="number"
          min={2}
          max={64}
          value={connections.childMaxConnections}
          onChange={(e) =>
            numeric(
              (n) => updateConnections({ childMaxConnections: n }),
              2,
              64,
            )(e.target.value)
          }
          className="h-8 w-24 text-right font-mono text-xs"
        />
      </PrefRow>

      <PrefRow
        label={t("settings.connections.maxChildPools.label")}
        prefId="connections.maxChildPools"
        description={t("settings.connections.maxChildPools.desc")}
        htmlFor="prefs-conn-max-children"
      >
        <Input
          id="prefs-conn-max-children"
          type="number"
          min={0}
          max={100}
          value={connections.maxChildPools}
          onChange={(e) =>
            numeric((n) => updateConnections({ maxChildPools: n }), 0, 100)(
              e.target.value,
            )
          }
          className="h-8 w-24 text-right font-mono text-xs"
        />
      </PrefRow>

      <PrefRow
        label={t("settings.connections.childIdleTtl.label")}
        prefId="connections.childIdleTtlSecs"
        description={t("settings.connections.childIdleTtl.desc")}
        htmlFor="prefs-conn-child-ttl"
      >
        <Input
          id="prefs-conn-child-ttl"
          type="number"
          min={0}
          max={86400}
          step={30}
          value={connections.childIdleTtlSecs}
          onChange={(e) =>
            numeric(
              (n) => updateConnections({ childIdleTtlSecs: n }),
              0,
              86400,
            )(e.target.value)
          }
          className="h-8 w-24 text-right font-mono text-xs"
        />
      </PrefRow>

      <PrefRow
        label={t("settings.connections.keepalive.label")}
        prefId="connections.keepaliveSecs"
        description={t("settings.connections.keepalive.desc")}
        htmlFor="prefs-conn-keepalive"
      >
        <Input
          id="prefs-conn-keepalive"
          type="number"
          min={0}
          max={3600}
          step={30}
          value={connections.keepaliveSecs}
          onChange={(e) =>
            numeric((n) => updateConnections({ keepaliveSecs: n }), 0, 3600)(
              e.target.value,
            )
          }
          className="h-8 w-24 text-right font-mono text-xs"
        />
      </PrefRow>

      <PrefRow
        label={t("settings.connections.mcpBridge.label")}
        prefId="connections.mcpBridge"
        description={t("settings.connections.mcpBridge.desc")}
      >
        <div className="flex items-center gap-3">
          {/* The bound port, not just the toggle: a user chasing a firewall
              prompt or an MCP client that won't attach needs the actual state,
              which can differ from the checkbox if the listener failed to
              start. */}
          {stats?.mcpBridgePort != null && (
            <span className="font-mono text-[11px] tabular-nums text-muted-foreground">
              127.0.0.1:{stats.mcpBridgePort}
            </span>
          )}
          <Switch
            checked={connections.mcpBridge}
            onCheckedChange={(v) => updateConnections({ mcpBridge: v })}
          />
        </div>
      </PrefRow>

      <p className="pt-3 text-[11px] leading-relaxed text-muted-foreground">
        {t("settings.connections.footnote")}
      </p>
    </div>
  );
}
