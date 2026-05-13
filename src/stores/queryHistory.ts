import { create } from "zustand";
import { persist } from "zustand/middleware";
import type { QueryHistoryEntry } from "@/types";

const MAX = 50;

interface HistoryState {
  entries: QueryHistoryEntry[];
  add: (entry: Omit<QueryHistoryEntry, "id" | "ranAt"> & { id?: string; ranAt?: number }) => void;
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
          return { entries: [e, ...s.entries].slice(0, MAX) };
        }),
      clear: () => set({ entries: [] }),
    }),
    { name: "huginn.queryHistory" },
  ),
);
