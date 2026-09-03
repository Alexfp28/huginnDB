/**
 * Frontend-facing TypeScript counterparts of the Rust types exposed by
 * the Tauri commands. Field names and casing must stay aligned with the
 * Rust `#[derive(Serialize)]` output — see `src-tauri/src/state.rs` and
 * `src-tauri/src/commands/`.
 */

/** Database backend supported by a profile. */
export type Driver = "postgres" | "mysql" | "sqlite" | "mongodb" | "sqlserver";

/**
 * How a SQL Server connection authenticates. `sql` is an ordinary SQL Server
 * login; `windows` is NTLM with an explicit `DOMAIN\user` + password and is
 * only available in Windows builds (the underlying driver gates it at compile
 * time), so the dialog hides it elsewhere.
 */
export type MsSqlAuth = "sql" | "windows";

/**
 * SQL Server-specific connection settings. Nested like {@link SshTunnel} so
 * the other four drivers' profiles don't carry fields that mean nothing to
 * them. Mirrors `state::MsSqlOptions` — a field missing here is silently
 * dropped on the IPC round-trip.
 */
export interface MsSqlOptions {
  /** Named instance (the `SQLEXPRESS` of `HOST\SQLEXPRESS`). The combined
   *  `HOST\INSTANCE` form SSMS asks for is accepted here (and in the host
   *  field) and split by `split_instance` on the backend. When set, the port
   *  is discovered through the SQL Browser instead of being used as given —
   *  except as the fallback tried when the Browser doesn't answer. */
  instance?: string | null;
  /** Accept the server's TLS certificate without validating it. Required in
   *  practice for the self-signed certificates most on-prem instances
   *  present. */
  trust_server_certificate?: boolean;
  auth?: MsSqlAuth;
}

/**
 * Authentication method for the SSH tunnel. The actual secret (password or
 * private-key passphrase) never appears in the profile; it lives in the OS
 * keychain under `${profile.id}::ssh::${ssh.username}` and is resolved at
 * connect time.
 */
export type SshAuth =
  | { kind: "password" }
  | { kind: "key"; path: string };

/**
 * How the client decides whether to trust the SSH server's host key.
 *
 * - `strict`     — only accept keys that match a previously stored
 *                  fingerprint for this `host:port`. Reject unknown servers.
 * - `accept-new` — accept and remember unknown servers on first connect
 *                  (TOFU); reject mismatches afterwards. Recommended default
 *                  and what `ssh -o StrictHostKeyChecking=accept-new` does.
 * - `accept-any` — accept any presented key without checking. Use only for
 *                  throwaway test setups; offers no MITM protection.
 */
export type HostKeyPolicy = "strict" | "accept-new" | "accept-any";

/** Optional SSH tunnel configuration. */
export interface SshTunnel {
  host: string;
  /** Default 22. */
  port: number;
  username: string;
  auth: SshAuth;
  /** Local port to bind for the tunnel listener. 0 = auto-assign. */
  local_port: number;
  /** Host-key trust policy. Defaults to `accept-new` (TOFU). */
  host_key_policy: HostKeyPolicy;
}

/**
 * Persisted connection profile. Mirrors `ConnectionProfile` in Rust.
 *
 * The matching password lives in the OS keychain — it is never part of
 * this object.
 */
export interface ConnectionProfile {
  id: string;
  name: string;
  driver: Driver;
  /** Host or, for SQLite, the empty string. */
  host: string;
  /** TCP port, ignored for SQLite. */
  port: number;
  /** Catalog name; for SQLite this is the filesystem path. */
  database: string;
  username: string;
  ssl: boolean;
  ssh_tunnel?: SshTunnel | null;
  /** Raw connection URI — the primary connection input for MongoDB
   *  (`mongodb://…` / `mongodb+srv://…`). When set it takes precedence over the
   *  discrete host/port/database fields. `null`/absent for the SQL drivers. */
  connection_string?: string | null;
  /** MongoDB `authSource` (the database to authenticate against, e.g.
   *  `admin`). The form-built `connection_string` already embeds it as a query
   *  option; it is persisted separately so the CLI fallback (no URI) and the
   *  form repopulation have it explicitly. `null`/absent for the SQL drivers. */
  auth_source?: string | null;
  /** SQL Server-specific settings (named instance, certificate trust, auth
   *  mode). `null`/absent for every other driver, and for a SQL Server profile
   *  saved before the field existed — the defaults are the plain
   *  SQL-login-over-an-explicit-port case. */
  mssql?: MsSqlOptions | null;
  /** Session-only profile (e.g. a CLI ad-hoc connection) that the backend
   *  keeps in memory but never writes to `profiles.json`. */
  ephemeral?: boolean;
  /** Free-text group/folder label for the connection list. `null`/absent
   *  means ungrouped. Purely a display grouping — matched by string
   *  equality in the frontend, no separate group registry. */
  group?: string | null;
  /** DataGrip-style subset of databases to show for a multi-DB connection
   *  (#64). `null`/absent = show all. When set, the multi-DB explorer renders
   *  and warms only these databases. Frontend-only display/perf concern; the
   *  backend stores it opaquely. */
  visible_databases?: string[] | null;
  /** How far the headless MCP connector (`huginndb-mcp`) may write to this
   *  connection (1.9.0). `"read-only"` (default / absent) = reads only;
   *  `"data"` = INSERT/UPDATE/DELETE + structured write tools; `"full"` = adds
   *  DDL. The sidecar re-reads this from `profiles.json` on every write, so a
   *  change here takes effect without restarting the MCP client. Mirrors
   *  `McpWritePolicy` in Rust. */
  mcp_write?: McpWritePolicy;
  /**
   * Total connections HuginnDB may hold against this server, overriding the
   * global `connections.maxConnections` preference. `null`/absent means "use
   * the preference".
   *
   * A *budget for the server*, not a size for one pool: every database view on
   * the same host draws from it too.
   *
   * Lives on the profile rather than in preferences because connection
   * capacity is a fact about a *server*: it then travels with the connection
   * through export/import and shared origins, and the headless MCP sidecar
   * honours it for free since it reads the same `profiles.json`. Clamped
   * backend-side, so an out-of-range value here is corrected rather than
   * rejected.
   */
  max_connections?: number | null;
  /**
   * Set when this profile came from a shared origin (#108). Such a profile is
   * **read-only in the UI**: it mirrors an entry in a file somebody else
   * curates, so a local edit would be silently undone by the next sync.
   * Duplicating it produces an ordinary local profile with no `origin_id`.
   *
   * `snake_case` like its neighbours here — this interface mirrors the Rust
   * struct's serde output, which is not camelCased for profiles.
   */
  origin_id?: string | null;
  /** Whether Pulse's background history sampler persists this connection's
   *  vital signs into `pulse.db`. Opt-in, `false`/absent by default — same
   *  reasoning as `mcp_write`: an upgrade must never silently start polling
   *  and storing data about a server the user didn't ask to be tracked. */
  pulse_enabled?: boolean;
  /** Whether the headless MCP connector may reach this connection at all.
   *  Opt-in, `false`/absent by default, and ticked in Settings → MCP. The
   *  sidecar re-reads it per call, so a change takes effect without restarting
   *  the MCP client; a client started with an explicit `--connections` list is
   *  pinned to it instead. Strictly local: preserved across a shared-origin
   *  sync and cleared on import, since what your AI clients may reach is a
   *  decision about this machine. */
  mcp_exposed?: boolean;
}

/** Outcome of registering the sidecar with the Claude Code CLI. Mirrors
 *  `ClaudeCodeOutcome` in Rust (serde kebab-case).
 *
 *  `already-registered` is deliberately not an error: it is what a second
 *  click looks like. `cli-not-found` means the panel should fall back to the
 *  copyable command. */
export type ClaudeCodeOutcome =
  | "added"
  | "already-registered"
  | "cli-not-found"
  | "failed";

export interface ClaudeCodeRegistration {
  outcome: ClaudeCodeOutcome;
  /** What the CLI printed, trimmed. Empty unless `outcome` is `failed`. */
  detail: string;
}

/** How far the MCP connector may write to a connection. Mirrors
 *  `McpWritePolicy` in Rust (serde kebab-case). */
export type McpWritePolicy = "read-only" | "data" | "full";

/** Database / schema row in the schema explorer. */
export interface DatabaseInfo {
  name: string;
}

/**
 * A database's approximate on-disk size, from `get_database_sizes` (#153).
 *
 * Mirrors `DatabaseSize` in `src-tauri/src/commands/schema.rs`. `size_bytes`
 * is **optional, and its absence means "the engine would not say"** — never
 * "empty". A MySQL login without the privilege on a 31-table schema is the
 * case this exists for, and rendering that as `0` would tell the user their
 * data is gone. The backend omits the key rather than sending `null`, matching
 * `TableInfo.size_bytes`; guard with `!= null` all the same, since a `null`
 * once slipped through and crashed `formatBytes`.
 *
 * The five drivers measure genuinely different things and their numbers do not
 * reconcile — with each other, with the sum of the per-table badges, or with
 * Pulse. See the Rust DTO for what each one counts.
 */
export interface DatabaseSize {
  name: string;
  size_bytes?: number;
}

/** Table or view row in the schema explorer. */
export interface TableInfo {
  schema: string;
  name: string;
  kind: "table" | "view";
  /**
   * Approximate row count from the engine's statistics catalog.
   * Undefined for SQLite (no reliable catalog source without N+1 queries)
   * and for views on any driver.
   */
  row_count?: number;
  /**
   * Approximate on-disk size in bytes (data + indexes).
   * Undefined for views, and for SQLite when the `dbstat` virtual table is
   * unavailable.
   */
  size_bytes?: number;
}

/** Column metadata as displayed in the schema explorer. */
export interface ColumnInfo {
  name: string;
  data_type: string;
  nullable: boolean;
  is_primary_key: boolean;
  /**
   * For single-column FOREIGN KEY constraints, the schema/table/column the
   * value must exist in. All three are `null` for non-FK columns or for
   * composite FKs (which we don't surface in this iteration).
   */
  referenced_schema?: string | null;
  referenced_table?: string | null;
  referenced_column?: string | null;
}

/** One row in an FK dropdown. */
export interface FkOption {
  /** Stringified referenced primary-key value. */
  value: string;
  /**
   * Optional human-readable label (first textual non-PK column). When absent
   * the UI falls back to displaying `value` only.
   */
  label: string | null;
}

/** Result page returned by `fetch_fk_options`. */
export interface FkOptionsPage {
  options: FkOption[];
  /** True when more rows match than the requested limit. */
  has_more: boolean;
}

/** Index summary including the participating columns. */
export interface IndexInfo {
  name: string;
  columns: string[];
  unique: boolean;
}

// ---------------------------------------------------------------------------
// MongoDB index manager — mirror of the Rust DTOs in
// src-tauri/src/db/mongo/indexes.rs.
//
// Deliberately NOT `IndexInfo`: that one carries a name, field names and
// `unique`, which is everything the SQL explorer's tree needs and nowhere near
// enough to rebuild a Mongo index. Recreating `{ createdAt: -1 }` from a list
// of field names would silently make it ascending.
// ---------------------------------------------------------------------------

/** One entry of an index's `key` document, in order. */
export interface MongoIndexKey {
  /** Indexed field path (`customData.format`, `tags`, `$**`). */
  field: string;
  /** The key's value as source text: `1`, `-1`, `"text"`, `"2dsphere"`,
   *  `"hashed"`. A union of direction and index type, so it stays text. */
  value: string;
}

/** Derived label for an index's shape; not a server concept. */
export type MongoIndexKind =
  | "regular"
  | "text"
  | "geo"
  | "hashed"
  | "wildcard"
  | "ttl";

export interface MongoIndexInfo {
  name: string;
  keys: MongoIndexKey[];
  /** The whole `key` document as source text — what the editor loads and what
   *  a recreate sends back, so exotic keys round-trip intact. */
  keysSource: string;
  unique: boolean;
  sparse: boolean;
  hidden: boolean;
  expireAfterSeconds?: number | null;
  partialFilterExpression?: string | null;
  collation?: string | null;
  weights?: string | null;
  defaultLanguage?: string | null;
  kind: MongoIndexKind;
  /** `_id_`: undroppable, unhidable. */
  isId: boolean;
  /** Null when the role can't read `$collStats`. */
  sizeBytes?: number | null;
  /** Null when the role can't read `$indexStats`. Zero ops over a long
   *  `usageSince` is an index nobody is using. */
  usageOps?: number | null;
  usageSince?: string | null;
  /** Every option the DTO doesn't model, as a source-text document. */
  extraOptions?: string | null;
}

/** The index the editor wants to exist. Documents are source text, parsed in
 *  Rust — the frontend never parses BSON (gotcha #33). */
export interface NewMongoIndexSpec {
  keys: string;
  /** Blank/omitted falls back to the `field_1_other_-1` convention, computed
   *  on the Rust side (`default_index_name` in `db/mongo/indexes.rs`) — the
   *  raw `createIndexes` command this app uses does not derive it itself. */
  name?: string | null;
  unique: boolean;
  sparse: boolean;
  hidden: boolean;
  expireAfterSeconds?: number | null;
  partialFilterExpression?: string | null;
  collation?: string | null;
  weights?: string | null;
  defaultLanguage?: string | null;
  /** Escape hatch for options the dialog has no field for. */
  extraOptions?: string | null;
}

/**
 * One server-side user/role in the "Security" panel. Field meaning is
 * driver-specific — see `list_users` in `src-tauri/src/commands/schema.rs`.
 * `name` is `"user@host"` for MySQL, a bare name for every other driver.
 * Always an empty list for SQLite (no user/permission concept).
 */
export interface UserInfo {
  name: string;
  is_superuser: boolean;
  can_login: boolean;
  roles: string[];
}

/**
 * One granted privilege for a `UserInfo`, lazy-loaded when its row is
 * expanded. `schema`/`table` are both `null` for a server/database-wide
 * grant (e.g. `ON *.*`).
 */
export interface PrivilegeInfo {
  privilege: string;
  schema: string | null;
  table: string | null;
}

// ---------------------------------------------------------------------------
// Table-structure editor — mirror of the Rust DTOs in src-tauri/src/db/ddl.rs.
// camelCase on the wire.
// ---------------------------------------------------------------------------

export interface ColumnDef {
  name: string;
  /** Original name when editing; absent for a new column (distinguishes a
   *  rename from a drop+add). */
  originalName?: string | null;
  dataType: string;
  nullable: boolean;
  default?: string | null;
  isPrimaryKey: boolean;
  autoIncrement?: boolean;
}

export interface StructureIndexDef {
  name?: string | null;
  columns: string[];
  unique: boolean;
}

export interface ForeignKeyDef {
  name?: string | null;
  columns: string[];
  refSchema?: string | null;
  refTable: string;
  refColumns: string[];
  onDelete?: string | null;
  onUpdate?: string | null;
}

export interface TableStructure {
  schema?: string | null;
  name: string;
  columns: ColumnDef[];
  indexes: StructureIndexDef[];
  foreignKeys: ForeignKeyDef[];
}

export interface StructurePreview {
  statements: string[];
  /** True when applying on SQLite rebuilds the table (destructive). */
  rebuild: boolean;
}

// ---------------------------------------------------------------------------
// View editor — mirror of the Rust DTOs in
// src-tauri/src/db/view_ddl.rs / src-tauri/src/commands/view.rs.
// ---------------------------------------------------------------------------

export interface ViewDefinition {
  schema?: string | null;
  name: string;
  /** The view body only (a `SELECT ...` statement), never the surrounding
   *  `CREATE VIEW ... AS`. */
  query: string;
}

export interface ViewPreview {
  statements: string[];
  /** True when applying redefines the view via drop+recreate rather than
   *  `CREATE OR REPLACE VIEW` (always the case on SQLite, which has neither
   *  `CREATE OR REPLACE VIEW` nor `ALTER VIEW`). Informational only — a view
   *  holds no data of its own, so unlike the SQLite table rebuild this isn't
   *  gated behind a destructive-confirmation dialog. */
  dropAndRecreate: boolean;
}

// ---------------------------------------------------------------------------
// MongoDB aggregation editor — mirror of the Rust DTOs in
// src-tauri/src/db/mongo/aggregation.rs / src-tauri/src/commands/aggregation.rs.
// ---------------------------------------------------------------------------

/**
 * A MongoDB view as the aggregation editor sees it. Unlike {@link ViewDefinition}
 * there is no SQL body: a Mongo view is a stored pipeline over `viewOn`, so the
 * editor holds source *text* — the exact relaxed-JSON the user typed, parsed
 * only in Rust.
 */
export interface MongoViewDefinition {
  name: string;
  /** The collection (or view) the pipeline reads from. */
  viewOn: string;
  /** The whole pipeline as one array literal, for the text editor. */
  pipeline: string;
  /** The same pipeline split per stage, for the stage editor. */
  stages: string[];
}

/** One stage as sent to the backend: its source plus its on/off state. */
export interface PipelineStageInput {
  body: string;
  enabled: boolean;
}

/** A pipeline normalised into both of the editor's representations. Returned
 *  by `formatMongoPipeline`, which is both the prettify action and the
 *  stages ⇄ text mode switch (splitting an array literal into stages needs the
 *  grammar, so it can't be done client-side). */
export interface PipelineText {
  text: string;
  stages: string[];
}

/** Preview output for one stage, index-aligned to the stages that were sent. */
export interface StagePreview {
  index: number;
  /** The stage is switched off — nothing ran for it. */
  skipped: boolean;
  result: QueryResult | null;
  /** A parse error in this stage's body, or the server error from running the
   *  pipeline up to and including it. */
  error: string | null;
  /** The sample hit the preview limit, so the real output is "this many or
   *  more" rather than exactly this many. */
  truncated: boolean;
}

/** Column descriptor in a `QueryResult`. */
export interface ColumnMeta {
  name: string;
  data_type: string;
}

/**
 * Any value the backend can render. Objects appear for JSON columns,
 * `null` for SQL NULL, and primitives for scalars.
 */
export type CellValue = string | number | boolean | null | object;

/** Shape returned by `execute_query` / `fetch_table_data`. */
export interface QueryResult {
  columns: ColumnMeta[];
  rows: CellValue[][];
  rows_affected: number;
  elapsed_ms: number;
  /** Only populated by `fetch_table_data` when called with `withCount: true`.
   *  The table-data browser fetches the total separately via
   *  {@link CountResult} so the count never blocks the first row render. */
  total: number | null;
  /**
   * MongoDB only: per-cell BSON *type* structure, parallel to {@link rows}
   * (one inner array per row, aligned to {@link columns}). Absent for the SQL
   * drivers, whose per-column {@link ColumnMeta.data_type} already says
   * everything there is to say.
   *
   * Needed because the JSON a MongoDB cell arrives as is deliberately lossy:
   * `Int32`/`Int64`/`Double` all become a JSON number and
   * `ObjectId`/`Date`/`Decimal128` all become a string. The document list view
   * edits fields in place and must send the field's real type back, so it
   * reads it from here instead of guessing — see `bson_type_tree` in
   * `src-tauri/src/db/mongo/values.rs`. */
  row_types?: BsonTypeTree[][] | null;
  /**
   * `true` when the driver returned more rows than the ad-hoc query cap
   * (`MAX_ADHOC_QUERY_ROWS` in `src-tauri/src/commands/query.rs`) and the
   * excess was discarded rather than sent to the frontend. Only ever set by
   * `execute_query`/`execute_batch` on a hand-typed SELECT with no
   * `LIMIT`/`TOP`/`.limit()` of its own — `fetch_table_data` always paginates
   * server-side and never truncates.
   */
  truncated?: boolean;
}

/** Mirror of a BSON value's type structure (see {@link QueryResult.row_types}):
 *  a scalar is its type name, a document an object of the same keys, an array
 *  an array of the same length. */
export type BsonTypeTree =
  | string
  | { [key: string]: BsonTypeTree }
  | BsonTypeTree[];

/** Row total for the table-data browser, fetched separately from the data
 *  page (see `count_table_rows`). `estimated` is `true` when the total is a
 *  fast engine statistics estimate (whole-table browse) rather than an exact
 *  `COUNT(*)`; the footer renders an estimate as `~N`. */
export interface CountResult {
  total: number;
  estimated: boolean;
}

/** Outcome of one statement inside a {@link BatchResult}. */
export interface StmtOutcome {
  index: number;
  /** Single-line, length-capped echo of the statement for the summary. */
  preview: string;
  rows_affected: number;
  is_select: boolean;
  /** Driver error message; when set, the batch stopped at this statement. */
  error: string | null;
}

/** Result of running a batch of statements via `execute_batch`. */
export interface BatchResult {
  statements: StmtOutcome[];
  /** Full result set of the last SELECT in the batch, for the grid. */
  last_result: QueryResult | null;
  total_affected: number;
}

/** Tabs in the main workspace can host either table data or a query editor. */
export type TabKind =
  | "table"
  | "query"
  | "structure"
  | "security"
  | "view"
  | "aggregation"
  | "indexes";

/** New-table vs edit-existing for a structure tab. Reused as-is for view
 *  tabs ("new" view vs "edit" an existing one) — same semantics, no need
 *  for a parallel `ViewMode` type. */
export type StructureMode = "new" | "edit";

export interface AppTab {
  id: string;
  kind: TabKind;
  title: string;
  connectionId: string;
  schema?: string;
  /** The table for a table/structure tab; for `kind: "aggregation"` it is the
   *  collection the pipeline reads from (`viewOn`). */
  table?: string;
  /** For `kind: "view"` tabs: the view name being edited; absent when
   *  `viewMode` is `"new"`. For `kind: "aggregation"` tabs the same field
   *  names the MongoDB view the pipeline is bound to — absent when the tab is
   *  an unbound pipeline over a plain collection, which "Save as view" then
   *  binds. */
  view?: string;
  /** For view and aggregation tabs: whether we're creating a new view or
   *  editing one. */
  viewMode?: StructureMode;
  /** User-assigned tab colour (hex, e.g. `#ef4444`). Undefined = no colour.
   *  Purely cosmetic; persisted per connection. */
  color?: string;
  /** Pinned tabs survive bulk-close (close others / all / to the right) and
   *  are grouped first in the tab switcher, so they don't get lost among many
   *  open tabs. Persisted per connection. */
  pinned?: boolean;
  /** Initial / current SQL for query tabs. */
  query?: string;
  /** For structure tabs: whether we're creating a new table or editing one. */
  structureMode?: StructureMode;
  /**
   * Seed server-side filters for a `kind: "table"` tab — set when the tab is
   * opened by "go to referenced row" (FK navigation) so the table lands
   * pre-filtered to the master record. Transient (not persisted); re-opening
   * an already-open table with a fresh array re-applies it. See
   * `TableDataTab` + `useTabs.open`.
   */
  initialFilters?: ColumnFilter[];
  /**
   * Committed view state of a `kind: "table"` tab, persisted with the tab so a
   * restored session comes back filtered and sorted the way it was left (#112).
   *
   * Distinct from `initialFilters` in both direction and lifetime: that one is a
   * transient *seed* pushed in by FK navigation, while this is the tab's current
   * state pushed *out* by `TableDataTab` via `setViewState` whenever the user
   * commits a change. `TableDataTab` reads it once on mount and owns the working
   * copy from then on, so there is no write-back loop.
   *
   * Lives on the tab rather than inside `TableDataTab` because
   * `persistedTabs.snapshotFor` can only see what's in this store.
   */
  viewState?: TabViewState;
}

/** Persisted, committed view state of a table tab (#112). */
export interface TabViewState {
  filters?: ColumnFilter[];
  sort?: SortSpec[];
  /** The *applied* free-text search, never the uncommitted toolbar draft. */
  search?: string;
  /**
   * "table" vs "list" row layout for this tab specifically, not a global
   * preference — each table tab keeps its own choice, independent of other
   * tabs and other windows. Falls back to `GridPrefs.documentViewMode` (the
   * default for a newly opened tab) when absent. See `TableDataTab`.
   */
  documentViewMode?: "table" | "list";
}

/**
 * Comparison operator for `ColumnFilter`. Mirrors the closed set the
 * backend accepts in `fetch_table_data`. `is_null` / `is_not_null` ignore
 * the `value` field; every other op consumes it. The `contains` family is
 * substring/prefix/suffix `LIKE`; `gt`/`gte`/`lt`/`lte`/`between` are ordered
 * comparisons (offered for numeric/date columns) — `between` additionally
 * consumes `value2` as the inclusive upper bound. `in` / `not_in` read the
 * `values` list instead of `value`.
 */
export type FilterOp =
  | "eq"
  | "ne"
  | "contains"
  | "not_contains"
  | "starts_with"
  | "ends_with"
  | "gt"
  | "gte"
  | "lt"
  | "lte"
  | "between"
  | "in"
  | "not_in"
  | "is_null"
  | "is_not_null";

/** A single column-level predicate AND-composed in `fetch_table_data`. */
export interface ColumnFilter {
  column: string;
  op: FilterOp;
  value?: CellValue;
  /** Range upper bound, only used by `"between"`. */
  value2?: CellValue;
  /**
   * Value list, only used by `"in"` / `"not_in"`. The backend deduplicates it,
   * handles a `null` member through a dedicated `IS NULL` branch, and rejects
   * lists longer than its `MAX_IN_VALUES` cap (1000).
   */
  values?: CellValue[];
}

/**
 * The predicate half of a table browse: structured column filters plus the
 * free-text needle and the columns it searches. Mirrors `TableFilter` in
 * `src-tauri/src/commands/query.rs`, where it is `#[serde(flatten)]`ed into
 * the two payloads below — so the wire shape is one flat object, not a nested
 * `filter` key.
 */
export interface TableFilter {
  filters?: ColumnFilter[];
  /** Free-text needle, `LIKE`-escaped server-side and OR-composed across
   *  `searchColumns`, then AND-composed with `filters`. An empty string is
   *  treated as "no needle", not as a match-everything predicate. */
  search?: string;
  searchColumns?: string[];
}

/** A table plus a predicate over it, with no paging — the payload of
 *  `countTableRows` and `exportTableRows`. Mirrors Rust `TableScan`. */
export interface TableScan extends TableFilter {
  connectionId: string;
  schema?: string;
  table: string;
}

/** One page of a table browse — the payload of `fetchTableData`. Mirrors Rust
 *  `TableQuery`. A field declared here but not there is dropped by serde
 *  without a word (CLAUDE.md gotcha #14), so the two must move together. */
export interface TableQuery extends TableScan {
  limit: number;
  offset: number;
  /** Ordered multi-column sort; `order[0]` is the primary key. */
  order?: SortSpec[];
  /** Run the companion `COUNT(*)`. The GUI always passes `false` (the total is
   *  fetched out-of-band via `countTableRows` so it never gates the first row
   *  render); the headless MCP `browse_table` tool uses the inline count.
   *  Defaults to `true` on the backend when omitted. */
  withCount?: boolean;
}

/** One column/value pair used when building an INSERT. */
export interface RowValue {
  column: string;
  value: string | null;
  /** `data_type` from `ColumnMeta` — forwarded so the backend can apply
   *  driver-specific binding (e.g. `CAST(? AS UNSIGNED)` for MySQL BIT). */
  columnType?: string;
}

/**
 * Per-cell state for the inline insert/duplicate draft row.
 *
 * `touched=false` means the user has not interacted with this cell, so the
 * column is omitted from the INSERT and the database default is used.
 * `touched=true` + `value=null` is an explicit `NULL`. `touched=true` +
 * `value="some string"` is bound as text.
 */
export interface DraftCell {
  value: string | null;
  touched: boolean;
  /**
   * Type the value must be written as, overriding the column's catalog type.
   *
   * Only the list view's draft card sets it, and only on MongoDB: a collection
   * has no schema, so the type a new field is stored with is a *choice*, not a
   * property of the column. Inferring it from the text would write an `Int32`
   * into a field the collection holds as a `Long` — the same fidelity trap
   * gotcha #29 documents for edits. Absent → the catalog type is used, which is
   * what every SQL insert wants (it is what tells the backend a MySQL `BIT`
   * needs its `CAST`, gotcha #15).
   */
  type?: string;
}

/** Inline draft row state owned by `TableDataTab`. */
export interface DraftRow {
  cells: Record<string, DraftCell>;
  error: string | null;
  saving: boolean;
}

/**
 * How a table's existing data is treated by `exportDatabases` relative to
 * the rows being written. `truncate_insert` prefixes each table's INSERTs
 * with a `DELETE FROM` so re-running the dump against a target that already
 * has conflicting rows replaces them instead of erroring on the primary key.
 */
export type DataMode = "insert" | "truncate_insert";

/** One database (or, for a multi-DB connection, one already-resolved
 *  `<parent>::db::<name>` child) to include in an `exportDatabases` call. */
export interface ExportTarget {
  connectionId: string;
  databaseName: string;
  /** `undefined` exports every table in this database. */
  tables?: string[];
}

/**
 * Response from `preview_bulk_update`: how many rows/documents currently
 * match the filter, plus the statement `apply_bulk_update` would run.
 */
export interface BulkUpdatePreview {
  statement: string;
  affectedEstimate: number;
}

/**
 * User preferences. Mirrors `Preferences` in `src-tauri/src/prefs.rs`.
 *
 * Persisted to `prefs.json` in the platform config dir. The frontend store
 * always sends a full snapshot — partial updates are merged client-side.
 */
export interface Preferences {
  version: number;
  editor: EditorPrefs;
  grid: GridPrefs;
  ui: UiPrefs;
  /** Notification placement, timing and history. See {@link NotificationPrefs}. */
  notifications: NotificationPrefs;
  /** Connection-pool policy. See {@link ConnectionPrefs}. */
  connections: ConnectionPrefs;
  /** Pulse's background history sampler. See {@link PulsePrefs}. */
  pulse: PulsePrefs;
  /**
   * User-rebound keyboard shortcuts, keyed by action id to an ordered list of
   * bindings (e.g. `["Mod+K"]`, `["Mod+Enter", "F9"]`). The first entry is the
   * primary one — what menus and tooltips display; the rest are aliases that
   * fire just as well.
   *
   * Three states, all distinct and all meaningful:
   * - key absent → use that action's defaults
   * - `[]`       → the user deliberately unbound it
   * - `[a, b]`   → primary plus aliases
   *
   * `ACTIONS` in `src/lib/keybindings/actions.ts` is the single source of truth
   * for the defaults, so an empty map here is a fully functional state. The
   * backend accepts a bare string per key too (the pre-1.19 shape) and folds it
   * into a one-element list on read.
   */
  keybindings: Record<string, string[]>;
}

/**
 * How many database connections HuginnDB may hold, and for how long.
 *
 * These are the *global* fallbacks; a single server that needs a different
 * budget is better expressed per profile via
 * {@link ConnectionProfile.max_connections}, which travels with the connection
 * and is also honoured by the headless MCP sidecar.
 *
 * Mirrors `ConnectionPrefs` in `src-tauri/src/prefs.rs`.
 */
export interface ConnectionPrefs {
  /**
   * **Total** connections HuginnDB may hold against one server, shared by
   * every connection and every database view that reaches it.
   *
   * A per-*pool* ceiling before 1.13.0, which is exactly why the footprint was
   * unbounded: three connections to the same host each got their own
   * allowance. Clamped to 2..64 backend-side.
   */
  maxConnections: number;
  /**
   * Ceiling for each synthetic `<parent>::db::<name>` pool. Kept low on
   * purpose: these are the pools that multiply with the number of databases
   * browsed on one server.
   */
  childMaxConnections: number;
  /** Seconds a per-database pool may go untouched before it is closed. `0` disables reaping. */
  childIdleTtlSecs: number;
  /** Most per-database pools one connection may hold; longest-unused are closed past this. `0` = unlimited. */
  maxChildPools: number;
  /**
   * Whether the app runs the local MCP bridge, letting a `huginndb-mcp` sidecar
   * borrow the app's pools instead of opening its own. Off by default — it is a
   * listening socket fronting every saved database, so it is opt-in.
   */
  mcpBridge: boolean;
  /** Keepalive ping interval in seconds. `0` disables the heartbeat. */
  keepaliveSecs: number;
}

/**
 * Pulse's background history sampler — the one part of Pulse with a real,
 * recurring cost, so every knob here exists to keep that cost bounded and
 * visible. Nothing here has any effect on a connection unless that
 * connection's own {@link ConnectionProfile.pulse_enabled} is also set.
 *
 * Mirrors `PulsePrefs` in `src-tauri/src/prefs.rs`.
 */
export interface PulsePrefs {
  /** How often the dock panel / expanded window poll live vital signs, in
   *  seconds, while on screen. Frontend-only (`usePulseLive` schedules this,
   *  not the backend) — kept alongside `historyIntervalSecs` so both of
   *  Pulse's clocks live in one place. */
  liveIntervalSecs: number;
  /** How often the sampler writes a tick to `pulse.db`, in seconds, for
   *  every connection with `pulseEnabled` set. */
  historyIntervalSecs: number;
  /** How long a history point survives before it is pruned. */
  retentionDays: number;
  /** Whether the sampler keeps ticking while the main window is minimised.
   *  On by default. */
  sampleWhenMinimized: boolean;
  /** Soft cap on `pulse.db`'s size, in megabytes. `0` disables it. */
  maxDiskMb: number;
}

/** Live pool footprint, from the `connection_pool_stats` command. */
export interface PoolStats {
  /** Pools for connections the user explicitly opened. */
  connections: number;
  /** Synthetic per-database pools opened by browsing databases. */
  databaseViews: number;
  /**
   * Per-server reservations — the row that actually answers "how many
   * connections am I holding against *that* box", since one server can back
   * several pools.
   */
  endpoints: EndpointUsage[];
  /** Loopback port the MCP bridge is listening on; `null` when it is off. */
  mcpBridgePort?: number | null;
}

/** One server's share of the connection footprint. */
export interface EndpointUsage {
  /** `host:port`, plus the SSH tunnel when there is one. */
  label: string;
  /** Connections reserved against it right now. */
  inUse: number;
}

export interface EditorPrefs {
  fontFamily: string;
  fontSize: number;
  tabSize: number;
  wordWrap: boolean;
  minimap: boolean;
  lineNumbers: boolean;
  formatOnPaste: boolean;
  /**
   * Monaco theme id. Defaults to `"huginn-dark"`. The runtime maps
   * unknown values back to the default via `resolveMonacoTheme`, so an
   * older `prefs.json` without this key, or one carrying a theme that's
   * since been removed, still renders cleanly.
   */
  theme: string;
  /** Underline values that violate the JSON Schema bound to their column.
   *  Never gates a save — the database is the authority, the schema is an aid. */
  jsonSchemaValidation: boolean;
  /** Offer the bound schema's properties and enum values while typing. */
  jsonSchemaCompletion: boolean;
  /** Show a property's schema `description` on hover. */
  jsonSchemaHover: boolean;
}

export interface GridPrefs {
  rowHeight: number;
  nullDisplay: string;
  truncateLongTextAt: number;
  zebraStripes: boolean;
  stickyHeader: boolean;
  defaultPageSize: number;
  /** Whether the floating cell-value preview panel appears when a cell is
   *  selected in the data grid. `false` keeps single-click as pure navigation. */
  cellPreview: boolean;
  /** How MySQL BIT columns render. The backend always sends BIT as a number;
   *  the grid maps it to one of these so toggling re-renders without a
   *  re-query. */
  bitDisplay: "true_false" | "zero_one";
  /** User-resized column widths (px), keyed by `"<schema>.<table>"` then by
   *  column name (see `tableKey` in `stores/schema.ts`). Ad-hoc query result
   *  grids resize in-session only and never write here. */
  columnWidths: Record<string, Record<string, number>>;
  /** Column names pinned to the left edge (freeze-panes style), keyed the same
   *  way as `columnWidths`. Stacked in the columns' natural left-to-right
   *  order, not the order they were pinned in. Ad-hoc query result grids pin
   *  in-session only and never write here. */
  pinnedColumns: Record<string, string[]>;
  /** How a browsed table/collection renders. A single global toggle (not
   *  per-relation), honoured by every driver — the list view started out
   *  MongoDB-only, which is all the `document` in the name still refers to
   *  (the row-as-document layout), kept so an existing preference survives. */
  documentViewMode: "table" | "list";
  /** List view: whether nested objects/arrays start expanded. `false` (the
   *  default) folds them and lets the user open what they need. */
  listExpandNested: boolean;
  /** List view: whether each field's type is shown in the right-hand gutter. */
  listShowTypes: boolean;
  /** List view: whether fields are numbered in the left-hand gutter. */
  listLineNumbers: boolean;
}

/** Schema-tree metric column. Source of truth for the enum is the frontend. */
/**
 * What the schema tree shows beside a table's name.
 *
 * `"both"` renders `12.1k · 4.3 MB`. The app has had both numbers for every
 * driver since the metric existed and made the user pick one, for no reason
 * anyone recorded.
 *
 * Rust stores this as a plain `String` it declares it does not interpret
 * (`prefs.rs`), so widening the union needs no backend migration and an older
 * `prefs.json` still reads. In the other direction an older build reading
 * `"both"` falls through both branches of `tableMetricLabel` and renders no
 * badge — a clean degradation, unlike the keybindings trade in gotcha #53
 * where a downgrade loses every preference.
 */
export type SchemaTableMetric = "none" | "row-count" | "size" | "both";

/** Supported UI languages. Add a locale here, a translation file under
 *  `src/lib/i18n/locales/`, and a `<SelectItem>` entry in GeneralSection. */
export type AppLanguage = "en" | "es";

export interface UiPrefs {
  confirmDestructive: boolean;
  /** Whether the schema-explorer "Empty table" action (#69) confirms first.
   *  Separate from `confirmDestructive` so its "don't ask again" checkbox only
   *  silences the empty-table prompt. */
  confirmEmptyTable: boolean;
  queryHistoryLimit: number;
  restoreTabsOnOpen: boolean;
  /** Whether the main window reconnects, on launch, to the connections that
   *  were live when it last closed. Uses the OS-keychain secrets; a
   *  connection whose secret is missing or whose host is unreachable is
   *  skipped without blocking startup. Independent of `restoreTabsOnOpen`,
   *  which governs whether tabs/layout come back once connected. */
  reconnectOnLaunch: boolean;
  schemaTableMetric: SchemaTableMetric;
  language: AppLanguage;
  /** Default surface for the heavyweight cell editor when escalated from an
   *  inline edit / preview. */
  cellEditorMode: CellEditorMode;
  /**
   * Driver used when a connection is created without an explicit choice —
   * the CLI ad-hoc path when `--driver` is omitted, and the initial driver
   * of the "New connection" form. `null` means "not configured": the CLI
   * then prompts for the driver instead of guessing.
   */
  defaultDriver: Driver | null;
  /**
   * Remembered choice for the "second launch" connect dialog when a running
   * instance receives a new CLI connection intent. `"ask"` (the default)
   * always shows the dialog; the other two apply that action silently.
   */
  cliConnectDefault: CliConnectDefault;
  /** Names of connection-list groups currently collapsed in the sidebar.
   *  Matched by string equality against the live `ConnectionProfile.group`
   *  values — a stale entry from a renamed/deleted group is harmless. */
  collapsedConnectionGroups: string[];
  /** Visual treatment for a tab's active/colour accent — "cap" (2px inset
   *  top border, the original look), "rail" (3px inset left border), or
   *  "boxed" (raised surface + bottom-edge underline for a custom colour). */
  tabAccentStyle: TabAccentStyle;
  /** How grouped connections start out in the tree views (File menu,
   *  connections manager, environment Schema tree). "remember" seeds the
   *  initial fold state from `collapsedConnectionGroups`; "expanded"/
   *  "collapsed" force it. Either way each surface then keeps its own
   *  session-local overrides — see `useConnectionGroupCollapse`. */
  connectionGroupExpandMode: ConnectionGroupExpandMode;
}

/** Corner or edge the notification stack grows from. */
export type NotificationPosition =
  | "top-left"
  | "top-center"
  | "top-right"
  | "bottom-left"
  | "bottom-center"
  | "bottom-right";

/** Notification card density. `compact` drops the body line. */
export type NotificationDensity = "comfortable" | "compact";

/**
 * Where notifications appear, how long they stay and how much is remembered.
 *
 * Mirrors `NotificationPrefs` in `src-tauri/src/prefs.rs` — a field missing on
 * either side is silently dropped by serde on the way through
 * `update_preferences` (CLAUDE.md gotcha #14), so both declarations change
 * together. `notifications_use_the_camel_case_keys_the_frontend_sends` in
 * `prefs.rs` pins the exact JSON.
 */
export interface NotificationPrefs {
  position: NotificationPosition;
  /** Lifetime of a dismissible notification in ms. `0` = until dismissed.
   *  Defaults to 6000; clamped to {@link NOTIFICATION_DURATION_BOUNDS}. */
  durationMs: number;
  /** Errors ignore `durationMs` and wait to be dismissed. Default `true`. */
  errorsPersist: boolean;
  /** On-screen at once; the rest collapse behind a counter. */
  maxVisible: number;
  /** Hovering the stack expands it and freezes every timer. */
  expandOnHover: boolean;
  density: NotificationDensity;
  /** Entries the window remembers. `0` disables the history and the bell. */
  historyLimit: number;
  /** Whether the status bar shows the bell. The history survives either way. */
  showBell: boolean;
}

export type CellEditorMode = "modal" | "side";

export type CliConnectDefault = "ask" | "current" | "new";

export type TabAccentStyle = "cap" | "rail" | "boxed";

export type ConnectionGroupExpandMode = "expanded" | "collapsed" | "remember";

/** Per-connection slice of the persisted tab state. */
export interface ConnectionTabState {
  tabs: PersistedTab[];
  activeTabId: string | null;
  expandedSchemaNodes: string[];
  /** Unix seconds; refreshed each save. Drives LRU pruning. */
  lastOpened: number;
  /**
   * @deprecated The inner-dockview geometry is now session-level, not
   * per-connection — see `WorkspaceLayout` / `api.getWorkspaceLayout`. The
   * backend hoists any legacy value here up to the top level on first load
   * after upgrading and never writes it again; the frontend no longer reads
   * or sends it. Kept only so old blobs still type-check.
   */
  internalLayout?: unknown | null;
}

/**
 * Session-level inner-dockview geometry (the workspace's split/float
 * arrangement), shared across every connection's tabs. Opaque dockview
 * `toJSON()` blob; `null` means the default tabbed layout.
 *
 * Scoped to the active environment on the backend side — `getWorkspaceLayout`
 * always answers for whichever environment is current.
 */
export type WorkspaceLayout = unknown | null;

/**
 * A named set of connections plus the session state that belongs to them.
 * Mirrors `Environment` in `src-tauri/src/tab_state.rs` (`tab_state.json` v5).
 *
 * Only the presentation fields (plus `launch`, see below) are exposed here.
 * `connections` and `internalLayout` live in the same on-disk struct but are
 * owned by the session-state commands (`get/saveTabState`,
 * `get/saveWorkspaceLayout`), which resolve against the active environment —
 * the frontend never sends them as part of an environment payload.
 */
export interface Environment {
  id: string;
  /**
   * Empty means "never named by the user": the backend refuses to write display
   * copy (it would freeze one language into the user's data), so render
   * `environmentLabel()` rather than this field directly.
   */
  name: string;
  color: string | null;
  icon: string | null;
  order: number;
  /**
   * Theme id (a built-in or custom `Theme.id` from `src/lib/themes.ts`) to
   * apply while this environment is active. `null` means no override — the
   * app's regular default theme applies. Resolved by
   * `useThemeStore.setEnvironmentOverride`, not interpreted here.
   */
  themeId: string | null;
  /**
   * Present only on READ (e.g. via `listEnvironments`) — the Rust struct
   * always serialises it, this type just didn't expose it before. Never sent
   * back through `saveEnvironment`, which only accepts the presentation
   * fields above (see its comment in `lib/tauri.ts`).
   *
   * Secondary "New window" instances use this to apply a chosen environment's
   * connection/database filters to their own, purely in-memory view without
   * ever touching `tab_state.json` (gotcha #8) — see
   * `stores/session/environments.ts`'s `applyLocalView`.
   */
  launch?: LaunchState;
  /**
   * Which registered `Origin` this environment mirrors, if any (#108
   * continuous environment sync). `null`/absent means an ordinary,
   * locally-owned environment.
   *
   * A mirrored environment's connection membership is overwritten on every
   * pull, so that stays read-only — released only via `useOriginSync`'s
   * environment adopt/retire. Its cosmetics are not: see `localName` etc.
   * below for the local-override escape hatch.
   */
  originId?: string | null;
  /** The publisher's own `Environment.id` for the mirrored bundle. Paired
   *  with `originId` to recognise "the same" environment across syncs —
   *  display/UI code never needs it directly, only `originId`. */
  originSourceId?: string | null;
  /**
   * This machine's local override of `name`/`color`/`icon`/`themeId`, one
   * field each. `sync_origin` never touches these — they exist so a user who
   * dislikes a colleague's icon/colour/name/theme choice for a mirrored
   * environment can change it here without the next pull reverting it. Read
   * the *effective* value via `environmentLabel`/`effectiveColor`/
   * `effectiveIcon`/`effectiveThemeId` (`stores/session/environments.ts`),
   * never these fields directly — `localX ?? x` is the resolution, and doing
   * it ad hoc at each call site is how one of them gets missed.
   *
   * Only meaningful when `originId` is set; write via
   * `setEnvironmentLocalOverrides`, never `saveEnvironment`.
   */
  localName?: string | null;
  localColor?: string | null;
  localIcon?: string | null;
  localThemeId?: string | null;
  /**
   * This machine's own hide/show override for a mirrored environment's
   * connections picker, shadowing `launch.visibleConnections` the same way
   * the four fields above shadow the cosmetics — except what it protects
   * from a sync isn't a display choice, it's the fact that
   * `launch.visibleConnections` doubles as `sync_origin`'s notion of this
   * environment's true membership. Hiding a connection here used to be
   * undone by the very next sync before this field existed.
   *
   * Never read directly: `getLaunchState`/`listEnvironments` already resolve
   * it into `launch.visibleConnections` on the Rust side, so `useUi`'s
   * `visibleConnections` is always the effective value.
   */
  localVisibleConnections?: string[] | null;
}

/**
 * A shared folder an environment imports connections from (#108). Mirrors
 * `Origin` in `src-tauri/src/tab_state.rs`.
 *
 * `path` points at a file in the format "Export profiles…" already writes. The
 * sync is pull-only — HuginnDB never writes back to it — and the passphrase for
 * an encrypted file lives in this user's OS keychain, never here.
 */
/**
 * Outcome of `deleteProfiles`. Mirrors `DeleteProfilesReport` in
 * `src-tauri/src/commands/connection.rs`.
 *
 * `skippedOrigin` is unreachable from the connection manager — a profile a
 * shared origin publishes can never be checked there — and is reported anyway,
 * because the refusal lives at the boundary where the CLI and the MCP connector
 * also arrive.
 */
export interface DeleteProfilesReport {
  deleted: string[];
  skippedOrigin: string[];
  missing: string[];
  /** `[id, message]` pairs: the profile is gone, its keychain entry was not. */
  failed: Array<[string, string]>;
}

export interface Origin {
  id: string;
  name: string;
  path: string;
  /** RFC 3339, or `null` if it has never synced. Display only. */
  lastSyncedAt: string | null;
  /**
   * Per-profile fingerprints of the encrypted secrets this machine has already
   * decrypted and landed in its keychain, so an unchanged origin file doesn't
   * re-derive a PBKDF2 key on every launch (`already_landed` in
   * `commands/origins.rs`).
   *
   * Never read this to render anything. It is declared because `list_origins`
   * serialises it and the type would otherwise lie about the payload: the day a
   * command *saves* a whole `Origin` back, serde would drop the field and wipe
   * the cache (gotcha #14, inverted).
   */
  landedSecrets?: Record<string, string>;
  /**
   * Whether *this* machine may write the file back (#155). Absent on an origin
   * registered before the editor existed, which deserialises as `"consumer"`
   * server-side — nobody gains write access to a shared file by updating.
   */
  role?: OriginRole;
  /** `meta.maintainer` as of the last read of the file — who curates it.
   *  Display only; coordination, never permission. */
  maintainer?: string | null;
}

/**
 * What this machine is allowed to do with an origin's file. Mirrors
 * `OriginRole` in `src-tauri/src/tab_state.rs`.
 *
 * Only the first of three layers: the OS's own answer
 * (`probeOriginWritable`) overrides it, and the file's `maintainer`/`revision`
 * coordinate between publishers without granting anything.
 */
export type OriginRole = "consumer" | "publisher";

// --- The document an origin publishes (#155) --------------------------------
//
// Mirrors `src-tauri/src/origin_doc`. The editor composes a *document*, never
// this machine's own state: nothing in here is read from (or written to)
// `profiles.json`, `tab_state.json` or `json_schemas.json`.

/** Publication metadata. `revision` absent means the file predates the editor,
 *  which is deliberately distinct from `0`. */
export interface OriginDraftMeta {
  maintainer?: string | null;
  revision?: number | null;
  note?: string | null;
  /** What the loaded file's header said. The backend recomputes it from the
   *  slots it actually writes, so never trust this to decide anything. */
  encrypted: boolean;
}

/**
 * Where a published connection's ciphertext comes from.
 *
 * `keep` is what everything loaded from the file gets, and it is copied byte
 * for byte: re-encrypting draws a fresh salt and nonce, which invalidates every
 * consumer's `landedSecrets` cache and costs them ~600 000 PBKDF2 rounds per
 * slot on their next sync. `fromKeychain` is what a connection just added from
 * the local list gets; `clear` publishes nothing and the consumer is asked for
 * a password.
 */
export type OriginSecretSlot =
  | { kind: "keep"; envelope: ExportedSecretEnvelope }
  | { kind: "fromKeychain" }
  | { kind: "clear" };

/** Base64 `salt || nonce || AES-256-GCM(secret)`, one slot each. Opaque here —
 *  the frontend never decrypts anything. */
export interface ExportedSecretEnvelope {
  db_password: string | null;
  ssh_secret: string | null;
}

export interface OriginDraftEnvironment {
  /**
   * The publisher's own environment id, and the identity `sync_origin` matches
   * a bundle against its local mirror with. **Never regenerate it for an
   * environment that came out of the file**: every consumer would see that
   * environment disappear and a different one arrive, losing the tabs, layout
   * and filters they had in it.
   */
  sourceEnvironmentId: string;
  name: string;
  color?: string | null;
  icon?: string | null;
  themeId?: string | null;
  connectionIds: string[];
  origins: Array<{ name: string; path: string }>;
}

/** One connection as the document publishes it: a profile plus its secret
 *  decision. The profile's `id` is preserved on purpose — it is what lets a
 *  publisher consume their own origin without duplicating every server. */
export type OriginDraftConnection = ConnectionProfile & {
  secret: OriginSecretSlot;
};

export interface OriginDraft {
  meta: OriginDraftMeta;
  environments: OriginDraftEnvironment[];
  connections: OriginDraftConnection[];
  schemas: JsonSchemaEntry[];
  bindings: JsonSchemaBinding[];
}

/** What the file looked like when the editor opened it. Handed back on save,
 *  where the hash is recomputed from disk: a mismatch means somebody else
 *  published and the save is refused rather than overwriting them. */
export interface OriginDraftBase {
  sha256: string;
  mtime?: string | null;
  revision: number;
}

/** Whether a real write succeeded, not whether the permission bits say it
 *  would. On a share the bits describe the local mount. */
export interface OriginWritableProbe {
  exists: boolean;
  writable: boolean;
  reason?: string | null;
}

export interface OriginDocument {
  originId: string;
  name: string;
  path: string;
  role: OriginRole;
  draft: OriginDraft;
  base: OriginDraftBase;
  writable: OriginWritableProbe;
  /** Whether a passphrase for this origin is in this machine's keychain. The
   *  value never crosses the boundary. */
  hasPassphrase: boolean;
}

/** One entry in a publish preview. `id` is a profile id for a connection and a
 *  `sourceEnvironmentId` for an environment; `name` rides along because a
 *  vanished entry exists only in the file being replaced. */
export interface OriginImpactEntity {
  id: string;
  name: string;
}

export interface OriginEntityImpact {
  added: OriginImpactEntity[];
  refreshed: OriginImpactEntity[];
  unchanged: number;
  vanished: OriginImpactEntity[];
  owned: number;
  /**
   * **Nobody will be told.** Past `commands::origins`'s suspicion threshold the
   * sync treats the read as broken and clears its `vanished` list, so a file
   * missing half the roster leaves every consumer with phantom connections and
   * zero notices. This flag is the reason the preview exists.
   */
  silentlyDropped: boolean;
}

export interface OriginReencryptionCost {
  connections: OriginImpactEntity[];
  slots: number;
  pbkdf2Rounds: number;
  /** True when a `fromKeychain` slot made the count an upper bound. */
  estimated: boolean;
}

export interface OriginFreshMachineImpact {
  connections: number;
  environments: number;
  schemas: number;
  bindings: number;
  slots: number;
  pbkdf2Rounds: number;
}

export interface OriginDraftMembership {
  byEnvironment: Array<{
    sourceEnvironmentId: string;
    name: string;
    connectionIds: string[];
  }>;
  /** Connections no environment lists — the document's loose connections.
   *  Publishable: every profile in the file lands in the consumer's global
   *  pool, and only `visibleConnections` filters it per environment. */
  unassigned: string[];
  /** Ids an environment lists that the document no longer carries. */
  dangling: string[];
}

export interface OriginPublishImpact {
  connections: OriginEntityImpact;
  environments: OriginEntityImpact;
  freshMachine: OriginFreshMachineImpact;
  reencryption: OriginReencryptionCost;
  withoutPassword: OriginImpactEntity[];
  bindingsPinned: number;
  /** Bindings pinned to a connection the document does not carry: they arrive
   *  **disabled** on every consumer. */
  bindingsUnresolvable: number;
  membership: OriginDraftMembership;
}

export interface OriginSaveReport {
  base: OriginDraftBase;
  revision: number;
  /** Whether the previous revision was kept as `<file>.bak`. Best effort. */
  backup: boolean;
  /** What the write actually did, recomputed against the file that was on disk
   *  — not the preview the confirmation dialog showed, which was computed
   *  against a base that may have moved since. */
  impact: OriginPublishImpact;
}

/** A save either landed or found the file changed underneath it. The conflict
 *  carries the document as it now stands, so the editor can show what moved
 *  instead of asking the user to guess. */
export type OriginSaveOutcome =
  | ({ status: "saved" } & OriginSaveReport)
  | { status: "conflict"; document: OriginDocument };

/**
 * Outcome of one `syncOrigin` run. Mirrors `OriginSyncReport` in
 * `src-tauri/src/commands/origins.rs`.
 *
 * Note what it does *not* contain: any notion of a deletion having happened. The
 * sync only ever reports; adopting or retiring a vanished connection is the
 * user's call (#108).
 */
export interface OriginSyncReport {
  /** Profile ids created by this sync. */
  added: string[];
  /** Profile ids refreshed from the file. */
  updated: string[];
  /** Ids whose metadata changed but which have a live pool, so the change is
   *  held back rather than repointing a server under a running query. */
  deferred: string[];
  /** Ids present locally under this origin but absent from the file. */
  vanished: string[];
  /**
   * True when the read looked untrustworthy (a truncated or half-written file
   * parses fine while listing far fewer profiles than it should). `vanished` is
   * empty in that case — never offer removals when this is set.
   */
  suspicious: boolean;
  /** RFC 3339 stamp of this run. */
  syncedAt: string;
  /** Environment ids created by this sync, when the origin publishes whole
   *  environments (`kind = "environment"`). Empty for a plain profile origin. */
  environmentsAdded: string[];
  /** Environment ids whose cosmetics/membership were refreshed from the file. */
  environmentsUpdated: string[];
  /** Environment ids this origin owns locally whose bundle disappeared from
   *  the file. Reported only — never deleted on our own initiative. */
  environmentsVanished: string[];
  /** Same purpose as `suspicious`, scoped to the environment count. */
  environmentsSuspicious: boolean;
  /** JSON Schemas this pull created / refreshed. Non-zero only for an
   *  environment-kind file whose publisher included them (1.19.0). */
  schemasAdded?: number;
  schemasUpdated?: number;
  /** Owned by this origin locally and absent from the file. Reported only,
   *  like every other disappearance here. */
  schemasVanished?: number;
  bindingsAdded?: number;
  bindingsUpdated?: number;
  bindingsVanished?: number;
  /** Landed with `enabled: false` because they name a connection this machine
   *  does not have. */
  bindingsDisabled?: number;
}

/** What `listEnvironments` returns — the list and the active id together, so a
 *  switcher can't render out of step with the backend's current environment. */
export interface EnvironmentList {
  environments: Environment[];
  activeEnvironmentId: string;
}

/**
 * The main window's launch-restore state: which connections were live at last
 * close, which one the schema explorer / status bar was focused on, and which
 * tab was globally active. Restored after auto-reconnect so the workspace
 * comes back the way it was left, independent of reconnect order.
 */
export interface LaunchState {
  activeConnections: string[];
  selectedConnectionId: string | null;
  activeTabId: string | null;
  /** Connections folded in the connections tree (#107). The *collapsed* set, not
   *  the expanded one: a row follows its pool by default, so only an override is
   *  worth storing, and a stale id can then only ever mean "show folded". Must be
   *  declared in the Rust `LaunchState` too or serde drops it (gotcha #14). */
  collapsedConnections: string[];
  /**
   * DataGrip-style subset of saved connections to show in the connections tree
   * — the same "hide the noise" idea as
   * `ConnectionProfile.visible_databases`, one level up. `null`/absent means
   * "show all" (the historical behaviour); a hidden connection is still saved,
   * just not rendered as a row. Scoped to the environment (not global
   * `Preferences.ui`, where it used to live) so a filter tuned for one
   * environment doesn't stay active after switching to another. Must be
   * declared in the Rust `LaunchState` too or serde drops it (gotcha #14).
   */
  visibleConnections: string[] | null;
  /**
   * Per-connection override of `ConnectionProfile.visible_databases`, keyed by
   * connection id.
   *
   * The profile keeps its value as the **default** (it travels with export /
   * import and shared origins); an entry here wins for this environment only.
   * Key present → override; key absent → fall back to the profile. The value is
   * nullable because `null` is itself an override — "show all *here*", which is
   * the only way an environment can widen a subset its profile narrows.
   *
   * Resolve it with `useVisibleDatabases` rather than reading either layer
   * directly. Must be declared in the Rust `LaunchState` too or serde drops it
   * (gotcha #14).
   */
  databaseVisibility: Record<string, string[] | null>;
}

export interface PersistedTab {
  id: string;
  kind: TabKind;
  schema: string | null;
  table: string | null;
  query: string | null;
  title: string | null;
  color: string | null;
  /** Whether the tab was pinned. Must round-trip through the Rust struct or
   *  serde drops it on the typed IPC boundary (gotcha #14). */
  pinned: boolean | null;
  /**
   * Table-tab view state, restored when the tab comes back (#112): the
   * structured column filters, the multi-level sort, and the committed
   * free-text search. `null` on a query tab, which has none of them.
   *
   * Same IPC-boundary rule as `color`/`pinned` — each field must exist on the
   * Rust `PersistedTab` or serde drops it before it reaches disk (gotcha #14).
   */
  filters: ColumnFilter[] | null;
  sort: SortSpec[] | null;
  search: string | null;
  /** Same IPC-boundary rule as the three fields above — this tab's own
   *  "table" vs "list" choice, independent of `GridPrefs.documentViewMode`
   *  (which only seeds a newly opened tab's default). `null` on a query tab. */
  documentViewMode: "table" | "list" | null;
}

/**
 * One entry in the in-app Console panel.
 *
 * Mirrors the `LogEntry` shape emitted by the Rust `huginndb://log` event
 * (see `src-tauri/src/log_bus.rs`). Optional fields are populated based
 * on `kind`: SQL events carry `sql`/`rows_affected`/`duration_ms`,
 * Connection events carry `message`. Any operation that failed includes
 * `error`.
 */
export interface LogEntry {
  id: number;
  timestamp_ms: number;
  kind: "sql" | "connection";
  connection_id?: string;
  driver?: string;
  sql?: string;
  message?: string;
  duration_ms?: number;
  rows_affected?: number;
  error?: string;
}

/** One entry in the persisted query history. */
export interface QueryHistoryEntry {
  id: string;
  sql: string;
  connectionId: string;
  ranAt: number;
  elapsedMs: number;
  rowsAffected: number;
  error?: string;
}

// ---------------------------------------------------------------------------
// Import / Export types — mirror of src-tauri/src/transfer.rs
// ---------------------------------------------------------------------------

/** Summary returned by `analyze_import_file`. */
export interface ImportAnalysis {
  total: number;
  encrypted: boolean;
  conflicts: ImportConflict[];
}

/** A profile in the file whose `id` already exists locally. */
export interface ImportConflict {
  id: string;
  existing_name: string;
  incoming_name: string;
}

/** Per-conflict resolution action sent to `import_profiles`. */
export type ConflictAction = "overwrite" | "skip" | "rename";

export interface ConflictResolution {
  id: string;
  action: ConflictAction;
}

/** Result summary returned by `import_profiles`. */
export interface ImportResult {
  imported: string[];
  skipped: string[];
  /** [original_name, new_name] pairs */
  renamed: [string, string][];
  needs_password: string[];
}

/**
 * A shared origin's registration as it travels through an environment
 * export/import — name and path only, mirroring `ExportedOrigin` in
 * `src-tauri/src/transfer.rs`. Never carries a passphrase: that stays in the
 * exporting machine's keychain, same threat model as `Origin` itself.
 */
export interface ExportedOrigin {
  name: string;
  path: string;
}

/**
 * Display summary for one environment inside an `EnvironmentImportAnalysis`
 * — enough for the picker to show what each one is without decrypting or
 * importing anything yet.
 */
export interface EnvironmentImportAnalysisEntry {
  name: string;
  connectionCount: number;
  /** For display only — origins never conflict, since import always lands in
   *  a brand-new environment. */
  origins: ExportedOrigin[];
}

/** Summary returned by `analyzeEnvironmentImport`. One entry per environment
 *  in the file; `conflicts`/`total_profiles`/`encrypted` apply to the file's
 *  shared connection-profile pool as a whole. */
export interface EnvironmentImportAnalysis {
  environments: EnvironmentImportAnalysisEntry[];
  /** Snake_case on the wire: unlike the persisted state, `transfer.rs` carries no
   *  `rename_all`, so these DTOs keep Rust's field names. */
  total_profiles: number;
  encrypted: boolean;
  conflicts: ImportConflict[];
  /** How many JSON Schemas ride along, for display only. Their name conflicts
   *  are resolved by the *same* `conflictResolutions` list as the profiles,
   *  keyed by the incoming schema id, so they need no extra wizard step. */
  total_json_schemas: number;
  total_json_schema_bindings: number;
}

/** One environment created by `importEnvironment`. */
export interface ImportedEnvironment {
  environmentId: string;
  name: string;
  /** Ids of the origins registered in this environment, in file order. */
  originIds: string[];
}

/** Result returned by `importEnvironment` — one entry per bundle in the file. */
export interface EnvironmentImportResult {
  environments: ImportedEnvironment[];
  profiles: ImportResult;
  /** Present only when the file carried a schema bundle. `undefined` differs
   *  meaningfully from a zeroed result: the exporter never ticked the box, so
   *  the UI stays silent rather than reporting "0 schemas". */
  json_schemas?: JsonSchemaImportResult | null;
}

// ---------------------------------------------------------------------------
// CLI args — mirror of src-tauri/src/state.rs StartupArgs
// ---------------------------------------------------------------------------

/** Command-line arguments parsed at startup, returned by `get_startup_args`. */
export interface StartupArgs {
  connect_profile: string | null;
  connect_by_id: boolean;
  adhoc_host: string | null;
  adhoc_port: number | null;
  adhoc_database: string | null;
  adhoc_username: string | null;
  adhoc_driver: string | null;
  /** Connection URI from `--uri`/`--connection-string` (MongoDB-primary). */
  adhoc_connection_string: string | null;
  /** MongoDB `authSource` from `--auth-source` (used by the URI-less path). */
  adhoc_auth_source: string | null;
  adhoc_name: string | null;
  /** Password from `--password`/`--pass`. In-memory only, never persisted. */
  adhoc_password: string | null;
}

// ---------------------------------------------------------------------------
// In-app issue reporter — mirror of src-tauri/src/commands/feedback.rs
// ---------------------------------------------------------------------------

/** What the user is filing: a defect or an idea. */
export type FeedbackKind = "bug" | "feature";

/** One level of a data-grid sort. `order[0]` is the primary key, `order[1]`
 *  the first tie-breaker, etc. Mirrors `SortSpec` in the Rust query command. */
export interface SortSpec {
  column: string;
  desc: boolean;
}

/** Build/runtime facts folded into a report body, from `get_diagnostics`. */
export interface Diagnostics {
  app_version: string;
  os: string;
  arch: string;
}

/** Where the `huginndb-mcp` sidecar binary lives, from
 *  `get_mcp_connector_info`. `available` is false outside a packaged
 *  install (e.g. `tauri dev`), where the sidecar isn't staged. */
export interface McpConnectorInfo {
  binary_path: string;
  available: boolean;
}

/** Build flavor of the running app, from `get_app_flavor`. The React bundle is
 *  identical between stable and canary, so this is the only way the frontend
 *  can tell it is running inside the isolated sandbox (canary) build. Drives
 *  the sandbox indicator (ribbon + window title + badge). */
export interface AppFlavor {
  /** True when this is the `--features canary` sandbox build. */
  canary: boolean;
  /** Product name for this flavor: "HuginnDB Canary" or "HuginnDB". */
  productName: string;
  /** Isolated on-disk state dir name ("HuginnDB-Canary" or "HuginnDB"). */
  stateDir: string;
}

/** Result of `submit_issue`: `created` is true when filed via the API
 *  (the URL is the created issue), false when it's a pre-filled URL to open. */
export interface IssueOutcome {
  url: string;
  created: boolean;
}

// ---------------------------------------------------------------------------
// JSON Schemas — mirror of src-tauri/src/json_schemas/mod.rs
// ---------------------------------------------------------------------------

/** Where a library entry came from. `imported` covers both a file import and
 *  (from 1.18.0) an origin sync, told apart by `originId` being set. */
export type JsonSchemaSource = "manual" | "imported" | "inferred";

/** One schema in the user library.
 *
 *  Mirrors `JsonSchemaItem`. `body` is the document as **source text**, exactly
 *  as typed: the backend never parses it, so a draft that is momentarily
 *  invalid still saves. */
export interface JsonSchemaEntry {
  id: string;
  /** Display name, and the conflict key on import (a schema id can never
   *  collide across machines; a name always will). */
  name: string;
  description?: string | null;
  body: string;
  createdAt: string;
  updatedAt: string;
  source: JsonSchemaSource;
  /** Owning shared origin (1.18.0). Always null for a locally-authored entry. */
  originId?: string | null;
}

/** A rule attaching one schema to a set of columns.
 *
 *  Every axis but `column` may be `null`, meaning "any". `table` and `column`
 *  accept a simple `*` glob, matched case-insensitively.
 *
 *  `connectionId` is always a **profile** id, never a synthetic
 *  `<parent>::db::<db>` one — pass it through `parentConnectionId`
 *  (`lib/connectionLabel.ts`) before saving, or the rule will never match on a
 *  server-wide connection. */
export interface JsonSchemaBinding {
  id: string;
  schemaId: string;
  connectionId?: string | null;
  /** Whatever the explorer calls a schema for that driver: a Postgres schema,
   *  a MySQL/MongoDB *database*, `main` on SQLite. */
  dbSchema?: string | null;
  table?: string | null;
  /** Required. Admits dots, so a MongoDB nested field can be bound by the same
   *  dotted path form `$set` takes (`customData.format`). */
  column: string;
  enabled: boolean;
  /** Tie-break among equally specific bindings, ascending. */
  order: number;
  originId?: string | null;
}

/** The whole persisted library, from `listJsonSchemas`. */
export interface JsonSchemaLibrary {
  version: number;
  schemas: JsonSchemaEntry[];
  bindings: JsonSchemaBinding[];
}

/** The schema that won the cascade for one column.
 *
 *  `specificity` and `bindingId` come back so the UI can say *why* this schema
 *  applies without a second call. */
export interface ResolvedJsonSchema {
  /** Echoed, because the batch call returns a list rather than a map. */
  column: string;
  schemaId: string;
  name: string;
  body: string;
  bindingId: string;
  specificity: number;
  /** True when the winning rule names this exact column literally, false when
   *  it was inherited from a broader one. Decides whether "unlink" may be
   *  offered — unlinking an inherited rule would affect other columns too. */
  exact: boolean;
}

/** One entry of the ranked cascade from `explainJsonSchemaBindings`. */
export interface JsonSchemaMatch {
  binding: JsonSchemaBinding;
  schemaId: string;
  schemaName: string;
  specificity: number;
  /** 1-based rank; `1` is the winner. */
  rank: number;
}

/** What `inferJsonSchema` warns about. */
export interface JsonSchemaInferStats {
  samples: number;
  truncatedDepth: boolean;
  truncatedArrays: boolean;
  /** Dotted paths that held structurally different types and became `anyOf`. */
  mixedPaths: string[];
}

/** A drafted schema, pretty-printed and ready for an editor. */
export interface JsonSchemaInferResult {
  body: string;
  stats: JsonSchemaInferStats;
}

/** Summary from `analyzeJsonSchemaImport`. Snake_case on the wire, like the
 *  rest of `transfer.rs`. */
export interface JsonSchemaImportAnalysis {
  total_schemas: number;
  total_bindings: number;
  conflicts: ImportConflict[];
  /** How many bindings would land disabled because they name a connection this
   *  machine does not have. */
  bindings_unresolvable: number;
}

/** Result of `importJsonSchemas`. */
export interface JsonSchemaImportResult {
  imported: string[];
  skipped: string[];
  overwritten: string[];
  /** `[original name, stored name]` per renamed entry. */
  renamed: [string, string][];
  bindings_imported: number;
  bindings_disabled: number;
  bindings_dropped: number;
  bindings_duplicate: number;
}

// ── HuginnDB Pulse ────────────────────────────────────────────────────────

/**
 * Whether a reading accumulates since the server started or describes the
 * instant. A consumer must difference a `"counter"` against the previous
 * sample and must not difference a `"gauge"`. Mirrors `pulse::MetricKind`.
 */
export type PulseMetricKind = "counter" | "gauge";

/** What a metric counts, so a value can be formatted without a lookup table.
 *  Mirrors `pulse::MetricUnit`. */
export type PulseMetricUnit = "count" | "bytes";

/** One reading in a Pulse snapshot. `name` is a canonical, engine-independent
 *  metric name from the backend's catalogue (`pulse::METRICS`) — never the
 *  engine's own spelling. */
export interface PulseMetricSample {
  name: string;
  value: number;
  kind: PulseMetricKind;
  unit: PulseMetricUnit;
}

/**
 * A reading Pulse could *not* take — a capability the server does not grant, a
 * feature switched off. `code` is machine-readable and translated on this side;
 * the backend never picks display copy. There is no severity: every note reads
 * as a caution (see `pulse::PulseNote`).
 */
export interface PulseNote {
  code: string;
}

/** One read of a connection's vital signs, from the `pulse_health` command. */
export interface PulseHealth {
  /** `"mysql"` / `"mongodb"`. Redundant here (the profile already says), but
   *  the same DTO serves MCP clients that have no profile. */
  driver: string;
  serverVersion: string;
  /** Seconds since the server last restarted, when it reports one. */
  uptimeSecs: number | null;
  /** Stamped by the backend. Every rate divides by the gap between two of
   *  these, so both ends come from the same clock. */
  sampledAtMs: number;
  metrics: PulseMetricSample[];
  notes: PulseNote[];
}

/**
 * One normalised statement the server has spent time on, from
 * `pulse_top_queries`. Aggregated since the statistics were last reset, not
 * over an interval — see `pulse::TopQuery` for why that framing is deliberate.
 */
export interface PulseTopQuery {
  digest: string;
  schema: string | null;
  count: number;
  /** Mean, not a percentile: `QUANTILE_95` does not exist before MySQL 8.0. */
  avgMs: number;
  maxMs: number;
  rowsExamined: number;
  rowsSent: number;
  /** Executions that resolved without using any index. */
  fullScans: number;
  /** One runnable example, source text in the engine's own grammar — what
   *  `pulseExplain` wraps in `EXPLAIN`. `null` disables the Explain action:
   *  the server kept no example, or the statement shape has no well-defined
   *  plan to preview. */
  sample: string | null;
}

/** One `EXPLAIN` read, from `pulse_explain`. The two engines' plan shapes
 *  share no field, so this stays a single opaque tree the viewer renders
 *  read-only rather than a modelled type. */
export interface PulseExplainPlan {
  raw: unknown;
}

/** One active session/operation, from `pulse_sessions`. MySQL's
 *  `command`/`state` and MongoDB's `op`/state derived from `currentOp` keep
 *  their own engine's vocabulary rather than being translated into a shared
 *  one — see `pulse::SessionRow`. */
export interface PulseSession {
  id: string;
  user: string | null;
  host: string | null;
  db: string | null;
  command: string;
  state: string | null;
  durationSecs: number;
  query: string | null;
  /** This session's own `id`, when it is known to be waiting on a lock this
   *  other session holds. MySQL only in this release — see the backend DTO's
   *  doc comment for why MongoDB never sets it yet. */
  blockedBy: string | null;
}

/** One index's usage since its counters were last reset, from
 *  `pulse_index_usage`. `reads: null` means the server could not be asked (a
 *  role without the privilege) — distinct from `0`, an index genuinely
 *  untouched, which is the whole signal this view exists to surface. */
export interface PulseIndexUsage {
  schema: string | null;
  table: string;
  indexName: string;
  reads: number | null;
  sizeBytes: number | null;
}

/** One metric's stored history for a connection, from `pulse_history`.
 *  `kind` says whether `points` plots as-is (a gauge) or has to be
 *  differenced into a rate first (a counter) — the same distinction
 *  {@link PulseMetricSample.kind} carries for the live series, since a raw
 *  history point has no `PulseHealth` snapshot to carry it on instead. */
export interface PulseHistorySeries {
  kind: PulseMetricKind;
  points: PulseHistoryPoint[];
}

/** One raw reading, oldest-to-newest. */
export interface PulseHistoryPoint {
  tsMs: number;
  value: number;
}

/** One relation's footprint, from `pulse_storage`. */
export interface PulseStorageItem {
  name: string;
  schema: string | null;
  dataBytes: number;
  indexBytes: number;
  /** Allocated but unused — what a rebuild would hand back. */
  freeBytes: number;
}
