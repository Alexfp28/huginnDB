/**
 * Dockview helpers: layout persistence + module-scope handle on the
 * single dockview API instance.
 *
 * Lives in `lib/` (rather than next to App.tsx) so that components like
 * the FileMenu can trigger `resetLayout` without creating a circular
 * import on the App module.
 */

import type { DockviewApi } from "dockview-react";

/** localStorage key for the persisted dockview layout JSON. */
export const LAYOUT_STORAGE_KEY = "huginndb.layout";

/**
 * Single dockview API handle for the running window. There is only ever
 * one DockviewReact mount inside the app shell, so a module-level
 * singleton is sufficient and avoids prop-drilling the API down to every
 * call site that wants to reset or reshape the layout.
 */
let dockviewApi: DockviewApi | null = null;

/** Stash the API once the DockviewReact `onReady` callback fires. */
export function registerDockviewApi(api: DockviewApi) {
  dockviewApi = api;
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
  api.addPanel({
    id: "schema",
    component: "schema",
    title: "Schema",
  });
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
