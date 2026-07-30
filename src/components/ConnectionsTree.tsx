/**
 * The Schema panel's top two levels: folder → connection (#107).
 *
 * Before this, the panel showed the schema of whichever connection was selected
 * elsewhere, so browsing a second server meant leaving the tree to pick it from
 * a menu. Now every saved connection is a row here, grouped by its folder, and
 * expanding one renders its existing schema subtree underneath — database →
 * tables for a multi-DB connection, schema → tables for a single-DB one.
 *
 * Two things are reused rather than reinvented. Folders come from
 * `bucketByGroup` + `useConnectionGroupCollapse`, the same pair the File menu and
 * the status bar use, so a folded folder and the `connectionGroupExpandMode`
 * preference behave identically in all three. The subtree is
 * `SchemaExplorer nested` — the same component the panel rendered before, minus
 * its own title and scroll container.
 *
 * Expansion is session state, not persisted, and defaults to "expanded when
 * connected". That is deliberate: which connections are live is already restored
 * at launch and on an environment switch, so the tree comes back looking right
 * without a second, parallel list of expanded ids that could drift out of step
 * with what is actually open.
 */

import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { ChevronDown, ChevronRight, Loader2, Plug, RotateCw, X } from "lucide-react";
import { useConnections } from "@/stores/connections";
import { useConnectionHealth } from "@/stores/connectionHealth";
import { useUi } from "@/stores/ui";
import { useConnectionGroupCollapse } from "@/lib/useConnectionGroups";
import { connectAndWarm, disconnectAndClean } from "@/lib/connectFlow";
import { bucketByGroup, cn } from "@/lib/utils";
import { DriverBadge } from "@/components/DriverBadge";
import { SchemaExplorer } from "@/components/SchemaExplorer";
import { VanishedOriginMark } from "@/components/VanishedOriginNotice";
import type { ConnectionProfile } from "@/types";

export function ConnectionsTree() {
  const { t } = useTranslation();
  const profiles = useConnections((s) => s.profiles);
  const active = useConnections((s) => s.active);
  const lostConnections = useConnectionHealth((s) => s.lost);
  const selected = useUi((s) => s.selectedConnectionId);
  const setSelected = useUi((s) => s.setSelectedConnectionId);
  const groupCollapse = useConnectionGroupCollapse();

  // Reference-stable inputs, derived here rather than in the selector (gotcha #1).
  const buckets = useMemo(() => bucketByGroup(profiles), [profiles]);

  /**
   * Explicit user overrides only. Absence means "follow the connection": open if
   * it has a live pool, closed otherwise — see the module note on why this isn't
   * persisted.
   */
  const [overrides, setOverrides] = useState<Record<string, boolean>>({});
  /** Id currently connecting, so its row can show a spinner and refuse clicks. */
  const [connecting, setConnecting] = useState<string | null>(null);

  const isExpanded = (p: ConnectionProfile) =>
    p.id in overrides ? overrides[p.id] : active.has(p.id);

  /**
   * A row click both focuses the connection (tabs and the query editor follow
   * `selectedConnectionId`) and opens it. An idle connection connects first —
   * clicking a connection you can see and getting nothing would be the more
   * surprising behaviour.
   */
  async function handleRowClick(p: ConnectionProfile) {
    if (connecting) return;
    if (!active.has(p.id)) {
      setConnecting(p.id);
      const ok = await connectAndWarm(p.id);
      setConnecting(null);
      if (!ok) return;
      setSelected(p.id);
      setOverrides((prev) => ({ ...prev, [p.id]: true }));
      return;
    }
    setSelected(p.id);
    setOverrides((prev) => ({ ...prev, [p.id]: !isExpanded(p) }));
  }

  async function handleDisconnect(p: ConnectionProfile) {
    await disconnectAndClean(p.id);
    if (selected === p.id) setSelected(null);
    // Drop the override so the row goes back to following the connection: left
    // pinned open, it would show an empty subtree with no explanation.
    setOverrides((prev) => {
      const next = { ...prev };
      delete next[p.id];
      return next;
    });
  }

  /** Tear the dead pool down and reopen it, mirroring the status bar's affordance. */
  async function handleReconnect(p: ConnectionProfile) {
    setConnecting(p.id);
    try {
      await useConnections.getState().disconnect(p.id);
    } catch {
      // Already dead; reconnect regardless.
    }
    const ok = await connectAndWarm(p.id);
    setConnecting(null);
    if (ok) setSelected(p.id);
  }

  function renderConnection(p: ConnectionProfile, indented = false) {
    const isActive = active.has(p.id);
    const lostError = lostConnections[p.id];
    const isLost = !!lostError;
    const expanded = isExpanded(p);
    const isConnecting = connecting === p.id;

    return (
      <div key={p.id}>
        <div
          role="button"
          tabIndex={0}
          onClick={() => void handleRowClick(p)}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === " ") {
              e.preventDefault();
              void handleRowClick(p);
            }
          }}
          title={isLost ? t("connections.lost", { message: lostError }) : p.name}
          className={cn(
            "group flex cursor-pointer items-center gap-1 py-1 pr-2 text-sm outline-none hover:bg-accent/40 focus-visible:ring-1 focus-visible:ring-ring",
            indented ? "pl-4" : "pl-2",
            isLost && "bg-destructive/10",
            !isLost && selected === p.id && "bg-brand/10",
          )}
        >
          {isConnecting ? (
            <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-muted-foreground" />
          ) : expanded ? (
            <ChevronDown className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
          ) : (
            <ChevronRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
          )}
          {/* Live/idle at a glance: the dot is the same brand/destructive
              vocabulary the status bar uses for the same three states. */}
          <span
            className={cn(
              "h-1.5 w-1.5 shrink-0 rounded-full",
              isLost
                ? "bg-destructive"
                : isActive
                  ? "bg-brand"
                  : "bg-muted-foreground/30",
            )}
          />
          <span
            className={cn(
              "flex-1 truncate",
              selected === p.id && "font-semibold",
              !isActive && "text-muted-foreground",
            )}
          >
            {p.name}
          </span>
          <VanishedOriginMark profileId={p.id} />
          <DriverBadge driver={p.driver} />
          {isLost ? (
            <button
              type="button"
              title={t("connections.reconnectTooltip")}
              className="flex shrink-0 items-center gap-1 rounded-sm px-1.5 py-0.5 text-2xs font-medium text-destructive transition-colors hover:bg-destructive/20"
              onClick={(e) => {
                e.stopPropagation();
                void handleReconnect(p);
              }}
            >
              <RotateCw className="h-3 w-3" />
              {t("connections.reconnect")}
            </button>
          ) : isActive ? (
            <button
              type="button"
              title={t("statusBar.disconnect")}
              // Hidden until hover/focus so a long list of live connections
              // isn't a wall of buttons, but always shown for the focused row.
              className={cn(
                "shrink-0 rounded-sm p-0.5 text-muted-foreground transition-colors hover:bg-destructive/15 hover:text-destructive group-hover:opacity-100",
                selected === p.id ? "opacity-100" : "opacity-0",
              )}
              onClick={(e) => {
                e.stopPropagation();
                void handleDisconnect(p);
              }}
            >
              <X className="h-3.5 w-3.5" />
            </button>
          ) : (
            <Plug className="h-3 w-3 shrink-0 text-muted-foreground/40 opacity-0 transition-opacity group-hover:opacity-100" />
          )}
        </div>

        {/* Only a live connection has a subtree to show. An expanded-but-idle row
            can't happen (disconnecting drops the override), but the guard is what
            makes that true rather than incidental. */}
        {expanded && isActive && (
          <div className={cn("border-l border-border/40", indented ? "ml-5" : "ml-3")}>
            <SchemaExplorer connectionId={p.id} nested />
          </div>
        )}
      </div>
    );
  }

  function GroupHeader({ name, count }: { name: string; count: number }) {
    const collapsed = groupCollapse.isCollapsed(name);
    return (
      <button
        type="button"
        onClick={() => groupCollapse.toggle(name)}
        className="flex w-full items-center gap-1 px-2 py-1 text-left text-[10px] font-semibold uppercase tracking-wider text-muted-foreground hover:text-foreground"
      >
        {collapsed ? (
          <ChevronRight className="h-3 w-3 shrink-0" />
        ) : (
          <ChevronDown className="h-3 w-3 shrink-0" />
        )}
        <span className="truncate">{name}</span>
        <span className="text-muted-foreground/60">({count})</span>
      </button>
    );
  }

  if (profiles.length === 0) {
    return (
      <div className="flex h-full items-center justify-center px-3 text-center text-xs text-muted-foreground">
        {t("connectionsTree.empty")}
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col">
      <div className="flex-1 overflow-y-auto py-1">
        {buckets.ungrouped.map((p) => renderConnection(p))}
        {buckets.groups.map(({ name, items }) => (
          <div key={name}>
            <GroupHeader name={name} count={items.length} />
            {!groupCollapse.isCollapsed(name) &&
              items.map((p) => renderConnection(p, true))}
          </div>
        ))}
      </div>
    </div>
  );
}
