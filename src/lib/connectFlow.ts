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

import { toast } from "sonner";
import { useConnections } from "@/stores/connections";
import { useSchema } from "@/stores/schema";
import { useTabs } from "@/stores/tabs";
import { driverMismatchHint } from "@/lib/driver";

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
    toast.error(hint ? `${msg} — ${hint}` : msg);
    return false;
  }
}

/**
 * Tear down the pool for `id` and everything hanging off it: the cached schema
 * (so a later reconnect refetches instead of showing a stale tree) and the tabs
 * that pointed at it. Errors are swallowed — a pool that was already dead should
 * still leave the UI in a clean state.
 */
export async function disconnectAndClean(id: string): Promise<void> {
  try {
    await useConnections.getState().disconnect(id);
    useSchema.getState().drop(id);
    useTabs.getState().closeForConnection(id);
  } catch {
    // Non-fatal: leave the rest of the UI untouched on a teardown error.
  }
}
