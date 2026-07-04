/**
 * Wires the Rust `huginndb://prefs-changed` event (see `update_preferences`
 * in `src-tauri/src/commands/prefs.rs`) into `stores/preferences.ts`.
 *
 * Each window hydrates a private `Preferences` snapshot once at boot and
 * otherwise has no way to learn that another window changed a setting.
 * Worse than staleness: every save sends the *entire* blob (not a diff), so
 * without this, two windows changing different settings would silently
 * lose whichever change saved first the instant the other's debounce timer
 * fires (issue #18). The listener just adopts the broadcasted snapshot as
 * its new baseline via `applyExternal` — no re-save, so this can't loop.
 *
 * Mount once at App startup — re-subscribing every render would attach
 * duplicate listeners (HMR / StrictMode).
 */

import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { usePreferences } from "@/stores/preferences";
import type { Preferences } from "@/types";

const PREFS_CHANGED_EVENT = "huginndb://prefs-changed";

export async function startPrefsSyncBridge(): Promise<UnlistenFn> {
  return listen<Preferences>(PREFS_CHANGED_EVENT, (event) => {
    usePreferences.getState().applyExternal(event.payload);
  });
}
