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
 * preference behave identically in all three. The subtree is the same
 * `SchemaExplorer` the panel rendered before — it lost its panel-level title,
 * icon strip and scroll container, since the row above it now owns all three
 * (its right-click menu is [[ConnectionActionsMenu]], defined next to the
 * dialogs it drives).
 *
 * Expansion defaults to "expanded when connected" and only the user's folds are
 * stored (`LaunchState.collapsedConnections`, per environment). Keeping the
 * default derived rather than persisted is what stops the tree from ever claiming
 * a row is open over a subtree that doesn't exist: a remembered fold can only
 * ever mean "show this folded when it comes back".
 */

import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  ChevronDown,
  ChevronRight,
  Folder,
  FolderOpen,
  ListFilter,
  Loader2,
  Plug,
  PlugZap,
  RotateCw,
  Search,
  X,
} from "lucide-react";
import { useConnections } from "@/stores/session/connections";
import { useConnectionHealth } from "@/stores/session/connectionHealth";
import { useSchema } from "@/stores/session/schema";
import { useTabs } from "@/stores/session/tabs";
import { useUi } from "@/stores/session/ui";
import { useConnectionGroupCollapse } from "@/lib/connection/useConnectionGroups";
import { connectAndWarm, disconnectAndClean } from "@/lib/connection/connectFlow";
import { persistLaunchState } from "@/stores/session/persistedTabs";
import { bucketByGroup, cn } from "@/lib/utils";
import { DriverBadge } from "@/components/common/DriverBadge";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  ConnectionActionsMenu,
  SchemaExplorer,
} from "@/components/schema/SchemaExplorer";
import { VanishedOriginMark } from "@/components/common/VanishedOriginNotice";
import type { ConnectionProfile } from "@/types";

export function ConnectionsTree() {
  const { t } = useTranslation();
  const profiles = useConnections((s) => s.profiles);
  const active = useConnections((s) => s.active);
  const disconnect = useConnections((s) => s.disconnect);
  const lostConnections = useConnectionHealth((s) => s.lost);
  // Whole map, so a row can show that its schema is being fetched. The explorer's
  // spinning refresh button carried that signal before its icon strip moved to
  // the context menu; on the row it's visible even while the connection is
  // collapsed. `MultiDbExplorer` already subscribes this broadly for the same
  // reason — the lookups are cheap and the map is replaced, not mutated.
  const schemaByConnection = useSchema((s) => s.byConnection);
  const dropSchema = useSchema((s) => s.drop);
  const closeTabsForConnection = useTabs((s) => s.closeForConnection);
  const selected = useUi((s) => s.selectedConnectionId);
  const setSelected = useUi((s) => s.setSelectedConnectionId);
  // The folded set (see `useUi`): a row follows its pool unless the user said
  // otherwise, so only the overrides are tracked — and only the collapsing ones,
  // since "expanded" is already the default for a live connection.
  const collapsed = useUi((s) => s.collapsedConnections);
  const setConnectionCollapsed = useUi((s) => s.setConnectionCollapsed);
  // One filter box for the whole tree (previously duplicated inside every
  // expanded connection). It only ever scopes to `selected` — see
  // `renderConnection` — so browsing several connections at once never
  // hides the ones you're not searching.
  const treeFilter = useUi((s) => s.treeFilter);
  const setTreeFilter = useUi((s) => s.setTreeFilter);
  const groupCollapse = useConnectionGroupCollapse();

  // DataGrip-style subset of connections to show, one level up from the
  // per-connection database subset (`useVisibleDatabases`, SchemaExplorer.tsx).
  // Lives in `useUi`, persisted per environment via
  // `LaunchState.visibleConnections` — not in prefs, so switching environments
  // doesn't drag one's filter into another's tree. The level below now resolves
  // the same way, through a per-environment override on top of the profile's
  // `visible_databases`.
  const visibleConnectionIds = useUi((s) => s.visibleConnections);
  const visibleSet = useMemo(
    () =>
      visibleConnectionIds && visibleConnectionIds.length > 0
        ? new Set(visibleConnectionIds)
        : null,
    [visibleConnectionIds],
  );
  const [visibilityPickerOpen, setVisibilityPickerOpen] = useState(false);

  // Reference-stable inputs, derived here rather than in the selector (gotcha #1).
  const visibleProfiles = useMemo(
    () => profiles.filter((p) => !visibleSet || visibleSet.has(p.id)),
    [profiles, visibleSet],
  );
  const buckets = useMemo(() => bucketByGroup(visibleProfiles), [visibleProfiles]);

  /** Id currently connecting, so its row can show a spinner and refuse clicks. */
  const [connecting, setConnecting] = useState<string | null>(null);

  const isExpanded = (p: ConnectionProfile) =>
    active.has(p.id) && !collapsed.includes(p.id);

  /**
   * Fold or unfold, and persist it. `persistLaunchState` is otherwise only called
   * on connect/disconnect and at graceful close, so without this a fold made just
   * before an abrupt exit would be lost — the same "keep it roughly fresh"
   * reasoning the connect/disconnect calls already document.
   */
  function setCollapsed(id: string, value: boolean) {
    setConnectionCollapsed(id, value);
    void persistLaunchState(Array.from(useConnections.getState().active));
  }

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
      // Connecting unfolds: the click that opened it asked to see inside.
      setCollapsed(p.id, false);
      return;
    }
    setSelected(p.id);
    setCollapsed(p.id, isExpanded(p));
  }

  async function handleDisconnect(p: ConnectionProfile) {
    await disconnectAndClean(p.id);
    if (selected === p.id) setSelected(null);
    // The fold is left in place deliberately: it can only mean "show folded when
    // this comes back", never "open over a subtree that isn't there".
  }

  /** Tear down every live pool and clear the selected connection. Lives here
   *  (rather than the File menu, where it used to sit next to the now-removed
   *  connection list) since it's a bulk action over exactly what this tree shows. */
  async function handleDisconnectAll() {
    for (const id of Array.from(active)) {
      try {
        await disconnect(id);
        dropSchema(id);
        closeTabsForConnection(id);
      } catch {
        // Continue on partial failures so one bad pool doesn't block the rest.
      }
    }
    setSelected(null);
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

  function renderConnection(p: ConnectionProfile) {
    const isActive = active.has(p.id);
    const lostError = lostConnections[p.id];
    const isLost = !!lostError;
    const expanded = isExpanded(p);
    const isBusy = connecting === p.id || !!schemaByConnection[p.id]?.loading;

    return (
      <div key={p.id}>
        <ConnectionActionsMenu
          connectionId={p.id}
          onConnect={() => void handleRowClick(p)}
          onDisconnect={() => void handleDisconnect(p)}
        >
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
              "group flex cursor-pointer items-center gap-2 rounded-md py-1.5 pl-2 pr-2 text-sm outline-none transition-colors duration-150 hover:bg-accent/50 focus-visible:ring-2 focus-visible:ring-brand/40",
              isLost && "bg-destructive/10",
              // Selected connection: the same brand rail the active table row
              // carries in `SchemaExplorer`, so "this is the one you're in"
              // reads identically at both levels of the tree, plus a hairline
              // blue edge as the card's quiet version of an active border.
              !isLost &&
                selected === p.id &&
                "bg-brand/10 ring-1 ring-inset ring-brand/25 shadow-[inset_2px_0_0_hsl(var(--brand))]",
            )}
          >
            {isBusy ? (
              <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-muted-foreground" />
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
                selected === p.id && "font-semibold",
                !isActive && "text-muted-foreground",
              )}
            >
              {p.name}
            </span>
            <VanishedOriginMark profileId={p.id} />
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
        </ConnectionActionsMenu>

        {/* Only a live connection has a subtree to show. An expanded-but-idle row
            can't happen (disconnecting drops the override), but the guard is what
            makes that true rather than incidental. Nesting this the same way as
            a folder's own guide (below) is what makes the line read as one
            continuous tree rather than a per-row accent: a connection inside a
            folder naturally sits one guide deeper than an ungrouped one. */}
        {expanded && isActive && (
          <div className="ml-3 border-l border-border/35 pl-0.5">
            <SchemaExplorer
              connectionId={p.id}
              filter={selected === p.id ? treeFilter : ""}
            />
          </div>
        )}
      </div>
    );
  }

  function GroupHeader({ name, count }: { name: string; count: number }) {
    const collapsed = groupCollapse.isCollapsed(name);
    const FolderIcon = collapsed ? Folder : FolderOpen;
    return (
      <button
        type="button"
        onClick={() => groupCollapse.toggle(name)}
        className="flex w-full items-center gap-1.5 px-2 py-1.5 text-left text-[10px] font-semibold uppercase tracking-wider text-muted-foreground hover:text-foreground"
      >
        {collapsed ? (
          <ChevronRight className="h-3 w-3 shrink-0" />
        ) : (
          <ChevronDown className="h-3 w-3 shrink-0" />
        )}
        <FolderIcon className="h-3.5 w-3.5 shrink-0" />
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
      <div className="shrink-0 px-2 pb-1 pt-2">
        {/* Tree-wide actions, above the filter box: bulk-disconnect on the
            left, the visibility picker (which acts on the whole tree, not
            one row, so it can't live in a per-connection context menu) on
            the right. */}
        <div className="mb-1.5 flex items-center justify-between gap-1">
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={active.size === 0}
            onClick={() => void handleDisconnectAll()}
            title={t("menu.file.disconnectAll")}
            className="h-6 min-w-0 gap-1 px-2 text-[11px]"
          >
            <PlugZap className="h-3 w-3 shrink-0" />
            <span className="truncate">{t("menu.file.disconnectAll")}</span>
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => setVisibilityPickerOpen(true)}
            title={t("connectionsTree.selectConnections.action")}
            className="h-6 min-w-0 gap-1 px-2 text-[11px]"
          >
            <ListFilter className="h-3 w-3 shrink-0" />
            <span className="truncate">{t("connectionsTree.selectConnections.action")}</span>
          </Button>
        </div>
        <Input
          value={treeFilter}
          onChange={(e) => setTreeFilter(e.target.value)}
          placeholder={t("schema.filterPlaceholder")}
          className="h-7 text-xs"
        />
        {visibleSet && (
          <div className="mt-1 text-[11px] text-muted-foreground">
            {t("connectionsTree.selectConnections.subsetActive", {
              count: visibleSet.size,
              total: profiles.length,
            })}
          </div>
        )}
        {/* Only meaningful once something is typed — an empty box needing no
            selection at all would be a confusing thing to say up front. */}
        {treeFilter && !selected && (
          <div className="mt-1 text-[11px] text-muted-foreground">
            {t("connectionsTree.filterNeedsSelection")}
          </div>
        )}
      </div>
      <div className="flex-1 overflow-y-auto py-1.5 pr-1">
        {visibleProfiles.length === 0 && (
          <div className="px-3 py-2 text-xs text-muted-foreground">
            {t("connectionsTree.selectConnections.allHidden")}
          </div>
        )}
        {buckets.ungrouped.map((p) => renderConnection(p))}
        {buckets.groups.map(({ name, items }) => (
          <div key={name}>
            <GroupHeader name={name} count={items.length} />
            {/* One guide per folder, nested the same way a connection's own
                subtree line nests under it — indentation reads as depth
                everywhere in this tree, not just here. */}
            {!groupCollapse.isCollapsed(name) && (
              <div className="ml-3 border-l border-border/35 pl-0.5">
                {items.map((p) => renderConnection(p))}
              </div>
            )}
          </div>
        ))}
      </div>
      {visibilityPickerOpen && (
        <ConnectionVisibilityDialog
          profiles={profiles}
          selected={visibleConnectionIds ?? null}
          onClose={() => setVisibilityPickerOpen(false)}
        />
      )}
    </div>
  );
}

/**
 * DataGrip-style "choose which connections to show" picker, one level up
 * from `DatabaseVisibilityDialog` (SchemaExplorer.tsx). Persisted per
 * environment via `LaunchState.visibleConnections` rather than on a profile,
 * since it spans every saved connection rather than one — and
 * rather than in global prefs, so the filter doesn't follow the user across
 * environments. "All selected" stores `null` so a newly-saved connection
 * stays visible by default. Save is disabled with nothing selected — an
 * empty subset would hide the whole tree, which is never what the user wants.
 */
function ConnectionVisibilityDialog({
  profiles,
  selected,
  onClose,
}: {
  profiles: ConnectionProfile[];
  /** The persisted subset of ids, or null when all are shown. */
  selected: string[] | null;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const [sel, setSel] = useState<Set<string>>(
    () => new Set(selected ?? profiles.map((p) => p.id)),
  );
  const [filter, setFilter] = useState("");

  const filtered = useMemo(() => {
    const q = filter.trim().toLowerCase();
    if (!q) return profiles;
    return profiles.filter((p) => p.name.toLowerCase().includes(q));
  }, [profiles, filter]);

  const allFilteredSelected =
    filtered.length > 0 && filtered.every((p) => sel.has(p.id));

  const toggle = (id: string) => {
    setSel((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };
  const toggleAllFiltered = () =>
    setSel((prev) => {
      const next = new Set(prev);
      if (allFilteredSelected) {
        for (const p of filtered) next.delete(p.id);
      } else {
        for (const p of filtered) next.add(p.id);
      }
      return next;
    });

  const submit = () => {
    if (sel.size === 0) return;
    const chosen = profiles.filter((p) => sel.has(p.id)).map((p) => p.id);
    // "All" → null so a connection saved later stays visible automatically.
    const value = chosen.length === profiles.length ? null : chosen;
    useUi.getState().setVisibleConnections(value);
    void persistLaunchState(Array.from(useConnections.getState().active));
    onClose();
  };

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{t("connectionsTree.selectConnections.title")}</DialogTitle>
          <DialogDescription>
            {t("connectionsTree.selectConnections.description")}
          </DialogDescription>
        </DialogHeader>
        <div className="mb-1.5 flex items-center gap-1.5">
          <div className="relative flex-1">
            <Search className="pointer-events-none absolute left-2 top-1/2 h-3 w-3 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              placeholder={t("connectionsTree.selectConnections.filterPlaceholder")}
              className="h-7 pl-6 text-xs"
            />
          </div>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="h-7 shrink-0 px-2 text-[11px]"
            disabled={filtered.length === 0}
            onClick={toggleAllFiltered}
          >
            {allFilteredSelected
              ? t("connectionsTree.selectConnections.deselectAll")
              : t("connectionsTree.selectConnections.selectAll")}
          </Button>
        </div>
        <div className="flex items-center justify-between pb-1">
          <span className="text-xs text-muted-foreground">
            {t("connectionsTree.selectConnections.count", {
              selected: sel.size,
              total: profiles.length,
            })}
          </span>
        </div>
        <div className="max-h-64 divide-y divide-border overflow-y-auto rounded-md border border-border">
          {filtered.length === 0 ? (
            <p className="px-3 py-2 text-xs text-muted-foreground">
              {t("connectionsTree.selectConnections.noMatches", { query: filter })}
            </p>
          ) : (
            filtered.map((p) => (
              <label
                key={p.id}
                className="flex cursor-pointer items-center gap-3 px-3 py-2 hover:bg-muted/50"
              >
                <input
                  type="checkbox"
                  checked={sel.has(p.id)}
                  onChange={() => toggle(p.id)}
                  className="h-3.5 w-3.5 rounded accent-primary"
                />
                <span className="flex-1 truncate text-xs">{p.name}</span>
                <DriverBadge driver={p.driver} />
              </label>
            ))
          )}
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            {t("common.cancel")}
          </Button>
          <Button onClick={submit} disabled={sel.size === 0}>
            {t("common.save")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
