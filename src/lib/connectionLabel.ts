/**
 * Resolve a connectionId to a human "Connection · database" label.
 *
 * Handles the two id shapes in play: a plain profile id (→ `name · database`,
 * or just `name` when the profile carries no database) and the synthetic
 * multi-DB id `<parentId>::db::<db>` minted by `open_database_view`
 * (→ `parentName · db`). Falls back to the raw id when nothing matches.
 *
 * Extracted from the inline resolver in `TabbedArea`'s custom tab so the tab
 * switcher and any other cross-connection surface share one implementation.
 */

import type { ConnectionProfile } from "@/types";

const DB_SEP = "::db::";

export function resolveConnectionLabel(
  profiles: ConnectionProfile[],
  connectionId: string,
): string {
  const direct = profiles.find((p) => p.id === connectionId);
  if (direct) {
    return direct.database ? `${direct.name} · ${direct.database}` : direct.name;
  }
  const sep = connectionId.indexOf(DB_SEP);
  if (sep > 0) {
    const parent = profiles.find((p) => p.id === connectionId.slice(0, sep));
    const db = connectionId.slice(sep + DB_SEP.length);
    return parent ? `${parent.name} · ${db}` : db;
  }
  return connectionId;
}

export interface ConnectionParts {
  /** The owning profile's display name, or null if the profile is unknown. */
  profileName: string | null;
  /** The database the connection is scoped to, or null when none applies. */
  database: string | null;
}

/**
 * Structured variant of [`resolveConnectionLabel`] — returns the profile name
 * and database separately so callers can compose their own strings (the OS
 * window title #59, the `db.table` tab title #57) instead of the fixed
 * `name · database` label. Shares the `<parent>::db::<db>` parsing.
 */
export function resolveConnectionParts(
  profiles: ConnectionProfile[],
  connectionId: string,
): ConnectionParts {
  const sep = connectionId.indexOf(DB_SEP);
  if (sep > 0) {
    const parent = profiles.find((p) => p.id === connectionId.slice(0, sep));
    const database = connectionId.slice(sep + DB_SEP.length) || null;
    return { profileName: parent?.name ?? null, database };
  }
  const direct = profiles.find((p) => p.id === connectionId);
  if (!direct) return { profileName: null, database: null };
  let database: string | null = direct.database || null;
  // SQLite's `database` is a filesystem path — show just the file name so the
  // title/tab stays short. The SQL drivers store a plain catalog name.
  if (direct.driver === "sqlite" && database) {
    database = database.replace(/\\/g, "/").split("/").pop() || database;
  }
  return { profileName: direct.name, database };
}

/**
 * The title for a `kind: "table"` tab (#57): `database.table` so the database
 * and table are shown together, falling back to the bare table name when the
 * database can't be resolved (unknown profile, or a SQLite path we chose to
 * drop). Used at every `openTab({ kind: "table" })` call site.
 */
export function tableTabTitle(
  profiles: ConnectionProfile[],
  connectionId: string,
  table: string,
): string {
  const { database } = resolveConnectionParts(profiles, connectionId);
  return database ? `${database}.${table}` : table;
}
