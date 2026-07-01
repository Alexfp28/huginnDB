/**
 * Wires the Rust `huginndb://cli-connect` Tauri event into the frontend.
 *
 * Emitted by the single-instance handler (`lib.rs::handle_second_instance`)
 * when a *second* `huginndb …` launch forwards a connection intent to the
 * already-running window. The window has already been focused in Rust; the
 * frontend's job is to ask the user how to route the incoming connection
 * (this window vs. a new one) and then drive the connect flow.
 *
 * Mount once at App startup — re-subscribing every render would fire the
 * dialog multiple times per launch.
 */

import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type { StartupArgs } from "@/types";

const CLI_CONNECT_EVENT = "huginndb://cli-connect";

/**
 * Subscribe to second-launch connection intents. `onIntent` is invoked with
 * the parsed args for each forwarded launch. Returns the unlisten function so
 * the caller can clean up on unmount (keeps HMR / StrictMode from attaching
 * duplicate listeners).
 */
export async function startCliConnectBridge(
  onIntent: (args: StartupArgs) => void,
): Promise<UnlistenFn> {
  return listen<StartupArgs>(CLI_CONNECT_EVENT, (event) => {
    onIntent(event.payload);
  });
}
