/**
 * UI-only state shared across the app shell — currently just the
 * "currently selected" connection id.
 *
 * This was previously local state inside `App.tsx`, but with the move
 * to a dockview-based docking layout each panel renders independently
 * (it can't read a sibling component's local state). Lifting it into
 * a tiny store keeps the panels stateless and avoids threading the
 * value through dockview params, which would force per-change calls
 * to `panel.api.updateParameters`.
 */

import { create } from "zustand";

interface UiState {
  /** The connection profile currently focused in the workspace. */
  selectedConnectionId: string | null;
  setSelectedConnectionId: (id: string | null) => void;
  /**
   * Connections the user folded in the connections tree (#107). A row follows
   * its pool by default — open when live — so this holds only the overrides.
   *
   * It lives here rather than inside `ConnectionsTree` because it is persisted:
   * `persistLaunchState` reads it, and it is restored per environment alongside
   * the reconnect. See `LaunchState.collapsedConnections` for why the collapsed
   * set is the one stored.
   */
  collapsedConnections: string[];
  toggleConnectionCollapsed: (id: string) => void;
  /** Fold a connection, or unfold it (used when connecting expands a row). */
  setConnectionCollapsed: (id: string, collapsed: boolean) => void;
  /** Replace the whole set — restoring an environment, or clearing on the way out. */
  setCollapsedConnections: (ids: string[]) => void;
  /**
   * Free-text filter for the schema tree, owned at the tree level rather than
   * duplicated inside every expanded connection. It only ever applies to
   * `selectedConnectionId`'s subtree — `ConnectionsTree` passes an empty
   * string to every other connection's `SchemaExplorer`, so the rest of the
   * tree stays visible, unfiltered. Not persisted: a search is a momentary
   * tool, not session state worth restoring.
   */
  treeFilter: string;
  setTreeFilter: (value: string) => void;
  /**
   * DataGrip-style subset of saved connections to show in the connections
   * tree. `null` means "show all". Persisted per environment via
   * `LaunchState.visibleConnections` — restored on launch/switch by
   * `useEnvironments.restoreSession`, cleared on the way out by `switchTo` —
   * rather than in `usePreferences`, which is global: a filter tuned for one
   * environment (e.g. "Pruebas") must not stay active after switching to
   * another (e.g. "Predeterminado"), which is exactly what living in global
   * prefs used to cause.
   */
  visibleConnections: string[] | null;
  setVisibleConnections: (ids: string[] | null) => void;
  /**
   * Per-connection override of the "databases to show" subset, keyed by
   * connection id — the same "hide the noise" filter as `visibleConnections`,
   * one level down.
   *
   * `ConnectionProfile.visible_databases` remains the default (it is global, and
   * ships with the profile through export and shared origins); an entry here
   * overrides it for the active environment only. Key present → override, key
   * absent → profile. The value is nullable on purpose: `null` means "show all
   * here", which is how an environment widens a subset the profile narrows.
   * Never read this map directly in a component — go through
   * `useVisibleDatabases`, which resolves both layers.
   *
   * Persisted per environment via `LaunchState.databaseVisibility`, restored and
   * cleared in exactly the same three places as `visibleConnections`.
   */
  databaseVisibility: Record<string, string[] | null>;
  /** Replace the whole map — restoring an environment, or clearing on the way out. */
  setDatabaseVisibility: (map: Record<string, string[] | null>) => void;
  /**
   * Set one connection's override, or drop it (`undefined`) so the connection
   * falls back to its profile's subset.
   */
  setDatabaseVisibilityFor: (
    connectionId: string,
    value: string[] | null | undefined,
  ) => void;
}

export const useUi = create<UiState>((set) => ({
  selectedConnectionId: null,
  setSelectedConnectionId: (id) => set({ selectedConnectionId: id }),

  collapsedConnections: [],
  toggleConnectionCollapsed: (id) =>
    set((s) => ({
      collapsedConnections: s.collapsedConnections.includes(id)
        ? s.collapsedConnections.filter((c) => c !== id)
        : [...s.collapsedConnections, id],
    })),
  setConnectionCollapsed: (id, collapsed) =>
    set((s) => {
      const has = s.collapsedConnections.includes(id);
      if (has === collapsed) return s;
      return {
        collapsedConnections: collapsed
          ? [...s.collapsedConnections, id]
          : s.collapsedConnections.filter((c) => c !== id),
      };
    }),
  setCollapsedConnections: (ids) => set({ collapsedConnections: ids }),

  treeFilter: "",
  setTreeFilter: (value) => set({ treeFilter: value }),

  visibleConnections: null,
  setVisibleConnections: (ids) => set({ visibleConnections: ids }),

  databaseVisibility: {},
  setDatabaseVisibility: (map) => set({ databaseVisibility: map }),
  setDatabaseVisibilityFor: (connectionId, value) =>
    set((s) => {
      const next = { ...s.databaseVisibility };
      // `undefined` removes the key rather than storing it: the difference
      // between "no override" and "override = show all" (`null`) is the whole
      // point of the two layers, and `{ id: undefined }` would serialise as the
      // latter.
      if (value === undefined) delete next[connectionId];
      else next[connectionId] = value;
      return { databaseVisibility: next };
    }),
}));

/**
 * The three view filters, as one value.
 *
 * `collapsedConnections`, `visibleConnections` and `databaseVisibility` are
 * always read, written and cleared together: they are what an environment's
 * `LaunchState` means by "how does the tree look", as opposed to what it
 * reopens. They were spelled out one `useUi.getState()` call at a time in five
 * places (`applyLocalView`, `restoreSession`, `switchTo`'s capture and its
 * teardown, `replicate`'s capture, plus `persistLaunchState`), which is five
 * chances for a fourth filter to be added to four of them.
 *
 * `LaunchState` is structurally a superset of this, so a snapshot straight off
 * the backend is a valid argument.
 */
export interface LaunchView {
  collapsedConnections: string[];
  visibleConnections: string[] | null;
  databaseVisibility: Record<string, string[] | null>;
}

/**
 * "Nothing folded, everything shown, no overrides" — the defaults every consumer
 * of a `LaunchView` shares, in one place so the neutral value and the value
 * `applyLaunchView` falls back to can never drift apart.
 */
export function emptyLaunchView(): LaunchView {
  return { collapsedConnections: [], visibleConnections: null, databaseVisibility: {} };
}

/** This window's current filters, for writing into a `LaunchState`. */
export function currentLaunchView(): LaunchView {
  const s = useUi.getState();
  return {
    collapsedConnections: s.collapsedConnections,
    visibleConnections: s.visibleConnections,
    databaseVisibility: s.databaseVisibility,
  };
}

/**
 * Point this window's filters at a launch snapshot.
 *
 * Every write is **unconditional**, and the defaults are meaningful values
 * rather than "leave it alone": `null` visible-connections is "show all" and an
 * empty `databaseVisibility` is "every connection follows its profile", so
 * skipping either as falsy is exactly how a filter tuned for the environment
 * being left used to stay active in the one being entered.
 *
 * Folds go first: set after the connections render, a row the user had folded
 * would show open for as long as the reconnect takes and then snap shut.
 */
export function applyLaunchView(view: Partial<LaunchView> | null | undefined): void {
  const empty = emptyLaunchView();
  const s = useUi.getState();
  s.setCollapsedConnections(view?.collapsedConnections ?? empty.collapsedConnections);
  s.setVisibleConnections(view?.visibleConnections ?? empty.visibleConnections);
  s.setDatabaseVisibility(view?.databaseVisibility ?? empty.databaseVisibility);
}

/**
 * Reset the filters to "nothing folded, everything shown, no overrides".
 *
 * Called on the way *out* of an environment rather than on the way in, because
 * `restoreSession` returns early when `reconnectOnLaunch` is off — leaving the
 * clear to the incoming side would carry the outgoing environment's filters
 * across the switch.
 */
export function clearLaunchView(): void {
  applyLaunchView(null);
}
