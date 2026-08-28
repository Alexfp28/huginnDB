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
import { createJSONStorage, persist, type StateStorage } from "zustand/middleware";
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

/**
 * `localStorage.setItem` on every write, trailing-edge throttled to
 * `delayMs`. A live sash drag calls the store's persisted `set()` on every
 * animation frame (see `nudgePanel`'s doc comment), and `persist`'s default
 * storage `JSON.stringify`s the whole state and writes it synchronously on
 * every one of those — a drag was writing to disk roughly 60 times a
 * second. `flush` forces the last pending write out immediately; the four
 * `Sash` call sites use it on `onDraggingChange(false)` so the on-disk value
 * never lags behind by up to `delayMs` after the user actually lets go.
 */
function createThrottledStorage(delayMs: number): {
  storage: StateStorage;
  flush: () => void;
} {
  let pendingKey: string | null = null;
  let pendingValue: string | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;

  function flush() {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
    if (pendingKey !== null && pendingValue !== null) {
      localStorage.setItem(pendingKey, pendingValue);
      pendingKey = null;
      pendingValue = null;
    }
  }

  return {
    flush,
    storage: {
      getItem: (name) => localStorage.getItem(name),
      setItem: (name, value) => {
        pendingKey = name;
        pendingValue = value;
        if (timer === null) timer = setTimeout(flush, delayMs);
      },
      // A removal (e.g. clearing persisted state) is rare and should never
      // be delayed behind a pending write.
      removeItem: (name) => {
        flush();
        localStorage.removeItem(name);
      },
    },
  };
}

const { storage: throttledStorage, flush: flushPanelLayoutStorage } =
  createThrottledStorage(250);

/** Force any pending (throttled) panel-layout write to disk immediately.
 *  Called on `Sash`'s `onDraggingChange(false)` — see
 *  `createThrottledStorage`'s doc comment. */
export { flushPanelLayoutStorage };

/** The four keys `nudgePanel` may adjust — exactly `PANEL_CLAMPS`'s keys. */
export type PanelSizeKey = keyof typeof PANEL_CLAMPS;

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
  /** Adjust one panel's size by a delta, reading the CURRENT value from
   *  inside the store update rather than from whatever the caller's render
   *  closed over. `Sash`'s `onResize` fires many times per drag — a caller
   *  reading its own `useSessionPanelLayout` selector and computing
   *  `current + delta` in its own render scope is reading a value that may
   *  already be stale by the time this runs, which is what let the panel
   *  edge escape the cursor at the clamp boundary (the delta kept adding to
   *  a value the store had already clamped past). */
  nudgePanel: (key: PanelSizeKey, delta: number) => void;
  openSideEditor: () => void;
  closeSideEditor: () => void;
  resetLayout: () => void;
}

const DEFAULTS: Omit<
  PanelLayoutState,
  | "toggleSchema"
  | "openSchema"
  | "toggleSaved"
  | "toggleConsole"
  | "nudgePanel"
  | "openSideEditor"
  | "closeSideEditor"
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
      nudgePanel: (key, delta) =>
        set((s) => ({ [key]: clamp(s[key] + delta, PANEL_CLAMPS[key]) })),
      openSideEditor: () => set({ sideEditorOpen: true }),
      closeSideEditor: () => set({ sideEditorOpen: false }),
      resetLayout: () => set({ ...DEFAULTS }),
    }),
    {
      name: STORAGE_KEYS.panelLayout,
      version: 1,
      storage: createJSONStorage(() => throttledStorage),
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
