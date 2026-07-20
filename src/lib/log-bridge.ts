/**
 * Wires the Rust `huginndb://log` Tauri event into the frontend log
 * store. Mount once at App startup — re-subscribing every render would
 * duplicate entries.
 */

import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import type { LogEntry } from "@/types";
import { useLogs } from "@/stores/logs";

const LOG_EVENT = "huginndb://log";

/**
 * Subscribe to backend log events for **this window only**. Returns the
 * unlisten function so the caller can clean up on unmount (useful in dev with
 * HMR).
 *
 * The `target` filter is essential for per-window isolation (#50). Command
 * handlers emit their SQL/connection log entries with `emit_to(window_label)`
 * (see `log_bus::emit`), targeting the window that ran the statement. But a
 * bare `listen()` registers with `EventTarget::Any`, and Tauri delivers every
 * `emit_to(...)` to an `Any` listener regardless of its target — so with a
 * second ("New window") window open, both Consoles received both windows'
 * entries. Scoping the listener to the current window's label makes it match
 * only `emit_to(thisLabel)` (plus global `emit` broadcasts, which Tauri sends
 * to every listener unconditionally — e.g. the keepalive connection-lost log
 * in `keepalive.rs`, which is meant for all windows sharing the connection).
 */
export async function startLogBridge(): Promise<UnlistenFn> {
  const label = getCurrentWindow().label;
  return listen<LogEntry>(
    LOG_EVENT,
    (event) => {
      useLogs.getState().push(event.payload);
    },
    { target: label },
  );
}
