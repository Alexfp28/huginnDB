/**
 * Tabs store — the open table-data and query-editor tabs in the main
 * workspace.
 *
 * Tab ids are random short strings rather than UUIDs because they only
 * need to be unique within the current session.
 */

import { create } from "zustand";
import type { AppTab } from "@/types";

interface TabsState {
  tabs: AppTab[];
  activeId: string | null;
  /**
   * Open a new tab and make it active. For `kind: "table"` tabs, a
   * matching (connection, schema, table) already in the list is reused
   * instead of being duplicated.
   */
  open: (tab: Omit<AppTab, "id"> & { id?: string }) => string;
  /** Remove a tab. If it was active, the previous tab becomes active. */
  close: (id: string) => void;
  setActive: (id: string) => void;
  /** Update the in-memory SQL of a query tab. */
  updateQuery: (id: string, query: string) => void;
  /**
   * Store the row count and elapsed time from the most recent query execution
   * in `id`. Used by the status bar to display live execution metadata.
   */
  updateQueryStats: (
    id: string,
    stats: { rows: number; elapsed_ms: number },
  ) => void;
  /** Drop every tab for a connection (called on disconnect). */
  closeForConnection: (connectionId: string) => void;
  /**
   * Replace every tab plus the active id in one shot. Used by the
   * per-connection workspace restore (`persistedTabs.hydrate`) so the
   * incoming snapshot lands atomically instead of as a stream of `open`
   * calls — keeps the active-tab pointer correct and avoids the dedup
   * branch in `open` from collapsing legitimately-distinct tabs.
   */
  replaceAll: (tabs: AppTab[], activeId: string | null) => void;
}

function genId() {
  return Math.random().toString(36).slice(2, 10);
}

export const useTabs = create<TabsState>((set, get) => ({
  tabs: [],
  activeId: null,
  open: (input) => {
    if (input.kind === "table") {
      const existing = get().tabs.find(
        (t) =>
          t.kind === "table" &&
          t.connectionId === input.connectionId &&
          t.schema === input.schema &&
          t.table === input.table,
      );
      if (existing) {
        set({ activeId: existing.id });
        return existing.id;
      }
    }
    const id = input.id ?? genId();
    const tab: AppTab = { ...input, id } as AppTab;
    set((s) => ({ tabs: [...s.tabs, tab], activeId: id }));
    return id;
  },
  close: (id) => {
    set((s) => {
      const tabs = s.tabs.filter((t) => t.id !== id);
      let activeId = s.activeId;
      if (activeId === id) {
        activeId = tabs.length ? tabs[tabs.length - 1].id : null;
      }
      return { tabs, activeId };
    });
  },
  setActive: (id) => set({ activeId: id }),
  updateQuery: (id, query) =>
    set((s) => ({
      tabs: s.tabs.map((t) => (t.id === id ? { ...t, query } : t)),
    })),
  updateQueryStats: (id, stats) =>
    set((s) => ({
      tabs: s.tabs.map((t) =>
        t.id === id ? { ...t, lastQueryStats: stats } : t,
      ),
    })),
  replaceAll: (tabs, activeId) => set({ tabs, activeId }),
  closeForConnection: (connectionId) =>
    set((s) => {
      const tabs = s.tabs.filter((t) => t.connectionId !== connectionId);
      const activeStillThere =
        s.activeId && tabs.some((t) => t.id === s.activeId);
      return {
        tabs,
        activeId: activeStillThere
          ? s.activeId
          : tabs.length
            ? tabs[tabs.length - 1].id
            : null,
      };
    }),
}));
