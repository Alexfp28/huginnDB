/**
 * Connections store — saved profiles + the set of profiles that are
 * currently open. Mirrors the Tauri-managed Rust state, refreshed via
 * `api.listProfiles` / `api.activeConnections`.
 *
 * Server version strings are fetched once per connection and cached here
 * so the status bar and other UI can read them without re-querying.
 */

import { create } from "zustand";
import { api } from "@/lib/tauri";
import { useFilterHistory } from "@/stores/filterHistory";
import { flushTabState, hydrateTabState } from "@/stores/persistedTabs";
import { useSchema } from "@/stores/schema";
import { useTabs } from "@/stores/tabs";
import type { ConnectionProfile } from "@/types";

interface ConnectionsState {
  /** Profiles persisted on disk (no passwords). */
  profiles: ConnectionProfile[];
  /** Ids of profiles that currently have a live pool in the backend. */
  active: Set<string>;
  /**
   * Cached server version strings keyed by profile id.
   * Populated after a successful `connect()` call; never written to disk.
   */
  versions: Record<string, string>;
  loading: boolean;
  error: string | null;
  /** Pull `profiles` and `active` from the backend. */
  refresh: () => Promise<void>;
  /** Create or update a profile; the keychain entries are written when
   *  `password` / `sshSecret` are provided. */
  save: (
    profile: ConnectionProfile,
    password?: string,
    sshSecret?: string,
  ) => Promise<ConnectionProfile>;
  /** Delete a profile and its keychain entries. */
  remove: (id: string) => Promise<void>;
  /** Open a pool for `id`. Falls back to the stored secrets if omitted. */
  connect: (id: string, password?: string, sshSecret?: string) => Promise<void>;
  /** Close the pool for `id`. */
  disconnect: (id: string) => Promise<void>;
  /** Convenience helper for components. */
  isActive: (id: string) => boolean;
  /** Return the cached server version for `id`, or undefined if not yet fetched. */
  getVersion: (id: string) => string | undefined;
}

export const useConnections = create<ConnectionsState>((set, get) => ({
  profiles: [],
  active: new Set(),
  versions: {},
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
  save: async (profile, password, sshSecret) => {
    const saved = await api.saveProfile(profile, password, sshSecret);
    await get().refresh();
    return saved;
  },
  remove: async (id) => {
    await api.deleteProfile(id);
    await get().refresh();
  },
  connect: async (id, password, sshSecret) => {
    await api.connect(id, password, sshSecret);
    const active = new Set(get().active);
    active.add(id);
    set({ active });

    // Rehydrate the persisted workspace (open tabs + schema-tree
    // expansion) before we kick off the version probe, so the user sees
    // their previous layout immediately on reconnect. The call honours
    // the `restoreTabsOnOpen` preference internally.
    await hydrateTabState(id);

    // Fetch and cache the server version string. This is a best-effort call;
    // a failure should not prevent the connection from succeeding.
    try {
      const version = await api.serverVersion(id);
      set((s) => ({ versions: { ...s.versions, [id]: version } }));
    } catch {
      // Version display is non-critical; swallow the error silently.
    }
  },
  disconnect: async (id) => {
    // Flush any pending workspace snapshot to disk and detach the
    // subscription before the pool is dropped. Doing this BEFORE the
    // backend disconnect means a save failure can't leave us with no
    // pool but a still-mounted subscription.
    await flushTabState(id);

    await api.disconnect(id);
    const active = new Set(get().active);
    active.delete(id);
    // Remove the stale version entry so a reconnect always fetches a fresh one.
    set((s) => {
      const versions = { ...s.versions };
      delete versions[id];
      return { active, versions };
    });
    // The user asked for filter history to be tied to the connection
    // lifetime; wipe it when the pool closes.
    useFilterHistory.getState().clearForConnection(id);
    // Drop the schema cache so a subsequent reconnect (possibly to a
    // different database on the same host) always fetches fresh metadata
    // instead of showing the stale tree from the previous session.
    useSchema.getState().drop(id);

    // Multi-DB sessions register synthetic `<id>::db::<db>` child
    // connections in the backend (see `open_database_view`); the backend
    // sweeps them when the parent disconnects, but the frontend stores
    // also keep per-child schema slices and open tabs. Drop them here so
    // we don't leave orphaned trees / tabs pointing at dead pools.
    const prefix = `${id}::db::`;
    const tabsState = useTabs.getState();
    const schemaState = useSchema.getState();
    for (const tab of tabsState.tabs) {
      if (tab.connectionId.startsWith(prefix)) {
        tabsState.closeForConnection(tab.connectionId);
        schemaState.drop(tab.connectionId);
      }
    }
    // Drop any schema slice for a child that was browsed but never had a
    // tab opened against it.
    for (const childId of Object.keys(schemaState.byConnection)) {
      if (childId.startsWith(prefix)) {
        schemaState.drop(childId);
      }
    }
  },
  isActive: (id) => get().active.has(id),
  getVersion: (id) => get().versions[id],
}));
