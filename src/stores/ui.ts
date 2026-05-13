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
}

export const useUi = create<UiState>((set) => ({
  selectedConnectionId: null,
  setSelectedConnectionId: (id) => set({ selectedConnectionId: id }),
}));
