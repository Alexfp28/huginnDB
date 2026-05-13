import { create } from "zustand";
import { api } from "@/lib/tauri";
import type { ConnectionProfile } from "@/types";

interface ConnectionsState {
  profiles: ConnectionProfile[];
  active: Set<string>;
  loading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
  save: (profile: ConnectionProfile, password?: string) => Promise<ConnectionProfile>;
  remove: (id: string) => Promise<void>;
  connect: (id: string, password?: string) => Promise<void>;
  disconnect: (id: string) => Promise<void>;
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
