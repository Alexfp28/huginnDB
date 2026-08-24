import { resolveVisibleDatabases } from "@/lib/connection/visibleDatabases";
import { useConnections } from "@/stores/session/connections";
import { useUi } from "@/stores/session/ui";

/**
 * Resolve the "databases to show" subset for a connection, in the two layers it
 * is stored in: the active environment's override wins, and the profile's
 * `visible_databases` is the fallback. `null` from either layer means "show
 * all"; the difference is that the environment can *hold* a `null` to widen a
 * subset the profile narrows (see `useUi.databaseVisibility`).
 *
 * A hook rather than a plain function because both layers are stores and the
 * result has to re-render on either changing. Both selectors return an existing
 * reference (or `null`/`undefined`), never a fresh array, so gotcha #1 holds.
 */
export function useVisibleDatabases(connectionId: string): string[] | null {
  const override = useUi((s) => s.databaseVisibility[connectionId]);
  const fromProfile = useConnections(
    (s) => s.profiles.find((p) => p.id === connectionId)?.visible_databases ?? null,
  );
  // The resolution itself lives in `lib/connection/visibleDatabases.ts` so the
  // command palette, which needs the answer for many connections at once, can
  // share it instead of re-deriving the override/profile precedence.
  return resolveVisibleDatabases(override, fromProfile);
}
