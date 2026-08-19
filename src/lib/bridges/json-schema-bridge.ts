/**
 * Wires the Rust `huginndb://json-schemas-changed` event (see
 * `src-tauri/src/commands/json_schemas.rs`) into `stores/jsonSchemas.ts`.
 *
 * The library is one global file every window shares, so a schema created or
 * edited in window A must apply in window B, and every window's cached
 * resolutions go stale together. That is why the listener registers **without a
 * `target`**.
 *
 * That looks like the cross-window leak of gotcha #25 and is the deliberate
 * opposite of it: the Console bug that gotcha describes came from a *per-window*
 * payload reaching every window. Here the payload is global config, the backend
 * broadcasts with an unscoped `emit`, and scoping this listener would mean a
 * schema edited in one window silently not applying in another. Do not "fix" it.
 *
 * The event carries no payload on purpose — the library can be hundreds of KB of
 * schema bodies, and shipping that on every save is exactly the cost this
 * feature avoided by keeping the library out of `prefs.json`. The listener
 * re-fetches instead, which also means it cannot loop: `reload` never writes.
 *
 * Mount once at App startup — re-subscribing every render would attach duplicate
 * listeners (HMR / StrictMode).
 */

import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { useJsonSchemas } from "@/stores/jsonSchemas";

const JSON_SCHEMAS_CHANGED_EVENT = "huginndb://json-schemas-changed";

export async function startJsonSchemaBridge(): Promise<UnlistenFn> {
  return listen(JSON_SCHEMAS_CHANGED_EVENT, () => {
    void useJsonSchemas.getState().reload();
  });
}
