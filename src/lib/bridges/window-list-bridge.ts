/**
 * Wires the Rust `huginndb://window-list-changed` event into
 * `stores/session/windowRegistry.ts`.
 *
 * Emitted by the backend whenever any window is created (`open_new_window` /
 * `open_tab_window` / `open_pulse_window` in `commands/connection.rs`) or
 * destroyed (the global `on_window_event` handler in `lib.rs`). Deliberately
 * a bare, unscoped `listen()` — every window's `WindowColorBadge` needs to
 * know the total count, not just changes caused by itself, so this is the
 * broadcast-to-everyone case gotcha #25 carves out (like the keepalive
 * connection-lost log), not the per-window `emit_to` case.
 *
 * Mount once per window (via `useBridge`) — re-subscribing every render
 * would attach duplicate listeners under HMR / StrictMode.
 */

import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { useWindowRegistry } from "@/stores/session/windowRegistry";

const WINDOW_LIST_CHANGED_EVENT = "huginndb://window-list-changed";

export async function startWindowListBridge(): Promise<UnlistenFn> {
  void useWindowRegistry.getState().refresh();
  return listen(WINDOW_LIST_CHANGED_EVENT, () => {
    void useWindowRegistry.getState().refresh();
  });
}
