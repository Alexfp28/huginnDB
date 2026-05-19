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
  CellValue,
  ColumnFilter,
  ColumnInfo,
  ConnectionProfile,
  ConnectionTabState,
  DatabaseInfo,
  FkOptionsPage,
  IndexInfo,
  Preferences,
  QueryResult,
  RowValue,
  TableInfo,
} from "@/types";

export const api = {
  // Connections ----------------------------------------------------------

  /** Return every saved profile. */
  listProfiles: () => invoke<ConnectionProfile[]>("list_profiles"),

  /**
   * Create or update a profile. Pass `password` to update the DB-password
   * keychain entry; omit it to keep the existing one. Pass `sshSecret`
   * (SSH password or private-key passphrase) when the profile has a
   * tunnel and you want to update that secret too.
   */
  saveProfile: (
    profile: ConnectionProfile,
    password?: string,
    sshSecret?: string,
  ) =>
    invoke<ConnectionProfile>("save_profile", {
      profile,
      password,
      sshSecret,
    }),

  /** Delete a profile and its keychain entries (DB + optional SSH). */
  deleteProfile: (id: string) => invoke<void>("delete_profile", { id }),

  /**
   * Open a throwaway pool, run `SELECT 1`, then close it. `sshSecret` is
   * resolved from the keychain when omitted, mirroring `password`.
   */
  testConnection: (
    profile: ConnectionProfile,
    password?: string,
    sshSecret?: string,
  ) =>
    invoke<string>("test_connection", { profile, password, sshSecret }),

  /** Open a long-lived pool for the profile and remember it. */
  connect: (id: string, password?: string, sshSecret?: string) =>
    invoke<void>("connect", { id, password, sshSecret }),

  /** Drop the pool for `id`, if any. */
  disconnect: (id: string) => invoke<void>("disconnect", { id }),

  /** Ids of every connection that is currently open. */
  activeConnections: () => invoke<string[]>("active_connections"),

  /**
   * Open a secondary pool bound to `database` under the parent connection
   * `parentId` and return the synthetic connection id (`<parentId>::db::
   * <database>`) the frontend should use for every subsequent command
   * targeting that database — `listTables`, `listColumns`,
   * `fetchTableData`, `updateCell`, etc. Idempotent: returns the existing
   * id when the child pool is already open.
   *
   * Used by the schema explorer when the parent profile has an empty
   * `database` field, so the user can expand every database on the server
   * as a top-level node without us having to thread an extra `database`
   * parameter through every command in the backend.
   */
  openDatabaseView: (parentId: string, database: string) =>
    invoke<string>("open_database_view", { parentId, database }),

  /**
   * Stable synthetic id for a per-database browse session. Kept in sync
   * with `connection.rs::database_view_id` so the frontend can compute it
   * without a round-trip when it only needs to address an already-open
   * child (e.g. dispatching tab actions).
   */
  databaseViewId: (parentId: string, database: string) =>
    `${parentId}::db::${database}`,

  /**
   * Forget the trusted SSH host-key fingerprint for `host:port`. Returns
   * `true` when an entry was actually removed. Use after a server is
   * legitimately reinstalled, when the dialog reports a key mismatch.
   */
  forgetHostKey: (hostPort: string) =>
    invoke<boolean>("forget_host_key", { hostPort }),

  /** Read the trusted SSH host-key fingerprint for `host:port`, if any. */
  getHostKey: (hostPort: string) =>
    invoke<string | null>("get_host_key", { hostPort }),

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

  /** `DROP TABLE` for a catalog-sourced (schema, table) pair. */
  dropTable: (connectionId: string, schema: string | undefined, table: string) =>
    invoke<void>("drop_table", { connectionId, schema, table }),

  /** `ALTER TABLE … RENAME TO` (or `RENAME TABLE` on MySQL) for a
   *  catalog-sourced (schema, table) pair. */
  renameTable: (
    connectionId: string,
    schema: string | undefined,
    table: string,
    newName: string,
  ) => invoke<void>("rename_table", { connectionId, schema, table, newName }),

  /**
   * Return a short version string for the connected server, e.g.
   * `"sqlite 3.45.3"`, `"postgresql 16.2"`, `"mysql 8.0.35"`.
   */
  serverVersion: (connectionId: string) =>
    invoke<string>("server_version", { connectionId }),

  // Query execution ------------------------------------------------------

  /** Run arbitrary SQL on the connection. */
  executeQuery: (connectionId: string, sql: string) =>
    invoke<QueryResult>("execute_query", { connectionId, sql }),

  /**
   * Paginated SELECT against a known table.
   *
   * - `filters`: structured column predicates (chips), AND-composed.
   * - `search` + `searchColumns`: free-text needle applied as
   *   case-insensitive `LIKE` across the supplied columns and
   *   OR-composed with itself, then AND-composed with `filters`.
   *   The needle is escaped against LIKE metacharacters server-side.
   */
  fetchTableData: (args: {
    connectionId: string;
    schema?: string;
    table: string;
    limit: number;
    offset: number;
    orderBy?: string;
    orderDesc?: boolean;
    filters?: ColumnFilter[];
    search?: string;
    searchColumns?: string[];
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

  /** DELETE one or more rows by primary key. */
  deleteRows: (args: {
    connectionId: string;
    schema?: string;
    table: string;
    pkColumn: string;
    pkValues: CellValue[];
  }) => invoke<number>("delete_rows", args),

  /**
   * INSERT one row from the supplied column/value pairs. When `pkColumn`
   * is given on Postgres, the generated PK is returned via `RETURNING`;
   * MySQL/SQLite return their `last_insert_id`/`last_insert_rowid`.
   */
  insertRow: (args: {
    connectionId: string;
    schema?: string;
    table: string;
    pkColumn?: string;
    values: RowValue[];
  }) => invoke<CellValue>("insert_row", args),

  /**
   * Fetch a page of valid values for a foreign-key column. When
   * `labelColumn` is omitted the backend picks the first textual non-PK
   * column from the target table; the resulting `label` is `null` when no
   * suitable column exists. Pass `search` to switch to server-side
   * `ILIKE` filtering (used once the prefetched page reports
   * `has_more=true`).
   */
  fetchFkOptions: (args: {
    connectionId: string;
    schema?: string;
    table: string;
    keyColumn: string;
    labelColumn?: string;
    search?: string;
    limit: number;
  }) => invoke<FkOptionsPage>("fetch_fk_options", args),

  // Preferences ----------------------------------------------------------

  /** Read the user's preferences blob from disk. */
  getPreferences: () => invoke<Preferences>("get_preferences"),

  /**
   * Replace the entire preferences blob on disk. The store sends a full
   * snapshot; partial updates are merged client-side before this call.
   */
  updatePreferences: (prefs: Preferences) =>
    invoke<void>("update_preferences", { prefs }),

  /** Look up the persisted workspace for a connection, if any. */
  getTabState: (connectionId: string) =>
    invoke<ConnectionTabState | null>("get_tab_state", { connectionId }),

  /** Replace the persisted workspace for a connection. */
  saveTabState: (connectionId: string, tabStateValue: ConnectionTabState) =>
    invoke<void>("save_tab_state", { connectionId, tabStateValue }),

  /** Drop the persisted workspace for a connection. */
  clearTabState: (connectionId: string) =>
    invoke<void>("clear_tab_state", { connectionId }),
};
