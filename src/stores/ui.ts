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
}));
