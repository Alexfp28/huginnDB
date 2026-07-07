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
  /** Close every tab in the current workspace. */
  closeAll: () => void;
  /** Close every tab except `id`, which stays open and active. */
  closeOthers: (id: string) => void;
  setActive: (id: string) => void;
  /** Set (or clear, with `null`) a tab's cosmetic colour. */
  setColor: (id: string, color: string | null) => void;
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
    if (input.kind === "table" || input.kind === "security") {
      const existing = get().tabs.find(
        (t) =>
          t.kind === input.kind &&
          t.connectionId === input.connectionId &&
          (input.kind !== "table" ||
            (t.schema === input.schema && t.table === input.table)),
      );
      if (existing) {
        // Re-navigation (FK "go to referenced row") may carry a fresh
        // initial filter for an already-open table — apply it so the tab
        // refilters to the new master record instead of silently no-opping.
        if (input.initialFilters) {
          set((s) => ({
            tabs: s.tabs.map((t) =>
              t.id === existing.id
                ? { ...t, initialFilters: input.initialFilters }
                : t,
            ),
            activeId: existing.id,
          }));
        } else {
          set({ activeId: existing.id });
        }
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
  closeAll: () => set({ tabs: [], activeId: null }),
  closeOthers: (id) =>
    set((s) => {
      const kept = s.tabs.filter((t) => t.id === id);
      // If the target somehow no longer exists, fall back to clearing all
      // rather than leaving orphaned tabs the reconciler can't account for.
      return kept.length
        ? { tabs: kept, activeId: id }
        : { tabs: [], activeId: null };
    }),
  setActive: (id) => set({ activeId: id }),
  setColor: (id, color) =>
    set((s) => ({
      tabs: s.tabs.map((t) =>
        t.id === id ? { ...t, color: color ?? undefined } : t,
      ),
    })),
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
