/**
 * Saved queries library — a user-curated collection of named SQL
 * snippets. Persisted to localStorage and surfaced in the "Saved" tab
 * of the sidebar.
 */

import { create } from "zustand";
import { persist } from "zustand/middleware";
import { STORAGE_KEYS } from "@/lib/constants";

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
  /** Return entries that include `tag`. */
  byTag: (tag: string) => SavedQuery[];
}

function genId() {
  return `q-${Math.random().toString(36).slice(2, 10)}`;
}

export const useSavedQueries = create<SavedQueriesState>()(
  persist(
    (set, get) => ({
      items: [],
      add: (input) => {
        const now = Date.now();
        const q: SavedQuery = {
          id: genId(),
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
      byTag: (tag) => get().items.filter((q) => q.tags.includes(tag)),
    }),
    { name: STORAGE_KEYS.savedQueries },
  ),
);
