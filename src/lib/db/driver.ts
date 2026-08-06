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
};

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
  return null;
}

/**
 * Marker the backend prefixes onto a connection-limit refusal.
 *
 * Errors cross the IPC boundary as plain strings, so this is the only thing we
 * can match on. Must stay in sync with `TOO_MANY_CONNECTIONS_TAG` in
 * `src-tauri/src/error.rs`.
 */
const TOO_MANY_CONNECTIONS_TAG = "too many connections";

/**
 * Whether `error` is the server (or our own pool) refusing a connection
 * because the limit is reached.
 *
 * The distinction matters because it is the one connection failure with a
 * *client-side* remedy — release pools, lower the ceiling, close a database
 * view — and because it must stop the caller from retrying. The schema
 * explorer's cross-database search in particular re-fires its whole fan-out on
 * every keystroke; without this check it hammers a server that is already
 * turning it away.
 */
export function isTooManyConnections(error: unknown): boolean {
  return String(error).toLowerCase().includes(TOO_MANY_CONNECTIONS_TAG);
}
