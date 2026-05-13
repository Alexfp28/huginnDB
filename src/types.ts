export type Driver = "postgres" | "mysql" | "sqlite";

export interface SshTunnel {
  host: string;
  port: number;
  username: string;
}

export interface ConnectionProfile {
  id: string;
  name: string;
  driver: Driver;
  host: string;
  port: number;
  database: string;
  username: string;
  ssl: boolean;
  ssh_tunnel?: SshTunnel | null;
}

export interface DatabaseInfo {
  name: string;
}

export interface TableInfo {
  schema: string;
  name: string;
  kind: "table" | "view";
}

export interface ColumnInfo {
  name: string;
  data_type: string;
  nullable: boolean;
  is_primary_key: boolean;
}

export interface IndexInfo {
  name: string;
  columns: string[];
  unique: boolean;
}

export interface ColumnMeta {
  name: string;
  data_type: string;
}

export type CellValue = string | number | boolean | null | object;

export interface QueryResult {
  columns: ColumnMeta[];
  rows: CellValue[][];
  rows_affected: number;
  elapsed_ms: number;
  total: number | null;
}

export type TabKind = "table" | "query";

export interface AppTab {
  id: string;
  kind: TabKind;
  title: string;
  connectionId: string;
  schema?: string;
  table?: string;
  query?: string;
}

export interface QueryHistoryEntry {
  id: string;
  sql: string;
  connectionId: string;
  ranAt: number;
  elapsedMs: number;
  rowsAffected: number;
  error?: string;
}
