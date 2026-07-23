/**
 * Bridges the in-memory `useTabs` + `useSchema.expanded` stores with the
 * on-disk `tab_state.json` so a user's workspace (open tabs, the active
 * tab, expanded schema tree nodes) survives across app restarts on a
 * per-connection basis.
 *
 * Flow:
 *
 *   • On `connect(id)` →
 *       `hydrate(id)` reads the persisted blob (if any), respects the
 *       `restoreTabsOnOpen` UI preference, and replaces `useTabs` /
 *       `useSchema.expanded` for that connection atomically.
 *
 *   • While the connection is open →
 *       a single Zustand subscription on `useTabs` (filtered to the
 *       active connection's tabs) and on `useSchema.byConnection[id]`
 *       debounce-flushes the snapshot to disk 600ms after the last
 *       change.
 *
 *   • On `disconnect(id)` →
 *       `flush(id)` cancels the debounce and writes the latest snapshot
 *       synchronously, then detaches the subscriptions. We deliberately
 *       do NOT clear `useTabs` here — `useConnections.disconnect` calls
 *       `useTabs.closeForConnection` afterwards as before.
 *
 * One snapshot at a time is kept per connection. If the user connects,
 * disconnects, and reconnects in quick succession, we re-hydrate from
 * disk on the second connect — staleness between in-memory and disk
 * is bounded by the debounce window.
 *
 *   • On window close (main window only) →
 *       `flushAllTabState()` (wired from `App.tsx`'s `onCloseRequested`
 *       handler) synchronously saves every still-active connection plus the
 *       session-level workspace layout, bypassing the debounce. Before this
 *       existed, only an explicit `disconnect()` ever flushed synchronously —
 *       a normal window close (let alone a crash) could lose up to
 *       `SAVE_DEBOUNCE_MS` of trailing tab/layout edits.
 *
 * The inner-dockview split/float geometry is NOT per connection: one inner
 * dockview hosts every open connection's tabs, so its geometry is a
 * session-level artifact persisted once (top-level `workspaceLayout` in
 * `tab_state.json`) via `scheduleSaveActive` → `saveWorkspaceLayoutNow`, and
 * restored once at launch via `hydrateWorkspaceLayout`. It used to be
 * duplicated under every connection, which made restore order-dependent.
 */

import type { ConnectionTabState, PersistedTab, AppTab } from "@/types";
import { api } from "@/lib/tauri";
import i18n from "@/lib/i18n";
import { useTabs } from "@/stores/tabs";
import { useSchema } from "@/stores/schema";
import { usePreferences } from "@/stores/preferences";
import { getCurrentWindow } from "@tauri-apps/api/window";
import {
  getInnerDockviewApi,
  setPendingInternalLayout,
} from "@/lib/dockview";

const SAVE_DEBOUNCE_MS = 600;

interface ActiveSubscription {
  timer: ReturnType<typeof setTimeout> | null;
  unsubTabs: () => void;
  unsubSchema: () => void;
}

const active = new Map<string, ActiveSubscription>();

function snapshotFor(connectionId: string): ConnectionTabState {
  const tabsState = useTabs.getState();
  const schemaSlice = useSchema.getState().byConnection[connectionId];
  const tabs: PersistedTab[] = tabsState.tabs
    .filter((t) => t.connectionId === connectionId)
    // Structure-editor and view-editor tabs are ephemeral working sessions
    // (a half-built "new table"/"new view", or an in-progress edit) — don't
    // persist them across restarts.
    .filter((t) => t.kind !== "structure" && t.kind !== "view")
    .map((t) => ({
      id: t.id,
      kind: t.kind,
      schema: t.schema ?? null,
      table: t.table ?? null,
      query: t.query ?? null,
      title: t.title ?? null,
      color: t.color ?? null,
      pinned: t.pinned ?? null,
    }));
  const activeId = tabs.find((t) => t.id === tabsState.activeId)?.id ?? null;
  const expandedSchemaNodes = schemaSlice
    ? Array.from(schemaSlice.expanded)
    : [];

  // Note: the inner-dockview geometry is NOT captured here anymore. It is a
  // session-level artifact (one shared inner dockview hosts every
  // connection's tabs), so it is persisted once via `saveWorkspaceLayoutNow`
  // into the top-level `workspaceLayout`, not duplicated under each
  // connection — see the module header and `saveWorkspaceLayoutNow`.
  return {
    tabs,
    activeTabId: activeId,
    expandedSchemaNodes,
    lastOpened: Math.floor(Date.now() / 1000),
  };
}

function scheduleSave(connectionId: string) {
  const entry = active.get(connectionId);
  if (!entry) return;
  if (entry.timer) clearTimeout(entry.timer);
  entry.timer = setTimeout(() => {
    entry.timer = null;
    void api
      .saveTabState(connectionId, snapshotFor(connectionId))
      .catch((err) => {
        console.error(`[persistedTabs] save failed for ${connectionId}:`, err);
      });
  }, SAVE_DEBOUNCE_MS);
}

/** True only in the main window — the sole owner of `tab_state.json`
 *  (gotcha #8). Secondary "New window" instances are ephemeral. */
function isMainWindow(): boolean {
  return getCurrentWindow().label === "main";
}

// --- Session-level workspace layout -----------------------------------------
// The inner dockview's split/float geometry is shared across every open
// connection (one inner dockview hosts them all), so it is persisted once at
// the top level of `tab_state.json` rather than duplicated per connection.

let layoutSaveTimer: ReturnType<typeof setTimeout> | null = null;

/** Capture the current inner-dockview geometry and write it to disk now.
 *  Writes `null` (default tabbed layout) unless the user has actually split
 *  or floated panels (>1 group) — keeping the blob lean and the common case
 *  on the fast default-restore path. Main-window-only and best-effort. */
async function saveWorkspaceLayoutNow(): Promise<void> {
  if (!isMainWindow()) return;
  const innerApi = getInnerDockviewApi();
  const layout =
    innerApi && innerApi.groups.length > 1
      ? (innerApi.toJSON() as unknown)
      : null;
  try {
    await api.saveWorkspaceLayout(layout);
  } catch (err) {
    console.error("[persistedTabs] workspace layout save failed:", err);
  }
}

/**
 * Debounced save of the session-level inner-dockview geometry. Wired to the
 * inner dockview's `onDidLayoutChange` (a pure split/float/resize gesture
 * touches no tab or schema state, so nothing else would schedule a save for
 * it) — see `TabbedArea.tsx`. Named `scheduleSaveActive` for historical
 * reasons; it now saves one session-level blob, not one per connection.
 */
export function scheduleSaveActive() {
  if (!isMainWindow()) return;
  if (layoutSaveTimer) clearTimeout(layoutSaveTimer);
  layoutSaveTimer = setTimeout(() => {
    layoutSaveTimer = null;
    void saveWorkspaceLayoutNow();
  }, SAVE_DEBOUNCE_MS);
}

/** Persist the set of connections currently live in this (main) window, so
 *  the next launch can auto-reconnect them. Best-effort; fire-and-forget. */
export function persistActiveConnections(ids: string[]): void {
  if (!isMainWindow()) return;
  void api.saveActiveConnections(ids).catch((err) => {
    console.error("[persistedTabs] active-connections save failed:", err);
  });
}

/**
 * Rehydrate persisted tabs + expansion for `connectionId`. Returns
 * silently when the preference toggle is off, when there is no persisted
 * state, or when the call fails — never blocks the connect flow.
 */
export async function hydrateTabState(connectionId: string): Promise<void> {
  // Only the main window persists tab state — secondary windows (opened via
  // "New window") are intentionally ephemeral, so they never hydrate from or
  // save to `tab_state.json` (see `commands::prefs::get_tab_state`). Without
  // this guard a secondary window would silently overwrite the main
  // window's persisted snapshot the moment it opened a connection.
  if (getCurrentWindow().label !== "main") return;

  const restore = usePreferences.getState().prefs.ui.restoreTabsOnOpen;
  if (!restore) {
    // Skip both restore *and* save: with the preference off, we leave the
    // previously persisted workspace alone on disk so flipping the toggle
    // back on later still produces a useful restore. Attaching the
    // subscription here would silently overwrite the saved snapshot with
    // whatever the user happens to open in this session.
    return;
  }
  try {
    const state = await api.getTabState(connectionId);
    if (state) {
      const restored: AppTab[] = state.tabs.map((p) => ({
        id: p.id,
        kind: p.kind,
        connectionId,
        // Persisted state never carries a generated title for table tabs
        // (it can be derived from the table name on demand); we fall back
        // to the table name or "Query" so the tab bar always has a label.
        title:
          p.title ??
          p.table ??
          (p.kind === "query"
            ? i18n.t("tabs.queryFileName")
            : i18n.t("tabs.tableFallback")),
        schema: p.schema ?? undefined,
        table: p.table ?? undefined,
        query: p.query ?? undefined,
        color: p.color ?? undefined,
        pinned: p.pinned ?? undefined,
      }));

      // Merge: keep tabs from other connections, drop the previous set
      // for this one, append the restored ones. Avoids clobbering a
      // workspace the user already has open against a different DB.
      const tabsStore = useTabs.getState();
      const carryover = tabsStore.tabs.filter(
        (t) => t.connectionId !== connectionId,
      );
      const nextTabs = [...carryover, ...restored];
      const nextActive =
        state.activeTabId &&
        restored.some((t) => t.id === state.activeTabId)
          ? state.activeTabId
          : (restored[restored.length - 1]?.id ?? tabsStore.activeId);

      // The inner-dockview geometry is no longer restored here — it is
      // session-level, applied once via `hydrateWorkspaceLayout` (called from
      // the launch flow), not per connection. The TabbedArea reconciler adds
      // this connection's tabs into whatever geometry is already in place.
      tabsStore.replaceAll(nextTabs, nextActive);

      useSchema
        .getState()
        .replaceExpanded(connectionId, new Set(state.expandedSchemaNodes));
    }
  } catch (err) {
    console.error(`[persistedTabs] hydrate failed for ${connectionId}:`, err);
  } finally {
    attachSubscriptions(connectionId);
  }
}

/**
 * Restore the session-level inner-dockview geometry once at launch. Reads the
 * top-level `workspaceLayout` blob and hands it to the inner dockview: if it
 * is already mounted, apply `fromJSON` directly; otherwise stash it for
 * `TabbedArea.onReady` to consume when it mounts. `fromJSON` is the
 * authoritative panel+geometry rebuild (gotcha #10); the TabbedArea
 * reconciler then converges as each connection hydrates its tabs (orphan
 * panels removed, any missing tab added tabbed). Main-window-only and gated
 * on `restoreTabsOnOpen`, matching `hydrateTabState`.
 */
export async function hydrateWorkspaceLayout(): Promise<void> {
  if (!isMainWindow()) return;
  if (!usePreferences.getState().prefs.ui.restoreTabsOnOpen) return;
  try {
    const layout = (await api.getWorkspaceLayout()) ?? null;
    if (!layout) return;
    setPendingInternalLayout(layout);
    const innerApi = getInnerDockviewApi();
    if (innerApi) {
      // Already mounted — consume the pending blob ourselves so onReady
      // (which won't fire again) doesn't leave it dangling.
      setPendingInternalLayout(null);
      try {
        innerApi.fromJSON(layout as Parameters<typeof innerApi.fromJSON>[0]);
      } catch (err) {
        console.warn("[persistedTabs] workspace layout restore failed:", err);
      }
    }
  } catch (err) {
    console.error("[persistedTabs] workspace layout hydrate failed:", err);
  }
}

/**
 * Subscribe to tab and schema-expansion changes for `connectionId`. The
 * subscription is idempotent — calling twice for the same id is a no-op.
 */
function attachSubscriptions(connectionId: string) {
  if (active.has(connectionId)) return;

  const entry: ActiveSubscription = {
    timer: null,
    unsubTabs: () => {},
    unsubSchema: () => {},
  };

  // We watch the full tabs array; filtering happens inside `snapshotFor`.
  // Zustand's subscribe fires on every state change, which keeps the
  // wiring simple — the cost is one shallow comparison per tab edit.
  entry.unsubTabs = useTabs.subscribe(() => scheduleSave(connectionId));
  entry.unsubSchema = useSchema.subscribe((state, prev) => {
    if (state.byConnection[connectionId] !== prev.byConnection[connectionId]) {
      scheduleSave(connectionId);
    }
  });

  active.set(connectionId, entry);
}

/**
 * Flush the pending debounce (if any) and detach the per-connection
 * subscription. Called on disconnect; safe to call when nothing is
 * subscribed.
 */
export async function flushTabState(connectionId: string): Promise<void> {
  const entry = active.get(connectionId);
  if (!entry) return;
  if (entry.timer) {
    clearTimeout(entry.timer);
    entry.timer = null;
    try {
      await api.saveTabState(connectionId, snapshotFor(connectionId));
    } catch (err) {
      console.error(`[persistedTabs] flush failed for ${connectionId}:`, err);
    }
  }
  entry.unsubTabs();
  entry.unsubSchema();
  active.delete(connectionId);
}

/**
 * Save every currently-tracked connection's snapshot to disk right now,
 * unconditionally (unlike `flushTabState`, this does not require a pending
 * debounce timer — the window is closing, so whatever the current in-memory
 * state is must reach disk). Subscriptions are left attached; the window is
 * going away, not the connection.
 *
 * Saves run sequentially, not `Promise.all` — `save_tab_state` writes each
 * connection through a fixed `.json.tmp` path before renaming, and two
 * concurrent saves would race on that same temp file.
 */
export async function flushAllTabState(): Promise<void> {
  for (const connectionId of active.keys()) {
    const entry = active.get(connectionId);
    if (entry?.timer) {
      clearTimeout(entry.timer);
      entry.timer = null;
    }
    try {
      await api.saveTabState(connectionId, snapshotFor(connectionId));
    } catch (err) {
      console.error(`[persistedTabs] flush-all failed for ${connectionId}:`, err);
    }
  }
  // The session-level inner-dockview geometry is debounced separately
  // (`scheduleSaveActive`); cancel any pending timer and write it now so a
  // trailing split/resize gesture isn't lost on close.
  if (layoutSaveTimer) {
    clearTimeout(layoutSaveTimer);
    layoutSaveTimer = null;
  }
  await saveWorkspaceLayoutNow();
}
