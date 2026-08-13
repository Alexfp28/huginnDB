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

import type { ConnectionProfile, Driver } from "@/types";

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

/**
 * Resolve a connectionId to its driver, for surfaces that show a
 * `DriverBadge` next to the connection (the workspace tab strip). Shares the
 * `<parent>::db::<db>` parsing with [`resolveConnectionLabel`] — a synthetic
 * multi-DB child id inherits the parent profile's driver.
 */
export function resolveConnectionDriver(
  profiles: ConnectionProfile[],
  connectionId: string,
): Driver | undefined {
  const direct = profiles.find((p) => p.id === connectionId);
  if (direct) return direct.driver;
  const sep = connectionId.indexOf(DB_SEP);
  if (sep > 0) {
    const parent = profiles.find((p) => p.id === connectionId.slice(0, sep));
    if (parent) return parent.driver;
  }
  return undefined;
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

/**
 * The name a tab is *really* about, with the database dropped when a
 * surrounding surface already shows it.
 *
 * A table tab's title is `database.table` (see [`tableTabTitle`]) so a bare
 * tab reads unambiguously. But the tab strip and the tab switcher also render
 * the connection context — `resolveConnectionLabel`, itself `name · database`
 * — right next to it, so the database was printed twice in the same 200px:
 * `Oset · iMesPyme · iMesPyme.pedidos`. The repetition is what pushed the
 * table name (the only part that differs between two tabs of the same
 * connection) past the truncation point. Call this wherever the context is
 * shown alongside, and keep `tab.title` where it stands alone (window title,
 * detached window, persistence).
 */
export function tabLeafTitle(
  profiles: ConnectionProfile[],
  tab: { kind: string; title: string; connectionId: string; table?: string },
): string {
  if (tab.kind !== "table" || !tab.table) return tab.title;
  const { database } = resolveConnectionParts(profiles, tab.connectionId);
  return database && tab.title === `${database}.${tab.table}`
    ? tab.table
    : tab.title;
}
