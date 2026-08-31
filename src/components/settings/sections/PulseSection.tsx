/**
 * Pulse settings: the sampler's own knobs, plus which connections it
 * watches.
 *
 * The picker is a tree grouped by provenance, mirroring `McpSection`'s —
 * same reasoning: a connection a shared origin publishes keeps the same id
 * on every machine, and grouping by where a profile came from is how the
 * connection rail itself reads, so this panel and that rail can't drift on
 * labels or ordering.
 *
 * Every field here composes with `ConnectionProfile.pulse_enabled`: a
 * connection with the sampler off costs nothing here no matter how the
 * intervals below are tuned, and none of these intervals do anything until
 * at least one connection opts in.
 */

import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Search, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Segmented } from "@/components/ui/segmented";
import { api } from "@/lib/tauri";
import { notify } from "@/lib/notify";
import {
  filterByScope,
  isFromOrigin,
  originIdOf,
  type ProfileScope,
} from "@/lib/connection/origin";
import { buildRailSections } from "@/lib/connection/railSections";
import { useOrigins } from "@/stores/sync/origins";
import { usePreferences, selectPulsePrefs } from "@/stores/preferences/preferences";
import type { ConnectionProfile } from "@/types";
import { PrefRow } from "./PrefRow";
import { PulseConnectionTree } from "./PulseConnectionTree";

export function PulseSection() {
  const { t } = useTranslation();
  const pulse = usePreferences(selectPulsePrefs);
  const updatePulse = usePreferences((s) => s.updatePulse);

  const [profiles, setProfiles] = useState<ConnectionProfile[]>([]);
  const [filter, setFilter] = useState("");
  const [scope, setScope] = useState<ProfileScope>("all");

  useEffect(() => {
    void api
      .listProfiles()
      .then(setProfiles)
      .catch(() => setProfiles([]));
  }, []);

  const shared = useMemo(() => profiles.filter(isFromOrigin), [profiles]);
  const hasShared = shared.length > 0;
  useEffect(() => {
    if (!hasShared && scope !== "all") setScope("all");
  }, [hasShared, scope]);

  const filteredProfiles = useMemo(() => {
    const q = filter.trim().toLowerCase();
    const inScope = filterByScope(profiles, scope);
    if (!q) return inScope;
    return inScope.filter((p) => p.name.toLowerCase().includes(q));
  }, [profiles, filter, scope]);

  const originsById = useOrigins((s) => s.byId);
  const sections = useMemo(() => {
    const nameOf = (id: string) => originsById[id]?.name ?? null;
    const labels = {
      shared: (origin: string) => t("connections.sharedSection", { origin }),
      orphaned: t("connections.orphanedSection"),
    };
    return [
      ...buildRailSections(filteredProfiles, "local", nameOf, labels).map(
        (section) => ({ ...section, label: t("settings.mcp.localSection") }),
      ),
      ...buildRailSections(filteredProfiles, "shared", nameOf, labels),
    ];
  }, [filteredProfiles, originsById, t]);

  const sharedTooltip = (p: ConnectionProfile) => {
    const name = originsById[originIdOf(p) ?? ""]?.name;
    return name
      ? t("connections.sharedBadgeTooltip", { origin: name })
      : t("connections.sharedBadgeTooltipUnknown");
  };

  /**
   * Persist one or more profiles' opt-in. Optimistic, resynced from disk on
   * failure — same shape as `McpSection.setWritePolicy`, and for the same
   * reason it goes through a dedicated command rather than `saveProfile`:
   * this writes the one field it means to, nothing else in the record.
   */
  async function setEnabled(ids: string[], enabled: boolean) {
    const wanted = new Set(ids);
    setProfiles((prev) =>
      prev.map((p) => (wanted.has(p.id) ? { ...p, pulse_enabled: enabled } : p)),
    );
    try {
      await api.setPulseEnabled(ids, enabled);
    } catch (e) {
      notify.error(String(e));
      void api.listProfiles().then(setProfiles).catch(() => {});
    }
  }

  /** Commit a numeric field, ignoring the intermediate garbage a
   *  partially-typed number produces. */
  const numeric =
    (apply: (n: number) => void, min: number, max: number) =>
    (raw: string) => {
      const n = Number.parseInt(raw, 10);
      if (Number.isFinite(n) && n >= min && n <= max) apply(n);
    };

  return (
    <div className="space-y-4 text-sm">
      <p className="text-[12px] text-muted-foreground">
        {t("settings.pulse.intro")}
      </p>

      <div className="space-y-1">
        <PrefRow
          label={t("settings.pulse.historyIntervalSecs.label")}
          prefId="pulse.historyIntervalSecs"
          description={t("settings.pulse.historyIntervalSecs.desc")}
          htmlFor="prefs-pulse-history-interval"
        >
          <Input
            id="prefs-pulse-history-interval"
            type="number"
            min={10}
            max={3600}
            step={10}
            value={pulse.historyIntervalSecs}
            onChange={(e) =>
              numeric(
                (n) => updatePulse({ historyIntervalSecs: n }),
                10,
                3600,
              )(e.target.value)
            }
            className="h-8 w-24 text-right font-mono text-xs"
          />
        </PrefRow>

        <PrefRow
          label={t("settings.pulse.retentionDays.label")}
          prefId="pulse.retentionDays"
          description={t("settings.pulse.retentionDays.desc")}
          htmlFor="prefs-pulse-retention"
        >
          <Input
            id="prefs-pulse-retention"
            type="number"
            min={1}
            max={365}
            value={pulse.retentionDays}
            onChange={(e) =>
              numeric((n) => updatePulse({ retentionDays: n }), 1, 365)(
                e.target.value,
              )
            }
            className="h-8 w-24 text-right font-mono text-xs"
          />
        </PrefRow>

        <PrefRow
          label={t("settings.pulse.maxDiskMb.label")}
          prefId="pulse.maxDiskMb"
          description={t("settings.pulse.maxDiskMb.desc")}
          htmlFor="prefs-pulse-max-disk"
        >
          <Input
            id="prefs-pulse-max-disk"
            type="number"
            min={0}
            max={10000}
            value={pulse.maxDiskMb}
            onChange={(e) =>
              numeric((n) => updatePulse({ maxDiskMb: n }), 0, 10000)(
                e.target.value,
              )
            }
            className="h-8 w-24 text-right font-mono text-xs"
          />
        </PrefRow>

        <PrefRow
          label={t("settings.pulse.sampleWhenMinimized.label")}
          prefId="pulse.sampleWhenMinimized"
          description={t("settings.pulse.sampleWhenMinimized.desc")}
        >
          <Switch
            checked={pulse.sampleWhenMinimized}
            onCheckedChange={(v) => updatePulse({ sampleWhenMinimized: v })}
          />
        </PrefRow>
      </div>

      <div>
        <div className="mb-1 flex items-center justify-between gap-2">
          <span className="text-[11px] uppercase tracking-wider text-muted-foreground">
            {t("settings.pulse.connectionsLabel")}
          </span>
          {profiles.length > 0 && (
            <span className="text-[11px] text-muted-foreground">
              {t("settings.pulse.enabledCount", {
                enabled: profiles.filter((p) => p.pulse_enabled).length,
                total: profiles.length,
              })}
            </span>
          )}
        </div>

        {profiles.length === 0 ? (
          <p className="text-[12px] text-muted-foreground">
            {t("settings.pulse.noConnections")}
          </p>
        ) : (
          <>
            {hasShared && (
              <Segmented
                size="sm"
                variant="underline"
                className="mb-1.5"
                value={scope}
                onValueChange={setScope}
                options={[
                  {
                    value: "all",
                    label: `${t("settings.mcp.scopeAll")} ${profiles.length}`,
                  },
                  {
                    value: "local",
                    label: `${t("connections.scope.local")} ${
                      profiles.length - shared.length
                    }`,
                  },
                  {
                    value: "shared",
                    label: `${t("connections.scope.shared")} ${shared.length}`,
                  },
                ]}
                aria-label={t("connections.scopeLabel")}
              />
            )}
            <div className="mb-1.5 flex items-center gap-1.5">
              <div className="relative flex-1">
                <Search className="pointer-events-none absolute left-2 top-1/2 h-3 w-3 -translate-y-1/2 text-muted-foreground" />
                <Input
                  inputSize="xs"
                  value={filter}
                  onChange={(e) => setFilter(e.target.value)}
                  placeholder={t("settings.mcp.filterPlaceholder")}
                  className="pl-6 pr-6"
                />
                {filter && (
                  <button
                    type="button"
                    onClick={() => setFilter("")}
                    aria-label={t("common.clear")}
                    className="absolute right-1.5 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                  >
                    <X className="h-3 w-3" />
                  </button>
                )}
              </div>
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="h-7 shrink-0 px-2 text-[11px]"
                disabled={filteredProfiles.length === 0}
                onClick={() =>
                  void setEnabled(
                    filteredProfiles.map((p) => p.id),
                    !filteredProfiles.every((p) => p.pulse_enabled),
                  )
                }
              >
                {filteredProfiles.every((p) => p.pulse_enabled)
                  ? t("settings.pulse.disableAll")
                  : t("settings.pulse.enableAll")}
              </Button>
            </div>

            <div className="max-h-72 overflow-y-auto rounded-md border border-border">
              {filteredProfiles.length === 0 ? (
                <p className="px-3 py-2 text-[12px] text-muted-foreground">
                  {t("settings.mcp.noMatches", { query: filter })}
                </p>
              ) : (
                <PulseConnectionTree
                  sections={sections}
                  onToggle={(p) => void setEnabled([p.id], !p.pulse_enabled)}
                  onToggleAll={(ids, enabled) => void setEnabled(ids, enabled)}
                  sharedTooltip={sharedTooltip}
                  searching={filter.trim().length > 0}
                />
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
