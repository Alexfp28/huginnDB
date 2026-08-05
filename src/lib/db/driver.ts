/**
 * Driver helpers shared by the CLI ad-hoc flow and the connect error paths.
 *
 * `normalizeDriver` maps the free-form `--driver` value (and common aliases)
 * onto the canonical {@link Driver} the backend understands; it returns
 * `null` for an empty/unrecognized value so callers can fall back to the
 * configured default or prompt the user.
 *
 * `driverMismatchHint` turns the cryptic protocol error you get when the
 * wrong driver is pointed at a server (e.g. the Postgres driver reading a
 * MySQL handshake) into an actionable suggestion.
 */

import type { Driver } from "@/types";

const DRIVER_ALIASES: Record<string, Driver> = {
  postgres: "postgres",
  postgresql: "postgres",
  postgre: "postgres",
  pg: "postgres",
  psql: "postgres",
  mysql: "mysql",
  mariadb: "mysql",
  maria: "mysql",
  sqlite: "sqlite",
  sqlite3: "sqlite",
  mongodb: "mongodb",
  mongo: "mongodb",
  sqlserver: "sqlserver",
  mssql: "sqlserver",
  "ms-sql": "sqlserver",
  tsql: "sqlserver",
  azuresql: "sqlserver",
};

/**
 * Per-driver capability gates for the UI.
 *
 * These exist so the explorer doesn't accumulate `driver !== "mongodb" &&
 * driver !== "sqlserver"` chains that read as "not these two engines" when
 * what they actually mean is "this surface is implemented". Each one names the
 * *feature*, and the backend refuses the same operations with
 * `UnsupportedDriver`, so a gate that drifts produces an error message rather
 * than wrong SQL.
 */

/** Structure/view editing (`ALTER TABLE`, rename, `CREATE VIEW`). MongoDB has
 *  no SQL DDL at all; SQL Server's T-SQL DDL builder is not written yet, so
 *  both surfaces are read-only there for now. */
export function supportsDdlEditing(driver: Driver | undefined): boolean {
  return driver !== "mongodb" && driver !== "sqlserver";
}

/** Whole-database / per-table `.sql` export and import. Needs a per-driver
 *  literal encoder (`db/dump.rs`), which SQL Server doesn't have yet;
 *  MongoDB uses the per-collection JSON path instead. */
export function supportsSqlDump(driver: Driver | undefined): boolean {
  return driver !== "mongodb" && driver !== "sqlserver";
}

/** Server-level `CREATE DATABASE` / `DROP DATABASE`. SQLite's file *is* the
 *  database and MongoDB creates them implicitly on first write. */
export function supportsCreateDatabase(driver: Driver | undefined): boolean {
  return driver === "postgres" || driver === "mysql" || driver === "sqlserver";
}

/** Canonicalize a free-form driver string; `null` when empty/unrecognized. */
export function normalizeDriver(
  value: string | null | undefined,
): Driver | null {
  if (!value) return null;
  return DRIVER_ALIASES[value.trim().toLowerCase()] ?? null;
}

/**
 * When a connection fails with a wire-protocol error, guess whether the
 * driver is mismatched and return a human hint. Returns `null` when the error
 * doesn't look driver-related.
 */
export function driverMismatchHint(error: string): string | null {
  const e = error.toLowerCase();
  // Postgres driver talking to a non-Postgres server: sqlx_postgres chokes
  // reading the startup/ReadyForQuery, or on the SSLRequest reply.
  if (
    e.includes("postgres protocol error") ||
    e.includes("unexpected response from sslrequest")
  ) {
    return "the server didn't respond as PostgreSQL — if this is a MySQL/MariaDB server, set the driver to MySQL.";
  }
  // MySQL driver talking to a non-MySQL server.
  if (e.includes("mysql protocol error") || e.includes("malformed packet")) {
    return "the server didn't respond as MySQL — if this is a PostgreSQL server, set the driver to PostgreSQL.";
  }
  // SQL Server driver talking to something that isn't speaking TDS. tiberius
  // surfaces this as a protocol/token error rather than a connection failure,
  // which reads as a server-side problem when it's really the wrong driver.
  if (
    e.includes("sql server error") &&
    (e.includes("protocol error") || e.includes("token"))
  ) {
    return "the server didn't respond as SQL Server — check the port (1433 by default), or the instance name if this is a named instance.";
  }
  return null;
}
