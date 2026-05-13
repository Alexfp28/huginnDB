/**
 * Persisted ring-buffer of the queries the user has run, ordered
 * newest-first. Capped at `QUERY_HISTORY_LIMIT` to keep localStorage
 * size bounded.
 */

import { create } from "zustand";
import { persist } from "zustand/middleware";
import { QUERY_HISTORY_LIMIT, STORAGE_KEYS } from "@/lib/constants";
import type { QueryHistoryEntry } from "@/types";

interface HistoryState {
  entries: QueryHistoryEntry[];
  /** Push a new entry at the front. Older entries beyond the limit are dropped. */
  add: (
    entry: Omit<QueryHistoryEntry, "id" | "ranAt"> & {
      id?: string;
      ranAt?: number;
    },
  ) => void;
  clear: () => void;
}

export const useQueryHistory = create<HistoryState>()(
  persist(
    (set) => ({
      entries: [],
      add: (entry) =>
        set((s) => {
          const e: QueryHistoryEntry = {
            id: entry.id ?? Math.random().toString(36).slice(2, 10),
            ranAt: entry.ranAt ?? Date.now(),
            sql: entry.sql,
            connectionId: entry.connectionId,
            elapsedMs: entry.elapsedMs,
            rowsAffected: entry.rowsAffected,
            error: entry.error,
          };
          return {
            entries: [e, ...s.entries].slice(0, QUERY_HISTORY_LIMIT),
          };
        }),
      clear: () => set({ entries: [] }),
    }),
    { name: STORAGE_KEYS.queryHistory },
  ),
);
