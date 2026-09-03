/**
 * How many HuginnDB OS windows are open right now, as seen from inside this
 * one window.
 *
 * Backed by Tauri's own window registry (`getAllWindows()`), not a count we
 * track ourselves — there is nothing here to desync, since the runtime
 * already knows the true answer. `refresh()` re-asks it; `count` just caches
 * the last answer for `WindowColorBadge` to read as a stable selector
 * (gotcha #1).
 */

import { create } from "zustand";
import { getAllWindows } from "@tauri-apps/api/window";

interface WindowRegistryState {
  count: number;
  refresh: () => Promise<void>;
}

export const useWindowRegistry = create<WindowRegistryState>()((set) => ({
  count: 1,

  refresh: async () => {
    try {
      const windows = await getAllWindows();
      set({ count: windows.length });
    } catch {
      // Outside the Tauri shell, or a transient IPC failure — keep the last
      // known count rather than flashing the badge away.
    }
  },
}));
