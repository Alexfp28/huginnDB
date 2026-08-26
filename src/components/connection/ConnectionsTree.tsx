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
 * `bucketByGroup` + `useConnectionGroupCollapse`, the same pair the File menu,
 * the connections manager dialog and the status bar use, so the initial fold
 * state and the `connectionGroupExpandMode` preference behave identically in
 * all of them — but each surface keeps its own session-local overrides after
 * that, so folding a folder in the connections manager while this tree is
 * open no longer folds it here too. The subtree is the same
 * `SchemaExplorer` the panel rendered before — it lost its panel-level title,
 * icon strip and scroll container, since the row above it now owns all three
 * (its right-click menu is [[ConnectionActionsMenu]], its neighbour here).
 *
 * Expansion defaults to "expanded when connected" and only the user's folds are
 * stored (`LaunchState.collapsedConnections`, per environment). Keeping the
 * default derived rather than persisted is what stops the tree from ever claiming
 * a row is open over a subtree that doesn't exist: a remembered fold can only
 * ever mean "show this folded when it comes back".
 *
 * **This file owns the search.** The filter box used to hand a raw string down
 * to whichever connection happened to be selected and `""` to every other one,
 * so with two connections open one filtered and the other did not, and nothing
 * on screen said why — the only marker of "selected" is a hairline on the row,
 * and the selection moves on its own when a tab opens. Now the needle is
 * committed once (`useTreeSearch`), counted once against every live connection
 * (`useTreeMatchCounts`), and what travels down to the explorers is the parsed
 * `patterns` array plus that connection's already-computed summary. A row with
 * no matches folds to one dimmed line with a `0` badge instead of silently
 * showing its whole tree.
 *
 * The fold a filter causes is **visual and ephemeral**: it never touches
 * `collapsedConnections`, because that set goes through `persistLaunchState`
 * and a search would otherwise leave permanent folds the user never asked for.
 * The chevron still works, as a session-local override for as long as the
 * filter lasts.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  ChevronDown,
  ChevronRight,
  DatabaseZap,
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
import { resolveVisibleDatabases } from "@/lib/connection/visibleDatabases";
import { isServerWide } from "@/lib/connectionLabel";
import { useTreeMatchCounts } from "@/lib/schema/useTreeMatchCounts";
import { rowMatchState, totalMatches } from "@/lib/schema/treeMatches";
import { scopeLabel } from "@/lib/schema/filterScope";
import { TREE_SEARCH_DEBOUNCE_MS, useTreeSearch } from "@/stores/session/treeSearch";
import { connectAndWarm, disconnectAndClean } from "@/lib/connection/connectFlow";
import { persistLaunchState } from "@/stores/session/persistedTabs";
import { bucketByGroup, cn } from "@/lib/utils";
import { DriverBadge } from "@/components/common/DriverBadge";
import { EmptyState } from "@/components/common/EmptyState";
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
import { ConnectionActionsMenu } from "@/components/connection/ConnectionActionsMenu";
import { ScopeChip, TreeFilterBox } from "@/components/connection/TreeFilterBox";
import { SchemaExplorer } from "@/components/schema/SchemaExplorer";
import { VanishedOriginMark } from "@/components/common/VanishedOriginNotice";
import type { TreeConnectionInput } from "@/lib/schema/treeMatches";
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
  // One filter box for the whole tree, searching every live connection at once.
  // `raw` is what the user is typing; `patterns` is the committed, parsed needle
  // the subtrees below filter by (see `useTreeSearch`).
  const raw = useTreeSearch((s) => s.raw);
  const needle = useTreeSearch((s) => s.needle);
  const patterns = useTreeSearch((s) => s.patterns);
  const scope = useTreeSearch((s) => s.scope);
  const setRaw = useTreeSearch((s) => s.setRaw);
  const commitNeedle = useTreeSearch((s) => s.commit);
  const clearSearch = useTreeSearch((s) => s.clear);
  const narrowTo = useTreeSearch((s) => s.narrowTo);
  const clearScope = useTreeSearch((s) => s.clearScope);
  const widenScopeOneLevel = useTreeSearch((s) => s.widen);
  const requestFocus = useTreeSearch((s) => s.requestFocus);
  const focusRequest = useTreeSearch((s) => s.focusRequest);
  const groupCollapse = useConnectionGroupCollapse();
  const filterInputRef = useRef<HTMLInputElement>(null);
  const filtering = needle.length > 0;

  /**
   * The one debounce in the whole search path.
   *
   * It used to be per `MultiDbExplorer`, which is how the raw needle and the
   * debounced one could disagree for 250 ms about which databases to show
   * versus what to show inside them. With the string no longer travelling down
   * as a prop, only one committed needle exists at any instant and that
   * disagreement is unrepresentable.
   *
   * The empty case skips the wait, as it always has: clearing has to feel
   * immediate.
   */
  useEffect(() => {
    if (raw.trim().length === 0) {
      commitNeedle("");
      return;
    }
    const id = setTimeout(() => commitNeedle(), TREE_SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(id);
  }, [raw, commitNeedle]);

  // A focus request (the keyboard shortcut, or a scope button that wants the
  // caret back) selects what is there, so typing replaces the previous needle.
  useEffect(() => {
    if (focusRequest === 0) return;
    filterInputRef.current?.focus();
    filterInputRef.current?.select();
  }, [focusRequest]);

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

  // Inputs for the match counter: only *live* connections, since an idle one has
  // nothing to search and its row says so instead of showing a misleading `0`.
  // The visible-databases subset is resolved through the pure
  // `resolveVisibleDatabases` rather than `useVisibleDatabases`, which cannot be
  // called in a loop (Rules of Hooks) — that split is exactly why the pure
  // function exists.
  const databaseVisibility = useUi((s) => s.databaseVisibility);
  const treeConnections = useMemo<TreeConnectionInput[]>(
    () =>
      visibleProfiles
        .filter((p) => active.has(p.id))
        .map((p) => ({
          connectionId: p.id,
          multiDb: isServerWide(p),
          visibleDatabases: resolveVisibleDatabases(
            databaseVisibility[p.id],
            p.visible_databases,
          ),
        })),
    [visibleProfiles, active, databaseVisibility],
  );
  const matchCounts = useTreeMatchCounts(treeConnections, patterns, scope);
  const totals = useMemo(() => totalMatches(matchCounts.values()), [matchCounts]);

  /**
   * A scope whose connection left the tree is dropped automatically.
   *
   * Without this the box keeps a chip naming a connection that is no longer
   * there and every search silently returns nothing — which is the implicit
   * scope's original failure mode with a label stuck on it. "Left the tree"
   * covers both disconnecting and being filtered out of the environment's
   * visible subset.
   */
  useEffect(() => {
    useTreeSearch
      .getState()
      .pruneScopeAgainst((id) => active.has(id) && (!visibleSet || visibleSet.has(id)));
  }, [active, visibleSet]);

  const scopeProfile = useMemo(
    () => (scope.kind === "all" ? null : profiles.find((p) => p.id === scope.connectionId)),
    [profiles, scope],
  );

  /**
   * Connections the user re-opened by hand while the filter had folded them.
   *
   * Deliberately component-local and not `collapsedConnections`: that set is
   * persisted through `persistLaunchState`, so recording a search's folds there
   * would leave the user with permanent folds they never chose. Dropped as soon
   * as the filter is gone, which is also when the automatic folds disappear.
   */
  const [foldOverrides, setFoldOverrides] = useState<Set<string>>(() => new Set());
  useEffect(() => {
    if (!filtering) setFoldOverrides((prev) => (prev.size === 0 ? prev : new Set()));
  }, [filtering]);

  /** Id currently connecting, so its row can show a spinner and refuse clicks. */
  const [connecting, setConnecting] = useState<string | null>(null);

  /**
   * Has the filter folded this row to a single line?
   *
   * Only a *real* zero folds — a connection still loading, or a multi-DB server
   * whose databases have never been read, has no evidence for one (see
   * `rowMatchState`). Folding on a provisional zero is how a user concludes the
   * search failed and gives up on it.
   */
  function filterFolds(id: string): boolean {
    if (!filtering || foldOverrides.has(id)) return false;
    return filterFoldsIgnoringOverride(id);
  }

  function toggleFoldOverride(id: string) {
    setFoldOverrides((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  const isExpanded = (p: ConnectionProfile) =>
    active.has(p.id) && !collapsed.includes(p.id) && !filterFolds(p.id);

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
    // While the filter has this row folded for having nothing to show, the
    // chevron toggles a session-local override instead of a persisted fold:
    // the user is peeking inside a connection the search dismissed, which is
    // not a statement about how they want the tree to look next launch.
    if (filtering && filterFoldsIgnoringOverride(p.id)) {
      toggleFoldOverride(p.id);
      return;
    }
    setCollapsed(p.id, isExpanded(p));
  }

  /** `filterFolds`, blind to the override — "would the filter fold this?" */
  function filterFoldsIgnoringOverride(id: string): boolean {
    const summary = matchCounts.get(id);
    if (!summary) return false;
    const state = rowMatchState(summary);
    return state === "none" || state === "out-of-scope";
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
    const summary = matchCounts.get(p.id);
    const matchState = summary ? rowMatchState(summary) : null;
    // Dimmed, never hidden: a connection row is what the user needs in order to
    // connect it or to narrow the search to it, so the filter may quieten it
    // but must not take it away.
    const dimmedByFilter =
      filtering &&
      isActive &&
      (matchState === "none" || matchState === "out-of-scope");
    const isScopeTarget = scope.kind !== "all" && scope.connectionId === p.id;

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
              dimmedByFilter && "opacity-55 hover:opacity-100",
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
            {/* One of the three explicit ways into a scope (the others are this
                row's context menu and a database row's). Offered only while
                something is typed: narrowing an empty search would leave a chip
                with nothing to modify. */}
            {filtering && isActive && !isScopeTarget && (
              <button
                type="button"
                title={t("connectionsTree.filter.scopeHere")}
                aria-label={t("connectionsTree.filter.scopeHere")}
                className="shrink-0 rounded-sm p-0.5 text-muted-foreground opacity-0 transition-colors hover:bg-accent/40 hover:text-foreground focus-visible:opacity-100 group-hover:opacity-100"
                onClick={(e) => {
                  e.stopPropagation();
                  narrowTo({ kind: "connection", connectionId: p.id });
                  requestFocus();
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
              patterns={patterns}
              summary={summary}
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
    return <EmptyState icon={DatabaseZap} title={t("connectionsTree.empty")} />;
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
        <TreeFilterBox
          ref={filterInputRef}
          value={raw}
          onChange={setRaw}
          onClear={clearSearch}
          chip={
            scope.kind !== "all" && scopeProfile ? (
              <ScopeChip
                driver={scopeProfile.driver}
                label={scopeLabel(scope, scopeProfile.name)}
                title={
                  scope.kind === "database"
                    ? t("schema.filterScopedTo", { db: scope.database })
                    : t("schema.filterScopedToConnection", { name: scopeProfile.name })
                }
                onClear={clearScope}
                clearLabel={t("connectionsTree.filter.clearScope")}
              />
            ) : undefined
          }
          onKeyDown={(e) => {
            // Backspace on an empty box peels one level off the scope, the way
            // it removes the last chip in any tag input. Each press does
            // something visible, which is what makes the layering learnable.
            if (e.key === "Backspace" && raw.length === 0 && scope.kind !== "all") {
              e.preventDefault();
              widenScopeOneLevel();
              return;
            }
            if (e.key === "Enter") {
              // Commit now rather than waiting out the debounce. Deliberately
              // NOT "open the first match": with several connections searched at
              // once there is no single obvious first match, and guessing one is
              // the ambiguity this redesign exists to remove.
              e.preventDefault();
              commitNeedle();
            }
          }}
          placeholder={t("schema.filterPlaceholder")}
          clearLabel={t("connectionsTree.filter.clear")}
        />
        {visibleSet && (
          <div className="mt-1 text-[11px] text-muted-foreground">
            {t("connectionsTree.selectConnections.subsetActive", {
              count: visibleSet.size,
              total: profiles.length,
            })}
          </div>
        )}
        {/* The count is the only signal that the search reached a connection
            other than the one being looked at, so it is announced. */}
        {filtering && (
          <div
            role="status"
            aria-live="polite"
            className="mt-1 text-[11px] text-muted-foreground"
          >
            {totals.matches === 0 && !totals.pending && totals.cold === 0 ? (
              <>
                <span>{t("connectionsTree.filter.noMatchesAnywhere")}</span>{" "}
                {/* The honest confession of what this filter actually looks at.
                    It has never searched columns, schemas or connection names,
                    and nothing on screen has ever said so. */}
                <span className="text-muted-foreground/70">
                  {t("connectionsTree.filter.noMatchesHint")}
                </span>
              </>
            ) : (
              <span>
                {scope.kind !== "all" && scopeProfile
                  ? t("connectionsTree.filter.summaryScoped", {
                      matches: totals.matches,
                      name: scopeLabel(scope, scopeProfile.name),
                    })
                  : t("connectionsTree.filter.summary", {
                      matches: totals.matches,
                      connections: totals.connections,
                    })}
              </span>
            )}
            {totals.cold > 0 && (
              <div className="text-muted-foreground/70">
                {t("connectionsTree.filter.partialCount", {
                  count: totals.matches,
                  cold: totals.cold,
                })}
              </div>
            )}
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
  state: ReturnType<typeof rowMatchState> | null;
}) {
  const { t } = useTranslation();
  const base =
    "shrink-0 rounded-sm px-1 text-[10px] leading-4 tabular-nums";

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
        count > 0 ? "bg-brand/15 text-brand" : "bg-muted text-muted-foreground/60",
      )}
    >
      {count}
      {partial && "+"}
    </span>
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
