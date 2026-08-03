/**
 * Schema store — per-connection cache of database / table / column /
 * index metadata, plus the expanded-node bookkeeping for the explorer
 * tree. Data is fetched lazily as the user expands tree nodes.
 */

import { create } from "zustand";
import { api } from "@/lib/tauri";
import type {
  ColumnInfo,
  DatabaseInfo,
  IndexInfo,
  TableInfo,
} from "@/types";

/** Per-connection slice of schema state. */
interface ConnectionSchema {
  databases: DatabaseInfo[];
  tables: TableInfo[];
  /** Columns keyed by `${schema}.${table}`. */
  columns: Record<string, ColumnInfo[]>;
  /** Indexes keyed by `${schema}.${table}`. */
  indexes: Record<string, IndexInfo[]>;
  /** Set of tree-node keys (e.g. `schema:public`, `table:public.users`). */
  expanded: Set<string>;
  loading: boolean;
  error: string | null;
  /**
   * True once `refresh` has completed at least once successfully for this
   * connection. Stays false when the slice is created by `replaceExpanded`
   * (workspace hydration) so the explorer can distinguish "data loaded and
   * empty" from "never fetched yet".
   */
  initialized: boolean;
}

interface SchemaState {
  byConnection: Record<string, ConnectionSchema>;
  /** Re-fetch databases + tables for `connectionId`. */
  refresh: (connectionId: string) => Promise<void>;
  /** Toggle a tree-node key in the `expanded` set. */
  toggleNode: (connectionId: string, key: string) => void;
  /** Populate `columns[tableKey(schema, table)]`. */
  loadColumns: (
    connectionId: string,
    schema: string | undefined,
    table: string,
  ) => Promise<void>;
  /** Populate `indexes[tableKey(schema, table)]`. */
  loadIndexes: (
    connectionId: string,
    schema: string | undefined,
    table: string,
  ) => Promise<void>;
  /** Drop all cached data for `connectionId` (called on disconnect). */
  drop: (connectionId: string) => void;
  /**
   * Replace the expanded-node set for `connectionId` in one shot. Used by
   * the persisted-workspace hydration path so the saved tree state lands
   * without firing N `toggleNode` events.
   */
  replaceExpanded: (connectionId: string, expanded: Set<string>) => void;
}

function emptyState(): ConnectionSchema {
  return {
    databases: [],
    tables: [],
    columns: {},
    indexes: {},
    expanded: new Set(),
    loading: false,
    error: null,
    initialized: false,
  };
}

/** Stable cache key for a (schema, table) pair. */
export function tableKey(schema: string | undefined, table: string) {
  return `${schema ?? ""}.${table}`;
}

export const useSchema = create<SchemaState>((set, get) => ({
  byConnection: {},
  refresh: async (connectionId) => {
    set((state) => ({
      byConnection: {
        ...state.byConnection,
        [connectionId]: {
          ...(state.byConnection[connectionId] ?? emptyState()),
          loading: true,
          error: null,
        },
      },
    }));
    try {
      const [databases, tables] = await Promise.all([
        api.listDatabases(connectionId),
        api.listTables(connectionId),
      ]);
      set((state) => {
        // Discard a response that outlived its slice — see the note in the
        // catch below.
        const current = state.byConnection[connectionId];
        if (!current) return state;
        return {
          byConnection: {
            ...state.byConnection,
            [connectionId]: {
              ...current,
              databases,
              tables,
              loading: false,
              initialized: true,
            },
          },
        };
      });
    } catch (e) {
      set((state) => {
        // If `drop(connectionId)` ran while this call was in flight, the
        // connection is gone (disconnected, or its environment was switched
        // away from) and this result is stale. Writing it would *resurrect* the
        // slice, because the spread below used to fall back to `emptyState()`
        // for a missing entry — and resurrecting it on the error path is
        // permanent damage, not a cosmetic glitch: the entry comes back with
        // `initialized: true`, which is exactly the flag that stops the
        // explorer's `!initialized && !loading` guard from ever retrying.
        //
        // That is the "not connected: <id>" that survived a full reconnect: the
        // teardown closed the pool, an in-flight `list_tables` lost the race and
        // landed after the drop, and the healthy connection that came back
        // inherited a poisoned slice no automatic path would ever refresh.
        const current = state.byConnection[connectionId];
        if (!current) return state;
        return {
          byConnection: {
            ...state.byConnection,
            [connectionId]: {
              ...current,
              loading: false,
              // Mark as initialized even on failure so the useEffect guard
              // (`!cs.initialized && !cs.loading`) does not auto-retry and
              // create a loop. The user can retry manually via the refresh
              // button. Safe only because of the staleness check above.
              initialized: true,
              error: String(e),
            },
          },
        };
      });
    }
  },
  toggleNode: (connectionId, key) => {
    const cur = get().byConnection[connectionId] ?? emptyState();
    const expanded = new Set(cur.expanded);
    if (expanded.has(key)) expanded.delete(key);
    else expanded.add(key);
    set((state) => ({
      byConnection: {
        ...state.byConnection,
        [connectionId]: { ...cur, expanded },
      },
    }));
  },
  loadColumns: async (connectionId, schema, table) => {
    const cols = await api.listColumns(connectionId, schema, table);
    const cur = get().byConnection[connectionId] ?? emptyState();
    set((state) => ({
      byConnection: {
        ...state.byConnection,
        [connectionId]: {
          ...cur,
          columns: { ...cur.columns, [tableKey(schema, table)]: cols },
        },
      },
    }));
  },
  loadIndexes: async (connectionId, schema, table) => {
    const idx = await api.listIndexes(connectionId, schema, table);
    const cur = get().byConnection[connectionId] ?? emptyState();
    set((state) => ({
      byConnection: {
        ...state.byConnection,
        [connectionId]: {
          ...cur,
          indexes: { ...cur.indexes, [tableKey(schema, table)]: idx },
        },
      },
    }));
  },
  replaceExpanded: (connectionId, expanded) => {
    const cur = get().byConnection[connectionId] ?? emptyState();
    set((state) => ({
      byConnection: {
        ...state.byConnection,
        [connectionId]: { ...cur, expanded },
      },
    }));
  },
  drop: (connectionId) => {
    set((state) => {
      const copy = { ...state.byConnection };
      delete copy[connectionId];
      return { byConnection: copy };
    });
  },
}));
