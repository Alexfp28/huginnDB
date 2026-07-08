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
