/**
 * Environments store — the top-level working set: which connections are in
 * play, and the session state (tabs, pane geometry, focus) that belongs to them.
 *
 * The backend scopes every session-state command
 * (`get/saveTabState`, `get/saveWorkspaceLayout`, `get/saveLaunchState`) to
 * whichever environment is active, so switching one is mostly a pointer move on
 * disk. The work — and the ordering risk — is all on this side.
 *
 * Main-window only, like everything that touches `tab_state.json` (gotcha #8).
 * A secondary "New window" instance is ephemeral and must not reshape the main
 * window's session, so `switchTo` refuses to run there.
 *
 * Selector note (gotcha #1): components read `environments` / `activeId` /
 * `switching` as raw values and derive anything else with `useMemo`. Never
 * return a fresh array or object from a selector here.
 */

import { create } from "zustand";
import { api } from "@/lib/tauri";
import { useConnections } from "@/stores/connections";
import { useTabs } from "@/stores/tabs";
import { useUi } from "@/stores/ui";
import { usePreferences } from "@/stores/preferences";
import {
  flushAllTabState,
  hydrateWorkspaceLayout,
} from "@/stores/persistedTabs";
import { getCurrentWindow } from "@tauri-apps/api/window";
import type { Environment } from "@/types";

/**
 * Display name for an environment. An empty `name` means the user never named
 * it — the backend deliberately refuses to write display copy, since a literal
 * stored there would freeze one language into the user's data (see the `name`
 * field in `src-tauri/src/tab_state.rs`). Callers pass the localised fallback.
 */
export function environmentLabel(env: Environment, fallback: string): string {
  return env.name.trim() || fallback;
}

interface EnvironmentsState {
  environments: Environment[];
  /** Active environment id, or `null` before the first `load()` resolves. */
  activeId: string | null;
  /** True while `switchTo` is tearing down and rebuilding a session. Guards
   *  against re-entry and lets the switcher disable itself. */
  switching: boolean;
  error: string | null;

  load: () => Promise<void>;
  switchTo: (id: string) => Promise<void>;
  create: (name: string) => Promise<Environment | null>;
  update: (env: {
    id: string;
    name: string;
    color?: string | null;
    icon?: string | null;
  }) => Promise<void>;
  remove: (id: string) => Promise<void>;
  reorder: (ids: string[]) => Promise<void>;
  /**
   * Bring the active environment's session up: reconnect what was live, restore
   * the pane layout, restore focus. Shared by the launch flow in `App.tsx` and
   * by `switchTo`, because "entering an environment" is the same operation in
   * both cases and the ordering below is too easy to get subtly wrong twice.
   */
  restoreSession: () => Promise<void>;
}

/** True only in the main window — the sole owner of `tab_state.json`. */
function isMainWindow(): boolean {
  return getCurrentWindow().label === "main";
}

export const useEnvironments = create<EnvironmentsState>((set, get) => ({
  environments: [],
  activeId: null,
  switching: false,
  error: null,

  load: async () => {
    try {
      const { environments, activeEnvironmentId } = await api.listEnvironments();
      set({
        environments,
        activeId: activeEnvironmentId || null,
        error: null,
      });
    } catch (e) {
      set({ error: String(e) });
    }
  },

  restoreSession: async () => {
    // Gated on the same preference as the launch restore: with reconnect off
    // there is nothing to bring up, and the layout deliberately rides along with
    // the reconnect (see `hydrateWorkspaceLayout`).
    if (!usePreferences.getState().prefs.ui.reconnectOnLaunch) return;

    let launch;
    try {
      launch = await api.getLaunchState();
    } catch (e) {
      console.error("[environments] failed to read launch state", e);
      return;
    }

    if (launch.activeConnections.length > 0) {
      // Only reconnect ids that still have a profile, and skip anything already
      // live (a racing CLI intent, or a connection shared with the environment
      // we came from) so we never double-connect.
      await useConnections.getState().refresh();
      const { profiles, active } = useConnections.getState();
      const toConnect = launch.activeConnections.filter(
        (id) => profiles.some((p) => p.id === id) && !active.has(id),
      );
      // `connect()` awaits `hydrateTabState`, so once these settle every
      // reconnected connection's tabs are in `useTabs`. Failures are per
      // connection and never block the rest.
      await Promise.allSettled(
        toConnect.map((id) =>
          useConnections
            .getState()
            .connect(id)
            .catch((e) => {
              console.warn(`[environments] reconnect failed for ${id}`, e);
            }),
        ),
      );
    }

    // Layout AFTER the tabs exist. `fromJSON` rebuilds the panels, but the
    // TabbedArea reconciler removes any panel whose tab isn't in `useTabs` — run
    // this against an empty tab store and it deletes what it just built
    // (gotcha #10).
    if (useTabs.getState().tabs.length > 0) {
      await hydrateWorkspaceLayout();
    }

    // Focus last: `connect()` never sets `selectedConnectionId` itself, and the
    // App auto-select effect picks whichever pool opened first — which is
    // nondeterministic under a parallel reconnect.
    const nowActive = useConnections.getState().active;
    if (launch.selectedConnectionId && nowActive.has(launch.selectedConnectionId)) {
      useUi.getState().setSelectedConnectionId(launch.selectedConnectionId);
    }
    if (
      launch.activeTabId &&
      useTabs.getState().tabs.some((t) => t.id === launch.activeTabId)
    ) {
      useTabs.getState().setActive(launch.activeTabId);
    }
  },

  switchTo: async (id) => {
    if (!isMainWindow()) return;
    if (get().switching || get().activeId === id) return;
    set({ switching: true, error: null });
    try {
      // 1. Flush the outgoing environment's tabs and pane geometry while the
      //    backend still points at it. Everything below writes to whichever
      //    environment is active, so this has to happen before step 4.
      const leaving = Array.from(useConnections.getState().active);
      await flushAllTabState();

      // 2. Tear down the live pools. `disconnect()` closes each connection's
      //    tabs and drops its schema cache, which is what leaves a clean slate
      //    for the incoming environment to hydrate into.
      for (const connectionId of leaving) {
        try {
          await useConnections.getState().disconnect(connectionId);
        } catch (e) {
          console.warn(`[environments] disconnect failed for ${connectionId}`, e);
        }
      }

      // 3. Re-record what was live, using the set captured *before* the
      //    teardown. Each `disconnect()` persists the launch state as it goes,
      //    so by now the outgoing environment thinks nothing was open — coming
      //    back to it would restore an empty session. This last write wins.
      await api.saveLaunchState({
        activeConnections: leaving,
        selectedConnectionId: useUi.getState().selectedConnectionId,
        activeTabId: useTabs.getState().activeId,
      });

      // 4. Hand the backend over to the incoming environment.
      await api.setActiveEnvironment(id);
      set({ activeId: id });

      // 5. Clear whatever survived the teardown (tabs belonging to a connection
      //    that failed to disconnect cleanly) so the incoming session starts
      //    from an empty store rather than inheriting strays.
      useTabs.getState().replaceAll([], null);
      useUi.getState().setSelectedConnectionId(null);

      // 6. Bring the incoming environment up, same sequence as launch.
      await get().restoreSession();
    } catch (e) {
      set({ error: String(e) });
      console.error("[environments] switch failed", e);
    } finally {
      set({ switching: false });
    }
  },

  create: async (name) => {
    try {
      const env = await api.saveEnvironment({ name });
      await get().load();
      return env;
    } catch (e) {
      set({ error: String(e) });
      return null;
    }
  },

  update: async (env) => {
    try {
      await api.saveEnvironment(env);
      await get().load();
    } catch (e) {
      set({ error: String(e) });
    }
  },

  remove: async (id) => {
    try {
      // Deleting the active environment moves the backend's pointer to a
      // survivor, so the session on screen no longer belongs to the environment
      // it came from. Switch away first and let `switchTo` do the ordered
      // teardown, rather than leaving live pools attached to a deleted set.
      if (get().activeId === id) {
        const fallback = get().environments.find((e) => e.id !== id);
        if (fallback) await get().switchTo(fallback.id);
      }
      await api.deleteEnvironment(id);
      await get().load();
    } catch (e) {
      set({ error: String(e) });
    }
  },

  reorder: async (ids) => {
    // Optimistic: the switcher reorders under the pointer and a failed write
    // would otherwise show as a snap-back with no explanation.
    set((s) => ({
      environments: ids
        .map((id) => s.environments.find((e) => e.id === id))
        .filter((e): e is Environment => !!e)
        .map((e, i) => ({ ...e, order: i })),
    }));
    try {
      await api.reorderEnvironments(ids);
    } catch (e) {
      set({ error: String(e) });
      await get().load();
    }
  },
}));
