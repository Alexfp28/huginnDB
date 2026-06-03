/**
 * Dockview helpers: layout persistence, panel registry, and runtime
 * actions exposed to UI surfaces (FileMenu, ViewMenu).
 *
 * Lives in `lib/` (rather than next to App.tsx) so that components like
 * the FileMenu and ViewMenu can trigger layout changes without creating
 * a circular import on the App module.
 */

import type { AddPanelOptions, DockviewApi, DockviewTheme } from "dockview-react";

/**
 * Custom dockview theme that defers all colours to the app's existing
 * CSS variables (`--background`, `--foreground`, `--border`, …) defined
 * in `src/index.css`. The `className` here must match the selector in
 * the bridge CSS block.
 *
 * `dndPanelOverlay: 'group'` makes the drag-over highlight cover the
 * full panel group (tabs + content) rather than just the content area,
 * so the drop target is easy to see. `dndOverlayMounting: 'absolute'`
 * positions the overlay against the dockview root, which behaves more
 * predictably when panels are nested inside split groups.
 */
export const huginnDockviewTheme: DockviewTheme = {
  name: "huginndb",
  className: "dockview-theme-huginndb",
  dndPanelOverlay: "group",
  dndOverlayMounting: "absolute",
  dndTabIndicator: "fill",
  dndOverlayBorder: "2px dashed hsl(var(--primary))",
  tabGroupIndicator: "none",
  // "Island" spacing for the outer shell: dockview inserts this gap (px)
  // between groups, and the rounded `.dv-groupview` corners (see index.css)
  // turn each panel into a floating card. The gap reveals the dock root
  // backdrop, which `.outer-dock` tints slightly so the panels read as
  // raised. The inner tab dockview opts out — see `huginnDockviewThemeInner`.
  gap: 8,
};

/**
 * Theme for the *inner* tab dockview (`TabbedArea`). Identical to the outer
 * theme — same `className`, so it shares every CSS variable — but with no
 * gap, so open table/query tabs stay flush. The user asked to keep the data
 * tables edge-to-edge; only the outer window distribution gets the island
 * treatment. `gap` is applied by dockview at runtime (not via the class),
 * so sharing the class name is safe.
 */
export const huginnDockviewThemeInner: DockviewTheme = {
  ...huginnDockviewTheme,
  gap: 0,
};

/** localStorage key for the persisted dockview layout JSON. */
export const LAYOUT_STORAGE_KEY = "huginndb.layout";

/**
 * Canonical set of panels the app ships with. Anything that needs to
 * iterate over "all known panels" (View → Panels checkboxes, default
 * layout, reset) reads from here so there's a single source of truth.
 */
export const PANELS = [
  { id: "schema", component: "schema", title: "Schema" },
  { id: "saved", component: "saved", title: "Saved" },
  { id: "workspace", component: "workspace", title: "Workspace" },
  { id: "console", component: "console", title: "Console" },
  { id: "side-editor", component: "side-editor", title: "Cell" },
] as const;

export type PanelId = (typeof PANELS)[number]["id"];

/**
 * Single dockview API handle for the running window. There is only ever
 * one DockviewReact mount inside the app shell, so a module-level
 * singleton is sufficient and avoids prop-drilling the API down to every
 * call site that wants to reset or reshape the layout.
 */
let dockviewApi: DockviewApi | null = null;

const apiReadyListeners = new Set<(api: DockviewApi) => void>();

/** Stash the API once the DockviewReact `onReady` callback fires.
 *  Listeners registered via `onDockviewApiReady` are invoked
 *  synchronously after assignment. */
export function registerDockviewApi(api: DockviewApi) {
  dockviewApi = api;
  for (const listener of apiReadyListeners) listener(api);
}

/** Read-only accessor for surfaces that want to subscribe to layout
 *  events directly (e.g. View menu refreshing its checkbox state). */
export function getDockviewApi(): DockviewApi | null {
  return dockviewApi;
}

/** Subscribe to API-ready. Invoked immediately if the API is already
 *  registered. Returns an unsubscribe function. */
export function onDockviewApiReady(
  listener: (api: DockviewApi) => void,
): () => void {
  if (dockviewApi) listener(dockviewApi);
  apiReadyListeners.add(listener);
  return () => {
    apiReadyListeners.delete(listener);
  };
}

// ---------------------------------------------------------------------------
// Inner (workspace) dockview — the nested DockviewReact inside the Workspace
// panel that hosts open table/query tabs. There is exactly one mounted at a
// time (the active workspace's), so a module-level singleton mirrors the outer
// one above. `persistedTabs.ts` reaches it through these helpers to capture
// (`toJSON`) and restore (`fromJSON`) the per-connection split/float geometry.
// ---------------------------------------------------------------------------

let innerDockviewApi: DockviewApi | null = null;

/**
 * Layout blob handed in by `hydrateTabState` before the inner dockview has
 * mounted. `TabbedArea.onReady` consumes it once the API exists, so hydrate
 * and mount can happen in either order without a race.
 */
let pendingInternalLayout: unknown | null = null;

export function registerInnerDockviewApi(api: DockviewApi) {
  innerDockviewApi = api;
}

export function getInnerDockviewApi(): DockviewApi | null {
  return innerDockviewApi;
}

/** Drop the singleton when the inner dockview unmounts so a stale handle
 *  from a previous workspace can't be captured/restored against. */
export function clearInnerDockviewApi(api: DockviewApi) {
  if (innerDockviewApi === api) innerDockviewApi = null;
}

export function setPendingInternalLayout(layout: unknown | null) {
  pendingInternalLayout = layout;
}

/** Read and clear the pending layout (single-shot). */
export function consumePendingInternalLayout(): unknown | null {
  const v = pendingInternalLayout;
  pendingInternalLayout = null;
  return v;
}

/** Restore the layout from localStorage, or build the default if no
 *  saved layout exists or the saved JSON is unparseable. */
export function restoreOrInitLayout(api: DockviewApi) {
  const saved = localStorage.getItem(LAYOUT_STORAGE_KEY);
  if (saved) {
    try {
      api.fromJSON(JSON.parse(saved));
      return;
    } catch (err) {
      // Persisted layout is unusable (schema drift, manual edit, …).
      // Fall through to the default so the user isn't left blank.
      console.warn("Failed to restore dockview layout:", err);
    }
  }
  initDefaultLayout(api);
}

/** Default arrangement: Schema + Saved tabbed on the left (≈320 px),
 *  Workspace taking the rest on the right. */
export function initDefaultLayout(api: DockviewApi) {
  api.addPanel({ id: "schema", component: "schema", title: "Schema" });
  api.addPanel({
    id: "saved",
    component: "saved",
    title: "Saved",
    position: { referencePanel: "schema" },
  });
  api.addPanel({
    id: "workspace",
    component: "workspace",
    title: "Workspace",
    position: { referencePanel: "schema", direction: "right" },
  });
  api.getPanel("schema")?.api.setSize({ width: 320 });
}

/** Persist the current layout. Called from the `onDidLayoutChange`
 *  callback wired up in App.tsx. */
export function persistLayout(api: DockviewApi) {
  try {
    localStorage.setItem(LAYOUT_STORAGE_KEY, JSON.stringify(api.toJSON()));
  } catch {
    // Storage quota / disabled — non-fatal; layout simply won't persist.
  }
}

/** Wipe persisted layout state and rebuild the default arrangement.
 *  Exposed for the "Reset window layout" entry in the FileMenu. */
export function resetLayout() {
  if (!dockviewApi) return;
  localStorage.removeItem(LAYOUT_STORAGE_KEY);
  dockviewApi.clear();
  initDefaultLayout(dockviewApi);
}

// ---------------------------------------------------------------------------
// Panel visibility — used by the View → Panels checkboxes.
// ---------------------------------------------------------------------------

/** Does the given panel currently exist somewhere in the layout
 *  (docked or floating)? */
export function isPanelOpen(id: PanelId): boolean {
  return dockviewApi?.getPanel(id) != null;
}

/**
 * Toggle a panel's presence. If it's currently in the layout it is
 * removed; otherwise it is re-added with a position that mirrors the
 * default arrangement so the user doesn't end up with an orphan tab in
 * an unexpected spot.
 */
export function togglePanel(id: PanelId) {
  const api = dockviewApi;
  if (!api) return;
  const existing = api.getPanel(id);
  if (existing) {
    api.removePanel(existing);
    return;
  }
  const meta = PANELS.find((p) => p.id === id);
  if (!meta) return;

  const options: AddPanelOptions = {
    id: meta.id,
    component: meta.component,
    title: meta.title,
    position: positionFor(id, api),
  };
  api.addPanel(options);

  if (id === "schema") {
    // Restore a sensible width — otherwise the new split lands at 50/50.
    api.getPanel("schema")?.api.setSize({ width: 320 });
  }
}

/** Pick a reasonable insertion point for a re-opened panel based on
 *  whatever else is currently in the layout. */
function positionFor(
  id: PanelId,
  api: DockviewApi,
): AddPanelOptions["position"] {
  const has = (p: PanelId) => api.getPanel(p) != null;
  switch (id) {
    case "schema":
      if (has("workspace")) {
        return { referencePanel: "workspace", direction: "left" };
      }
      if (has("saved")) {
        return { referencePanel: "saved" };
      }
      return undefined;
    case "saved":
      if (has("schema")) {
        return { referencePanel: "schema" };
      }
      if (has("workspace")) {
        return { referencePanel: "workspace", direction: "left" };
      }
      return undefined;
    case "workspace":
      if (has("schema")) {
        return { referencePanel: "schema", direction: "right" };
      }
      if (has("saved")) {
        return { referencePanel: "saved", direction: "right" };
      }
      return undefined;
    case "console":
      // Re-open the console docked at the bottom, preferably under the
      // workspace so the schema tree keeps its full height.
      if (has("workspace")) {
        return { referencePanel: "workspace", direction: "below" };
      }
      if (has("schema")) {
        return { referencePanel: "schema", direction: "below" };
      }
      return undefined;
    case "side-editor":
      // Dock to the right of the workspace so the editor sits beside the
      // data grid, like JetBrains' value viewer.
      if (has("workspace")) {
        return { referencePanel: "workspace", direction: "right" };
      }
      return undefined;
  }
}

/**
 * Open (or focus) the docked side cell-editor panel. Called after the grid /
 * modal stashes a target in `useCellEditor`. If the panel already exists we
 * just activate it; otherwise we add it to the right of the workspace with a
 * reasonable width.
 */
export function isSideEditorOpen(): boolean {
  return dockviewApi?.getPanel("side-editor") != null;
}

export function openSideEditor() {
  const api = dockviewApi;
  if (!api) return;
  const existing = api.getPanel("side-editor");
  if (existing) {
    existing.api.setActive();
    return;
  }
  api.addPanel({
    id: "side-editor",
    component: "side-editor",
    title: "Cell",
    position: positionFor("side-editor", api),
  });
  api.getPanel("side-editor")?.api.setSize({ width: 420 });
}

// ---------------------------------------------------------------------------
// Floating groups — explicit action for users who don't discover the
// drag-out-of-container gesture.
// ---------------------------------------------------------------------------

/** Move the currently active panel into a floating group. No-op if
 *  there is no active panel (e.g. the layout is empty). Users who want
 *  to dock a floating panel back can drag its tab onto the main grid,
 *  or "Reset window layout" as a nuclear option. */
export function floatActivePanel() {
  const api = dockviewApi;
  const panel = api?.activePanel;
  if (!api || !panel) return;
  api.addFloatingGroup(panel);
}
