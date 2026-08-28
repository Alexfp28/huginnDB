/**
 * The "tables" / "views" section inside a schema node, and the two prop shapes
 * every level of the tree threads through it.
 *
 * `TableActions` is the bundle the explorers hand down (open a tab, refresh,
 * and the five destructive/renaming affordances) — it exists so the section and
 * the rows under it take one prop instead of eight, and so a new affordance is
 * added in one place rather than at every level it has to pass through.
 */

import { useTranslation } from "react-i18next";
import { ChevronDown, ChevronRight } from "lucide-react";

import { TableRow } from "@/components/schema/SchemaTableRow";
import { usePreferences } from "@/stores/preferences/preferences";
import { tableKey, useSchema } from "@/stores/session/schema";
import { useTabs } from "@/stores/session/tabs";
import type { Driver, TableInfo } from "@/types";

export interface TableActions {
  openTab: ReturnType<typeof useTabs.getState>["open"];
  refresh: () => void;
  onRename: (table: TableInfo) => void;
  onDrop: (table: TableInfo) => void;
  onEmpty: (table: TableInfo) => void;
  onRenameView: (view: TableInfo) => void;
  onDropView: (view: TableInfo) => void;
  driver: Driver | undefined;
}

interface SectionProps {
  label: string;
  icon: React.ReactNode;
  items: TableInfo[];
  sectionKey: string;
  connectionId: string;
  cs: ReturnType<typeof useSchema.getState>["byConnection"][string];
  toggleNode: (connectionId: string, key: string) => void;
  loadColumns: (
    connectionId: string,
    schema: string | undefined,
    table: string,
  ) => Promise<void>;
  actions: TableActions;
  /** Force every section to render open (used by the filter). */
  forceOpen?: boolean;
}

/** Expandable section listing a set of tables or views within a schema. */
export function TableSection({
  label,
  icon,
  items,
  sectionKey,
  connectionId,
  cs,
  toggleNode,
  loadColumns,
  actions,
  forceOpen,
}: SectionProps) {
  // Inner i18n hook — the table loop shadows `t`, so we use the function
  // directly via `i18n.t` here is overkill; instead alias it.
  const { t: translate } = useTranslation();
  const isOpen = forceOpen ? true : cs.expanded.has(sectionKey);
  const metric = usePreferences((s) => s.prefs.ui.schemaTableMetric);

  return (
    <div>
      <button
        className="flex w-full items-center gap-1 py-1 pl-5 pr-2 hover:bg-accent/30"
        onClick={() => toggleNode(connectionId, sectionKey)}
      >
        {isOpen ? (
          <ChevronDown className="h-3 w-3 text-muted-foreground/60" />
        ) : (
          <ChevronRight className="h-3 w-3 text-muted-foreground/60" />
        )}
        {icon}
        <span className="text-2xs font-medium uppercase tracking-wide text-muted-foreground">
          {label}
        </span>
        <span className="ml-auto text-3xs tabular-nums text-muted-foreground/60">
          {items.length}
        </span>
      </button>

      {isOpen && (
        <div
          // `content-visibility: auto` skips style recalc/layout/paint for
          // rows outside the tree's scroll viewport — with the filter active
          // there can be thousands of these across every open connection.
          // Safe here specifically because rows are fixed, known-height
          // (~24px: `py-1` plus the `2xs` line-height), so `items.length *
          // 24` is an exact estimate rather than a guess — not a
          // virtualizer, so `moveRowFocus`'s `querySelectorAll` over
          // `[data-tree-row]` still sees every row.
          style={{
            contentVisibility: "auto",
            containIntrinsicSize: `auto ${items.length * 24}px`,
          }}
        >
          {items.map((t) => (
            <TableRow
              key={tableKey(t.schema, t.name)}
              table={t}
              connectionId={connectionId}
              cs={cs}
              toggleNode={toggleNode}
              loadColumns={loadColumns}
              actions={actions}
              metric={metric}
              loadingLabel={translate("schema.loadingColumns")}
            />
          ))}
        </div>
      )}
    </div>
  );
}
