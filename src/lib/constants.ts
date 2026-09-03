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

/**
 * Largest `IN` / `NOT IN` value list the backend accepts, mirroring
 * `MAX_IN_VALUES` in `src-tauri/src/commands/query.rs`.
 *
 * Mirrored rather than derived because there is no wire surface that reports
 * it, and the filter dialog needs it *before* it calls: over the cap it
 * disables Apply and says so, instead of truncating the list (silent loss) or
 * letting the call through to come back as a raw error string in a toast, long
 * after the user stopped looking at what they pasted. Keep the two in step.
 */
export const MAX_FILTER_LIST_VALUES = 1000;

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
