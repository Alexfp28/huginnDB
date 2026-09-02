/**
 * Environments store — the top-level working set: which connections are in
 * play, and the session state (tabs, pane geometry, focus) that belongs to them.
 *
 * The backend scopes every session-state command
 * (`get/saveTabState`, `get/saveWorkspaceLayout`, `get/saveLaunchState`) to
 * whichever environment is active, so switching one is mostly a pointer move on
 * disk. The work — and the ordering risk — is all on this side.
 *
 * Writing to `tab_state.json` is main-window only (gotcha #8): `create`,
 * `update`, `remove`, `reorder` and the full `restoreSession`/`switchTo`
 * teardown-and-reconnect all touch it and only run there. A secondary "New
 * window" instance still reads the environment list (`load`, safe — it never
 * writes) and can `switchTo` locally: that branch never reaches the backend,
 * it only re-points this window's own `useUi` filters at the chosen
 * environment's `launch` snapshot (`applyLocalView`), so several windows can
 * each sit in a different environment at once without racing the shared file.
 *

 * Selector note (gotcha #1): components read `environments` / `activeId` /
 * `switchingTo` as raw values and derive anything else with `useMemo`. Never
 * return a fresh array or object from a selector here.
 */

import { useMemo } from "react";
import { create } from "zustand";
import { api } from "@/lib/tauri";
import { useConnections } from "@/stores/session/connections";
import { useTabs } from "@/stores/session/tabs";
import { useTreeSearch } from "@/stores/session/treeSearch";
import {
  applyLaunchView,
  clearLaunchView,
  currentLaunchView,
  emptyLaunchView,
  useUi,
} from "@/stores/session/ui";
import { usePreferences } from "@/stores/preferences/preferences";
import { useThemeStore } from "@/stores/preferences/theme";
import {
  flushAllTabState,
  hydrateWorkspaceLayout,
  resumeSaves,
  suspendSaves,
} from "@/stores/session/persistedTabs";
import { isMainWindow } from "@/lib/window";
import type { Environment } from "@/types";

/**
 * The environment list in the user's own order.
 *
 * A hook with a `useMemo`, never a derived selector: `[...environments].sort()`
 * inside a selector returns a fresh array on every store read, `Object.is` never
 * matches, and the component re-renders until React caps the update depth
 * (gotcha #1). The three consumers — the rail, the switcher and the empty-tab
 * picker — each had their own copy of exactly this memo.
 */
export function useOrderedEnvironments(): Environment[] {
  const environments = useEnvironments((s) => s.environments);
  return useMemo(
    () => [...environments].sort((a, b) => a.order - b.order),
    [environments],
  );
}

/**
 * Display name for an environment. `localName` (this machine's own override,
 * never touched by `sync_origin`) wins over the synced `name` when set; an
 * empty resolved name means the user never named it — the backend
 * deliberately refuses to write display copy, since a literal stored there
 * would freeze one language into the user's data (see the `name` field in
 * `src-tauri/src/tab_state.rs`). Callers pass the localised fallback.
 */
export function environmentLabel(env: Environment, fallback: string): string {
  return (env.localName ?? env.name).trim() || fallback;
}

/**
 * Effective colour/icon/theme for an environment — this machine's local
 * override if one is set, otherwise whatever the origin (or the user, for a
 * plain local environment) published. Every render site that shows an
 * environment's cosmetics goes through these three rather than reading
 * `env.color`/`env.icon`/`env.themeId` directly, or the local-override
 * feature is invisible everywhere but one.
 */
export function effectiveColor(env: Environment): string | null {
  return env.localColor ?? env.color;
}
export function effectiveIcon(env: Environment): string | null {
  return env.localIcon ?? env.icon;
}
export function effectiveThemeId(env: Environment): string | null {
  return env.localThemeId ?? env.themeId;
}

/**
 * Teams-style avatar initials: first letter of up to the first two words in
 * the label. "Producción" → "P", "Staging DB" → "SD", a single emoji/CJK
 * label still degrades to its first code point rather than throwing.
 */
export function environmentInitials(label: string): string {
  const words = label.trim().split(/\s+/).filter(Boolean).slice(0, 2);
  if (words.length === 0) return "?";
  return words.map((w) => w[0]!.toUpperCase()).join("");
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
  /**
   * The environment `switchTo` is currently moving *to*, or `null` when idle.
   * Guards against re-entry and lets the switcher disable itself.
   *
   * The target, not a boolean, and that is the whole point. `activeId` does not
   * move until step 5 of `switchTo` — after the outgoing session is flushed and
   * every one of its pools is torn down, which is the slow part. A `switching`
   * flag paired with `isActive` therefore parked the spinner on the environment
   * being *left* for the entire wait, so the one place in the UI that says
   * "work is happening" pointed at the wrong row. No amount of styling fixes
   * that: a boolean cannot say where you are going.
   *
   * Read it as a primitive (gotcha #1) and derive `switching` at the call site
   * with `!== null`; a selector returning a fresh object would re-render every
   * consumer on every store write.
   */
  switchingTo: string | null;
  error: string | null;

  load: () => Promise<void>;
  switchTo: (id: string) => Promise<void>;
  create: (env: {
    name: string;
    color?: string | null;
    icon?: string | null;
    themeId?: string | null;
  }) => Promise<Environment | null>;
  /**
   * Create an environment, enter it, and optionally seed it from the one being
   * left — the connections that were open (with their tabs) and/or the pane
   * geometry.
   */
  createAndEnter: (
    env: {
      name: string;
      color?: string | null;
      icon?: string | null;
      themeId?: string | null;
    },
    replicate: ReplicateOptions,
  ) => Promise<void>;
  /** Last replicate choice, so the dialog reopens the way it was left. */
  lastReplicate: ReplicateOptions;
  update: (env: {
    id: string;
    name: string;
    color?: string | null;
    icon?: string | null;
    themeId?: string | null;
  }) => Promise<void>;
  /** Set (or clear) this machine's local cosmetic override for a mirrored
   *  environment. See `setEnvironmentLocalOverrides` in `lib/tauri.ts` — the
   *  counterpart to `update` for the four `local*` fields, never the synced
   *  ones. */
  setLocalOverrides: (override: {
    id: string;
    localName?: string | null;
    localColor?: string | null;
    localIcon?: string | null;
    localThemeId?: string | null;
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

/**
 * Apply an environment's connection/database view filters to *this* window's
 * own `useUi` — nothing else. Used by secondary "New window" instances, which
 * never own `tab_state.json` (gotcha #8) and so can't run the pool/tab/layout
 * parts of `restoreSession`, only the "how does the tree look" part of it.
 * Each window has its own JS process and therefore its own `useUi` instance
 * (same free isolation `useConnections.active` already relies on), so this
 * never leaks into another window.
 */
function applyLocalView(env: Environment | undefined): void {
  applyLaunchView(env?.launch);
  // The tree's search is not one of the persisted view filters (it lives in
  // `useTreeSearch`, deliberately outside `LaunchView` — see that store's
  // header), but entering an environment is exactly when it stops making
  // sense: the needle was typed against another environment's connections,
  // and its scope may name one this environment does not even show.
  useTreeSearch.getState().clear();
}

export const useEnvironments = create<EnvironmentsState>((set, get) => ({
  environments: [],
  activeId: null,
  switchingTo: null,
  error: null,

  load: async () => {
    try {
      const { environments, activeEnvironmentId } =
        await api.listEnvironments();
      set({
        environments,
        activeId: activeEnvironmentId || null,
        error: null,
      });
      // Secondary windows never call `restoreSession` (main-window-only,
      // gotcha #8) and so never had their own view filters seeded — without
      // this a "New window" showed every saved connection from every
      // environment (the reported bug). Seed this window's local view from
      // whichever environment is active right now, with no pool/tab/layout
      // side effect — those stay main-only.
      if (!isMainWindow()) {
        applyLocalView(environments.find((e) => e.id === activeEnvironmentId));
      }
    } catch (e) {
      set({ error: String(e) });
    }
  },

  restoreSession: async () => {
    // Entering an environment drops the tree's search, for the same reason
    // `applyLocalView` does: the needle and its scope belong to the
    // environment they were typed in. Done here rather than in `switchTo` so
    // the launch path is covered too, and up front so no frame renders the
    // incoming connections through the outgoing environment's filter.
    useTreeSearch.getState().clear();

    // Apply the incoming environment's theme override (or clear it, for one
    // with none) before anything else — it's a pure visual affordance, not
    // gated on `reconnectOnLaunch` like the pool/tab restore below, and
    // whichever environment `activeId` names by now is the right one: `load()`
    // sets it before the launch effect calls this, and `switchTo` sets it
    // right before calling this too.
    const activeEnv = get().environments.find((e) => e.id === get().activeId);
    useThemeStore
      .getState()
      .setEnvironmentOverride(activeEnv ? effectiveThemeId(activeEnv) : null);

    let launch;
    try {
      launch = await api.getLaunchState();
    } catch (e) {
      console.error("[environments] failed to read launch state", e);
      // `switchTo` deliberately leaves the outgoing environment's view
      // filters in place through its own teardown (see its comment) and
      // relies on `applyLaunchView` below to replace them. This is the one
      // path that never reaches it, so it's the one place that has to clear
      // them itself — otherwise the outgoing filter would stay pointed at an
      // environment that isn't active anymore.
      clearLaunchView();
      return;
    }

    // The three view filters are restored *before* the `reconnectOnLaunch` gate
    // below, unlike everything else here. They describe how this environment
    // looks, not what it reopens: nothing about them depends on a pool being
    // live, and `persistLaunchState` writes them regardless of the preference —
    // so leaving them behind the gate meant that with reconnect off, entering
    // an environment showed the *previous* one's filters (or none at all after
    // a restart), which is the leak this whole per-environment scoping exists
    // to close. This unconditional call is also what lets `switchTo` leave the
    // outgoing environment's filter in place through its own teardown instead
    // of clearing it pre-emptively (see its comment): whatever's still applied
    // when we get here is replaced by the real thing regardless of
    // `reconnectOnLaunch`, so there's no window left where it could leak into
    // the environment being entered. Restoring them before the tree renders
    // the reconnected connections (rather than after) is `applyLaunchView`'s
    // own invariant, documented there.
    applyLaunchView(launch);

    // Everything from here down brings pools back up, and the layout
    // deliberately rides along with the reconnect (see `hydrateWorkspaceLayout`).
    if (!usePreferences.getState().prefs.ui.reconnectOnLaunch) return;

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
    if (
      launch.selectedConnectionId &&
      nowActive.has(launch.selectedConnectionId)
    ) {
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
    if (!isMainWindow()) {
      // Secondary windows never touch the shared backend pointer or its
      // pools/tabs/layout (gotcha #8) — picking a different environment here
      // only changes which one's connection/database filters *this* window
      // applies to its own connections tree, entirely in memory.
      if (get().switchingTo || get().activeId === id) return;
      const env = get().environments.find((e) => e.id === id);
      if (!env) return;
      set({ switchingTo: id });
      applyLocalView(env);
      set({ activeId: id, switchingTo: null });
      return;
    }
    if (get().switchingTo || get().activeId === id) return;
    set({ switchingTo: id, error: null });
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
      const leavingView = currentLaunchView();
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
      // Deliberately do NOT clear the three view filters here. They stay
      // pointed at the outgoing environment for the whole teardown below —
      // that's still a valid filter for what `ConnectionsTree`/`WorkspacePicker`
      // should show while that same environment's connections close one by
      // one, so leaving it in place is what keeps the tree looking like "this
      // environment's list, shrinking" instead of "every saved connection from
      // every environment" for however long a slow SSH tunnel takes to close.
      // `restoreSession` (step 6) applies the incoming environment's real
      // filter unconditionally, before its own `reconnectOnLaunch` gate — see
      // its comment — so there's no window left where the outgoing filter
      // could leak into the incoming environment on the happy path. The one
      // path where `restoreSession` never gets that far (its `getLaunchState`
      // call failing) clears to empty itself, right there, instead of
      // pre-emptively here.

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
          console.warn(
            `[environments] disconnect failed for ${connectionId}`,
            e,
          );
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
        ...leavingView,
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
      set({ switchingTo: null });
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
    // All three view filters ride with the connections: they are part of "which
    // connections are in play, and how they are meant to be seen", so
    // replicating the set and then unfolding everything (or dropping the
    // database subsets, reopening the same servers showing everything) would not
    // be the distribution the user asked to copy. Conversely, not replicating
    // connections but keeping the old filter would just hide the ones that got
    // copied in. The new environment owns the copy from that point on —
    // narrowing it there never touches the source, which is the point of the
    // override.
    const sourceView = replicate.connections
      ? currentLaunchView()
      : emptyLaunchView();
    let sourceTabs: [string, Awaited<ReturnType<typeof api.getTabState>>][] =
      [];
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
          ...sourceView,
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

  create: async ({ name, color = null, icon = null, themeId = null }) => {
    try {
      const env = await api.saveEnvironment({ name, color, icon, themeId });
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
      // Re-apply immediately if this was the active environment — otherwise a
      // theme change made from the edit dialog wouldn't show until the next
      // switch, and the dialog visually implies it takes effect on save.
      if (env.id === get().activeId) {
        useThemeStore.getState().setEnvironmentOverride(env.themeId ?? null);
      }
    } catch (e) {
      set({ error: String(e) });
    }
  },

  setLocalOverrides: async (override) => {
    try {
      const env = await api.setEnvironmentLocalOverrides(override);
      await get().load();
      if (env.id === get().activeId) {
        useThemeStore.getState().setEnvironmentOverride(effectiveThemeId(env));
      }
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
