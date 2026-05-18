/**
 * App-wide configuration constants.
 *
 * Anything magic-number-ish that more than one component cares about
 * lives here so it can be tuned in one place. Values that are part of
 * the wire protocol (Tauri command names, keychain account format) are
 * kept on the Rust side; this file is for UI knobs only.
 */

/** Default rows-per-page selected when opening a table tab. */
export const DEFAULT_PAGE_SIZE = 100;

/** Page-size options offered in the table data browser. */
export const PAGE_SIZE_OPTIONS = [50, 100, 250, 500] as const;

/** Maximum entries kept in the persisted query history. Older entries are dropped. */
export const QUERY_HISTORY_LIMIT = 50;

/** Default port assigned in the connection dialog when the user picks a driver. */
export const DEFAULT_PORTS = {
  postgres: 5432,
  mysql: 3306,
  sqlite: 0,
} as const;

/** Width of the sidebar (in % of the main area) on first launch. */
export const SIDEBAR_DEFAULT_PERCENT = 20;

/** localStorage keys used by zustand persist middleware. */
export const STORAGE_KEYS = {
  theme: "huginndb.theme.v2",
  queryHistory: "huginndb.queryHistory",
  savedQueries: "huginndb.savedQueries",
  viewPrefs: "huginndb.viewPrefs.v1",
  update: "huginndb.update.v1",
} as const;
