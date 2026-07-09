/**
 * Status-bar connections control. Replaces the old comma-joined list of
 * active connection names with a dropdown: active pools at the top (click to
 * jump to that workspace, or disconnect), saved-but-idle profiles below for
 * quick-connect. The trigger shows a brand-coloured dot + a live count.
 *
 * Connect / disconnect mirror the FileMenu flow (best-effort connect with the
 * keychain-stored secret; disconnect tears down the schema cache + tabs) so
 * the two entry points behave identically.
 */

import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import {
  Check,
  ChevronDown,
  ChevronRight,
  ChevronUp,
  Plug,
  RotateCw,
  X,
} from "lucide-react";
import { toast } from "sonner";
import { useConnections } from "@/stores/connections";
import { useConnectionHealth } from "@/stores/connectionHealth";
import { useSchema } from "@/stores/schema";
import { useTabs } from "@/stores/tabs";
import { useUi } from "@/stores/ui";
import { useConnectionGroupCollapse } from "@/lib/useConnectionGroups";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
} from "@/components/ui/dropdown";
import { DriverBadge } from "@/components/DriverBadge";
import { SimpleTooltip } from "@/components/ui/tooltip";
import { driverMismatchHint } from "@/lib/driver";
import { bucketByGroup, cn } from "@/lib/utils";
import type { ConnectionProfile } from "@/types";

export function StatusConnections() {
  const { t } = useTranslation();
  const profiles = useConnections((s) => s.profiles);
  const active = useConnections((s) => s.active);
  const versions = useConnections((s) => s.versions);
  const connect = useConnections((s) => s.connect);
  const disconnect = useConnections((s) => s.disconnect);
  const lostConnections = useConnectionHealth((s) => s.lost);
  const refreshSchema = useSchema((s) => s.refresh);
  const dropSchema = useSchema((s) => s.drop);
  const closeTabs = useTabs((s) => s.closeForConnection);
  const selected = useUi((s) => s.selectedConnectionId);
  const setSelected = useUi((s) => s.setSelectedConnectionId);
  const groupCollapse = useConnectionGroupCollapse();

  // Split profiles into active / idle. Both inputs are reference-stable, so
  // deriving here (rather than via a store selector) honours the Zustand rule.
  const { activeProfiles, idleProfiles } = useMemo(() => {
    const a: ConnectionProfile[] = [];
    const idle: ConnectionProfile[] = [];
    for (const p of profiles) (active.has(p.id) ? a : idle).push(p);
    return { activeProfiles: a, idleProfiles: idle };
  }, [profiles, active]);

  // Bucket each section by `group` — a group collapsed here hides it in
  // both Active and Available, matching a user's expectation that "Acme"
  // is one thing to fold, not two independent toggles.
  const activeBuckets = useMemo(
    () => bucketByGroup(activeProfiles),
    [activeProfiles],
  );
  const idleBuckets = useMemo(() => bucketByGroup(idleProfiles), [idleProfiles]);

  // The connection currently in focus (a live pool the workspace points at).
  // Drives the trigger label so the active connection is visible at a glance.
  const current = useMemo(
    () =>
      selected
        ? profiles.find((p) => p.id === selected && active.has(p.id)) ?? null
        : null,
    [selected, profiles, active],
  );

  async function handleConnect(p: ConnectionProfile) {
    if (active.has(p.id)) {
      setSelected(p.id);
      return;
    }
    try {
      await connect(p.id);
      await refreshSchema(p.id);
      setSelected(p.id);
    } catch (e) {
      // Same behaviour as the FileMenu: a profile that needs an
      // interactively-typed password surfaces the failure rather than
      // silently doing nothing.
      const msg = String(e);
      const hint = driverMismatchHint(msg);
      toast.error(hint ? `${msg} — ${hint}` : msg);
    }
  }

  /** Mirrors `ConnectionList.handleReconnect`: tear down the dead pool and
   *  reopen it, keeping any open tabs intact. */
  async function handleReconnect(p: ConnectionProfile) {
    try {
      await disconnect(p.id);
    } catch {
      // The pool was already dead; proceed to reconnect regardless.
    }
    await handleConnect(p);
  }

  async function handleDisconnect(id: string) {
    try {
      await disconnect(id);
      dropSchema(id);
      closeTabs(id);
      if (selected === id) setSelected(null);
    } catch {
      // Non-fatal: leave the rest of the UI untouched on a teardown error.
    }
  }

  function renderActiveItem(p: ConnectionProfile) {
    const lostError = lostConnections[p.id];
    const isLost = !!lostError;
    return (
      <DropdownMenuItem
        key={p.id}
        onSelect={() => setSelected(p.id)}
        // A lost pool is the most important state in this list — give the whole
        // row a destructive wash so it's unmissable, not just a 6px red dot.
        // Otherwise the focused connection (the one the workspace points at)
        // gets a resting brand wash so it reads as "active", distinct from the
        // other merely-connected rows (issue #31).
        className={cn(
          "gap-2",
          isLost
            ? "bg-destructive/10 focus:bg-destructive/15"
            : selected === p.id && "bg-brand/10",
        )}
      >
        {isLost ? (
          <span className="h-2 w-2 shrink-0 rounded-full bg-destructive" />
        ) : selected === p.id ? (
          <Check className="h-3.5 w-3.5 shrink-0 text-brand" />
        ) : (
          <span className="h-2 w-2 shrink-0 rounded-full bg-brand" />
        )}
        <span
          className={cn(
            "flex-1 truncate text-xs",
            selected === p.id && "font-semibold",
          )}
          title={isLost ? t("connections.lost", { message: lostError }) : undefined}
        >
          {p.name}
        </span>
        {selected === p.id && (
          <span className="shrink-0 rounded bg-brand/15 px-1 py-0.5 text-[9px] font-medium uppercase tracking-wide text-brand">
            {t("statusBar.activeLabel")}
          </span>
        )}
        {versions[p.id] && !isLost && (
          <span className="max-w-[6rem] truncate font-mono text-3xs text-muted-foreground">
            {versions[p.id]}
          </span>
        )}
        <DriverBadge driver={p.driver} />
        {isLost ? (
          // Explicit labelled affordance rather than a cryptic red icon.
          <button
            type="button"
            title={t("connections.reconnectTooltip")}
            className="ml-0.5 flex shrink-0 items-center gap-1 rounded-sm px-1.5 py-0.5 text-2xs font-medium text-destructive transition-colors hover:bg-destructive/20"
            onClick={(e) => {
              e.preventDefault();
              e.stopPropagation();
              void handleReconnect(p);
            }}
          >
            <RotateCw className="h-3 w-3" />
            {t("connections.reconnect")}
          </button>
        ) : (
          <button
            type="button"
            title={t("statusBar.disconnect")}
            className="ml-0.5 rounded-sm p-1 text-muted-foreground transition-colors hover:bg-destructive/15 hover:text-destructive"
            onClick={(e) => {
              // Don't let the click bubble to the row's onSelect (jump).
              e.preventDefault();
              e.stopPropagation();
              void handleDisconnect(p.id);
            }}
          >
            <X className="h-3.5 w-3.5" />
          </button>
        )}
      </DropdownMenuItem>
    );
  }

  function renderIdleItem(p: ConnectionProfile) {
    return (
      <DropdownMenuItem
        key={p.id}
        onSelect={() => void handleConnect(p)}
        className="gap-2"
      >
        <Plug className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        <span className="flex-1 truncate text-xs">{p.name}</span>
        <DriverBadge driver={p.driver} />
      </DropdownMenuItem>
    );
  }

  /** One group's collapsible header, shared by the Active/Available lists. */
  function GroupHeader({ name, count: n }: { name: string; count: number }) {
    const collapsed = groupCollapse.isCollapsed(name);
    return (
      <button
        type="button"
        onClick={(e) => {
          e.preventDefault();
          e.stopPropagation();
          groupCollapse.toggle(name);
        }}
        className="flex w-full items-center gap-1 px-2 py-1 text-left text-[10px] font-semibold uppercase tracking-wider text-muted-foreground hover:text-foreground"
      >
        {collapsed ? (
          <ChevronRight className="h-3 w-3 shrink-0" />
        ) : (
          <ChevronDown className="h-3 w-3 shrink-0" />
        )}
        <span className="truncate">{name}</span>
        <span className="text-muted-foreground/60">({n})</span>
      </button>
    );
  }

  const count = activeProfiles.length;

  return (
    <DropdownMenu>
      <SimpleTooltip label={t("statusBar.connectionsActive")} side="top">
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            className={cn(
              "flex items-center gap-1.5 rounded-sm px-1 py-0.5 outline-none transition-colors hover:bg-accent hover:text-foreground focus-visible:ring-1 focus-visible:ring-ring",
              count > 0 && "text-foreground",
            )}
          >
            {current ? (
            <DriverBadge driver={current.driver} />
          ) : (
            <span
              className={cn(
                "h-1.5 w-1.5 rounded-full",
                count > 0 ? "bg-brand" : "bg-muted-foreground/40",
              )}
            />
          )}
          <span className="max-w-[12rem] truncate">
            {current
              ? current.name
              : count > 0
                ? t("statusBar.connections", { count })
                : t("statusBar.disconnected")}
          </span>
          <ChevronUp className="h-3 w-3 opacity-60" />
        </button>
        </DropdownMenuTrigger>
      </SimpleTooltip>
      <DropdownMenuContent
        side="top"
        align="start"
        className="w-72"
      >
        <div className="px-2 py-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
          {t("statusBar.connectionsActive")}
        </div>
        {activeProfiles.length === 0 ? (
          <div className="px-2 py-1.5 text-xs text-muted-foreground">
            {t("statusBar.noConnections")}
          </div>
        ) : (
          <>
            {activeBuckets.ungrouped.map(renderActiveItem)}
            {activeBuckets.groups.map(({ name, items }) => (
              <div key={name}>
                <GroupHeader name={name} count={items.length} />
                {!groupCollapse.isCollapsed(name) && items.map(renderActiveItem)}
              </div>
            ))}
          </>
        )}

        {idleProfiles.length > 0 && (
          <>
            <DropdownMenuSeparator />
            <div className="px-2 py-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
              {t("statusBar.connectionsAvailable")}
            </div>
            {idleBuckets.ungrouped.map(renderIdleItem)}
            {idleBuckets.groups.map(({ name, items }) => (
              <div key={name}>
                <GroupHeader name={name} count={items.length} />
                {!groupCollapse.isCollapsed(name) && items.map(renderIdleItem)}
              </div>
            ))}
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
