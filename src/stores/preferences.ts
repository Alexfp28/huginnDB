/**
 * User-tunable preferences store, backed by `prefs.json` in the platform
 * config dir via the Rust commands `get_preferences` / `update_preferences`.
 *
 * Unlike the theme / history / saved-queries stores we deliberately do NOT
 * use the Zustand `persist` middleware — disk (via Rust) is the source of
 * truth here, not localStorage. The flow is:
 *
 *   1. `hydrate()` is awaited once at app boot, before the UI renders.
 *   2. Every setter mutates the in-memory snapshot and schedules a
 *      debounced `api.updatePreferences()` (400 ms) so slider drags don't
 *      hammer the disk.
 *   3. Each section is updated as a single shallow-merged object so React
 *      selectors that subscribe to a slice (e.g. `state.editor`) keep
 *      reference stability when an unrelated section changes — required to
 *      avoid the infinite-re-render trap documented in `CLAUDE.md`.
 *
 * The one-time migration from the previous `localStorage["huginndb.viewPrefs.v1"]`
 * blob runs inside `hydrate()` so the user's schema-tree metric choice
 * survives the move to disk-backed storage.
 */

import { create } from "zustand";
import { api } from "@/lib/tauri";
import { STORAGE_KEYS } from "@/lib/constants";
import type {
  EditorPrefs,
  GridPrefs,
  Preferences,
  SchemaTableMetric,
  UiPrefs,
} from "@/types";

const DEFAULT_PREFS: Preferences = {
  version: 1,
  editor: {
    fontFamily: "JetBrains Mono",
    fontSize: 13,
    tabSize: 2,
    wordWrap: false,
    minimap: false,
    lineNumbers: true,
    formatOnPaste: false,
    theme: "one-dark-pro",
  },
  grid: {
    rowHeight: 26,
    nullDisplay: "NULL",
    truncateLongTextAt: 200,
    zebraStripes: true,
    stickyHeader: true,
    defaultPageSize: 100,
    cellPreview: true,
    bitDisplay: "true_false",
    columnWidths: {},
  },
  ui: {
    confirmDestructive: true,
    queryHistoryLimit: 50,
    restoreTabsOnOpen: true,
    schemaTableMetric: "none",
    language: "en",
    cellEditorMode: "modal",
    defaultDriver: null,
    cliConnectDefault: "ask",
    collapsedConnectionGroups: [],
  },
};

interface PreferencesState {
  prefs: Preferences;
  hydrated: boolean;
  hydrate: () => Promise<void>;
  updateEditor: (patch: Partial<EditorPrefs>) => void;
  updateGrid: (patch: Partial<GridPrefs>) => void;
  updateUi: (patch: Partial<UiPrefs>) => void;
  resetAll: () => void;
  /**
   * Adopt a snapshot that's already persisted elsewhere — the cross-window
   * `prefs-changed` broadcast (`prefs-sync-bridge.ts`) after another window
   * saved. Deliberately does NOT call `scheduleSave`: the payload came from
   * a save that already completed, so re-saving it here would be a
   * redundant disk write at best and, at worst, a race against a newer
   * local edit made in the moment between the event firing and this
   * running.
   */
  applyExternal: (prefs: Preferences) => void;
}

let saveTimer: ReturnType<typeof setTimeout> | null = null;
const SAVE_DEBOUNCE_MS = 400;

function scheduleSave(prefs: Preferences) {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    saveTimer = null;
    api.updatePreferences(prefs).catch((err) => {
      // Disk writes shouldn't fail in normal operation; if they do the user
      // can keep working with the in-memory copy and we surface to console.
      console.error("[preferences] failed to persist:", err);
    });
  }, SAVE_DEBOUNCE_MS);
}

/**
 * Read the legacy `localStorage["huginndb.viewPrefs.v1"]` blob and return
 * the schema-tree metric it stored, if any. Returns `null` when the key is
 * absent, parseable but empty, or contains an unknown value.
 */
function readLegacyViewPrefs(): SchemaTableMetric | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEYS.viewPrefs);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as {
      state?: { schemaTableMetric?: SchemaTableMetric };
    };
    const value = parsed?.state?.schemaTableMetric;
    if (value === "none" || value === "row-count" || value === "size") {
      return value;
    }
    return null;
  } catch {
    return null;
  }
}

export const usePreferences = create<PreferencesState>()((set, get) => ({
  prefs: DEFAULT_PREFS,
  hydrated: false,

  async hydrate() {
    if (get().hydrated) return;
    let loaded: Preferences;
    try {
      loaded = await api.getPreferences();
    } catch (err) {
      console.error("[preferences] hydrate failed; using defaults:", err);
      loaded = DEFAULT_PREFS;
    }

    // One-time migration: seed schemaTableMetric from the legacy
    // localStorage blob and then clear the key. We only seed when the disk
    // file is still at the default value — once the user has touched the
    // setting in the dialog, the disk value wins.
    const legacy = readLegacyViewPrefs();
    let seeded = false;
    if (legacy && loaded.ui.schemaTableMetric === "none" && legacy !== "none") {
      loaded = {
        ...loaded,
        ui: { ...loaded.ui, schemaTableMetric: legacy },
      };
      seeded = true;
    }
    if (legacy !== null) {
      // Whether we seeded or not, the localStorage copy is now stale; drop
      // it so we never run this migration twice.
      try {
        localStorage.removeItem(STORAGE_KEYS.viewPrefs);
      } catch {
        // Storage may be unavailable in some webview configs; ignore.
      }
    }

    set({ prefs: loaded, hydrated: true });
    if (seeded) scheduleSave(loaded);
  },

  updateEditor(patch) {
    set((s) => {
      const next: Preferences = {
        ...s.prefs,
        editor: { ...s.prefs.editor, ...patch },
      };
      scheduleSave(next);
      return { prefs: next };
    });
  },

  updateGrid(patch) {
    set((s) => {
      const next: Preferences = {
        ...s.prefs,
        grid: { ...s.prefs.grid, ...patch },
      };
      scheduleSave(next);
      return { prefs: next };
    });
  },

  updateUi(patch) {
    set((s) => {
      const next: Preferences = {
        ...s.prefs,
        ui: { ...s.prefs.ui, ...patch },
      };
      scheduleSave(next);
      return { prefs: next };
    });
  },

  resetAll() {
    set({ prefs: DEFAULT_PREFS });
    scheduleSave(DEFAULT_PREFS);
  },

  applyExternal(prefs) {
    set({ prefs });
  },
}));

// Slice selectors — exported so components subscribe to the smallest stable
// reference possible. Calling `usePreferences(s => s.editor)` directly works
// too; these are sugar that document the intended boundary.
export const selectEditorPrefs = (s: PreferencesState) => s.prefs.editor;
export const selectGridPrefs = (s: PreferencesState) => s.prefs.grid;
export const selectUiPrefs = (s: PreferencesState) => s.prefs.ui;
