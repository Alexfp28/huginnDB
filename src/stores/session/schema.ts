/**
 * Schema store — per-connection cache of database / table / column /
 * index metadata, plus the expanded-node bookkeeping for the explorer
 * tree. Data is fetched lazily as the user expands tree nodes.
 */

import { useEffect } from "react";
import { create } from "zustand";
import { api } from "@/lib/tauri";
import { isDatabaseViewOf, parentConnectionId } from "@/lib/connectionLabel";
import type {
  ColumnInfo,
  DatabaseInfo,
  IndexInfo,
  TableInfo,
} from "@/types";

/**
 * Fetch a connection's schema once, on mount, unless it is already loaded or a
 * fetch is in flight.
 *
 * Both explorers had a byte-identical copy of this effect, and the guard is the
 * subtle part: `!cs.loading` matters because `refresh` calls
 * `set({ loading: true })`, which mints a new slice reference, re-runs the
 * effect, and would fire a second concurrent fetch before the first returns —
 * a tight loop on the slower drivers (MySQL). The `!cs` arm covers the very
 * first render, before any slice exists.
 *
 * `id` is whatever the caller renders for: a profile id in the single-database
 * explorer, the *parent* id in the multi-database one (its own tables live in
 * the `::db::` child slices, gotcha #36).
 */
export function useEnsureSchemaLoaded(id: string): void {
  const cs = useSchema((s) => s.byConnection[id]);
  const refresh = useSchema((s) => s.refresh);
  useEffect(() => {
    if (!cs || (!cs.initialized && !cs.loading)) refresh(id);
  }, [id, cs, refresh]);
}

/** Per-connection slice of schema state. */
interface ConnectionSchema {
  databases: DatabaseInfo[];
  tables: TableInfo[];
  /** Columns keyed by `${schema}.${table}`. */
  columns: Record<string, ColumnInfo[]>;
  /** Indexes keyed by `${schema}.${table}`. */
  indexes: Record<string, IndexInfo[]>;
  /**
   * Error from the last `loadColumns` call for a given table key, if it
   * failed. Lets the explorer stop showing a loading skeleton forever on a
   * rejected promise (a timed-out or `NotConnected` metadata call) and offer
   * a retry instead. Cleared on the next successful load for that key.
   */
  columnErrors: Record<string, string>;
  /** Same as `columnErrors`, for `loadIndexes`. */
  indexErrors: Record<string, string>;
  /**
   * On-disk size per database name, from `getDatabaseSizes` (#153).
   *
   * A name is present only once the engine answered a size for it. A database
   * the engine would not size is simply absent, which is the same thing the
   * absent `size_bytes` key means and keeps "would not say" distinct from
   * "empty" all the way to the badge.
   */
  databaseSizes: Record<string, number>;
  /** True while `loadDatabaseSizes` is in flight, so it can't be re-entered. */
  databaseSizesLoading: boolean;
  /** True once a `loadDatabaseSizes` pass has settled — success or failure.
   *  Distinguishes "no badge because nothing was asked for" from "asked, and
   *  this engine would not say". */
  databaseSizesLoaded: boolean;
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
  /**
   * Re-fetch databases + tables for `connectionId`, **invalidating** the
   * cached columns/indexes with them and re-loading the ones whose tree node
   * is still open.
   *
   * This only ever touches the one slice it is given. On a multi-DB
   * connection that is almost never the slice the user is looking at — use
   * [`refreshTree`] from anything holding a profile id.
   */
  refresh: (connectionId: string) => Promise<void>;
  /**
   * Refresh a connection *and* every per-database child slice opened beneath
   * it (`<parent>::db::<db>`).
   *
   * A server-wide connection's tables live in the child slices, never in the
   * parent's — the parent's `list_tables` answers for the login's default
   * database (Postgres) or for nothing at all (MySQL, where `SELECT
   * DATABASE()` is NULL). So a plain `refresh(parentId)` re-fetched a list
   * nobody renders and left the visible subtree untouched, which is what made
   * "Refresh" look broken for a table created outside the app.
   */
  refreshTree: (connectionId: string) => Promise<void>;
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
  /**
   * Fetch the per-database sizes for `connectionId`, once.
   *
   * **Deferred on purpose, and never part of the launch refresh.** On Postgres
   * this is `pg_database_size`, which is not a catalog read but a walk of the
   * database's directory calling `stat` per file — seconds on a server with
   * nineteen large databases, against a 20 s backend timeout. It is called
   * when the tree actually renders a database node, not when a connection
   * opens.
   *
   * Failure is swallowed: this is a badge, and an engine that will not answer
   * should cost the badge and nothing else.
   */
  loadDatabaseSizes: (connectionId: string) => Promise<void>;
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
    columnErrors: {},
    indexErrors: {},
    databaseSizes: {},
    databaseSizesLoading: false,
    databaseSizesLoaded: false,
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
      // Tables whose per-table metadata was cached *and* whose node is still
      // open — read before the wipe below so they can be re-fetched after it.
      // Computed here rather than inside the `set` updater to keep that
      // updater a pure state transition.
      const before = get().byConnection[connectionId];
      const reloadColumns: TableInfo[] = [];
      const reloadIndexes: TableInfo[] = [];
      for (const t of tables) {
        if (!before) break;
        const k = tableKey(t.schema, t.name);
        if (!before.expanded.has(`table:${k}`)) continue;
        if (before.columns[k] || before.columnErrors[k]) reloadColumns.push(t);
        if (before.indexes[k] || before.indexErrors[k]) reloadIndexes.push(t);
      }
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
              // Invalidate the per-table metadata too. Keeping it across a
              // refresh is what made an `ALTER TABLE ADD COLUMN` performed
              // outside the app invisible forever: `TableRow` only calls
              // `loadColumns` when the key is *absent* (a deliberate guard, so
              // collapsing and re-expanding doesn't re-query), and the only
              // other thing that ever cleared these was `drop()` on
              // disconnect. "Refresh" has to mean the schema, not just the
              // table list.
              columns: {},
              indexes: {},
              columnErrors: {},
              indexErrors: {},
              // Sizes go with them, for the reason the comment above gives:
              // "Refresh" means the schema. A database that grew — or was
              // dropped and recreated — outside the app would otherwise keep
              // showing the size it had when the tree was first opened, with
              // no way to correct it short of disconnecting. Cleared rather
              // than re-fetched: the next database node to render asks again,
              // so the cost is only paid if something is actually on screen.
              databaseSizes: {},
              databaseSizesLoading: false,
              databaseSizesLoaded: false,
              loading: false,
              initialized: true,
            },
          },
        };
      });
      // Re-populate what the user has open, so an expanded table comes back
      // with its (now current) columns instead of an empty node the guard
      // above would never fill on its own.
      await Promise.all([
        ...reloadColumns.map((t) => get().loadColumns(connectionId, t.schema, t.name)),
        ...reloadIndexes.map((t) => get().loadIndexes(connectionId, t.schema, t.name)),
      ]);
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
  refreshTree: async (connectionId) => {
    // Accept either id shape: a child id resolves to its parent, so a caller
    // never has to know which one it is holding.
    const parent = parentConnectionId(connectionId);
    const ids = new Set([
      parent,
      connectionId,
      ...Object.keys(get().byConnection).filter((id) =>
        isDatabaseViewOf(id, parent),
      ),
    ]);
    // Per-connection failures are already captured on each slice's `error`,
    // so one unreachable child can't abort the rest.
    await Promise.all([...ids].map((id) => get().refresh(id)));
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
    const key = tableKey(schema, table);
    try {
      const cols = await api.listColumns(connectionId, schema, table);
      set((state) => {
        // A response outliving its slice (the connection was dropped while
        // this call was in flight — see the note in `refresh`'s catch
        // branch) must not resurrect it.
        const current = state.byConnection[connectionId];
        if (!current) return state;
        // Drop the key entirely rather than storing `undefined`, so
        // `cs.columnErrors?.[key]` reads as absent, not as a falsy value.
        const { [key]: _cleared, ...columnErrors } = current.columnErrors;
        return {
          byConnection: {
            ...state.byConnection,
            [connectionId]: {
              ...current,
              columns: { ...current.columns, [key]: cols },
              columnErrors,
            },
          },
        };
      });
    } catch (e) {
      // Never let a rejected promise here leave the explorer's column cell
      // stuck on its loading skeleton forever — record the error instead so
      // the UI can render a retry affordance.
      set((state) => {
        const current = state.byConnection[connectionId];
        if (!current) return state;
        return {
          byConnection: {
            ...state.byConnection,
            [connectionId]: {
              ...current,
              columnErrors: { ...current.columnErrors, [key]: String(e) },
            },
          },
        };
      });
    }
  },
  loadIndexes: async (connectionId, schema, table) => {
    const key = tableKey(schema, table);
    try {
      const idx = await api.listIndexes(connectionId, schema, table);
      set((state) => {
        const current = state.byConnection[connectionId];
        if (!current) return state;
        const { [key]: _cleared, ...rest } = current.indexErrors;
        return {
          byConnection: {
            ...state.byConnection,
            [connectionId]: {
              ...current,
              indexes: { ...current.indexes, [key]: idx },
              indexErrors: rest,
            },
          },
        };
      });
    } catch (e) {
      set((state) => {
        const current = state.byConnection[connectionId];
        if (!current) return state;
        return {
          byConnection: {
            ...state.byConnection,
            [connectionId]: {
              ...current,
              indexErrors: { ...current.indexErrors, [key]: String(e) },
            },
          },
        };
      });
    }
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
  loadDatabaseSizes: async (connectionId) => {
    const cs = get().byConnection[connectionId];
    // The guard is the whole reason this is not just a call: a database node
    // renders once per database, so without it expanding a nineteen-database
    // server fires nineteen `pg_database_size` sweeps at once.
    if (!cs || cs.databaseSizesLoading || cs.databaseSizesLoaded) return;

    set((state) => {
      const current = state.byConnection[connectionId];
      if (!current) return state;
      return {
        byConnection: {
          ...state.byConnection,
          [connectionId]: { ...current, databaseSizesLoading: true },
        },
      };
    });

    let sizes: Record<string, number> = {};
    try {
      for (const row of await api.getDatabaseSizes(connectionId)) {
        // `!= null` and no `?? 0`: an absent size means the engine would not
        // say, and defaulting it to zero here would tell the user a database
        // with 31 tables is empty — the exact case the MySQL arm exists for.
        if (row.size_bytes != null) sizes[row.name] = row.size_bytes;
      }
    } catch {
      // Swallowed by design. This is a badge; an engine that will not answer
      // costs the badge and nothing else. `databaseSizesLoaded` still flips,
      // so a permanently unprivileged connection is asked once, not per
      // render.
      sizes = {};
    }

    set((state) => {
      const current = state.byConnection[connectionId];
      // The connection may have been dropped while this was in flight.
      if (!current) return state;
      return {
        byConnection: {
          ...state.byConnection,
          [connectionId]: {
            ...current,
            databaseSizes: sizes,
            databaseSizesLoading: false,
            databaseSizesLoaded: true,
          },
        },
      };
    });
  },
  drop: (connectionId) => {
    set((state) => {
      const copy = { ...state.byConnection };
      delete copy[connectionId];
      return { byConnection: copy };
    });
  },
}));
