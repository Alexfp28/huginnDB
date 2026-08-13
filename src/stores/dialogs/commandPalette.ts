/**
 * Open state + recently-used history for the command palette (Ctrl/Cmd+K).
 *
 * Lives in its own store — rather than inside `CommandPalette.tsx`, where it
 * started — so the `window` keydown listener, the Monaco-scoped commands in
 * `QueryEditorTab` / `ViewEditorTab` (Monaco swallows Ctrl+K inside its focus
 * area, gotcha #9), the status bar button and the empty-workspace shortcuts can
 * all reach it without importing the component. Mirrors the other dialog stores
 * in this folder.
 *
 * `recent` is the only persisted slice: the ids of the last commands the user
 * ran, most recent first, which the palette floats to the top when the query is
 * empty (the "I keep coming back to this one" case). Ids of commands that no
 * longer resolve — a deleted connection, a closed tab — are simply skipped when
 * the list is rebuilt, so stale entries are harmless and never need pruning.
 */

import { create } from "zustand";
import { persist } from "zustand/middleware";

/** How many command ids the MRU list keeps. */
const RECENT_LIMIT = 12;

interface CommandPaletteState {
  open: boolean;
  /**
   * Query the palette should start with next time it opens — used to jump
   * straight into a mode (`"#"` for settings, `"?"` for help, …). Reset on
   * close, so a later plain Ctrl+K opens on the catch-all mode; it can't be
   * cleared while open without wiping whatever the user has typed since.
   */
  initialQuery: string;
  /** Ids of recently run commands, most recent first. Persisted. */
  recent: string[];
  setOpen: (open: boolean) => void;
  toggle: () => void;
  /** Open the palette pre-seeded with `query` (typically a mode prefix). */
  openWith: (query: string) => void;
  /** Record `id` as just-run, moving it to the front of the MRU list. */
  remember: (id: string) => void;
}

export const useCommandPalette = create<CommandPaletteState>()(
  persist(
    (set) => ({
      open: false,
      initialQuery: "",
      recent: [],
      setOpen: (open) => set(open ? { open } : { open, initialQuery: "" }),
      toggle: () => set((s) => ({ open: !s.open, initialQuery: "" })),
      openWith: (query) => set({ open: true, initialQuery: query }),
      remember: (id) =>
        set((s) => ({
          recent: [id, ...s.recent.filter((x) => x !== id)].slice(0, RECENT_LIMIT),
        })),
    }),
    {
      name: "huginndb.palette.v1",
      // `open` / `initialQuery` are session state; only the MRU survives a
      // restart.
      partialize: (s) => ({ recent: s.recent }),
    },
  ),
);
