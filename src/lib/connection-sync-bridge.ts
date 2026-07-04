/**
 * Wires the Rust `huginndb://connection-opened` / `-closed` /
 * `-profiles-changed` events (see `src-tauri/src/commands/connection.rs`)
 * into `stores/connections.ts`.
 *
 * Every window shares one backend `AppState`, but each window's frontend
 * used to hold a private `active` Set / `profiles` array snapshotted once
 * at boot, with no way to learn that another window connected/disconnected
 * a profile or edited/imported/deleted one (issue #18). This bridge closes
 * that gap the same way `connection-health-bridge.ts` does for the
 * keepalive's lost-connection signal.
 *
 * Mount once at App startup — re-subscribing every render would attach
 * duplicate listeners (HMR / StrictMode).
 */

import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { useConnections } from "@/stores/connections";

const CONNECTION_OPENED_EVENT = "huginndb://connection-opened";
const CONNECTION_CLOSED_EVENT = "huginndb://connection-closed";
const PROFILES_CHANGED_EVENT = "huginndb://profiles-changed";

interface ConnectionSyncPayload {
  connection_id: string;
}

export async function startConnectionSyncBridge(): Promise<UnlistenFn> {
  const unlistenOpened = await listen<ConnectionSyncPayload>(
    CONNECTION_OPENED_EVENT,
    (event) => {
      useConnections.getState().markConnected(event.payload.connection_id);
    },
  );
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
    unlistenOpened();
    unlistenClosed();
    unlistenProfiles();
  };
}
