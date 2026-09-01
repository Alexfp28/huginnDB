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
  AppTab,
  BulkUpdatePreview,
  CellValue,
  ColumnFilter,
  ColumnInfo,
  ConflictResolution,
  BatchResult,
  ConnectionProfile,
  ClaudeCodeRegistration,
  DeleteProfilesReport,
  McpWritePolicy,
  ConnectionTabState,
  DatabaseInfo,
  DataMode,
  Diagnostics,
  EnvironmentImportAnalysis,
  EnvironmentImportResult,
  ExportTarget,
  FeedbackKind,
  FkOptionsPage,
  IssueOutcome,
  ImportAnalysis,
  AppFlavor,
  McpConnectorInfo,
  ImportResult,
  IndexInfo,
  PoolStats,
  Preferences,
  PrivilegeInfo,
  PulseExplainPlan,
  PulseHealth,
  PulseHistorySeries,
  PulseIndexUsage,
  PulseSession,
  PulseStorageItem,
  PulseTopQuery,
  QueryResult,
  CountResult,
  RowValue,
  StartupArgs,
  MongoIndexInfo,
  MongoViewDefinition,
  NewMongoIndexSpec,
  PipelineStageInput,
  PipelineText,
  StagePreview,
  StructurePreview,
  TableInfo,
  TableQuery,
  TableScan,
  TableStructure,
  UserInfo,
  ViewDefinition,
  ViewPreview,
  WorkspaceLayout,
  LaunchState,
  Environment,
  EnvironmentList,
  Origin,
  OriginDocument,
  OriginDraft,
  OriginDraftBase,
  OriginDraftEnvironment,
  OriginPublishImpact,
  OriginRole,
  OriginSaveOutcome,
  OriginWritableProbe,
  OriginSyncReport,
  JsonSchemaLibrary,
  JsonSchemaEntry,
  JsonSchemaBinding,
  JsonSchemaSource,
  JsonSchemaMatch,
  JsonSchemaInferResult,
  JsonSchemaImportAnalysis,
  JsonSchemaImportResult,
  ResolvedJsonSchema,
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
   * Delete several profiles in one pass: one rewrite of `profiles.json`, one
   * sweep of `tab_state.json`, one `profiles-changed` event — instead of N of
   * each, which made every open window re-read and re-render N times.
   *
   * The backend refuses ids a shared origin publishes and hands them back in
   * `skippedOrigin`; deleting one locally is a no-op the next sync undoes.
   */
  deleteProfiles: (ids: string[]) =>
    invoke<DeleteProfilesReport>("delete_profiles", { ids }),

  /**
   * Set the MCP write policy on several profiles in one write. Returns how many
   * actually changed, so a caller can tell "done" from "already like that".
   */
  setMcpWritePolicy: (ids: string[], level: McpWritePolicy) =>
    invoke<number>("set_mcp_write_policy", { ids, level }),

  /**
   * Turn Pulse's history sampler on or off for several profiles in one
   * write. Same "how many actually changed" return as `setMcpWritePolicy`.
   */
  setPulseEnabled: (ids: string[], enabled: boolean) =>
    invoke<number>("set_pulse_enabled", { ids, enabled }),

  /**
   * Expose or hide several connections from the headless MCP connector in one
   * write. Same "how many actually changed" return as `setMcpWritePolicy`.
   *
   * This is what the Settings → MCP checkboxes write. The sidecar re-reads the
   * flag per call, so it takes effect without restarting the MCP client —
   * unless that client was started with an explicit `--connections` list, which
   * pins it for the life of the process.
   */
  setMcpExposed: (ids: string[], exposed: boolean) =>
    invoke<number>("set_mcp_exposed", { ids, exposed }),

  /**
   * Run `claude mcp add huginndb -s user -- <sidecar>` for the user, instead of
   * making them paste a path into a terminal. Reversible with
   * `claude mcp remove huginndb`; the button click is the confirmation.
   *
   * Never throws for the ordinary outcomes — "already registered" and "no CLI
   * on PATH" come back as values, since neither is a failure the user needs to
   * see as one.
   */
  registerWithClaudeCode: () =>
    invoke<ClaudeCodeRegistration>("register_with_claude_code"),

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
   * How many pools the backend is holding right now, split into top-level
   * connections and synthetic per-database views.
   *
   * Surfaced in Settings → Connections, because "too many connections" is only
   * an actionable error if the user can see their own contribution to it.
   */
  connectionPoolStats: () => invoke<PoolStats>("connection_pool_stats"),

  /**
   * Close every per-database pool, keeping the top-level connections the user
   * opened. Returns how many were closed.
   *
   * The manual counterpart to the backend's idle-pool reaper, and the recovery
   * action offered when a server refuses a connection because it is full. Safe
   * at any time: each closed view reopens transparently the next time that
   * database is touched, at the cost of one round trip — no state is lost.
   */
  releaseIdlePools: () => invoke<number>("release_idle_pools"),

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

  /** Create a MongoDB collection on the database `connectionId` is scoped to
   *  (#61). MongoDB-only — the backend rejects the SQL drivers, which create
   *  tables through the structure editor instead. */
  createCollection: (connectionId: string, name: string) =>
    invoke<void>("create_collection", { connectionId, name }),

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

  /**
   * Count how many rows/documents currently match a bulk update's filter,
   * and return the statement that `applyBulkUpdate` would run — shown in
   * the confirmation dialog before the user commits to the write. Never
   * modifies data.
   */
  previewBulkUpdate: (args: {
    connectionId: string;
    schema?: string;
    table: string;
    filters: ColumnFilter[];
    setValues: RowValue[];
    confirmUnfiltered?: boolean;
  }) => invoke<BulkUpdatePreview>("preview_bulk_update", { args }),

  /**
   * Apply a bulk update: `UPDATE ... SET ... WHERE ...` for SQL,
   * `update_many` with a `$set` for MongoDB. `filters` empty requires
   * `confirmUnfiltered: true`, or the backend rejects the call — a blank
   * filter can't silently become a full-table update. Returns the number
   * of rows/documents actually modified.
   */
  applyBulkUpdate: (args: {
    connectionId: string;
    schema?: string;
    table: string;
    filters: ColumnFilter[];
    setValues: RowValue[];
    confirmUnfiltered?: boolean;
  }) => invoke<number>("apply_bulk_update", { args }),

  /** `DROP TABLE` for a catalog-sourced (schema, table) pair. */
  dropTable: (connectionId: string, schema: string | undefined, table: string) =>
    invoke<void>("drop_table", { connectionId, schema, table }),

  /** Empty a table — remove every row but keep the table (#69). `TRUNCATE`
   *  on Postgres/MySQL, `DELETE FROM` on SQLite, `deleteMany({})` on MongoDB. */
  emptyTable: (connectionId: string, schema: string | undefined, table: string) =>
    invoke<void>("empty_table", { connectionId, schema, table }),

  /** `ALTER TABLE … RENAME TO` (or `RENAME TABLE` on MySQL) for a
   *  catalog-sourced (schema, table) pair — `renameCollection` on MongoDB.
   *
   *  `newSchema` is MongoDB-only (the destination database, when the rename
   *  also moves the collection); the SQL drivers ignore it. */
  renameTable: (
    connectionId: string,
    schema: string | undefined,
    table: string,
    newName: string,
    newSchema?: string,
  ) =>
    invoke<void>("rename_table", {
      connectionId,
      schema,
      table,
      newName,
      newSchema,
    }),

  /**
   * Return a short version string for the connected server, e.g.
   * `"sqlite 3.45.3"`, `"postgresql 16.2"`, `"mysql 8.0.35"`.
   */
  serverVersion: (connectionId: string) =>
    invoke<string>("server_version", { connectionId }),

  // View editor ------------------------------------------------------------

  /** Read a view's definition (schema/name + the SELECT body, with any
   *  driver-specific `CREATE VIEW ... AS` wrapper already stripped). */
  getViewDefinition: (
    connectionId: string,
    schema: string | undefined,
    view: string,
  ) =>
    invoke<ViewDefinition>("get_view_definition", {
      connectionId,
      schema,
      view,
    }),

  /** Generate (but do not run) the DDL to take `original` → `desired`.
   *  `original: null` means "create a new view". */
  previewViewChange: (args: {
    connectionId: string;
    original: ViewDefinition | null;
    desired: ViewDefinition;
  }) => invoke<ViewPreview>("preview_view_change", { args }),

  /** Execute the DDL to take `original` → `desired`. */
  applyViewChange: (args: {
    connectionId: string;
    original: ViewDefinition | null;
    desired: ViewDefinition;
  }) => invoke<void>("apply_view_change", { args }),

  /** Rename a view (`ALTER VIEW … RENAME TO` / `RENAME TABLE`, driver-aware). */
  renameView: (
    connectionId: string,
    schema: string | undefined,
    view: string,
    newName: string,
  ) => invoke<void>("rename_view", { connectionId, schema, view, newName }),

  /** `DROP VIEW` for a catalog-sourced (schema, view) pair. Works on MongoDB
   *  too — dropping a view there needs no DDL, so the command handles it. */
  dropView: (connectionId: string, schema: string | undefined, view: string) =>
    invoke<void>("drop_view", { connectionId, schema, view }),

  // MongoDB aggregation editor ---------------------------------------------
  //
  // A pipeline crosses this boundary as the *source text* the user typed, not
  // as parsed JSON: it is relaxed JSON (unquoted keys, `ObjectId(…)`,
  // comments) and Rust owns the only parser for it. That is also why the
  // stages ⇄ text mode switch is a command rather than a client-side split.

  /** Normalise a pipeline and get back both representations — the array
   *  literal and one source string per stage. Doubles as prettify. */
  formatMongoPipeline: (args: { text?: string; stages?: string[] }) =>
    invoke<PipelineText>("format_mongo_pipeline", { args }),

  /** Run the whole pipeline against `source` and return a sample of its
   *  output. Write stages (`$out`/`$merge`) are refused. */
  runMongoPipeline: (args: {
    connectionId: string;
    source: string;
    text?: string;
    stages?: PipelineStageInput[];
    limit?: number;
  }) => invoke<QueryResult>("run_mongo_pipeline", { args }),

  /** One bounded preview per stage: stage *i* sees the pipeline truncated
   *  after it. Errors come back per stage rather than failing the call. */
  previewMongoStages: (args: {
    connectionId: string;
    source: string;
    stages: PipelineStageInput[];
    limit?: number;
  }) => invoke<StagePreview[]>("preview_mongo_stages", { args }),

  /** Read a MongoDB view's `viewOn` + pipeline as editable source. */
  getMongoView: (connectionId: string, view: string) =>
    invoke<MongoViewDefinition>("get_mongo_view", { connectionId, view }),

  /** Create a view from the pipeline (`create: true`) or redefine an existing
   *  one (`collMod`). Disabled stages are dropped, never stored. */
  saveMongoView: (args: {
    connectionId: string;
    name: string;
    viewOn: string;
    text?: string;
    stages?: PipelineStageInput[];
    create: boolean;
  }) => invoke<void>("save_mongo_view", { args }),

  // MongoDB index manager ---------------------------------------------------
  //
  // Same source-text contract as the aggregation editor above: index keys,
  // partial filters, collations and weights cross as the text the user typed
  // and are parsed in Rust. There is no `alterMongoIndex` because MongoDB has
  // none — `recreateMongoIndex` is a drop plus a create, and it says so.

  /** A collection's full index catalogue, with sizes and usage counters when
   *  the connection's role can read `$collStats` / `$indexStats`. */
  listMongoIndexes: (connectionId: string, collection: string) =>
    invoke<MongoIndexInfo[]>("list_mongo_indexes", { connectionId, collection }),

  createMongoIndex: (args: {
    connectionId: string;
    collection: string;
    spec: NewMongoIndexSpec;
  }) => invoke<void>("create_mongo_index", { args }),

  /** Replace an index: drops `originalName`, then creates `spec`. The new
   *  spec is parsed before the drop, so a malformed filter costs an error
   *  rather than the index. */
  recreateMongoIndex: (args: {
    connectionId: string;
    collection: string;
    originalName: string;
    spec: NewMongoIndexSpec;
  }) => invoke<void>("recreate_mongo_index", { args }),

  dropMongoIndex: (connectionId: string, collection: string, name: string) =>
    invoke<void>("drop_mongo_index", { connectionId, collection, name }),

  /** Hide or unhide an index — the reversible rehearsal for dropping it. */
  setMongoIndexHidden: (
    connectionId: string,
    collection: string,
    name: string,
    hidden: boolean,
  ) =>
    invoke<void>("set_mongo_index_hidden", {
      connectionId,
      collection,
      name,
      hidden,
    }),

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
  fetchTableData: (query: TableQuery) =>
    invoke<QueryResult>("fetch_table_data", { query }),

  /**
   * Row total for the table-data browser, fetched separately from the data
   * page so an exact `COUNT(*)` on a huge table never blocks the first rows
   * from painting. With no filters/search the backend returns a fast engine
   * estimate (`estimated: true`); any predicate forces an exact count.
   */
  countTableRows: (query: TableScan) =>
    invoke<CountResult>("count_table_rows", { query }),

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
   * MongoDB only: remove a field from one document (`$unset`), addressed by
   * its `_id`. The document list view's "delete field" action.
   *
   * `field` is a path exactly like the `column` of {@link updateCell} on
   * MongoDB — `"customData.format"` unsets a key inside a sub-document. A SQL
   * row has a fixed column set, so the backend rejects the other drivers
   * instead of pretending this means "set to NULL" (that is `updateCell` with
   * a `null` value).
   */
  unsetField: (args: {
    connectionId: string;
    collection: string;
    idValue: CellValue;
    field: string;
  }) => invoke<number>("unset_field", args),

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

  /** Read the session-level inner-dockview geometry (or `null` for the
   *  default tabbed layout). Main-window-only, like the tab-state calls. */
  getWorkspaceLayout: () =>
    invoke<WorkspaceLayout>("get_workspace_layout"),

  /** Persist the session-level inner-dockview geometry (`null` clears it). */
  saveWorkspaceLayout: (layout: WorkspaceLayout) =>
    invoke<void>("save_workspace_layout", { layout }),

  /** The main window's launch-restore state (live connections, focused
   *  connection, active tab) for auto-reconnect + focus restore on launch. */
  getLaunchState: () =>
    invoke<LaunchState>("get_launch_state"),

  /** Persist the launch-restore state so the next launch can restore it. */
  saveLaunchState: (launchState: LaunchState) =>
    invoke<void>("save_launch_state", { launchState }),

  // Environments -----------------------------------------------------------
  // Every call above resolves against whichever environment is active, so
  // these are what decide the scope of the six calls above. Main-window-only,
  // for the same reason tab state is (gotcha #8).

  /** All environments in display order, plus which one is active. */
  listEnvironments: () => invoke<EnvironmentList>("list_environments"),

  /** Create (`id` omitted) or rename/restyle (`id` given) an environment.
   *  Only presentation fields — never the session state the environment owns. */
  saveEnvironment: (args: {
    id?: string | null;
    name: string;
    color?: string | null;
    icon?: string | null;
    themeId?: string | null;
  }) => invoke<Environment>("save_environment", args),

  /** Set (or clear) this machine's local override of a mirrored environment's
   *  `name`/`color`/`icon`/`themeId` — never overwritten by `sync_origin`.
   *  Passing `null` for a field clears that override, falling back to the
   *  synced value; there is no "leave unchanged" state, so callers always
   *  send the full effective draft. Separate from `saveEnvironment` on
   *  purpose — the two commands write disjoint fields, and merging them would
   *  reintroduce the "an omitted field silently reverts" trap. */
  setEnvironmentLocalOverrides: (args: {
    id: string;
    localName?: string | null;
    localColor?: string | null;
    localIcon?: string | null;
    localThemeId?: string | null;
  }) => invoke<Environment>("set_environment_local_overrides", args),

  /** Delete an environment and the session state it remembered. Rejects the
   *  last remaining one; connection profiles are never touched. */
  deleteEnvironment: (id: string) =>
    invoke<void>("delete_environment", { id }),

  /** Detach an environment from the origin that mirrors it (#108), so it
   *  becomes an ordinary local environment — the "keep as mine" action for a
   *  vanished mirrored environment. Connections/session state are left as-is;
   *  a set local cosmetic override is promoted into the public field and
   *  cleared (there's nothing left to shadow once detached). */
  adoptEnvironment: (id: string) =>
    invoke<Environment>("adopt_environment", { id }),

  /** Point the backend at a different environment. Callers must orchestrate
   *  the frontend side around this — see `useEnvironments.switchTo`. */
  setActiveEnvironment: (id: string) =>
    invoke<void>("set_active_environment", { id }),

  /** Persist the switcher's display order. */
  reorderEnvironments: (ids: string[]) =>
    invoke<void>("reorder_environments", { ids }),

  /** Every environment that references this connection (tab state, last-open
   *  set, focus, visibility filters) — `profiles.json` is global, so this is
   *  the only way to learn which environment a profile actually belongs to.
   *  Used by the CLI connect flow to follow a connection there instead of
   *  always landing in whatever's active. */
  findEnvironmentsForConnection: (profileId: string) =>
    invoke<string[]>("find_environments_for_connection", { profileId }),

  // JSON Schemas ------------------------------------------------------------
  //
  // The cascade that decides which schema applies to a column lives only in
  // Rust (see `src-tauri/src/json_schemas/mod.rs`): a second implementation
  // here would be the same one-grammar-two-parsers trap gotchas #30/#33 exist
  // to prevent, and a resolution bug is not an error, it is "the autocompletion
  // did not appear" — which nobody reports. The frontend therefore caches
  // *results*, never re-derives them.

  /** The whole library: schemas plus the bindings that attach them. */
  listJsonSchemas: () => invoke<JsonSchemaLibrary>("list_json_schemas"),

  /** Create (omit `id`) or update one schema. Discrete arguments rather than the
   *  whole entry, so a form cannot overwrite `createdAt` / `originId`. */
  saveJsonSchema: (args: {
    id?: string;
    name: string;
    description?: string | null;
    body: string;
    source?: JsonSchemaSource;
  }) => invoke<JsonSchemaEntry>("save_json_schema", args),

  /** Delete a schema and cascade to its bindings. Returns how many went, so the
   *  UI can say so; the confirmation itself is the caller's. */
  deleteJsonSchema: (id: string) => invoke<number>("delete_json_schema", { id }),

  /** Create (empty `id`) or update one binding. Here the full record *is* the
   *  right payload — every field is the user's to set. */
  saveJsonSchemaBinding: (binding: JsonSchemaBinding) =>
    invoke<JsonSchemaBinding>("save_json_schema_binding", { binding }),

  deleteJsonSchemaBinding: (id: string) =>
    invoke<void>("delete_json_schema_binding", { id }),

  /** Reassign binding `order` to match `ids`. Matters because `order` is the
   *  cascade's documented tie-break. */
  reorderJsonSchemaBindings: (ids: string[]) =>
    invoke<void>("reorder_json_schema_bindings", { ids }),

  /** Move literal bindings after a column rename. Called by the structure editor
   *  *after* a successful apply, best-effort: the DDL already ran. */
  renameJsonSchemaBindingColumn: (args: {
    connectionId?: string | null;
    dbSchema?: string | null;
    table?: string | null;
    from: string;
    to: string;
  }) => invoke<number>("rename_json_schema_binding_column", args),

  /** Resolve every column of one relation in a single call — made once per data
   *  tab, never once per cell. Only the columns that matched come back. */
  resolveJsonSchemasForColumns: (args: {
    connectionId?: string | null;
    dbSchema?: string | null;
    table?: string | null;
    columns: string[];
  }) => invoke<ResolvedJsonSchema[]>("resolve_json_schemas_for_columns", args),

  /** Resolve one column: the MongoDB dotted-path case, where the field path is
   *  not known until the user expands it. */
  resolveJsonSchema: (args: {
    connectionId?: string | null;
    dbSchema?: string | null;
    table?: string | null;
    column: string;
  }) => invoke<ResolvedJsonSchema | null>("resolve_json_schema", args),

  /** The full ranked cascade for one column — answers "why this schema?", and
   *  more often "why is my rule not applying?". */
  explainJsonSchemaBindings: (args: {
    connectionId?: string | null;
    dbSchema?: string | null;
    table?: string | null;
    column: string;
  }) => invoke<JsonSchemaMatch[]>("explain_json_schema_bindings", args),

  /** Draft a schema from sample values the caller already has in memory. */
  inferJsonSchema: (values: unknown[], closedObjects?: boolean) =>
    invoke<JsonSchemaInferResult>("infer_json_schema", { values, closedObjects }),

  /** Write the selected schemas to a file the user picks; returns the path.
   *  No passphrase: a JSON Schema carries no secret. */
  exportJsonSchemas: (ids: string[], includeBindings?: boolean) =>
    invoke<string>("export_json_schemas", { ids, includeBindings }),

  analyzeJsonSchemaImport: (filePath: string) =>
    invoke<JsonSchemaImportAnalysis>("analyze_json_schema_import", { filePath }),

  importJsonSchemas: (
    filePath: string,
    conflictResolutions: ConflictResolution[],
  ) =>
    invoke<JsonSchemaImportResult>("import_json_schemas", {
      filePath,
      conflictResolutions,
    }),

  // Shared origins ---------------------------------------------------------

  /** Every registered origin, global across all environments. */
  listOrigins: () => invoke<Origin[]>("list_origins"),

  /** Register a shared origin. `passphrase` only for an encrypted file; it goes
   *  to the OS keychain, never to `tab_state.json`. */
  addOrigin: (args: {
    name: string;
    path: string;
    passphrase?: string | null;
  }) => invoke<Origin>("add_origin", args),

  /** Rename / repoint an origin. `passphrase` is tri-state: omit to keep the
   *  stored one, `""` to clear it, a string to replace it. */
  updateOrigin: (args: {
    id: string;
    name: string;
    path: string;
    passphrase?: string | null;
    /** Omit to leave it alone. Switching to `"publisher"` is what lets this
     *  machine write the file at all — confirm it, never do it as a side
     *  effect of a rename. */
    role?: OriginRole | null;
  }) => invoke<Origin>("update_origin", args),

  /** Unregister an origin. The connections it imported are left in place. */
  removeOrigin: (id: string) => invoke<void>("remove_origin", { id }),

  /** Pull an origin. Rejects (touching nothing) when the file can't be read or
   *  parsed; never deletes — disappearances come back in `vanished`. */
  syncOrigin: (id: string) => invoke<OriginSyncReport>("sync_origin", { id }),

  // The origin's document (#155) -------------------------------------------

  /** Can this machine actually write `path`? Tries a real write — permission
   *  bits describe the local mount, not what a share will accept. Never
   *  rejects: an offline share is a state to render, not a failed call. */
  probeOriginWritable: (path: string) =>
    invoke<OriginWritableProbe>("probe_origin_writable", { path }),

  /** Open an origin's file as an editable document. Works for a consumer too —
   *  the editor renders read-only and `role`/`writable` say why. */
  openOriginDocument: (originId: string) =>
    invoke<OriginDocument>("open_origin_document", { originId }),

  /** This machine's own environments, shaped as bundles the editor can copy
   *  into a document — the left-hand column of its environments pane.
   *  Membership is resolved by the same helper the environment export uses, and
   *  an environment that mirrors an origin is excluded (its identity for a
   *  consumer is the publisher's source id, not this machine's). */
  listPublishableEnvironments: () =>
    invoke<OriginDraftEnvironment[]>("list_publishable_environments"),

  /** What publishing this draft would do to everyone pulling from the origin,
   *  computed against the file as it stands on disk. Neither decrypts nor
   *  writes anything, so it is safe to call on a debounce. */
  previewOriginPublish: (originId: string, draft: OriginDraft) =>
    invoke<OriginPublishImpact>("preview_origin_publish", { originId, draft }),

  /** Create an empty document at `path` and register it as an origin this
   *  machine publishes. Refuses an existing file: adopting one is
   *  `updateOrigin({ role: "publisher" })`. */
  createOriginDocument: (args: {
    path: string;
    name: string;
    maintainer?: string | null;
  }) => invoke<Origin>("create_origin_document", args),

  /**
   * Publish a draft. `base` is what `openOriginDocument` returned; the file is
   * re-hashed here and a mismatch comes back as `status: "conflict"` with the
   * newer document, having written nothing.
   *
   * `passphrase` is only needed when a `fromKeychain` slot has to be resolved
   * or `rotateFrom` is set. `rotateFrom` re-keys every envelope in the
   * document — the one operation that deliberately invalidates the whole
   * team's `landedSecrets` cache.
   */
  saveOriginDocument: (args: {
    originId: string;
    draft: OriginDraft;
    base: OriginDraftBase;
    passphrase?: string | null;
    rotateFrom?: string | null;
  }) => invoke<OriginSaveOutcome>("save_origin_document", args),

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

  /** Pop `tab` out into its own bare, native OS window (titled `title`) —
   *  the "sacar como ventana flotante" action. Returns the new window's
   *  label. The caller is responsible for removing the tab from its own
   *  `useTabs` right after — see `DetachedTabWindow` for the other half. */
  openTabWindow: (tab: AppTab, title: string) =>
    invoke<string>("open_tab_window", { tab, title }),

  /** Drain the tab payload stashed for this window's label by
   *  `openTabWindow`. Call once on boot. */
  takeDetachedTabIntent: (label: string) =>
    invoke<AppTab | null>("take_detached_tab_intent", { label }),

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

  // Environment export / import ---------------------------------------------
  // An environment's *portable* identity: its cosmetics, the connection
  // profiles it groups, and its shared origins (name + path, never a
  // passphrase). Tabs and dockview geometry never leave the machine that
  // produced them (CLAUDE.md gotcha #10) — see the module doc in
  // `src-tauri/src/transfer.rs`. Importing always creates a brand-new
  // environment; it never merges into one that already exists.

  /**
   * Export one or more environments (each one's cosmetics and registered
   * origins, plus a single deduplicated pool of the connection profiles any
   * of them reference) to a user-chosen JSON file. Same
   * `includePasswords`/`passphrase` contract as `exportProfiles`. Returns the
   * path of the written file.
   */
  exportEnvironments: (
    ids: string[],
    includePasswords: boolean,
    passphrase?: string,
    includeJsonSchemas?: boolean,
  ) =>
    invoke<string>("export_environments", {
      ids,
      includePasswords,
      passphrase,
      includeJsonSchemas,
    }),

  /**
   * Parse an environment export file and return metadata for the
   * conflict-resolution UI — same shape of step as `analyzeImportFile`, plus
   * one entry per environment in the file with its name and the origins it
   * will register.
   */
  analyzeEnvironmentImport: (filePath: string) =>
    invoke<EnvironmentImportAnalysis>("analyze_environment_import", {
      filePath,
    }),

  /**
   * Import an environment export — every bundle in the file becomes a new
   * environment. `conflictResolutions` must cover every id returned in
   * `analyze.conflicts`, exactly like `importProfiles`.
   */
  importEnvironment: (
    filePath: string,
    passphrase?: string,
    conflictResolutions?: ConflictResolution[],
  ) =>
    invoke<EnvironmentImportResult>("import_environment", {
      filePath,
      passphrase,
      conflictResolutions: conflictResolutions ?? [],
    }),

  // Database export / import ------------------------------------------------

  /**
   * Export one or more databases — each optionally scoped to a subset of
   * its tables — into a single combined `.sql` file at `destPath`. Backs
   * the connection-level and per-database "Export database…" dialog;
   * `targets` carries already-resolved connection ids (the frontend opens
   * any multi-DB synthetic `<parent>::db::<name>` pool itself before
   * calling this), so the backend never has to resolve them. Unlike
   * `exportTable`/`exportTableRows`, the save path is a caller-supplied
   * argument, not a Rust-side dialog — the export dialog owns that field.
   */
  exportDatabases: (args: {
    targets: ExportTarget[];
    dataMode: DataMode;
    destPath: string;
  }) => invoke<string>("export_databases", args),

  /**
   * Read a text file at `filePath`. Used by the "Import .sql…" flow to load
   * a picked file's content before splitting it with `splitSql` and running
   * it through `executeBatch` — there is no separate import-execution command.
   */
  readTextFile: (filePath: string) =>
    invoke<string>("read_text_file", { filePath }),

  /**
   * Read an image file at `filePath` and get it back as a `data:` URL. Used by
   * the environment-avatar picker (`src/lib/environmentAvatar.ts`), which then
   * downscales it in a canvas before it is stored. The backend validates the
   * format by magic bytes and rejects anything oversized, so a rejection here
   * is a real "that isn't a usable image", not a decode failure later.
   */
  readImageDataUrl: (filePath: string) =>
    invoke<string>("read_image_data_url", { filePath }),

  /**
   * Write `contents` to `filePath` verbatim. Used by theme export
   * (`src/lib/themeTransfer.ts`) once the frontend has already picked the
   * destination via the native save dialog — the counterpart to
   * `readTextFile`, and just as narrow (no format opinion, no encoding).
   */
  writeTextFile: (filePath: string, contents: string) =>
    invoke<void>("write_text_file", { filePath, contents }),

  /**
   * Export one SQL table (schema + data) to a user-chosen `.sql` file — the
   * same format `exportDatabase` produces, scoped to a single table.
   * Rejects MongoDB; use `exportCollection` for a collection.
   */
  exportTable: (connectionId: string, schema: string | undefined, table: string) =>
    invoke<string>("export_table", { connectionId, schema, table }),

  /**
   * Export the rows of a SQL table matching `filters`/`search` as `INSERT`
   * statements, without any DDL — "export query results" against the
   * DataGrid's current advanced-filter state, not the whole table. No
   * pagination limit. Rejects MongoDB.
   */
  exportTableRows: (query: TableScan) =>
    invoke<string>("export_table_rows", { query }),

  /**
   * Export a MongoDB collection's documents matching `filters` (all of them
   * when omitted/empty) to a user-chosen `.json` file as canonical Extended
   * JSON (#65). The save dialog opens on the Rust side; returns the written
   * path. Rejects if the user cancels.
   */
  exportCollection: (connectionId: string, collection: string, filters?: ColumnFilter[]) =>
    invoke<string>("export_collection", { connectionId, collection, filters }),

  /** Import documents from `filePath` (JSON array / object / JSONL) into a
   *  MongoDB collection (#65). Returns the number of inserted documents. */
  importCollection: (connectionId: string, collection: string, filePath: string) =>
    invoke<number>("import_collection", { connectionId, collection, filePath }),

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

  /**
   * Show `path` in the OS file manager **with the item selected** (Explorer on
   * Windows, Finder on macOS, the desktop's file manager on Linux) — not merely
   * opened, which is why this is `reveal_item_in_dir` rather than `open_path`.
   *
   * Used by the notification raised after an export (`notify.file`): the point
   * of showing a path is being able to get to the file. Unlike `open_url` there
   * is no URL allowlist to scope — the permission
   * (`opener:allow-reveal-item-in-dir`) grants the command as a whole, and the
   * only paths we ever hand it are ones the user just chose in a save dialog.
   *
   * Rejects when the file has since been moved or deleted; callers surface that
   * rather than swallowing it, so a dead path doesn't look like a dead button.
   *
   * The command's Rust argument is `paths: Vec<PathBuf>` (plural — it can
   * reveal several items at once), not `path`. Sending `{ path }` used to
   * fail IPC deserialization on every call regardless of whether the file
   * existed, which `reveal()` in `NotificationCard.tsx` then reported as
   * "the file is no longer there" — a false positive for a file that was
   * sitting right where it said it was.
   */
  revealItemInDir: (path: string) =>
    invoke<void>("plugin:opener|reveal_item_in_dir", { paths: [path] }),

  // MCP connector ----------------------------------------------------------

  /** Resolve the bundled `huginndb-mcp` sidecar's path (Settings → MCP). */
  getMcpConnectorInfo: () => invoke<McpConnectorInfo>("get_mcp_connector_info"),

  /**
   * Best-effort check for whether an external MCP client currently has the
   * `huginndb-mcp` sidecar running. Used before an update install, which
   * force-kills the sidecar to overwrite its binary — see `stores/update.ts`.
   */
  isMcpSidecarRunning: () => invoke<boolean>("is_mcp_sidecar_running"),

  // App flavor -------------------------------------------------------------

  /**
   * Report whether this build is the stable or the isolated `canary` sandbox
   * build. Resolved from a compile-time `cfg` on the backend — the frontend
   * bundle is identical across flavors, so runtime IPC is the only signal.
   * Drives the sandbox indicator (see `stores/appFlavor.ts`).
   */
  getAppFlavor: () => invoke<AppFlavor>("get_app_flavor"),

  // Pulse ------------------------------------------------------------------

  /**
   * One read of a connection's vital signs. Rejects with an
   * `UnsupportedDriver` error for a driver Pulse cannot measure yet, which the
   * panel renders as an explicit "not supported" state rather than a wall of
   * zeroes.
   */
  pulseHealth: (connectionId: string) =>
    invoke<PulseHealth>("pulse_health", { connectionId }),

  /**
   * Statements the server has spent the most time on. On demand, never polled:
   * it reads `performance_schema`, the most expensive statement Pulse issues,
   * and it rejects outright when that is switched off.
   */
  pulseTopQueries: (connectionId: string) =>
    invoke<PulseTopQuery[]>("pulse_top_queries", { connectionId }),

  /** The connection's biggest relations, largest first. On demand. */
  pulseStorage: (connectionId: string) =>
    invoke<PulseStorageItem[]>("pulse_storage", { connectionId }),

  /**
   * The plan the server would use for `sample` — one of a `PulseTopQuery`'s
   * own `sample` values — without running it. Rejects when `sample` is not a
   * single read-only statement; the panel only ever sends its own captured
   * samples, so that should never fire in practice.
   */
  pulseExplain: (connectionId: string, sample: string) =>
    invoke<PulseExplainPlan>("pulse_explain", { connectionId, sample }),

  /**
   * Every session or operation currently open on the server. On demand,
   * never polled — a live snapshot is only meaningful the instant someone
   * asks for it.
   */
  pulseSessions: (connectionId: string) =>
    invoke<PulseSession[]>("pulse_sessions", { connectionId }),

  /** Index usage across the connection's biggest relations, least-read
   *  first. On demand. */
  pulseIndexUsage: (connectionId: string) =>
    invoke<PulseIndexUsage[]>("pulse_index_usage", { connectionId }),

  /**
   * One metric's stored history for `connectionId` since `sinceMs` (epoch
   * milliseconds), oldest first. Works even when the connection is not
   * currently open — history outlives the pool it came from.
   */
  pulseHistory: (connectionId: string, metric: string, sinceMs: number) =>
    invoke<PulseHistorySeries>("pulse_history", {
      connectionId,
      metric,
      sinceMs,
    }),

  /**
   * Open Pulse's expanded view in its own OS window, measuring `connectionId`.
   * Returns the new window's label. Not a detached tab — Pulse has no
   * `TabKind` and never appears in the workspace.
   */
  openPulseWindow: (connectionId: string, title: string) =>
    invoke<string>("open_pulse_window", { connectionId, title }),

  /** Drain the connection id stashed for this Pulse window. Called once, on
   *  boot, by `PulseWindow`. */
  takePulseWindowIntent: (label: string) =>
    invoke<string | null>("take_pulse_window_intent", { label }),
};
