/**
 * The connection picker inside Settings → AI, as a tree.
 *
 * Same shape as `PulseConnectionTree` and `McpConnectionTree` — provenance
 * first, then the free-text `group` folder inside it, via the same
 * `buildRailSections` — so a connection sits in the same place in all three and
 * they cannot drift on labels or ordering. And no read-only carve-out for a
 * shared-origin section, on the same grounds: both flags here are *local*
 * decisions about what leaves this machine, which `merge_into` preserves across
 * a sync precisely because a publisher two machines away does not get a say.
 *
 * What differs from the Pulse picker is that there are **two** switches per row,
 * and they are not the same kind of decision:
 *
 * - **Reach** (`ai_enabled`) is whether the assistant can see the connection at
 *   all. Off means unreachable — the backend resolves a model's connection
 *   reference only among enabled profiles, so it cannot be named by id either.
 * - **Rows** (`ai_rows_allowed`) is whether row data may be sent to an endpoint
 *   the user has *not* declared as their own. It is deliberately shown as
 *   checked-and-disabled while the endpoint is trusted, because that is the
 *   truth: a trusted endpoint reads rows regardless (see `DataScope::resolve`),
 *   and a checkbox that appeared to withhold them would be a lie about the one
 *   thing this panel exists to be honest about.
 */

import { useState } from "react";
import { useTranslation } from "react-i18next";
import { ChevronDown, ChevronRight, Folder, FolderSync } from "lucide-react";

import { MICRO_HEADING } from "@/components/ui/styles";
import { cn } from "@/lib/utils";
import { Checkbox } from "@/components/ui/checkbox";
import { Switch } from "@/components/ui/switch";
import { SimpleTooltip } from "@/components/ui/tooltip";
import { isFromOrigin } from "@/lib/connection/origin";
import type { RailSection } from "@/lib/connection/railSections";
import { useConnectionGroupCollapse } from "@/lib/connection/useConnectionGroups";
import type { AiEndpointTrust, ConnectionProfile } from "@/types";

export function AiConnectionTree({
  sections,
  trust,
  onToggleEnabled,
  onToggleEnabledAll,
  onToggleRows,
  sharedTooltip,
  searching,
}: {
  sections: RailSection[];
  /** Drives whether the rows column is a live choice or a statement of fact. */
  trust: AiEndpointTrust;
  onToggleEnabled: (profile: ConnectionProfile) => void;
  onToggleEnabledAll: (ids: string[], enabled: boolean) => void;
  onToggleRows: (profile: ConnectionProfile) => void;
  sharedTooltip: (profile: ConnectionProfile) => string;
  /** An active search force-expands groups so a match is never hidden. */
  searching: boolean;
}) {
  const { t } = useTranslation();
  const groupCollapse = useConnectionGroupCollapse();
  const [foldedSections, setFoldedSections] = useState<Record<string, boolean>>(
    {},
  );
  const trusted = trust === "trusted";

  function row(p: ConnectionProfile) {
    const enabled = !!p.ai_enabled;
    return (
      <div
        key={p.id}
        className="flex items-center gap-2 px-3 py-1.5 hover:bg-accent"
      >
        <label className="flex min-w-0 flex-1 cursor-pointer items-center gap-2">
          <span className="truncate text-xs">{p.name}</span>
          {isFromOrigin(p) && (
            <SimpleTooltip label={sharedTooltip(p)}>
              <span className="flex shrink-0 items-center">
                <FolderSync className="h-3 w-3 text-muted-foreground" />
              </span>
            </SimpleTooltip>
          )}
        </label>
        <SimpleTooltip
          label={
            trusted
              ? t("settings.ai.rowsTrustedTooltip")
              : t("settings.ai.rowsTooltip")
          }
        >
          <span className="flex w-14 shrink-0 items-center justify-center">
            <Checkbox
              size="xs"
              checked={trusted || !!p.ai_rows_allowed}
              disabled={trusted || !enabled}
              onChange={() => onToggleRows(p)}
              aria-label={t("settings.ai.rowsFor", { name: p.name })}
            />
          </span>
        </SimpleTooltip>
        <Switch
          checked={enabled}
          onCheckedChange={() => onToggleEnabled(p)}
          aria-label={t("settings.ai.reachFor", { name: p.name })}
        />
      </div>
    );
  }

  return (
    <>
      <div className="flex items-center gap-2 border-b border-border/60 px-3 py-1">
        <span className="min-w-0 flex-1" />
        <span
          className={cn(
            MICRO_HEADING,
            "flex w-14 shrink-0 justify-center text-muted-foreground",
          )}
        >
          {t("settings.ai.rowsColumn")}
        </span>
        <span
          className={cn(MICRO_HEADING, "w-8 shrink-0 text-muted-foreground")}
        >
          {t("settings.ai.reachColumn")}
        </span>
      </div>
      {sections.map((section, i) => {
        const key = section.originId ?? `section:${i}`;
        const collapsed = !!foldedSections[key];
        const all = [
          ...section.ungrouped,
          ...section.groups.flatMap((g) => g.items),
        ];
        const allEnabled = all.length > 0 && all.every((p) => p.ai_enabled);
        return (
          <div key={key}>
            <div className="flex items-center gap-1.5 border-y border-border/60 bg-muted/30 px-3 py-1 first:border-t-0">
              <Checkbox
                size="xs"
                checked={allEnabled}
                onChange={() => onToggleEnabledAll(section.ids, !allEnabled)}
                onClick={(e) => e.stopPropagation()}
                aria-label={t("settings.ai.enableAllInSection", {
                  section: section.label,
                })}
              />
              <button
                type="button"
                onClick={() =>
                  setFoldedSections((prev) => ({ ...prev, [key]: !prev[key] }))
                }
                className="flex min-w-0 flex-1 items-center gap-1 text-left text-2xs text-muted-foreground hover:text-foreground"
              >
                {collapsed ? (
                  <ChevronRight className="h-3 w-3 shrink-0" />
                ) : (
                  <ChevronDown className="h-3 w-3 shrink-0" />
                )}
                <span className="truncate">{section.label}</span>
                <span className="text-muted-foreground/60">
                  ({section.ids.length})
                </span>
              </button>
            </div>
            {!collapsed && (
              <>
                {section.ungrouped.map(row)}
                {section.groups.map(({ name, items }) => {
                  const groupCollapsed =
                    !searching && groupCollapse.isCollapsed(name);
                  const groupEnabled = items.every((p) => p.ai_enabled);
                  return (
                    <div key={name}>
                      <div className="flex items-center gap-1.5 px-3 py-1">
                        <Checkbox
                          size="xs"
                          checked={groupEnabled}
                          onChange={() =>
                            onToggleEnabledAll(
                              items.map((p) => p.id),
                              !groupEnabled,
                            )
                          }
                          aria-label={t("settings.ai.enableAllInSection", {
                            section: name,
                          })}
                        />
                        <button
                          type="button"
                          onClick={() => groupCollapse.toggle(name)}
                          className={cn(
                            MICRO_HEADING,
                            "flex min-w-0 flex-1 items-center gap-1 text-left text-muted-foreground hover:text-foreground",
                          )}
                        >
                          {groupCollapsed ? (
                            <ChevronRight className="h-3 w-3 shrink-0" />
                          ) : (
                            <ChevronDown className="h-3 w-3 shrink-0" />
                          )}
                          <Folder className="h-3 w-3 shrink-0" />
                          <span className="truncate">{name}</span>
                          <span className="text-muted-foreground/60">
                            ({items.length})
                          </span>
                        </button>
                      </div>
                      {!groupCollapsed && items.map(row)}
                    </div>
                  );
                })}
              </>
            )}
          </div>
        );
      })}
    </>
  );
}
