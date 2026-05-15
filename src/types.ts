/**
 * Frontend-facing TypeScript counterparts of the Rust types exposed by
 * the Tauri commands. Field names and casing must stay aligned with the
 * Rust `#[derive(Serialize)]` output — see `src-tauri/src/state.rs` and
 * `src-tauri/src/commands/`.
 */

/** SQL backend supported by a profile. */
export type Driver = "postgres" | "mysql" | "sqlite";

/** Optional SSH tunnel configuration (UI only for now). */
export interface SshTunnel {
  host: string;
  port: number;
  username: string;
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
