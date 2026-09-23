/**
 * Session-scoped cache for foreign-key dropdown options.
 *
 * The FK combobox prefetches up to `PREFETCH_LIMIT` rows whenever it mounts.
 * This cache only decides what it can paint *before* that answer arrives:
 * it is a first frame, never the answer. Serving it as the answer is what
 * used to hide a referenced key the user had just renamed — the cache had
 * no invalidation at all, so neither F5 nor an edit to the referenced table
 * reached it, and it held whatever the first open saw until the app
 * restarted. Invalidating on writes instead would still miss a change made
 * from the SQL editor or from another client, which revalidating on every
 * open covers for the price of one bounded query.
 *
 * The cache is intentionally NOT a Zustand store: nothing in the UI needs to
 * subscribe to changes, and the project banner in `src/stores/theme.ts`
 * reminds us that derived collections from a store break reference equality.
 *
 * A target that reports `has_more` is kept, flagged `TOO_LARGE`: its first
 * page still serves as a preview, and the flag switches the combobox to
 * server-side ILIKE search as soon as the user types.
 */

import { isDatabaseViewOf } from "@/lib/connectionLabel";
import type { FkOption } from "@/types";

/** Sentinel value for a target whose row count exceeds the prefetch limit. */
export const TOO_LARGE = "too-large" as const;

/**
 * A prefetched FK page. We carry the same `options` field in both
 * variants so the combobox can show the first N rows as a preview even
 * for very large targets — `kind` only controls whether keystrokes
 * trigger a server-side ILIKE round trip.
 */
export type FkPrefetchEntry = {
  kind: "ready" | typeof TOO_LARGE;
  options: FkOption[];
};

/** Default page size for the initial prefetch. */
export const PREFETCH_LIMIT = 200;

const cache = new Map<string, FkPrefetchEntry>();

function keyOf(
  connectionId: string,
  schema: string | undefined,
  table: string,
  keyColumn: string,
): string {
  return `${connectionId}|${schema ?? ""}|${table}|${keyColumn}`;
}

export const fkOptionsCache = {
  get(
    connectionId: string,
    schema: string | undefined,
    table: string,
    keyColumn: string,
  ): FkPrefetchEntry | undefined {
    return cache.get(keyOf(connectionId, schema, table, keyColumn));
  },

  set(
    connectionId: string,
    schema: string | undefined,
    table: string,
    keyColumn: string,
    entry: FkPrefetchEntry,
  ): void {
    cache.set(keyOf(connectionId, schema, table, keyColumn), entry);
  },

  /**
   * Drop every entry for a connection and for the `<id>::db::<db>` children
   * a multi-DB session opened under it — the backend closes those pools with
   * the parent, so their options are just as dead. Called from
   * `markDisconnected`.
   */
  clearConnection(connectionId: string): void {
    const own = `${connectionId}|`;
    for (const k of cache.keys()) {
      const id = k.slice(0, k.indexOf("|"));
      if (k.startsWith(own) || isDatabaseViewOf(id, connectionId)) {
        cache.delete(k);
      }
    }
  },
};
