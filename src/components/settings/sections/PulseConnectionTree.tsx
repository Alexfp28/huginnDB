/**
 * The connection picker inside Settings → Pulse, as a tree.
 *
 * Same shape as `McpConnectionTree` — provenance first, then the free-text
 * `group` folder inside it, via the same `buildRailSections` — so a
 * connection sits in the same place in both pickers and the two can never
 * disagree about labels or ordering. What differs is what a checkbox means:
 * MCP's is an ephemeral selection for building a CLI snippet, so it needs its
 * own `Set` and a separate "apply policy" control; here the checkbox *is*
 * the persisted setting; toggling it writes straight through
 * `setPulseEnabled`, the same "one field, not the whole profile" shape
 * `set_mcp_write_policy` uses. There is no read-only carve-out for a
 * shared-origin section either, on the same grounds `McpConnectionTree`
 * ignores it for the write policy: this is a local resource decision, not a
 * property of the connection the publisher gets a say in — `merge_into`
 * preserves it across a sync for exactly that reason.
 */

import { useState } from "react";
import { useTranslation } from "react-i18next";
import { ChevronDown, ChevronRight, Folder, FolderSync } from "lucide-react";

import { MICRO_HEADING } from "@/components/ui/styles";
import { cn } from "@/lib/utils";
import { Checkbox } from "@/components/ui/checkbox";
import { Switch } from "@/components/ui/switch";
import { isFromOrigin } from "@/lib/connection/origin";
import type { RailSection } from "@/lib/connection/railSections";
import { useConnectionGroupCollapse } from "@/lib/connection/useConnectionGroups";
import type { ConnectionProfile } from "@/types";

export function PulseConnectionTree({
  sections,
  onToggle,
  onToggleAll,
  sharedTooltip,
  searching,
}: {
  sections: RailSection[];
  onToggle: (profile: ConnectionProfile) => void;
  onToggleAll: (ids: string[], enabled: boolean) => void;
  sharedTooltip: (profile: ConnectionProfile) => string;
  /** An active search force-expands groups so a match is never hidden. */
  searching: boolean;
}) {
  const { t } = useTranslation();
  const groupCollapse = useConnectionGroupCollapse();
  const [foldedSections, setFoldedSections] = useState<Record<string, boolean>>(
    {},
  );

  function row(p: ConnectionProfile) {
    return (
      <div
        key={p.id}
        className="flex items-center gap-2 px-3 py-1.5 hover:bg-accent"
      >
        <label className="flex min-w-0 flex-1 cursor-pointer items-center gap-2">
          <span className="truncate text-xs">{p.name}</span>
          {isFromOrigin(p) && (
            <span
              className="flex shrink-0 items-center"
              title={sharedTooltip(p)}
            >
              <FolderSync className="h-3 w-3 text-muted-foreground" />
            </span>
          )}
        </label>
        <Switch
          checked={!!p.pulse_enabled}
          onCheckedChange={() => onToggle(p)}
        />
      </div>
    );
  }

  return (
    <>
      {sections.map((section, i) => {
        const key = section.originId ?? `section:${i}`;
        const collapsed = !!foldedSections[key];
        const all = [
          ...section.ungrouped,
          ...section.groups.flatMap((g) => g.items),
        ];
        const allEnabled = all.length > 0 && all.every((p) => p.pulse_enabled);
        return (
          <div key={key}>
            <div className="flex items-center gap-1.5 border-y border-border/60 bg-muted/30 px-3 py-1 first:border-t-0">
              <Checkbox
                size="xs"
                checked={allEnabled}
                onChange={() => onToggleAll(section.ids, !allEnabled)}
                onClick={(e) => e.stopPropagation()}
                aria-label={t("settings.pulse.enableAllInSection", {
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
                  const groupEnabled = items.every((p) => p.pulse_enabled);
                  return (
                    <div key={name}>
                      <div className="flex items-center gap-1.5 px-3 py-1">
                        <Checkbox
                          size="xs"
                          checked={groupEnabled}
                          onChange={() =>
                            onToggleAll(
                              items.map((p) => p.id),
                              !groupEnabled,
                            )
                          }
                          aria-label={t("settings.pulse.enableAllInSection", {
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
