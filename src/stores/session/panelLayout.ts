/**
 * Outer shell layout — activity-bar-driven docked panels (Schema, Saved,
 * Console) plus the cell editor split inside the workspace island.
 *
 * Replaces the old outer `DockviewReact` (5 equal-rank panels) with fixed
 * roles: two side panels toggled from an activity bar, a bottom console
 * dock, and a cell-editor split owned by the island itself. Dockview gave
 * sash-resize and `toJSON` persistence for free, but its panel API has no
 * `setVisible` (see `DockviewPanelApi` vs `GridviewPanelApi` in
 * `dockview-core`) — there's no way to collapse a panel to 0px without
 * removing it, and removing/re-adding reflows siblings proportionally
 * (the same effect `trackSchemaWidthAroundSideEditor` used to patch around
 * for the old side-editor panel). Plain state + hand-rolled sashes (see
 * `Sash.tsx`) sidestep that entirely: a closed panel is just `width: 0` in
 * CSS, no dockview involved.
 *
 * Every consumer reads primitive fields (booleans/numbers) as selectors —
 * reference-stable by construction, per the Zustand rule in CLAUDE.md.
 */

import { create } from "zustand";
import { persist } from "zustand/middleware";
import { STORAGE_KEYS } from "@/lib/constants";

const SCHEMA_WIDTH_DEFAULT = 280;
const SAVED_WIDTH_DEFAULT = 260;
const CONSOLE_HEIGHT_DEFAULT = 190;
const SIDE_EDITOR_WIDTH_DEFAULT = 420;

export const PANEL_CLAMPS = {
  schemaWidth: { min: 200, max: 600 },
  savedWidth: { min: 200, max: 600 },
  consoleHeight: { min: 120, max: 600 },
  sideEditorWidth: { min: 280, max: 720 },
} as const;

function clamp(value: number, { min, max }: { min: number; max: number }): number {
  return Math.min(max, Math.max(min, value));
}

interface PanelLayoutState {
  schemaOpen: boolean;
  schemaWidth: number;
  savedOpen: boolean;
  savedWidth: number;
  consoleOpen: boolean;
  consoleHeight: number;
  sideEditorOpen: boolean;
  sideEditorWidth: number;

  toggleSchema: () => void;
  openSchema: () => void;
  toggleSaved: () => void;
  toggleConsole: () => void;
  setSchemaWidth: (width: number) => void;
  setSavedWidth: (width: number) => void;
  setConsoleHeight: (height: number) => void;
  openSideEditor: () => void;
  closeSideEditor: () => void;
  setSideEditorWidth: (width: number) => void;
  resetLayout: () => void;
}

const DEFAULTS: Omit<
  PanelLayoutState,
  | "toggleSchema"
  | "openSchema"
  | "toggleSaved"
  | "toggleConsole"
  | "setSchemaWidth"
  | "setSavedWidth"
  | "setConsoleHeight"
  | "openSideEditor"
  | "closeSideEditor"
  | "setSideEditorWidth"
  | "resetLayout"
> = {
  schemaOpen: true,
  schemaWidth: SCHEMA_WIDTH_DEFAULT,
  savedOpen: false,
  savedWidth: SAVED_WIDTH_DEFAULT,
  consoleOpen: false,
  consoleHeight: CONSOLE_HEIGHT_DEFAULT,
  sideEditorOpen: false,
  sideEditorWidth: SIDE_EDITOR_WIDTH_DEFAULT,
};

export const useSessionPanelLayout = create<PanelLayoutState>()(
  persist(
    (set) => ({
      ...DEFAULTS,
      toggleSchema: () => set((s) => ({ schemaOpen: !s.schemaOpen })),
      openSchema: () => set({ schemaOpen: true }),
      toggleSaved: () => set((s) => ({ savedOpen: !s.savedOpen })),
      toggleConsole: () => set((s) => ({ consoleOpen: !s.consoleOpen })),
      setSchemaWidth: (width) =>
        set({ schemaWidth: clamp(width, PANEL_CLAMPS.schemaWidth) }),
      setSavedWidth: (width) =>
        set({ savedWidth: clamp(width, PANEL_CLAMPS.savedWidth) }),
      setConsoleHeight: (height) =>
        set({ consoleHeight: clamp(height, PANEL_CLAMPS.consoleHeight) }),
      openSideEditor: () => set({ sideEditorOpen: true }),
      closeSideEditor: () => set({ sideEditorOpen: false }),
      setSideEditorWidth: (width) =>
        set({ sideEditorWidth: clamp(width, PANEL_CLAMPS.sideEditorWidth) }),
      resetLayout: () => set({ ...DEFAULTS }),
    }),
    {
      name: STORAGE_KEYS.panelLayout,
      version: 1,
      migrate: (_persisted, version) => {
        if (version !== 1) return { ...DEFAULTS };
        return _persisted as PanelLayoutState;
      },
    },
  ),
);

/** Read-only accessor for the side-editor's open state, for call sites
 *  (`DataGrid`, `CellEditor`) that only need to check/open it imperatively
 *  outside of a React render. */
export function isSideEditorOpen(): boolean {
  return useSessionPanelLayout.getState().sideEditorOpen;
}
