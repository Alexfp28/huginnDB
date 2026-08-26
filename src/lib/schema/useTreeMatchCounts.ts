/**
 * The app's ONE subscription to `useSchema.byConnection`.
 *
 * Every connection row needs a match count, which means somebody has to look at
 * every loaded table on every live connection whenever the needle changes.
 * Doing that per explorer is how the panel ended up with N wide subscriptions
 * to the same map — `ConnectionsTree` had one, and each `MultiDbExplorer` added
 * another — all recomputing overlapping answers on every store write.
 *
 * Reading the raw map in the selector is safe for the usual reason (gotcha #1):
 * `useSchema` *replaces* slices, never mutates them, so the reference only
 * changes when something really changed. Everything derived from it — the
 * summaries, the per-slice lowercased names inside `treeMatches` — hangs off a
 * `useMemo` or a `WeakMap` keyed on that same identity.
 *
 * The counts are skipped entirely when nothing is typed: with no needle every
 * table matches, the badges are not rendered, and walking every catalogue on
 * every render to compute a number nobody reads is pure waste.
 */

import { useMemo } from "react";
import { useSchema } from "@/stores/session/schema";
import {
  summarizeMatches,
  type ConnectionMatchSummary,
  type TreeConnectionInput,
} from "@/lib/schema/treeMatches";
import type { FilterScope } from "@/lib/schema/filterScope";

const EMPTY = new Map<string, ConnectionMatchSummary>();

/**
 * Match counts per connection, keyed by profile id.
 *
 * `connections` must be reference-stable across renders that change nothing —
 * derive it with `useMemo` in the caller, which is also where the
 * visible-databases subset is resolved (`resolveVisibleDatabases`, not
 * `useVisibleDatabases`: the hook cannot be called in a loop).
 */
export function useTreeMatchCounts(
  connections: TreeConnectionInput[],
  patterns: string[],
  scope: FilterScope,
): Map<string, ConnectionMatchSummary> {
  const byConnection = useSchema((s) => s.byConnection);
  return useMemo(() => {
    if (patterns.length === 0) return EMPTY;
    const summaries = summarizeMatches(connections, byConnection, patterns, scope);
    return new Map(summaries.map((s) => [s.connectionId, s]));
  }, [connections, byConnection, patterns, scope]);
}
