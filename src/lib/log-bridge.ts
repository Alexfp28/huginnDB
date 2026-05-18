/**
 * Wires the Rust `huginndb://log` Tauri event into the frontend log
 * store. Mount once at App startup — re-subscribing every render would
 * duplicate entries.
 */

import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type { LogEntry } from "@/types";
import { useLogs } from "@/stores/logs";

const LOG_EVENT = "huginndb://log";

/** Subscribe to backend log events. Returns the unlisten function so
 *  the caller can clean up on unmount (useful in dev with HMR). */
export async function startLogBridge(): Promise<UnlistenFn> {
  return listen<LogEntry>(LOG_EVENT, (event) => {
    useLogs.getState().push(event.payload);
  });
}
