/**
 * Subscribe to the driver behind a connection id.
 *
 * Wraps `resolveConnectionDriver` so the four surfaces that need a driver for
 * a tab — the data grid (identifier quoting in its "Copy as SQL" snippets),
 * the structure editor (type suggestions), the view editor, and the schema
 * tree's context menu — share one implementation instead of four inline
 * copies of the same `<parent>::db::<db>` fold.
 *
 * Returns a `Driver | undefined`, a primitive, so it is a reference-stable
 * Zustand selector return (stores gotcha #1). The lookup itself has to happen
 * *inside* the selector rather than over a subscribed `profiles` array: the
 * point is to re-render only when this connection's driver changes, not on
 * every unrelated profile edit.
 */

import { useConnections } from "@/stores/session/connections";
import { resolveConnectionDriver } from "@/lib/connectionLabel";
import type { Driver } from "@/types";

export function useConnectionDriver(connectionId: string): Driver | undefined {
  return useConnections((s) => resolveConnectionDriver(s.profiles, connectionId));
}
