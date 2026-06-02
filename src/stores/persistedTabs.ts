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
 */

import type { ConnectionTabState, PersistedTab, AppTab } from "@/types";
import { api } from "@/lib/tauri";
import { useTabs } from "@/stores/tabs";
import { useSchema } from "@/stores/schema";
import { usePreferences } from "@/stores/preferences";
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
    // Structure-editor tabs are ephemeral working sessions (a half-built
    // "new table", or an in-progress edit) — don't persist them across
    // restarts.
    .filter((t) => t.kind !== "structure")
    .map((t) => ({
      id: t.id,
      kind: t.kind,
      schema: t.schema ?? null,
      table: t.table ?? null,
      query: t.query ?? null,
      title: t.title ?? null,
    }));
  const activeId = tabs.find((t) => t.id === tabsState.activeId)?.id ?? null;
  const expandedSchemaNodes = schemaSlice
    ? Array.from(schemaSlice.expanded)
    : [];

  // Capture the inner dockview geometry only when the user has actually
  // split or floated panels (more than one group). For the common single
  // tabbed group we leave `internalLayout` undefined so the snapshot stays
  // lean and the default tabbed restore path is used. The blob is geometry
  // only (group tree + sizes + panel ids/params), a few KB — no panel
  // content is duplicated.
  const innerApi = getInnerDockviewApi();
  const internalLayout =
    innerApi && innerApi.groups.length > 1
      ? (innerApi.toJSON() as unknown)
      : undefined;

  return {
    tabs,
    activeTabId: activeId,
    expandedSchemaNodes,
    lastOpened: Math.floor(Date.now() / 1000),
    internalLayout,
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

/**
 * Rehydrate persisted tabs + expansion for `connectionId`. Returns
 * silently when the preference toggle is off, when there is no persisted
 * state, or when the call fails — never blocks the connect flow.
 */
export async function hydrateTabState(connectionId: string): Promise<void> {
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
        title: p.title ?? p.table ?? (p.kind === "query" ? "Query" : "Table"),
        schema: p.schema ?? undefined,
        table: p.table ?? undefined,
        query: p.query ?? undefined,
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
      // Hand the saved split/float geometry to the inner dockview. If it is
      // already mounted (e.g. switching workspace without remounting
      // TabbedArea), apply it directly after the store update; otherwise
      // stash it for `TabbedArea.onReady` to consume once it mounts. Either
      // way `fromJSON` is the authoritative panel+geometry rebuild and the
      // TabbedArea reconciler converges any divergence (orphans removed,
      // missing tabs added tabbed).
      const layout = state.internalLayout ?? null;
      setPendingInternalLayout(layout);

      tabsStore.replaceAll(nextTabs, nextActive);

      useSchema
        .getState()
        .replaceExpanded(connectionId, new Set(state.expandedSchemaNodes));

      if (layout) {
        const innerApi = getInnerDockviewApi();
        if (innerApi) {
          // Already mounted — consume the pending blob ourselves so onReady
          // (which won't fire again) doesn't leave it dangling.
          setPendingInternalLayout(null);
          try {
            innerApi.fromJSON(
              layout as Parameters<typeof innerApi.fromJSON>[0],
            );
          } catch (err) {
            console.warn(
              `[persistedTabs] inner layout restore failed for ${connectionId}:`,
              err,
            );
          }
        }
      }
    }
  } catch (err) {
    console.error(`[persistedTabs] hydrate failed for ${connectionId}:`, err);
  } finally {
    attachSubscriptions(connectionId);
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
