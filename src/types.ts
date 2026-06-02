/**
 * Frontend-facing TypeScript counterparts of the Rust types exposed by
 * the Tauri commands. Field names and casing must stay aligned with the
 * Rust `#[derive(Serialize)]` output — see `src-tauri/src/state.rs` and
 * `src-tauri/src/commands/`.
 */

/** SQL backend supported by a profile. */
export type Driver = "postgres" | "mysql" | "sqlite";

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
}

/** Database / schema row in the schema explorer. */
export interface DatabaseInfo {
  name: string;
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
  /** Only populated by `fetch_table_data`. */
  total: number | null;
}

/** Tabs in the main workspace can host either table data or a query editor. */
export type TabKind = "table" | "query";

export interface AppTab {
  id: string;
  kind: TabKind;
  title: string;
  connectionId: string;
  schema?: string;
  table?: string;
  /** Initial / current SQL for query tabs. */
  query?: string;
  /** Stats from the most recent query execution in this tab. */
  lastQueryStats?: { rows: number; elapsed_ms: number };
}

/**
 * Comparison operator for `ColumnFilter`. Mirrors the closed set the
 * backend accepts in `fetch_table_data`. `is_null` / `is_not_null` ignore
 * the `value` field.
 */
export type FilterOp = "eq" | "ne" | "is_null" | "is_not_null";

/** A single column-level predicate AND-composed in `fetch_table_data`. */
export interface ColumnFilter {
  column: string;
  op: FilterOp;
  value?: CellValue;
}

/** One column/value pair used when building an INSERT. */
export interface RowValue {
  column: string;
  value: string | null;
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
}

/** Inline draft row state owned by `TableDataTab`. */
export interface DraftRow {
  cells: Record<string, DraftCell>;
  error: string | null;
  saving: boolean;
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
   * Monaco theme id. Defaults to `"one-dark-pro"`. The runtime maps
   * unknown values back to the default via `resolveMonacoTheme`, so an
   * older `prefs.json` without this key, or one carrying a theme that's
   * since been removed, still renders cleanly.
   */
  theme: string;
}

export interface GridPrefs {
  rowHeight: number;
  nullDisplay: string;
  truncateLongTextAt: number;
  zebraStripes: boolean;
  stickyHeader: boolean;
  defaultPageSize: number;
  /** How MySQL BIT columns render. The backend always sends BIT as a number;
   *  the grid maps it to one of these so toggling re-renders without a
   *  re-query. */
  bitDisplay: "true_false" | "zero_one";
}

/** Schema-tree metric column. Source of truth for the enum is the frontend. */
export type SchemaTableMetric = "none" | "row-count" | "size";

/** Supported UI languages. Add a locale here, a translation file under
 *  `src/lib/i18n/locales/`, and a `<SelectItem>` entry in GeneralSection. */
export type AppLanguage = "en" | "es";

export interface UiPrefs {
  confirmDestructive: boolean;
  queryHistoryLimit: number;
  restoreTabsOnOpen: boolean;
  schemaTableMetric: SchemaTableMetric;
  language: AppLanguage;
  /** Default surface for the heavyweight cell editor when escalated from an
   *  inline edit / preview. */
  cellEditorMode: CellEditorMode;
}

export type CellEditorMode = "modal" | "side";

/**
 * Lightweight workspace summary used by the topbar switcher. The full
 * `connections` map never crosses the IPC boundary in this shape — tab
 * data is fetched on demand via `getTabState`, scoped to the active
 * workspace.
 */
export interface WorkspaceMeta {
  id: string;
  name: string;
  /** Optional accent hex color, e.g. `"#7c3aed"`. */
  color: string | null;
  /** Optional lucide-react icon name (free-form on the wire). */
  icon: string | null;
  order: number;
}

/** Per-connection slice of an active workspace. */
export interface ConnectionTabState {
  tabs: PersistedTab[];
  activeTabId: string | null;
  expandedSchemaNodes: string[];
  /** Unix seconds; refreshed each save. Drives LRU pruning. */
  lastOpened: number;
  /**
   * Opaque dockview `toJSON()` blob for the workspace's inner split/float
   * geometry. Restored via `fromJSON` on hydrate so a two-pane (or floating)
   * layout comes back the way the user left it. `null`/absent means the
   * default tabbed layout (the common case). The backend stores it verbatim.
   */
  internalLayout?: unknown | null;
}

export interface PersistedTab {
  id: string;
  kind: TabKind;
  schema: string | null;
  table: string | null;
  query: string | null;
  title: string | null;
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
