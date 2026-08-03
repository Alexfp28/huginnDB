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
  resumeSaves,
  suspendSaves,
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

/** What a newly created environment copies from the one being left. */
export interface ReplicateOptions {
  /** Reopen the same connections, each with the tabs it had. */
  connections: boolean;
  /** Reuse the split/float pane geometry. */
  layout: boolean;
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
  create: (env: {
    name: string;
    color?: string | null;
    icon?: string | null;
  }) => Promise<Environment | null>;
  /**
   * Create an environment, enter it, and optionally seed it from the one being
   * left — the connections that were open (with their tabs) and/or the pane
   * geometry.
   */
  createAndEnter: (
    env: { name: string; color?: string | null; icon?: string | null },
    replicate: ReplicateOptions,
  ) => Promise<void>;
  /** Last replicate choice, so the dialog reopens the way it was left. */
  lastReplicate: ReplicateOptions;
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

    // Folds first, before anything reconnects: set afterwards, a row the user had
    // folded would render open for as long as the reconnect takes and then snap
    // shut.
    useUi.getState().setCollapsedConnections(launch.collapsedConnections ?? []);
    // Same reasoning for the connection-visibility filter: restore it before the
    // tree renders the reconnected connections, not after — and unconditionally,
    // since `null` (show all) is itself meaningful and must overwrite whatever
    // the previous environment left behind.
    useUi.getState().setVisibleConnections(launch.visibleConnections ?? null);

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

    // Applied unconditionally, not gated on "are there tabs yet" — a saved
    // split can belong entirely to a multi-DB database-view child, which
    // isn't restored by the reconnect loop above at all (it comes back later,
    // asynchronously, via `SchemaExplorer`'s own auto-re-expand effect). Gating
    // this on `useTabs.getState().tabs.length > 0` used to skip the whole
    // restore in exactly that case — see `hydrateWorkspaceLayout`'s doc
    // comment for the full story and how it now handles a panel whose tab
    // hasn't shown up yet.
    await hydrateWorkspaceLayout();

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
      // Capture everything the outgoing environment needs remembered *before*
      // anything is torn down. All three are gone by the time we could ask
      // again: the teardown empties `active`, and step 2 deliberately clears
      // focus and tabs.
      const leaving = Array.from(useConnections.getState().active);
      const leavingSelected = useUi.getState().selectedConnectionId;
      const leavingActiveTab = useTabs.getState().activeId;
      const leavingCollapsed = useUi.getState().collapsedConnections;
      const leavingVisible = useUi.getState().visibleConnections;
      await flushAllTabState();

      // From here until `restoreSession` finishes rebuilding the incoming
      // session, block every debounced tab/layout save outright rather than
      // just cancelling whatever happens to be armed at a couple of check
      // points. The outgoing environment's real state is already on disk
      // (the flush above); anything that wakes a `useTabs`/`useSchema`
      // subscription between here and the resume is teardown/rebuild noise —
      // most notably `disconnect()` below, whose `markDisconnected` can wake
      // a *different*, still-subscribed connection's listener mid-loop, well
      // after any single `cancelPendingSaves()` call. A timer armed there
      // fires ~600ms later against whichever environment is active by
      // then — the incoming one — and overwrites its real tabs with a
      // snapshot of the transiently-emptied store (see `suspendSaves`'s own
      // comment for the full history; this is the same regression `2299f40`
      // fixed once, via a path that fix didn't close).
      suspendSaves();

      // 2. Unpoint the UI *before* closing anything. The schema explorer
      //    refreshes for whatever `selectedConnectionId` holds, so leaving it
      //    aimed at a connection while its pool is being dropped races a
      //    `list_tables` against the teardown: the call loses, the slice records
      //    `not connected: <id>`, and because the reconnect below never
      //    invalidates that slice the stale error stays on screen over a
      //    connection that is now perfectly healthy. Clearing focus and tabs
      //    first removes the race instead of papering over its result.
      useUi.getState().setSelectedConnectionId(null);
      useTabs.getState().replaceAll([], null);
      // Clear the folds here, not in `restoreSession`: with `reconnectOnLaunch`
      // off that function returns before it reads anything, and the outgoing
      // environment's folds would carry over into the incoming one.
      useUi.getState().setCollapsedConnections([]);
      // Same reasoning for the connection-visibility filter — this is the bug the
      // move to per-environment state fixes: leaving it set here is exactly
      // how a subset tuned for the outgoing environment used to stay active
      // after switching to another one.
      useUi.getState().setVisibleConnections(null);

      // Emptying the tab store above wakes the per-connection subscriptions,
      // but `suspendSaves()` already turned `scheduleSave` into a no-op, so
      // nothing gets armed. (No `cancelPendingSaves()` needed here anymore —
      // there's nothing to cancel.)

      // 3. Tear down the live pools. `disconnect()` closes each connection's
      //    tabs and drops its schema cache, which is what leaves a clean slate
      //    for the incoming environment to hydrate into.
      for (const connectionId of leaving) {
        try {
          await useConnections.getState().disconnect(connectionId);
        } catch (e) {
          console.warn(`[environments] disconnect failed for ${connectionId}`, e);
        }
      }

      // 4. Re-record what was live, from the values captured at the top. Each
      //    `disconnect()` persists the launch state as it goes, so by now the
      //    outgoing environment thinks nothing was open — coming back to it
      //    would restore an empty session. This last write wins.
      await api.saveLaunchState({
        activeConnections: leaving,
        selectedConnectionId: leavingSelected,
        activeTabId: leavingActiveTab,
        collapsedConnections: leavingCollapsed,
        visibleConnections: leavingVisible,
      });

      // 5. Hand the backend over to the incoming environment.
      await api.setActiveEnvironment(id);
      set({ activeId: id });

      // 6. Bring the incoming environment up, same sequence as launch.
      await get().restoreSession();
    } catch (e) {
      set({ error: String(e) });
      console.error("[environments] switch failed", e);
    } finally {
      // Re-arm debounced saving unconditionally — even on a failed switch,
      // whatever session is on screen afterwards (outgoing or a half-built
      // incoming one) needs its edits to start persisting again.
      resumeSaves();
      set({ switching: false });
    }
  },

  lastReplicate: { connections: true, layout: true },

  createAndEnter: async (env, replicate) => {
    set({ lastReplicate: replicate });
    // Capture the outgoing session BEFORE anything changes. Every session-state
    // command resolves against the *active* environment, so once we switch, the
    // source is no longer reachable — there is no "read environment X's tabs"
    // call, by design (see the command surface in commands/prefs.rs).
    const sourceIds = replicate.connections
      ? Array.from(useConnections.getState().active)
      : [];
    const sourceSelected = useUi.getState().selectedConnectionId;
    // Folds ride with the connections: replicating the distribution and then
    // unfolding everything would not be the distribution the user asked to copy.
    const sourceCollapsed = replicate.connections
      ? useUi.getState().collapsedConnections
      : [];
    // Same reasoning for the connection-visibility filter: it's part of "which
    // connections are in play", so it rides with `replicate.connections` too —
    // not replicating connections into a fresh environment but keeping the old
    // filter would just hide the ones that got copied in.
    const sourceVisible = replicate.connections
      ? useUi.getState().visibleConnections
      : null;
    let sourceTabs: [string, Awaited<ReturnType<typeof api.getTabState>>][] = [];
    let sourceLayout: unknown = null;
    try {
      if (replicate.connections) {
        sourceTabs = await Promise.all(
          sourceIds.map(
            async (id) =>
              [id, await api.getTabState(id)] as [
                string,
                Awaited<ReturnType<typeof api.getTabState>>,
              ],
          ),
        );
      }
      if (replicate.layout) sourceLayout = await api.getWorkspaceLayout();
    } catch (e) {
      console.warn("[environments] could not read the source session", e);
    }

    const created = await get().create(env);
    if (!created) return;

    // Entering first is not optional: the writes below land in whichever
    // environment is active, so they have to happen from inside the new one.
    // Its session is empty at this point, so this switch is cheap.
    await get().switchTo(created.id);
    if (get().activeId !== created.id) return; // switch failed; don't seed

    try {
      for (const [id, tabState] of sourceTabs) {
        if (tabState) await api.saveTabState(id, tabState);
      }
      if (replicate.layout) await api.saveWorkspaceLayout(sourceLayout);
      if (replicate.connections && sourceIds.length > 0) {
        await api.saveLaunchState({
          activeConnections: sourceIds,
          selectedConnectionId: sourceSelected,
          activeTabId: null,
          collapsedConnections: sourceCollapsed,
          visibleConnections: sourceVisible,
        });
        // Now that the new environment has a launch state, bring it up for
        // real. `switchTo` above already ran `restoreSession` against what was
        // then an empty environment, so this is the pass that does the work.
        await get().restoreSession();
      }
    } catch (e) {
      set({ error: String(e) });
      console.error("[environments] seeding the new environment failed", e);
    }
  },

  create: async ({ name, color = null, icon = null }) => {
    try {
      const env = await api.saveEnvironment({ name, color, icon });
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
