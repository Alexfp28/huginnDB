/**
 * Connections store — saved profiles + the set of profiles that are
 * currently open. Mirrors the Tauri-managed Rust state, refreshed via
 * `api.listProfiles` / `api.activeConnections`.
 */

import { create } from "zustand";
import { api } from "@/lib/tauri";
import type { ConnectionProfile } from "@/types";

interface ConnectionsState {
  /** Profiles persisted on disk (no passwords). */
  profiles: ConnectionProfile[];
  /** Ids of profiles that currently have a live pool in the backend. */
  active: Set<string>;
  loading: boolean;
  error: string | null;
  /** Pull `profiles` and `active` from the backend. */
  refresh: () => Promise<void>;
  /** Create or update a profile; the keychain entry is written when
   *  `password` is provided. */
  save: (
    profile: ConnectionProfile,
    password?: string,
  ) => Promise<ConnectionProfile>;
  /** Delete a profile and its keychain entry. */
  remove: (id: string) => Promise<void>;
  /** Open a pool for `id`. Falls back to the stored password if `password` is omitted. */
  connect: (id: string, password?: string) => Promise<void>;
  /** Close the pool for `id`. */
  disconnect: (id: string) => Promise<void>;
  /** Convenience helper for components. */
  isActive: (id: string) => boolean;
}

export const useConnections = create<ConnectionsState>((set, get) => ({
  profiles: [],
  active: new Set(),
  loading: false,
  error: null,
  refresh: async () => {
    set({ loading: true, error: null });
    try {
      const [profiles, active] = await Promise.all([
        api.listProfiles(),
        api.activeConnections(),
      ]);
      set({ profiles, active: new Set(active), loading: false });
    } catch (e) {
      set({ error: String(e), loading: false });
    }
  },
  save: async (profile, password) => {
    const saved = await api.saveProfile(profile, password);
    await get().refresh();
    return saved;
  },
  remove: async (id) => {
    await api.deleteProfile(id);
    await get().refresh();
  },
  connect: async (id, password) => {
    await api.connect(id, password);
    const active = new Set(get().active);
    active.add(id);
    set({ active });
  },
  disconnect: async (id) => {
    await api.disconnect(id);
    const active = new Set(get().active);
    active.delete(id);
    set({ active });
  },
  isActive: (id) => get().active.has(id),
}));
