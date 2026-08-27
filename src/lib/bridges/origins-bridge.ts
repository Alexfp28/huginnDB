/**
 * Wires the Rust `huginndb://origins-changed` event (see
 * `src-tauri/src/commands/origins.rs`) into `stores/sync/origins.ts`.
 *
 * Registers **without a `target`**, exactly like `json-schema-bridge.ts` and for
 * the same reason: the origin registry is one global list in `tab_state.json`,
 * so a rename in the Settings window must reach the connection manager in the
 * main window, and every window's cached id-to-name map goes stale at the same
 * instant. That is the deliberate opposite of gotcha #25, whose bug was a
 * *per-window* payload reaching every window — not a global one.
 *
 * The event carries no payload; the listener re-fetches. It cannot loop:
 * `load()` never writes.
 *
 * Mount once at App startup — re-subscribing every render would attach
 * duplicate listeners (HMR / StrictMode).
 */

import { listen, type UnlistenFn } from "@tauri-apps/api/event";

import { useOrigins } from "@/stores/sync/origins";

const ORIGINS_CHANGED_EVENT = "huginndb://origins-changed";

export async function startOriginsBridge(): Promise<UnlistenFn> {
  return listen(ORIGINS_CHANGED_EVENT, () => {
    void useOrigins.getState().load();
  });
}
