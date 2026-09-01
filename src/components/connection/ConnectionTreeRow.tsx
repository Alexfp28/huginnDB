/**
 * One connection row of `ConnectionsTree`, plus the subtree it expands into.
 *
 * Extracted out of `ConnectionsTree.renderConnection`, which returned this
 * exact JSX from a plain function CALLED per row (`renderConnection(p)`),
 * not rendered as `<renderConnection />` — so there was never a component
 * boundary here at all. Every row's JSX was reconciled as part of
 * `ConnectionsTree`'s own render pass, which means React could never bail
 * out of diffing it, no matter how little a given row actually changed. As
 * an actual `memo()`-wrapped component, a row now CAN skip re-rendering
 * when its own props are unchanged — see CLAUDE.md gotcha #28.
 *
 * The prop signature is wide (a whole `ConnectionMatchSummary`, a callback
 * bundle) rather than narrowed to primitives the way `SchemaTableRow` is —
 * deliberately: a connections list is dozens of rows, not the hundreds a
 * table list can be, so the payoff of chasing primitive props here is much
 * smaller than the `SchemaTableRow` fix earns. `actions` is grouped into one
 * bundle (the `TableActions` precedent) so a new affordance is one prop to
 * add, not eight.
 *
 * `actions` is a REF, not a plain object — the same `interactiveRef` /
 * `rowCallbacksRef` pattern `DataGrid`/`GridRow` already use, and
 * `DocumentListView`'s `callbacksRef`/`actionsRef` from the list-view memo
 * fix. `handleRowClick`/`handleDisconnect`/`handleReconnect` close over
 * several other per-render closures in `ConnectionsTree` (`filterFolds`,
 * `setCollapsed`, `matchCounts`, …) that are not themselves memoized, so a
 * `useCallback` for any of them would either go stale (an incomplete
 * dependency array silently calling last render's `matchCounts`) or gain no
 * stability at all (an exhaustive one, since most of those deps change
 * often) — a ref sidesteps the question entirely: it's rebuilt fresh every
 * `ConnectionsTree` render like the handlers themselves, but the REF OBJECT
 * `ConnectionTreeRow` receives never changes identity, so its `memo()` never
 * sees it as a changed prop.
 */

import { memo, type MutableRefObject } from "react";
import { useTranslation } from "react-i18next";
import {
  ChevronDown,
  ChevronRight,
  ListFilter,
  Plug,
  PlugZap,
  RotateCw,
} from "lucide-react";
import { Spinner } from "@/components/ui/spinner";
import { DriverBadge } from "@/components/common/DriverBadge";
import { VanishedOriginMark } from "@/components/common/VanishedOriginNotice";
import { ConnectionActionsMenu } from "@/components/connection/ConnectionActionsMenu";
import { SchemaExplorer } from "@/components/schema/SchemaExplorer";
import { cn } from "@/lib/utils";
import type {
  ConnectionMatchSummary,
  RowMatchState,
} from "@/lib/schema/treeMatches";
import type { ConnectionProfile } from "@/types";

export interface ConnectionRowActions {
  onRowClick: (p: ConnectionProfile) => void;
  onDisconnect: (p: ConnectionProfile) => void;
  onReconnect: (p: ConnectionProfile) => void;
  onNarrowToConnection: (connectionId: string) => void;
  moveRowFocus: (from: HTMLElement | null, delta: 1 | -1) => boolean;
}

interface ConnectionTreeRowProps {
  profile: ConnectionProfile;
  isActive: boolean;
  isBusy: boolean;
  isExpanded: boolean;
  isDisconnecting: boolean;
  isSelected: boolean;
  isScopeTarget: boolean;
  filtering: boolean;
  lostMessage: string | undefined;
  summary: ConnectionMatchSummary | undefined;
  matchState: RowMatchState | null;
  patterns: string[];
  actionsRef: MutableRefObject<ConnectionRowActions>;
}

export const ConnectionTreeRow = memo(function ConnectionTreeRow({
  profile: p,
  isActive,
  isBusy,
  isExpanded: expanded,
  isDisconnecting,
  isSelected,
  isScopeTarget,
  filtering,
  lostMessage,
  summary,
  matchState,
  patterns,
  actionsRef,
}: ConnectionTreeRowProps) {
  const { t } = useTranslation();
  const isLost = !!lostMessage;
  // Dimmed, never hidden: a connection row is what the user needs in order to
  // connect it or to narrow the search to it, so the filter may quieten it
  // but must not take it away.
  const dimmedByFilter =
    filtering &&
    isActive &&
    (matchState === "none" || matchState === "out-of-scope");

  return (
    <div>
      <ConnectionActionsMenu
        connectionId={p.id}
        onConnect={() => actionsRef.current.onRowClick(p)}
        onDisconnect={() => actionsRef.current.onDisconnect(p)}
      >
        <div
          role="button"
          tabIndex={0}
          data-tree-row
          onClick={() => actionsRef.current.onRowClick(p)}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === " ") {
              e.preventDefault();
              actionsRef.current.onRowClick(p);
              return;
            }
            if (e.key === "ArrowDown" || e.key === "ArrowUp") {
              if (
                actionsRef.current.moveRowFocus(
                  e.currentTarget,
                  e.key === "ArrowDown" ? 1 : -1,
                )
              ) {
                e.preventDefault();
              }
            }
          }}
          title={
            isLost ? t("connections.lost", { message: lostMessage }) : p.name
          }
          className={cn(
            "group flex cursor-pointer items-center gap-2 rounded-md py-1.5 pl-2 pr-2 text-sm outline-none transition-colors duration-150 hover:bg-accent focus-visible:ring-2 focus-visible:ring-brand/40",
            isLost && "bg-destructive/10",
            dimmedByFilter && "opacity-55 hover:opacity-100",
            // Selected connection: the same brand rail the active table row
            // carries in `SchemaExplorer`, so "this is the one you're in"
            // reads identically at both levels of the tree, plus a hairline
            // blue edge as the card's quiet version of an active border.
            !isLost &&
              isSelected &&
              "bg-brand/10 ring-1 ring-inset ring-brand/25 shadow-[inset_2px_0_0_var(--brand)]",
          )}
        >
          {isBusy ? (
            <Spinner size="sm" className="shrink-0 text-muted-foreground" />
          ) : expanded ? (
            <ChevronDown className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
          ) : (
            <ChevronRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
          )}
          {/* Identity glyph: the driver's brand mark now leads the row —
              something recognisable at a glance beats a plain bullet — with
              live/idle/lost folded into a small corner dot instead of a
              separate one. Same brand/destructive vocabulary the status bar
              uses, just relocated onto the icon. */}
          <span className="relative inline-flex shrink-0">
            <DriverBadge driver={p.driver} />
            <span
              className={cn(
                "absolute -bottom-0.5 -right-0.5 h-2 w-2 rounded-full ring-2 ring-background",
                isLost
                  ? "bg-destructive"
                  : isActive
                    ? "bg-brand"
                    : "bg-muted-foreground/40",
              )}
            />
          </span>
          <span
            className={cn(
              "flex-1 truncate",
              isSelected && "font-semibold",
              !isActive && "text-muted-foreground",
            )}
          >
            {p.name}
          </span>
          {/* One of the three explicit ways into a scope (the others are this
              row's context menu and a database row's). Offered only while
              something is typed: narrowing an empty search would leave a chip
              with nothing to modify. */}
          {filtering && isActive && !isScopeTarget && (
            <button
              type="button"
              title={t("connectionsTree.filter.scopeHere")}
              aria-label={t("connectionsTree.filter.scopeHere")}
              className="shrink-0 rounded-sm p-0.5 text-muted-foreground opacity-0 transition-colors hover:bg-accent hover:text-foreground focus-visible:opacity-100 group-hover:opacity-100"
              onClick={(e) => {
                e.stopPropagation();
                actionsRef.current.onNarrowToConnection(p.id);
              }}
            >
              <ListFilter className="h-3 w-3" />
            </button>
          )}
          {filtering && (
            <MatchBadge
              isActive={isActive}
              count={summary?.count ?? 0}
              cold={summary?.coldDatabases.length ?? 0}
              state={matchState}
            />
          )}
          <VanishedOriginMark profileId={p.id} />
          {isLost ? (
            <button
              type="button"
              title={t("connections.reconnectTooltip")}
              className="flex shrink-0 items-center gap-1 rounded-sm px-1.5 py-0.5 text-2xs font-medium text-destructive transition-colors hover:bg-destructive/20"
              onClick={(e) => {
                e.stopPropagation();
                actionsRef.current.onReconnect(p);
              }}
            >
              <RotateCw className="h-3 w-3" />
              {t("connections.reconnect")}
            </button>
          ) : isActive ? (
            <button
              type="button"
              title={t("statusBar.disconnect")}
              disabled={isDisconnecting}
              // Hidden until hover/focus so a long list of live connections
              // isn't a wall of buttons, but always shown for the focused row
              // — and for one that is mid-teardown, which is the whole point
              // of showing that state at all.
              className={cn(
                "shrink-0 rounded-sm p-0.5 text-muted-foreground transition-colors hover:bg-destructive/15 hover:text-destructive group-hover:opacity-100",
                isSelected || isDisconnecting ? "opacity-100" : "opacity-0",
              )}
              onClick={(e) => {
                e.stopPropagation();
                actionsRef.current.onDisconnect(p);
              }}
            >
              {/* `PlugZap`, the same mark the header's "disconnect all"
                  carries, not an ✕: an ✕ on a row reads as "remove this
                  connection", which is a different and much worse action
                  than closing its pool. */}
              {isDisconnecting ? (
                <Spinner size="sm" />
              ) : (
                <PlugZap className="h-3.5 w-3.5" />
              )}
            </button>
          ) : (
            <Plug className="h-3 w-3 shrink-0 text-muted-foreground/40 opacity-0 transition-opacity group-hover:opacity-100" />
          )}
        </div>
      </ConnectionActionsMenu>

      {/* Only a live connection has a subtree to show. An expanded-but-idle row
          can't happen (disconnecting drops the override), but the guard is what
          makes that true rather than incidental. Nesting this the same way as
          a folder's own guide (below) is what makes the line read as one
          continuous tree rather than a per-row accent: a connection inside a
          folder naturally sits one guide deeper than an ungrouped one. */}
      {expanded && isActive && (
        <div
          className="ml-3 border-l border-border/35 pl-0.5"
          // With the filter active there can be thousands of rows across
          // every open connection; `content-visibility: auto` skips style
          // recalc/layout/paint for whatever's outside the scroll viewport
          // (`rowsRef`'s `overflow-y-auto` below). Unlike virtualizing,
          // this does NOT remove nodes from the DOM, so `moveRowFocus`
          // (which walks `[data-tree-row]` via `querySelectorAll`) keeps
          // working unchanged — that's the whole reason this is CSS and
          // not a virtualizer. `contain-intrinsic-size`'s guess only
          // matters before this subtree has ever been measured once; the
          // browser remembers the real size afterward and re-estimates
          // only if it goes offscreen again before ever being painted.
          style={{
            contentVisibility: "auto",
            containIntrinsicSize: "auto 300px",
          }}
        >
          <SchemaExplorer
            connectionId={p.id}
            patterns={patterns}
            summary={summary}
          />
        </div>
      )}
    </div>
  );
});

/**
 * The per-connection match count, shown while something is typed.
 *
 * The four states it can render are the point of it. A connection that is not
 * connected has not been searched at all; one still fetching its own list is
 * counting; a multi-DB server whose databases have never been read has looked
 * at *some* of itself and says so with a `+` (or a bare `—` when it has found
 * nothing yet). Only the last case — everything visible loaded, nothing matched
 * — earns a plain `0`. Saying `0` about something nobody has read is what makes
 * a user abandon a search that would have worked.
 */
function MatchBadge({
  isActive,
  count,
  cold,
  state,
}: {
  isActive: boolean;
  count: number;
  cold: number;
  state: RowMatchState | null;
}) {
  const { t } = useTranslation();
  const base = "shrink-0 rounded-sm px-1 text-3xs leading-4 tabular-nums";

  if (!isActive) {
    return (
      <span
        title={t("connectionsTree.filter.connectToSearch")}
        className={cn(base, "bg-muted text-muted-foreground/60")}
      >
        —
      </span>
    );
  }
  if (state === "out-of-scope") {
    // Not "0": this connection was never searched, and saying it found nothing
    // would send the user off to fix a needle that is not the problem.
    return (
      <span
        title={t("connectionsTree.filter.clearScope")}
        className={cn(base, "bg-muted text-muted-foreground/60")}
      >
        —
      </span>
    );
  }
  if (state === "pending") {
    return (
      <span
        title={t("connectionsTree.filter.counting")}
        className={cn(base, "bg-muted text-muted-foreground/60")}
      >
        …
      </span>
    );
  }
  if (state === "unloaded") {
    return (
      <span
        title={t("connectionsTree.filter.partialCount", { count: 0, cold })}
        className={cn(base, "bg-muted text-muted-foreground/60")}
      >
        —
      </span>
    );
  }
  const partial = cold > 0;
  return (
    <span
      title={
        partial
          ? t("connectionsTree.filter.partialCount", { count, cold })
          : undefined
      }
      className={cn(
        base,
        count > 0
          ? "bg-brand/15 text-brand"
          : "bg-muted text-muted-foreground/60",
      )}
    >
      {count}
      {partial && "+"}
    </span>
  );
}
