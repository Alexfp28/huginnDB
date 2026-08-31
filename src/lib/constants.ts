/**
 * App-wide configuration constants.
 *
 * Anything magic-number-ish that more than one component cares about
 * lives here so it can be tuned in one place. Values that are part of
 * the wire protocol (Tauri command names, keychain account format) are
 * kept on the Rust side; this file is for UI knobs only.
 */

import type { Driver } from "@/types";

/** Page-size options offered in the table data browser. */
export const PAGE_SIZE_OPTIONS = [50, 100, 250, 500] as const;

/** Maximum entries kept in the persisted query history. Older entries are dropped. */
export const QUERY_HISTORY_LIMIT = 50;

/** Default port assigned in the connection dialog when the user picks a driver. */
export const DEFAULT_PORTS = {
  postgres: 5432,
  mysql: 3306,
  sqlite: 0,
  mongodb: 27017,
  sqlserver: 1433,
} as const satisfies Record<Driver, number>;

/** localStorage keys used by zustand persist middleware. */
export const STORAGE_KEYS = {
  theme: "huginndb.theme.v2",
  queryHistory: "huginndb.queryHistory",
  savedQueries: "huginndb.savedQueries",
  viewPrefs: "huginndb.viewPrefs.v1",
  update: "huginndb.update.v1",
  whatsNew: "huginndb.whatsNew.v1",
  panelLayout: "huginndb.panelLayout",
  pulse: "huginndb.pulse.v1",
} as const;

/** Superseded by `STORAGE_KEYS.panelLayout` — the old outer dockview's
 *  `toJSON()` blob under the panel-shell redesign. Not migrated (see
 *  `stores/session/panelLayout.ts`); read once at boot solely to remove it. */
export const LEGACY_DOCKVIEW_LAYOUT_KEY = "huginndb.layout";
