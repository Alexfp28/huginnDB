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
  ConflictResolution,
  BatchResult,
  ConnectionProfile,
  ConnectionTabState,
  DatabaseInfo,
  Diagnostics,
  FeedbackKind,
  FkOptionsPage,
  IssueOutcome,
  ImportAnalysis,
  McpConnectorInfo,
  ImportResult,
  IndexInfo,
  Preferences,
  PrivilegeInfo,
  QueryResult,
  RowValue,
  SortSpec,
  StartupArgs,
  StructurePreview,
  TableInfo,
  TableStructure,
  UserInfo,
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

  createDatabase: (connectionId: string, name: string) =>
    invoke<void>("create_database", { connectionId, name }),

  /** Drop a database on the server behind `connectionId` (the parent
   *  connection). Postgres/MySQL only; the backend closes the synthetic
   *  per-database pool first. */
  dropDatabase: (connectionId: string, name: string) =>
    invoke<void>("drop_database", { connectionId, name }),

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

  /** List server-side users/roles for the "Security" panel. Always
   *  resolves to an empty array for SQLite. */
  listUsers: (connectionId: string) =>
    invoke<UserInfo[]>("list_users", { connectionId }),

  /** Lazy-loaded on row expand: the privileges granted to `user` (the
   *  `UserInfo.name` returned by `listUsers`). */
  listPrivileges: (connectionId: string, user: string) =>
    invoke<PrivilegeInfo[]>("list_privileges", { connectionId, user }),

  /** Full editable structure of a table (columns, indexes, FKs, defaults,
   *  auto-increment) for the visual structure editor. */
  getTableStructure: (
    connectionId: string,
    schema: string | undefined,
    table: string,
  ) =>
    invoke<TableStructure>("get_table_structure", {
      connectionId,
      schema,
      table,
    }),

  /** Generate (but do not run) the DDL to take `original` → `desired`. */
  previewStructureChange: (args: {
    connectionId: string;
    original: TableStructure | null;
    desired: TableStructure;
  }) => invoke<StructurePreview>("preview_structure_change", { args }),

  /** Execute the DDL to take `original` → `desired`. */
  applyStructureChange: (args: {
    connectionId: string;
    original: TableStructure | null;
    desired: TableStructure;
  }) => invoke<void>("apply_structure_change", { args }),

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
   * Run a list of statements sequentially on a single pooled connection and
   * return a per-statement summary plus the last SELECT's result set. This
   * is the multi-statement path: a single `executeQuery` over a `;`-joined
   * buffer goes through the prepared protocol, which rejects multiple
   * commands. Statements are split client-side via `splitSql`.
   */
  executeBatch: (connectionId: string, statements: string[]) =>
    invoke<BatchResult>("execute_batch", { connectionId, statements }),

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
    /** Ordered multi-column sort; `order[0]` is the primary key. */
    order?: SortSpec[];
    filters?: ColumnFilter[];
    search?: string;
    searchColumns?: string[];
    /** Run the `COUNT(*)` companion. Pass `false` when only the sort/page
     *  changed and the caller reuses its cached total (defaults to true). */
    withCount?: boolean;
  }) => invoke<QueryResult>("fetch_table_data", args),

  /**
   * UPDATE one column of one row addressed by its (possibly composite)
   * primary key. `pkColumns` carries every column that participates in
   * the PK, with `pkValues` holding the parallel tuple of values for the
   * row being edited — sending only the first PK column on a composite
   * key would fan the UPDATE out across every row sharing that leading
   * value. `value` is sent as a string (or `null`) because the cell
   * editor always produces text; drivers coerce it to the target column
   * type. The backend rolls back and errors out if the resulting
   * `rows_affected` is greater than one (defence in depth).
   */
  updateCell: (args: {
    connectionId: string;
    schema?: string;
    table: string;
    pkColumns: string[];
    pkValues: CellValue[];
    column: string;
    value: string | null;
    /**
     * Raw column type (e.g. `bit(1)`, `varchar(255)`). Lets the backend pick
     * a server-side cast for types where a textual literal would be coerced
     * wrongly — notably MySQL `BIT`, where the literal `"1"` is read as the
     * ASCII byte `0x31` rather than the integer 1. Optional and ignored for
     * types that accept a plain string bind.
     */
    columnType?: string;
  }) => invoke<number>("update_cell", args),

  /**
   * DELETE one or more rows by their (possibly composite) primary key.
   * `pkValueRows` carries one tuple per row, each parallel to
   * `pkColumns`. The backend builds `WHERE (c1, c2, …) IN ((?, ?, …), …)`
   * so a composite-PK row can only ever be addressed by its full key.
   */
  deleteRows: (args: {
    connectionId: string;
    schema?: string;
    table: string;
    pkColumns: string[];
    pkValueRows: CellValue[][];
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

  /** Look up the persisted tab state for a connection, if any. Only the
   *  main window ever calls this — secondary windows are ephemeral. */
  getTabState: (connectionId: string) =>
    invoke<ConnectionTabState | null>("get_tab_state", { connectionId }),

  /** Replace the persisted tab state for a connection. */
  saveTabState: (connectionId: string, tabStateValue: ConnectionTabState) =>
    invoke<void>("save_tab_state", { connectionId, tabStateValue }),

  /** Drop the persisted tab state for a connection. */
  clearTabState: (connectionId: string) =>
    invoke<void>("clear_tab_state", { connectionId }),

  // Multi-window -----------------------------------------------------------

  /** Open a new, blank window. Optionally carries a connection intent for
   *  the new window's frontend to pick up via `takeWindowStartupIntent`.
   *  Returns the new window's label. */
  openNewWindow: (intent?: StartupArgs | null) =>
    invoke<string>("open_new_window", { intent: intent ?? null }),

  /** Drain the connection intent stashed for this window's label by
   *  `openNewWindow`. Call once on boot alongside `getStartupArgs`. */
  takeWindowStartupIntent: (label: string) =>
    invoke<StartupArgs | null>("take_window_startup_intent", { label }),

  // Import / Export --------------------------------------------------------

  /**
   * Parse an export file and return metadata for the conflict-resolution UI.
   * Does not decrypt anything; safe to call before collecting a passphrase.
   */
  analyzeImportFile: (filePath: string) =>
    invoke<ImportAnalysis>("analyze_import_file", { filePath }),

  /**
   * Export the given profiles (or all if `profileIds` is null) to a
   * user-chosen JSON file. When `includePasswords` is true, `passphrase`
   * must be provided; secrets are encrypted with AES-256-GCM.
   * Returns the path of the written file.
   */
  exportProfiles: (
    profileIds: string[] | null,
    includePasswords: boolean,
    passphrase?: string,
  ) =>
    invoke<string>("export_profiles", {
      profileIds,
      includePasswords,
      passphrase,
    }),

  /**
   * Import profiles from a previously exported JSON file.
   * `conflictResolutions` must cover every id returned in `analyze.conflicts`.
   * Returns a summary of what was imported, skipped, renamed, or left without
   * a password.
   */
  importProfiles: (
    filePath: string,
    passphrase?: string,
    conflictResolutions?: ConflictResolution[],
  ) =>
    invoke<ImportResult>("import_profiles", {
      filePath,
      passphrase,
      conflictResolutions: conflictResolutions ?? [],
    }),

  // Database export / import ------------------------------------------------

  /**
   * Dump the target database of `connectionId` (schema + data) to a
   * user-chosen `.sql` file — the save dialog is opened on the Rust side.
   * Returns the written path. Rejects if the user cancels the dialog.
   */
  exportDatabase: (connectionId: string) =>
    invoke<string>("export_database", { connectionId }),

  /**
   * Read a text file at `filePath`. Used by the "Import .sql…" flow to load
   * a picked file's content before splitting it with `splitSql` and running
   * it through `executeBatch` — there is no separate import-execution command.
   */
  readTextFile: (filePath: string) =>
    invoke<string>("read_text_file", { filePath }),

  // CLI args ---------------------------------------------------------------

  /**
   * Return the command-line arguments that were parsed before the app
   * started. Called once on boot to auto-connect when the user launched
   * HuginnDB with `--connect-profile` or ad-hoc connection flags.
   */
  getStartupArgs: () => invoke<StartupArgs>("get_startup_args"),

  /**
   * Drain a connection intent forwarded by a *second* launch (single-instance
   * handler). Called once when the CLI-connect bridge mounts to recover an
   * intent emitted before the listener existed (boot race). Returns `null`
   * when nothing is pending; the backend clears the buffer on read.
   */
  takePendingCliConnect: () =>
    invoke<StartupArgs | null>("take_pending_cli_connect"),

  // Issue reporter ---------------------------------------------------------

  /** Build/runtime facts to fold into a bug/feature report body. */
  getDiagnostics: () => invoke<Diagnostics>("get_diagnostics"),

  /** Store (or clear, when `token` is empty) the GitHub PAT in the OS
   *  keychain. */
  setGithubPat: (token: string) => invoke<void>("set_github_pat", { token }),

  /** Whether a GitHub PAT is currently stored. */
  hasGithubPat: () => invoke<boolean>("has_github_pat"),

  /** Forget the stored GitHub PAT. */
  clearGithubPat: () => invoke<void>("clear_github_pat"),

  /**
   * File a bug report or feature request. With a stored PAT the issue is
   * created via the GitHub API (`created: true`, URL is the new issue);
   * otherwise a pre-filled `issues/new` URL is returned for the caller to
   * open in the browser (`created: false`).
   */
  submitIssue: (report: { kind: FeedbackKind; title: string; body: string }) =>
    invoke<IssueOutcome>("submit_issue", { report }),

  /**
   * Build a `mailto:` URL prefilled with the report, for the "I don't have a
   * GitHub account" fallback. The caller opens it with `openUrl`.
   */
  mailtoReportUrl: (report: { kind: FeedbackKind; title: string; body: string }) =>
    invoke<string>("mailto_report_url", { report }),

  /**
   * Open an external URL in the OS default browser (or mail client, for
   * `mailto:`) via the `opener` plugin. `window.open` is a no-op inside the
   * Tauri WebView, so every external link must go through this command. The
   * capability scopes it to `github.com` and `mailto:` (see
   * `src-tauri/capabilities/default.json`).
   */
  openUrl: (url: string) =>
    invoke<void>("plugin:opener|open_url", { url, with: null }),

  // MCP connector ----------------------------------------------------------

  /** Resolve the bundled `huginndb-mcp` sidecar's path (Settings → MCP). */
  getMcpConnectorInfo: () => invoke<McpConnectorInfo>("get_mcp_connector_info"),
};
