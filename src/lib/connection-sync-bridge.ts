/**
 * Wires the Rust `huginndb://connection-closed` / `-profiles-changed` events
 * (see `src-tauri/src/commands/connection.rs`) into `stores/connections.ts`.
 *
 * Every window shares one backend `AppState`. Two kinds of cross-window state
 * are handled differently on purpose:
 *
 *   • PROFILES are shared config — a create/edit/delete/import in one window
 *     must be reflected everywhere (issue #18), so `-profiles-changed`
 *     re-fetches the profile list.
 *
 *   • The set of OPEN connections is per-window (issue #50): a window shows a
 *     connection as active only when it opened the pool itself, so we do NOT
 *     listen for `-connection-opened` — a new window must not adopt another
 *     window's live connections.
 *
 * We still listen for `-connection-closed`: because the backend pool is
 * physically shared, when one window disconnects a profile the pool dies for
 * *every* window that had it open, so each must drop its now-stale tabs and
 * schema cache. `markDisconnected` is a no-op for a window that never had the
 * connection active.
 *
 * Mount once at App startup — re-subscribing every render would attach
 * duplicate listeners (HMR / StrictMode).
 */

import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { useConnections } from "@/stores/connections";

const CONNECTION_CLOSED_EVENT = "huginndb://connection-closed";
const PROFILES_CHANGED_EVENT = "huginndb://profiles-changed";

interface ConnectionSyncPayload {
  connection_id: string;
}

export async function startConnectionSyncBridge(): Promise<UnlistenFn> {
  const unlistenClosed = await listen<ConnectionSyncPayload>(
    CONNECTION_CLOSED_EVENT,
    (event) => {
      useConnections.getState().markDisconnected(event.payload.connection_id);
    },
  );
  const unlistenProfiles = await listen(PROFILES_CHANGED_EVENT, () => {
    void useConnections.getState().refreshProfiles();
  });
  return () => {
    unlistenClosed();
    unlistenProfiles();
  };
}
