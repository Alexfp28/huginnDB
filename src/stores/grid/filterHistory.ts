/**
 * In-memory ring buffer of recent free-text search queries used by the
 * data-grid toolbar. Scoped per-connection so that filters typed against
 * a Postgres dump don't bleed into a separate SQLite profile, while
 * still letting the user re-apply the same search across tables of the
 * same database.
 *
 * Intentionally NOT persisted — the user explicitly asked for it to
 * reset on app restart or disconnect, so a plain Zustand store is the
 * right fit. `clearForConnection` is called by the connections store on
 * disconnect (and on app teardown by virtue of being in-memory).
 */

import { create } from "zustand";

/** Cap so the dropdown stays scannable. Anything older falls off the tail. */
const HISTORY_LIMIT = 20;

interface FilterHistoryState {
  /** Newest-first per connection id. */
  byConnection: Record<string, string[]>;
  /**
   * Record `query` against `connectionId`. No-op for empty / whitespace.
   * If `query` already exists, it is hoisted to the front so the most
   * recently used entry stays at the top.
   */
  push: (connectionId: string, query: string) => void;
  /** Drop all history for `connectionId` (used on disconnect). */
  clearForConnection: (connectionId: string) => void;
  /** Wipe every connection's history (used on "disconnect all"). */
  clearAll: () => void;
}

export const useFilterHistory = create<FilterHistoryState>((set) => ({
  byConnection: {},
  push: (connectionId, query) => {
    const trimmed = query.trim();
    if (!trimmed) return;
    set((state) => {
      const current = state.byConnection[connectionId] ?? [];
      const deduped = current.filter((q) => q !== trimmed);
      const next = [trimmed, ...deduped].slice(0, HISTORY_LIMIT);
      return {
        byConnection: { ...state.byConnection, [connectionId]: next },
      };
    });
  },
  clearForConnection: (connectionId) =>
    set((state) => {
      if (!(connectionId in state.byConnection)) return state;
      const next = { ...state.byConnection };
      delete next[connectionId];
      return { byConnection: next };
    }),
  clearAll: () => set({ byConnection: {} }),
}));
