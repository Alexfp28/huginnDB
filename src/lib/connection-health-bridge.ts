/**
 * Wires the Rust `huginndb://connection-lost` Tauri event (see
 * `src-tauri/src/keepalive.rs`) into `stores/connectionHealth.ts`.
 *
 * Mount once at App startup — re-subscribing every render would attach
 * duplicate listeners (HMR / StrictMode).
 */

import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { useConnectionHealth } from "@/stores/connectionHealth";

const CONNECTION_LOST_EVENT = "huginndb://connection-lost";

interface ConnectionLostPayload {
  connection_id: string;
  error: string;
}

export async function startConnectionHealthBridge(): Promise<UnlistenFn> {
  return listen<ConnectionLostPayload>(CONNECTION_LOST_EVENT, (event) => {
    useConnectionHealth
      .getState()
      .markLost(event.payload.connection_id, event.payload.error);
  });
}
