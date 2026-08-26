/**
 * The two gestures every surface that lists connections needs: open one (and
 * warm its schema so the tree isn't empty for a beat), and close one (dropping
 * its cached schema and its tabs).
 *
 * Extracted while building the connections tree (#107), which would otherwise
 * have been a fourth copy. The older call sites — `FileMenu`, `StatusConnections`
 * and `CommandPalette` — still carry their own inlined versions; two are
 * behaviourally identical to this and one (`FileMenu`) reports failures through
 * `alert` instead of a toast. Consolidating them is a separate cleanup, not
 * something to fold into a feature commit.
 *
 * Deliberately store-level rather than a hook: it's called from click handlers,
 * and a couple of the call sites need it outside React's render cycle.
 */

import { notify } from "@/lib/notify";
import { useConnections } from "@/stores/session/connections";
import { useSchema } from "@/stores/session/schema";
import { useTabs } from "@/stores/session/tabs";
import { persistLaunchState } from "@/stores/session/persistedTabs";
import { driverMismatchHint } from "@/lib/db/driver";

/**
 * Open the pool for `id` and load its schema. Returns whether it worked, so the
 * caller can decide what to focus — a profile whose password isn't in the
 * keychain, or whose host is unreachable, surfaces the driver's own message
 * (plus a hint when it looks like the wrong driver for the port) rather than
 * failing silently.
 */
export async function connectAndWarm(id: string): Promise<boolean> {
  try {
    await useConnections.getState().connect(id);
    await useSchema.getState().refresh(id);
    return true;
  } catch (e) {
    const msg = String(e);
    const hint = driverMismatchHint(msg);
    notify.error(hint ? `${msg} — ${hint}` : msg);
    return false;
  }
}

/**
 * Tear down the pool for `id` and everything hanging off it: the cached schema
 * (so a later reconnect refetches instead of showing a stale tree) and the tabs
 * that pointed at it. Errors are swallowed — a pool that was already dead should
 * still leave the UI in a clean state.
 */
export async function disconnectAndClean(
  id: string,
  opts?: { persistLaunch?: boolean },
): Promise<void> {
  try {
    await useConnections.getState().disconnect(id, opts);
    useSchema.getState().drop(id);
    useTabs.getState().closeForConnection(id);
  } catch {
    // Non-fatal: leave the rest of the UI untouched on a teardown error.
  }
}

/**
 * Close every live pool, concurrently.
 *
 * **Why this is one function and not two loops.** "Disconnect all" had two
 * implementations that disagreed on both axes that matter. The connections
 * tree awaited each connection in turn *and* cleaned up after each (schema
 * cache, tabs); the keyboard shortcut and the command palette fired them all
 * off with `void` *and* cleaned up neither, leaving a stale tree and tabs
 * pointing at closed pools. So the same command was slow and correct from one
 * surface, fast and lossy from another.
 *
 * **Why concurrency is the fix rather than a nicety.** A single disconnect is
 * not one round trip: the backend closes each synthetic `<parent>::db::<db>`
 * pool in turn — every one of them up to `CLOSE_TIMEOUT` (5s) if the server
 * has stopped answering — before closing the parent's, and the frontend
 * flushes one tab-state snapshot per child on top of that. Serialising the
 * *connections* on top of all that nesting is what turned "disconnect all"
 * into a visible wait, and one unreachable server made every healthy one
 * behind it wait out its timeout first. `allSettled`, not `all`: one pool that
 * refuses to close must not abandon the rest half-torn-down.
 *
 * The launch-state write is suppressed per connection and done once at the
 * end — see `useConnections.disconnect`'s `persistLaunch` for the race that
 * otherwise makes the *last* of N concurrent writes the winner.
 */
export async function disconnectAll(): Promise<void> {
  const ids = Array.from(useConnections.getState().active);
  if (ids.length === 0) return;
  await Promise.allSettled(
    ids.map((id) => disconnectAndClean(id, { persistLaunch: false })),
  );
  await persistLaunchState(Array.from(useConnections.getState().active));
}
