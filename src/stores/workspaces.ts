/**
 * Workspace switcher state.
 *
 * A workspace bundles a name + presentation chrome + the per-connection
 * tabs you had open while it was active. Switching workspaces does NOT
 * close pools; it just swaps which tabs the UI is showing.
 *
 * The store is intentionally thin — every mutation round-trips through
 * the backend so the on-disk blob is authoritative. The in-memory list
 * is purely a cache the topbar reads.
 *
 * ### Switching flow
 *
 * 1. [[flushTabState]] every currently-open connection so the outgoing
 *    workspace's tabs land in `tab_state.json` before we change scope.
 * 2. Call [[api.setActiveWorkspace]] to flip the backend pointer.
 * 3. Clear `useTabs` for every currently-open connection (the incoming
 *    workspace likely has different tabs — or none).
 * 4. Re-hydrate each connection from the new workspace so its persisted
 *    tabs reappear. We do this in parallel; tab order is irrelevant.
 */

import { create } from "zustand";
import type { WorkspaceMeta } from "@/types";
import { api } from "@/lib/tauri";
import { useConnections } from "@/stores/connections";
import { useTabs } from "@/stores/tabs";
import { flushTabState, hydrateTabState } from "@/stores/persistedTabs";

interface WorkspacesState {
  /** Sorted by `order`. Empty until [[hydrate]] resolves. */
  workspaces: WorkspaceMeta[];
  activeId: string | null;
  /** True once the first [[hydrate]] has resolved (success or fallback). */
  loaded: boolean;

  /** Initial fetch — call once on app mount. Idempotent. */
  hydrate: () => Promise<void>;
  /** Pull the latest list (e.g. after a mutation in another window). */
  refresh: () => Promise<void>;

  /** Create + select the new workspace. */
  create: (
    name: string,
    color?: string | null,
    icon?: string | null,
  ) => Promise<WorkspaceMeta>;

  rename: (id: string, name: string) => Promise<void>;
  updateAppearance: (
    id: string,
    color: string | null,
    icon: string | null,
  ) => Promise<void>;
  /** Delete a workspace. Throws if it is the only one (matches backend). */
  delete: (id: string) => Promise<void>;
  /** Apply a new ordering. First id ⇒ order 0, second ⇒ 1, … */
  reorder: (ids: string[]) => Promise<void>;
  /** Switch the active workspace and reload tabs for every open pool. */
  switchTo: (id: string) => Promise<void>;
}

/**
 * Reload tab state for every connection that has an open pool. Called
 * after the active workspace changes — the new workspace's persisted
 * tabs replace whatever was on screen.
 */
async function rehydrateAllConnections(): Promise<void> {
  const active = Array.from(useConnections.getState().active);
  // Strip the previous workspace's tabs first so the user doesn't see
  // a flash of the old layout while hydrate awaits.
  const tabs = useTabs.getState();
  const carryover = tabs.tabs.filter((t) => !active.includes(t.connectionId));
  tabs.replaceAll(carryover, carryover[carryover.length - 1]?.id ?? null);
  // Hydrate in parallel — each connection's persisted state is
  // independent and a slow one shouldn't block the others.
  await Promise.allSettled(active.map((id) => hydrateTabState(id)));
}

export const useWorkspaces = create<WorkspacesState>((set, get) => ({
  workspaces: [],
  activeId: null,
  loaded: false,

  async hydrate() {
    if (get().loaded) return;
    try {
      const [workspaces, activeId] = await Promise.all([
        api.listWorkspaces(),
        api.getActiveWorkspaceId(),
      ]);
      set({
        workspaces,
        activeId: activeId ?? workspaces[0]?.id ?? null,
        loaded: true,
      });
    } catch (err) {
      console.error("[workspaces] hydrate failed:", err);
      // Mark loaded anyway so the UI renders an (empty) switcher
      // instead of hanging on a spinner forever.
      set({ loaded: true });
    }
  },

  async refresh() {
    try {
      const [workspaces, activeId] = await Promise.all([
        api.listWorkspaces(),
        api.getActiveWorkspaceId(),
      ]);
      set({
        workspaces,
        activeId: activeId ?? workspaces[0]?.id ?? null,
      });
    } catch (err) {
      console.error("[workspaces] refresh failed:", err);
    }
  },

  async create(name, color, icon) {
    const meta = await api.createWorkspace(name, color ?? null, icon ?? null);
    set((s) => ({ workspaces: [...s.workspaces, meta] }));
    // New workspaces don't auto-focus — the user clicks to switch if
    // they want to start working in the new one.
    return meta;
  },

  async rename(id, name) {
    await api.renameWorkspace(id, name);
    set((s) => ({
      workspaces: s.workspaces.map((w) => (w.id === id ? { ...w, name } : w)),
    }));
  },

  async updateAppearance(id, color, icon) {
    await api.updateWorkspaceAppearance(id, color, icon);
    set((s) => ({
      workspaces: s.workspaces.map((w) =>
        w.id === id ? { ...w, color, icon } : w,
      ),
    }));
  },

  async delete(id) {
    await api.deleteWorkspace(id);
    // If we just deleted the active workspace, refresh from the
    // backend so we pick up whichever workspace is now active.
    const wasActive = get().activeId === id;
    set((s) => ({
      workspaces: s.workspaces.filter((w) => w.id !== id),
    }));
    if (wasActive) {
      await get().refresh();
      await rehydrateAllConnections();
    }
  },

  async reorder(ids) {
    await api.reorderWorkspaces(ids);
    set((s) => {
      // Apply the new ordering locally so we don't have to round-trip
      // listWorkspaces. The first id in `ids` becomes order=0, etc.
      const orderById = new Map(ids.map((id, idx) => [id, idx]));
      const next = s.workspaces.map((w) => ({
        ...w,
        order: orderById.get(w.id) ?? w.order,
      }));
      next.sort((a, b) => a.order - b.order);
      return { workspaces: next };
    });
  },

  async switchTo(id) {
    if (get().activeId === id) return;
    // Flush every open connection BEFORE flipping the active pointer
    // so the outgoing workspace gets its final snapshot. We don't
    // await failures here — a flush problem shouldn't block the user
    // from switching workspaces.
    const active = Array.from(useConnections.getState().active);
    await Promise.allSettled(active.map((cid) => flushTabState(cid)));
    await api.setActiveWorkspace(id);
    set({ activeId: id });
    await rehydrateAllConnections();
  },
}));
