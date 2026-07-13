/**
 * Connections store — saved profiles + the set of profiles that are
 * currently open *in this window*. `profiles` mirrors the Tauri-managed Rust
 * state (`api.listProfiles`); `active` is a per-window view driven by this
 * window's own connect()/disconnect() plus the cross-window pool-closed
 * cleanup in `connection-sync-bridge.ts` (#50). It is NOT seeded from the
 * backend's global pool set, so opening a new window doesn't adopt another
 * window's live connections.
 *
 * Server version strings are fetched once per connection and cached here
 * so the status bar and other UI can read them without re-querying.
 */

import { create } from "zustand";
import { api } from "@/lib/tauri";
import { useFilterHistory } from "@/stores/filterHistory";
import { flushTabState, hydrateTabState } from "@/stores/persistedTabs";
import { useConnectionHealth } from "@/stores/connectionHealth";
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
  /**
   * Local-only side effect of a connection becoming active — no backend
   * call. Used by `connect()` itself. Not driven cross-window: a window only
   * marks a connection active when it opens the pool itself (#50).
   */
  markConnected: (id: string) => void;
  /**
   * Local-only side effect of a connection closing — no backend call. Same
   * split as `markConnected`; mirrors `disconnect()`'s cleanup so a window
   * that didn't initiate the disconnect still drops its own tabs/schema
   * cache for a pool that's now dead everywhere.
   */
  markDisconnected: (id: string) => void;
  /** Re-fetch just the saved-profiles list (not `active`) — used by the
   *  sync bridge after another window creates/edits/deletes/imports a
   *  profile, where a full `refresh()` would be a heavier no-op for the
   *  `active` half. */
  refreshProfiles: () => Promise<void>;
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
      // `active` is deliberately NOT re-seeded from the backend's global pool
      // set. Every window shares one backend AppState, but each window owns its
      // own view of which connections are open (#50): a window adds to `active`
      // only through its own connect()/disconnect(), plus the cross-window
      // "pool closed everywhere" cleanup in the sync bridge. Pulling
      // api.activeConnections() here would make a freshly opened window adopt
      // the connections another window had open — the exact non-independence
      // #50 reported. The existing `active` set is preserved across refreshes.
      const profiles = await api.listProfiles();
      set({ profiles, loading: false });
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
    get().markConnected(id);

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
  markConnected: (id) => {
    // A successful (re)connect opens a fresh pool with its own heartbeat —
    // any previous "connection lost" flag no longer applies.
    useConnectionHealth.getState().clear(id);
    set((s) => {
      if (s.active.has(id)) return s;
      const active = new Set(s.active);
      active.add(id);
      return { active };
    });
  },
  disconnect: async (id) => {
    // Flush any pending workspace snapshot to disk and detach the
    // subscription before the pool is dropped. Doing this BEFORE the
    // backend disconnect means a save failure can't leave us with no
    // pool but a still-mounted subscription.
    await flushTabState(id);
    await api.disconnect(id);
    get().markDisconnected(id);
  },
  markDisconnected: (id) => {
    // An explicit disconnect isn't a "lost" connection — clear any stale
    // flag so a later reconnect doesn't briefly show the wrong state.
    useConnectionHealth.getState().clear(id);
    set((s) => {
      const active = new Set(s.active);
      active.delete(id);
      // Remove the stale version entry so a reconnect always fetches a fresh one.
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
    // we don't leave orphaned trees / tabs pointing at dead pools. This
    // matters just as much when the pool died via ANOTHER window's
    // disconnect — this window's own tabs/schema for it are equally stale.
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
  refreshProfiles: async () => {
    const profiles = await api.listProfiles();
    set({ profiles });
  },
  isActive: (id) => get().active.has(id),
  getVersion: (id) => get().versions[id],
}));
