/**
 * Saved queries library — a user-curated collection of named SQL
 * snippets. Persisted to localStorage and surfaced in the "Saved" tab
 * of the sidebar.
 */

import { create } from "zustand";
import { persist } from "zustand/middleware";
import { STORAGE_KEYS } from "@/lib/constants";
import { shortId } from "@/lib/utils";

export interface SavedQuery {
  id: string;
  name: string;
  description: string;
  sql: string;
  tags: string[];
  /**
   * Optional binding to a specific connection. Saved queries can be
   * opened from any connection regardless of this field; it is purely
   * informational for now.
   */
  connectionId?: string | null;
  createdAt: number;
  updatedAt: number;
}

interface SavedQueriesState {
  items: SavedQuery[];
  add: (
    input: Pick<SavedQuery, "name" | "description" | "sql" | "tags"> & {
      connectionId?: string | null;
    },
  ) => SavedQuery;
  update: (
    id: string,
    patch: Partial<Omit<SavedQuery, "id" | "createdAt">>,
  ) => void;
  remove: (id: string) => void;
}

export const useSavedQueries = create<SavedQueriesState>()(
  persist(
    (set) => ({
      items: [],
      add: (input) => {
        const now = Date.now();
        const q: SavedQuery = {
          id: `q-${shortId()}`,
          createdAt: now,
          updatedAt: now,
          connectionId: input.connectionId ?? null,
          ...input,
        };
        set((s) => ({ items: [q, ...s.items] }));
        return q;
      },
      update: (id, patch) => {
        set((s) => ({
          items: s.items.map((q) =>
            q.id === id ? { ...q, ...patch, updatedAt: Date.now() } : q,
          ),
        }));
      },
      remove: (id) =>
        set((s) => ({ items: s.items.filter((q) => q.id !== id) })),
    }),
    { name: STORAGE_KEYS.savedQueries },
  ),
);
