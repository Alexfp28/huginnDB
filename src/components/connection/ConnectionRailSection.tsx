/**
 * One provenance section of the manager's rail: an optional header, then the
 * `group` folders inside it.
 *
 * Split out of `ConnectionRail` alongside `ConnectionRailRow`: the rail now
 * renders two levels of collapsible header (provenance, then group) and the
 * nesting is easier to read as its own component than as two nested closures.
 *
 * The two headers use *different* collapse state on purpose. Group folds go
 * through `useConnectionGroupCollapse`, which honours the
 * `ui.connectionGroupExpandMode` preference and is shared with the schema tree,
 * the File menu and the workspace picker. Section folds are rail-local
 * `useState` in the parent: provenance is a new axis and does not belong to a
 * preference about connection *groups* — and the persisted key there is a bare
 * group name shared by four surfaces, so namespacing it would leave keys on disk
 * that nothing else understands.
 */

import { useTranslation } from "react-i18next";
import { ChevronDown, ChevronRight, Folder, FolderSync } from "lucide-react";

import { MICRO_HEADING } from "@/components/ui/styles";
import { Checkbox } from "@/components/ui/checkbox";
import { ConnectionRailRow } from "@/components/connection/ConnectionRailRow";
import type { GroupCollapse } from "@/lib/connection/useConnectionGroups";
import type { RailSection } from "@/lib/connection/railSections";
import { cn } from "@/lib/utils";
import type { ConnectionProfile } from "@/types";

export function ConnectionRailSection({
  section,
  collapsed,
  onToggleCollapsed,
  groupCollapse,
  searching,
  active,
  editingId,
  checked,
  showOriginBadge,
  originNameOf,
  onRowClick,
  onRowToggle,
  onOpen,
  onToggleAll,
}: {
  section: RailSection;
  /** Section-level fold. Ignored for a headerless section. */
  collapsed: boolean;
  onToggleCollapsed: () => void;
  groupCollapse: GroupCollapse;
  /** An active search force-expands groups so a match is never hidden. */
  searching: boolean;
  active: Set<string>;
  editingId: string | null;
  checked: Set<string>;
  showOriginBadge: boolean;
  originNameOf: (profile: ConnectionProfile) => string | null;
  onRowClick: (id: string, e: React.MouseEvent) => void;
  onRowToggle: (id: string) => void;
  onOpen: (id: string) => void;
  /** Header checkbox. Absent from a read-only section. */
  onToggleAll: (ids: string[]) => void;
}) {
  const { t } = useTranslation();
  const multi = checked.size > 1;

  function row(p: ConnectionProfile) {
    return (
      <ConnectionRailRow
        key={p.id}
        profile={p}
        active={active.has(p.id)}
        editing={editingId === p.id}
        checked={checked.has(p.id)}
        multi={multi}
        showOriginBadge={showOriginBadge}
        originName={originNameOf(p)}
        onClick={(e) => onRowClick(p.id, e)}
        onToggle={() => onRowToggle(p.id)}
        onOpen={() => onOpen(p.id)}
      />
    );
  }

  const allChecked =
    section.ids.length > 0 && section.ids.every((id) => checked.has(id));

  const body = (
    <>
      {section.ungrouped.map(row)}
      {section.groups.map(({ name, items }) => {
        const groupCollapsed = !searching && groupCollapse.isCollapsed(name);
        return (
          <div key={name}>
            <button
              type="button"
              onClick={() => groupCollapse.toggle(name)}
              className={cn(
                MICRO_HEADING,
                "flex w-full items-center gap-1 px-3 py-1 text-left text-muted-foreground hover:text-foreground",
              )}
            >
              {groupCollapsed ? (
                <ChevronRight className="h-3 w-3 shrink-0" />
              ) : (
                <ChevronDown className="h-3 w-3 shrink-0" />
              )}
              <Folder className="h-3 w-3 shrink-0" />
              <span className="truncate">{name}</span>
              <span className="text-muted-foreground/60">({items.length})</span>
            </button>
            {!groupCollapsed && items.map(row)}
          </div>
        );
      })}
    </>
  );

  if (section.label === null) return body;

  return (
    <div>
      <div
        className={cn(
          "flex items-center gap-1 px-3 py-1 text-[10px] font-semibold uppercase tracking-wider",
          "border-y border-border/60 bg-muted/30 text-muted-foreground",
        )}
      >
        {/* Only a section the user owns gets a select-all: an origin's rows are
            refused by the bulk delete, so the control would do nothing. */}
        {!section.readOnly && (
          <Checkbox
            size="xs"
            className="mr-1"
            checked={allChecked}
            onChange={() => onToggleAll(section.ids)}
            onClick={(e) => e.stopPropagation()}
            aria-label={t("connections.selectAllSection", {
              section: section.label,
            })}
          />
        )}
        <button
          type="button"
          onClick={onToggleCollapsed}
          className="flex min-w-0 flex-1 items-center gap-1 text-left hover:text-foreground"
        >
          {collapsed ? (
            <ChevronRight className="h-3 w-3 shrink-0" />
          ) : (
            <ChevronDown className="h-3 w-3 shrink-0" />
          )}
          <FolderSync className="h-3 w-3 shrink-0" />
          <span className="truncate normal-case">{section.label}</span>
          <span className="text-muted-foreground/60">
            ({section.ids.length})
          </span>
          {section.readOnly && (
            <span className="shrink-0 text-[9px] font-normal normal-case text-muted-foreground/60">
              · {t("connections.sharedReadOnly")}
            </span>
          )}
        </button>
      </div>
      {!collapsed && body}
    </div>
  );
}
