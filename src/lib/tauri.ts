import { invoke } from "@tauri-apps/api/core";
import type {
  ColumnInfo,
  ConnectionProfile,
  DatabaseInfo,
  IndexInfo,
  QueryResult,
  TableInfo,
  CellValue,
} from "@/types";

export const api = {
  listProfiles: () => invoke<ConnectionProfile[]>("list_profiles"),
  saveProfile: (profile: ConnectionProfile, password?: string) =>
    invoke<ConnectionProfile>("save_profile", { profile, password }),
  deleteProfile: (id: string) => invoke<void>("delete_profile", { id }),
  testConnection: (profile: ConnectionProfile, password?: string) =>
    invoke<string>("test_connection", { profile, password }),
  connect: (id: string, password?: string) =>
    invoke<void>("connect", { id, password }),
  disconnect: (id: string) => invoke<void>("disconnect", { id }),
  activeConnections: () => invoke<string[]>("active_connections"),

  listDatabases: (connectionId: string) =>
    invoke<DatabaseInfo[]>("list_databases", { connectionId }),
  listTables: (connectionId: string, database?: string) =>
    invoke<TableInfo[]>("list_tables", { connectionId, database }),
  listColumns: (connectionId: string, schema: string | undefined, table: string) =>
    invoke<ColumnInfo[]>("list_columns", { connectionId, schema, table }),
  listIndexes: (connectionId: string, schema: string | undefined, table: string) =>
    invoke<IndexInfo[]>("list_indexes", { connectionId, schema, table }),

  executeQuery: (connectionId: string, sql: string) =>
    invoke<QueryResult>("execute_query", { connectionId, sql }),
  fetchTableData: (args: {
    connectionId: string;
    schema?: string;
    table: string;
    limit: number;
    offset: number;
    orderBy?: string;
    orderDesc?: boolean;
  }) => invoke<QueryResult>("fetch_table_data", args),
  updateCell: (args: {
    connectionId: string;
    schema?: string;
    table: string;
    pkColumn: string;
    pkValue: CellValue;
    column: string;
    value: CellValue;
  }) => invoke<number>("update_cell", args),
};
