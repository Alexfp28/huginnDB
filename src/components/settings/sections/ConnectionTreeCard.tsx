/**
 * The "which connections may X reach" card that MCP, Pulse and the AI panel
 * each carry: a scope switch, a name filter and a bulk toggle over a
 * foldable connection tree, all inside one titled card.
 *
 * The three sections had each written this out by hand — same `Segmented`
 * built from the same three counts, same `SearchField`, same outline button,
 * same `max-h-72` bordered scroller — and differed only in what one row of the
 * tree controls (a checkbox and a write policy; a switch; a switch and a
 * checkbox). So this owns the chrome and nothing else: filtering, the counts
 * and what the bulk button does stay with the section, and the tree comes in
 * as `children`. Three copies of a toolbar is how they had already started to
 * drift in spacing.
 */

import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { SearchField } from "@/components/ui/search-field";
import { Segmented } from "@/components/ui/segmented";
import type { ProfileScope } from "@/lib/connection/origin";
import { GroupCount, PrefGroup } from "./PrefGroup";

interface Props {
  title: string;
  description?: React.ReactNode;
  /** "3 of 9 exposed" — omitted while there are no connections at all. */
  count?: string;
  /** Every connection, before scope and filter. Zero shows `emptyText`. */
  total: number;
  /** How many of `total` came from a shared origin. The scope switch only
   *  appears when some did: with none, "Shared" would always be empty. */
  sharedCount: number;
  scope: ProfileScope;
  onScopeChange: (scope: ProfileScope) => void;
  filter: string;
  onFilterChange: (filter: string) => void;
  bulkLabel: string;
  onBulk: () => void;
  /** True when scope and filter leave nothing listed. */
  noMatches: boolean;
  emptyText: string;
  /** Below the tree, inside the card: bulk actions, hints. */
  footer?: React.ReactNode;
  children: React.ReactNode;
}

export function ConnectionTreeCard({
  title,
  description,
  count,
  total,
  sharedCount,
  scope,
  onScopeChange,
  filter,
  onFilterChange,
  bulkLabel,
  onBulk,
  noMatches,
  emptyText,
  footer,
  children,
}: Props) {
  const { t } = useTranslation();
  return (
    <PrefGroup
      title={title}
      description={description}
      action={total > 0 && count ? <GroupCount>{count}</GroupCount> : undefined}
    >
      {total === 0 ? (
        <p className="px-4 py-3 text-xs text-muted-foreground">{emptyText}</p>
      ) : (
        <>
          <div className="flex flex-wrap items-center gap-2 border-b border-border/60 px-3 py-2">
            {sharedCount > 0 && (
              <Segmented
                size="sm"
                value={scope}
                onValueChange={onScopeChange}
                aria-label={t("connections.scopeLabel")}
                options={[
                  { value: "all", label: `${t("settings.mcp.scopeAll")} ${total}` },
                  {
                    value: "local",
                    label: `${t("connections.scope.local")} ${total - sharedCount}`,
                  },
                  {
                    value: "shared",
                    label: `${t("connections.scope.shared")} ${sharedCount}`,
                  },
                ]}
              />
            )}
            <SearchField
              size="xs"
              value={filter}
              onValueChange={onFilterChange}
              placeholder={t("settings.mcp.filterPlaceholder")}
              onClear={() => onFilterChange("")}
              clearLabel={t("common.clear")}
              className="min-w-40 flex-1"
            />
            <Button
              type="button"
              variant="outline"
              size="xs"
              className="shrink-0"
              disabled={noMatches}
              onClick={onBulk}
            >
              {bulkLabel}
            </Button>
          </div>
          <div className="max-h-72 overflow-y-auto">
            {noMatches ? (
              <p className="px-4 py-3 text-xs text-muted-foreground">
                {t("settings.mcp.noMatches", { query: filter })}
              </p>
            ) : (
              children
            )}
          </div>
          {footer && (
            <div className="space-y-1.5 border-t border-border/60 px-4 py-3">{footer}</div>
          )}
        </>
      )}
    </PrefGroup>
  );
}
