import { create } from "zustand";
import { api } from "@/lib/tauri";
import type {
  ColumnInfo,
  DatabaseInfo,
  IndexInfo,
  TableInfo,
} from "@/types";

interface ConnectionSchema {
  databases: DatabaseInfo[];
  tables: TableInfo[];
  columns: Record<string, ColumnInfo[]>;
  indexes: Record<string, IndexInfo[]>;
  expanded: Set<string>;
  loading: boolean;
  error: string | null;
}

interface SchemaState {
  byConnection: Record<string, ConnectionSchema>;
  refresh: (connectionId: string) => Promise<void>;
  toggleNode: (connectionId: string, key: string) => void;
  loadColumns: (
    connectionId: string,
    schema: string | undefined,
    table: string,
  ) => Promise<void>;
  loadIndexes: (
    connectionId: string,
    schema: string | undefined,
    table: string,
  ) => Promise<void>;
  drop: (connectionId: string) => void;
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
  };
}

function tableKey(schema: string | undefined, table: string) {
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
      set((state) => ({
        byConnection: {
          ...state.byConnection,
          [connectionId]: {
            ...(state.byConnection[connectionId] ?? emptyState()),
            databases,
            tables,
            loading: false,
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
            error: String(e),
          },
        },
      }));
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
  drop: (connectionId) => {
    set((state) => {
      const copy = { ...state.byConnection };
      delete copy[connectionId];
      return { byConnection: copy };
    });
  },
}));

export { tableKey };
