/**
 * Typed wrappers around every Tauri command the backend exposes.
 *
 * Putting them behind a single `api` object means components do not
 * import `invoke` directly, which:
 *
 *  - keeps the wire protocol (command names + argument shapes) in one
 *    place,
 *  - lets us swap the transport (e.g. for a web preview / Storybook)
 *    by replacing this file,
 *  - and gives TypeScript end-to-end types for command results.
 */

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
  // Connections ----------------------------------------------------------

  /** Return every saved profile. */
  listProfiles: () => invoke<ConnectionProfile[]>("list_profiles"),

  /**
   * Create or update a profile. Pass `password` to update the keychain
   * entry; omit it to keep the existing one.
   */
  saveProfile: (profile: ConnectionProfile, password?: string) =>
    invoke<ConnectionProfile>("save_profile", { profile, password }),

  /** Delete a profile and its keychain entry. */
  deleteProfile: (id: string) => invoke<void>("delete_profile", { id }),

  /** Open a throwaway pool, run `SELECT 1`, then close it. */
  testConnection: (profile: ConnectionProfile, password?: string) =>
    invoke<string>("test_connection", { profile, password }),

  /** Open a long-lived pool for the profile and remember it. */
  connect: (id: string, password?: string) =>
    invoke<void>("connect", { id, password }),

  /** Drop the pool for `id`, if any. */
  disconnect: (id: string) => invoke<void>("disconnect", { id }),

  /** Ids of every connection that is currently open. */
  activeConnections: () => invoke<string[]>("active_connections"),

  // Schema introspection -------------------------------------------------

  listDatabases: (connectionId: string) =>
    invoke<DatabaseInfo[]>("list_databases", { connectionId }),

  listTables: (connectionId: string, database?: string) =>
    invoke<TableInfo[]>("list_tables", { connectionId, database }),

  listColumns: (
    connectionId: string,
    schema: string | undefined,
    table: string,
  ) => invoke<ColumnInfo[]>("list_columns", { connectionId, schema, table }),

  listIndexes: (
    connectionId: string,
    schema: string | undefined,
    table: string,
  ) => invoke<IndexInfo[]>("list_indexes", { connectionId, schema, table }),

  // Query execution ------------------------------------------------------

  /** Run arbitrary SQL on the connection. */
  executeQuery: (connectionId: string, sql: string) =>
    invoke<QueryResult>("execute_query", { connectionId, sql }),

  /** Paginated SELECT against a known table with optional sort. */
  fetchTableData: (args: {
    connectionId: string;
    schema?: string;
    table: string;
    limit: number;
    offset: number;
    orderBy?: string;
    orderDesc?: boolean;
  }) => invoke<QueryResult>("fetch_table_data", args),

  /**
   * UPDATE one column of one row addressed by primary key. `value` is
   * sent as a string (or `null`) because the cell editor always
   * produces text; drivers coerce it to the target column type.
   */
  updateCell: (args: {
    connectionId: string;
    schema?: string;
    table: string;
    pkColumn: string;
    pkValue: CellValue;
    column: string;
    value: string | null;
  }) => invoke<number>("update_cell", args),
};
