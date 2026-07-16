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

/** Progress of a background warm run for a multi-DB parent connection. */
interface WarmProgress {
  /** A warm pass is currently iterating this parent's databases. */
  active: boolean;
  /** Databases queued for this pass (those not already cached). */
  total: number;
  /** Databases resolved so far in this pass. */
  done: number;
}

interface SchemaState {
  byConnection: Record<string, ConnectionSchema>;
  /** Background-warm progress, keyed by the multi-DB *parent* connection id. */
  warm: Record<string, WarmProgress>;
  /** Re-fetch databases + tables for `connectionId`. */
  refresh: (connectionId: string) => Promise<void>;
  /**
   * Eagerly load the table list of every database under a multi-DB parent
   * connection, so the connection-level filter reads from cache instead of
   * fanning out `openDatabaseView` + `list_tables` on the first keystroke.
   *
   * Runs with bounded concurrency to avoid opening N pools at once, skips
   * databases already cached (or in flight), and is a no-op if a pass is
   * already running for this parent. Failures per database are swallowed —
   * the database's own subtree surfaces the error when expanded.
   */
  warmDatabases: (
    parentId: string,
    visible?: string[] | null,
    concurrency?: number,
  ) => Promise<void>;
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

/** Synthetic child-connection id for browsing `database` under `parentId`. */
function childConnectionId(parentId: string, database: string) {
  return `${parentId}::db::${database}`;
}

/**
 * Parents with an in-flight warm pass. Module-level (not React state) so the
 * re-entrancy guard survives re-renders and doesn't itself trigger renders.
 */
const warmingParents = new Set<string>();

export const useSchema = create<SchemaState>((set, get) => ({
  byConnection: {},
  warm: {},
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
      set((state) => ({
        byConnection: {
          ...state.byConnection,
          [connectionId]: {
            ...(state.byConnection[connectionId] ?? emptyState()),
            databases,
            tables,
            loading: false,
            initialized: true,
          },
        },
      }));
    } catch (e) {
      set((state) => ({
        byConnection: {
          ...state.byConnection,
          [connectionId]: {
            ...(state.byConnection[connectionId] ?? emptyState()),
            loading: false,
            // Mark as initialized even on failure so the useEffect guard
            // (`!cs.initialized && !cs.loading`) does not auto-retry and
            // create a loop. The user can retry manually via the refresh button.
            initialized: true,
            error: String(e),
          },
        },
      }));
    }
  },
  warmDatabases: async (parentId, visible = null, concurrency = 5) => {
    if (warmingParents.has(parentId)) return;
    const parent = get().byConnection[parentId];
    if (!parent || !parent.initialized) return;

    // Snapshot the databases still missing from the cache. The on-demand
    // prefetch may grab some of these while we run, so each worker re-checks
    // before fetching to avoid a redundant round-trip. When the connection has
    // a DataGrip-style visible-databases subset (#64), warm only those — the
    // whole point is to skip fanning out across every database on the server.
    const visibleSet = visible && visible.length > 0 ? new Set(visible) : null;
    const queue = parent.databases
      .map((db) => ({ db: db.name, childId: childConnectionId(parentId, db.name) }))
      .filter(({ db, childId }) => {
        if (visibleSet && !visibleSet.has(db)) return false;
        const c = get().byConnection[childId];
        return !(c?.initialized || c?.loading);
      });
    if (queue.length === 0) return;

    warmingParents.add(parentId);
    const total = queue.length;
    let done = 0;
    set((s) => ({
      warm: { ...s.warm, [parentId]: { active: true, total, done } },
    }));

    const refresh = get().refresh;
    let cursor = 0;
    const worker = async () => {
      while (cursor < queue.length) {
        const { db, childId } = queue[cursor++];
        const c = get().byConnection[childId];
        if (!(c?.initialized || c?.loading)) {
          try {
            const resolved = await api.openDatabaseView(parentId, db);
            await refresh(resolved);
          } catch {
            // Swallowed — surfaced via the database's subtree on expand.
          }
        }
        done += 1;
        set((s) => {
          const cur = s.warm[parentId];
          if (!cur) return {};
          return { warm: { ...s.warm, [parentId]: { ...cur, done } } };
        });
      }
    };

    await Promise.all(
      Array.from({ length: Math.min(concurrency, queue.length) }, worker),
    );

    warmingParents.delete(parentId);
    set((s) => {
      const cur = s.warm[parentId] ?? { total, done };
      return { warm: { ...s.warm, [parentId]: { ...cur, active: false } } };
    });
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
    warmingParents.delete(connectionId);
    set((state) => {
      const copy = { ...state.byConnection };
      delete copy[connectionId];
      const warm = { ...state.warm };
      delete warm[connectionId];
      return { byConnection: copy, warm };
    });
  },
}));
