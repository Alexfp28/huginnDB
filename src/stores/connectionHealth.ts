/**
 * Tracks connections the backend's keepalive heartbeat has flagged as
 * lost (see `src-tauri/src/keepalive.rs`). Populated by
 * `lib/connection-health-bridge.ts`; cleared whenever the connection is
 * (re)connected or explicitly disconnected — see `stores/connections.ts`.
 *
 * Only top-level profile connections get a heartbeat (not the synthetic
 * `<id>::db::<name>` multi-DB children), so keys here are always plain
 * profile ids.
 */

import { create } from "zustand";

interface ConnectionHealthState {
  /** Profile id -> the ping error that flagged it lost. */
  lost: Record<string, string>;
  markLost: (id: string, error: string) => void;
  clear: (id: string) => void;
}

export const useConnectionHealth = create<ConnectionHealthState>((set) => ({
  lost: {},
  markLost: (id, error) =>
    set((s) => ({ lost: { ...s.lost, [id]: error } })),
  clear: (id) =>
    set((s) => {
      if (!(id in s.lost)) return s;
      const next = { ...s.lost };
      delete next[id];
      return { lost: next };
    }),
}));
