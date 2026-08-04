/**
 * Session-scoped cache for foreign-key dropdown options.
 *
 * The FK combobox prefetches up to `PREFETCH_LIMIT` rows the first time a
 * given target is opened. Subsequent opens within the same session hit
 * this cache and skip the round-trip. The cache is intentionally NOT a
 * Zustand store: nothing in the UI needs to subscribe to changes, and the
 * project banner in `src/stores/theme.ts` reminds us that derived
 * collections from a store break reference equality.
 *
 * Entries are dropped when they report `has_more`: in that case the
 * combobox switches to server-side ILIKE search and the prefetched slice
 * would be misleading.
 */

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

  /** Drop every entry for a connection. Call on disconnect. */
  clearConnection(connectionId: string): void {
    const prefix = `${connectionId}|`;
    for (const k of cache.keys()) {
      if (k.startsWith(prefix)) cache.delete(k);
    }
  },
};
