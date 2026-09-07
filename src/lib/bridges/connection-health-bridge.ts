/**
 * Wires the Rust `huginndb://connection-lost` Tauri event (see
 * `src-tauri/src/keepalive.rs`) into `stores/connectionHealth.ts`.
 *
 * Mount once at App startup — re-subscribing every render would attach
 * duplicate listeners (HMR / StrictMode).
 */

import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { useConnectionHealth } from "@/stores/session/connectionHealth";
import { useConnections } from "@/stores/session/connections";
import {
  connectAndWarm,
  disconnectAndClean,
} from "@/lib/connection/connectFlow";
import i18n from "@/lib/i18n";
import { notify } from "@/lib/notify";

const CONNECTION_LOST_EVENT = "huginndb://connection-lost";

interface ConnectionLostPayload {
  connection_id: string;
  error: string;
}

export async function startConnectionHealthBridge(): Promise<UnlistenFn> {
  return listen<ConnectionLostPayload>(CONNECTION_LOST_EVENT, (event) => {
    const { connection_id: id, error } = event.payload;
    const already = id in useConnectionHealth.getState().lost;
    useConnectionHealth.getState().markLost(id, error);
    // The badge the tree and the status bar grow is the *state*; this is the
    // *event*, and it is the one notification in the app nobody asked for —
    // the heartbeat fires every three minutes whether or not the connections
    // panel is even on screen, and the first thing anyone learns otherwise is
    // a cryptic driver error mid-query. Carrying "Reconnect" escalates it to a
    // card, which is right: a dead pool is not a thing to glance at.
    //
    // Only on the transition into "lost": the backend re-flags a connection on
    // every failed ping, and a card per ping for a server that stays down is
    // worse than none.
    if (already) return;
    const name =
      useConnections.getState().profiles.find((p) => p.id === id)?.name ?? id;
    notify.warning(i18n.t("connections.lostTitle", { name }), {
      description: error,
      actions: [
        {
          label: i18n.t("connections.reconnect"),
          variant: "primary",
          onClick: () => {
            void disconnectAndClean(id).then(() => connectAndWarm(id));
          },
        },
      ],
      // One card per connection, however many times it is re-reported.
      group: `connection-lost:${id}`,
    });
  });
}
