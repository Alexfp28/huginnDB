/**
 * Theme store — drives the look of the entire app.
 *
 * Conceptually there is exactly one "active" theme FAMILY at any moment,
 * plus a global light/dark MODE independent of it — the family is which
 * palette (HuginnDB, Claude, …), the mode is which of its two variants
 * `light-dark()` resolves to (see `applyTheme`/`applyColorScheme` in
 * `lib/themes.ts`). Built-in families are referenced by id and never
 * mutated; editing one auto-forks into a new custom family so the presets
 * stay pristine.
 *
 * CSS variable updates are flushed eagerly inside each action so the
 * UI re-paints synchronously — the persisted localStorage write
 * happens asynchronously via the `persist` middleware.
 */

import { create } from "zustand";
import { persist } from "zustand/middleware";
import { STORAGE_KEYS } from "@/lib/constants";
import { customThemeId } from "@/lib/utils";
import {
  BUILT_IN_THEMES,
  applyTheme,
  applyColorScheme,
  resolveLegacyThemeId,
  LEGACY_THEME_MODE_MAP,
  type ThemeFamily,
  type ThemeColors,
  type ThemeMode,
} from "@/lib/themes";

interface ThemeState {
  themeId: string;
  mode: ThemeMode;
  customThemes: ThemeFamily[];
  /**
   * Theme id the *active environment* wants applied instead of `themeId`, or
   * `null` for "no override — use the default". Only ever fixes the FAMILY,
   * never the mode — the mode stays a personal preference independent of
   * which environment is active (see gotcha #27: an environment describes
   * session/visual identity, not user ergonomics). Set by
   * `useEnvironments.restoreSession`/`switchTo`/`update`, never persisted
   * here: it describes the current environment, not a user preference, and
   * environments already persist their own `themeId` on the backend
   * (`Environment.themeId`, tab_state.json). Kept transient so a fresh
   * install or a rehydrate before environments load never shows a stale
   * override.
   */
  environmentOverrideId: string | null;
  setThemeId: (id: string) => void;
  upsertCustom: (family: ThemeFamily) => void;
  deleteCustom: (id: string) => void;
  duplicateAsCustom: (sourceId: string, name: string) => string;
  /** `variant` edits that specific light/dark half of the family; omitted,
   *  it defaults to the currently active global mode. */
  updateActiveColor: (key: keyof ThemeColors, value: string, variant?: ThemeMode) => void;
  setActiveMode: (mode: ThemeMode) => void;
  resetActive: () => void;
  /** Apply (or clear) the active environment's theme override. Re-resolves
   *  and re-paints immediately; a `themeId` that no longer matches any theme
   *  (a deleted custom theme) falls back to the default, same as `themeId`
   *  going stale would. */
  setEnvironmentOverride: (themeId: string | null) => void;
}

interface LegacyPersistedTheme {
  id: string;
  name: string;
  mode: ThemeMode;
  colors: ThemeColors;
  builtin?: boolean;
}
interface LegacyPersistedState {
  themeId?: string;
  customThemes?: LegacyPersistedTheme[];
}

function allThemes(state: ThemeState): ThemeFamily[] {
  return [...BUILT_IN_THEMES, ...state.customThemes];
}

/** The zustand/persist `migrate` logic, extracted so it's testable without
 *  touching localStorage — the persist config below just wraps it. */
export function migrateThemeState(persisted: unknown, version: number): ThemeState {
  if (version === 1) return persisted as ThemeState;

  const old = (persisted ?? {}) as LegacyPersistedState;
  const oldThemeId = old.themeId ?? "dark";

  // Duplicate each pre-refactor custom theme's single palette into both
  // variants — best-effort, the user edits the missing one later.
  const customThemes: ThemeFamily[] = (old.customThemes ?? []).map((t) => ({
    id: t.id,
    name: t.name,
    builtin: false,
    light: { ...t.colors },
    dark: { ...t.colors },
  }));

  const legacyCustom = (old.customThemes ?? []).find((t) => t.id === oldThemeId);
  const mode: ThemeMode =
    legacyCustom?.mode ?? LEGACY_THEME_MODE_MAP[oldThemeId] ?? "dark";

  return {
    themeId: resolveLegacyThemeId(oldThemeId),
    mode,
    customThemes,
    environmentOverrideId: null,
  } as ThemeState;
}

function resolveActiveFamily(state: ThemeState): ThemeFamily {
  // The environment override wins over the persisted default whenever it
  // resolves to a real theme — this is what makes assigning a theme to an
  // environment stick even if the user later changes their default theme
  // elsewhere (Settings > Appearance) while that environment stays active.
  if (state.environmentOverrideId) {
    const overridden = allThemes(state).find(
      (f) => f.id === state.environmentOverrideId,
    );
    if (overridden) return overridden;
  }
  return (
    allThemes(state).find((f) => f.id === state.themeId) ?? BUILT_IN_THEMES[0]
  );
}

export const useThemeStore = create<ThemeState>()(
  persist(
    (set, get) => ({
      themeId: "dark",
      mode: "dark",
      customThemes: [],
      environmentOverrideId: null,
      setEnvironmentOverride: (themeId) => {
        set({
          environmentOverrideId: themeId ? resolveLegacyThemeId(themeId) : null,
        });
        applyTheme(resolveActiveFamily(get()), get().mode);
      },
      setThemeId: (id) => {
        set({ themeId: resolveLegacyThemeId(id) });
        applyTheme(resolveActiveFamily(get()), get().mode);
      },
      upsertCustom: (family) => {
        set((s) => {
          const customThemes = s.customThemes.some((f) => f.id === family.id)
            ? s.customThemes.map((f) => (f.id === family.id ? family : f))
            : [...s.customThemes, family];
          return { customThemes };
        });
        applyTheme(resolveActiveFamily(get()), get().mode);
      },
      deleteCustom: (id) => {
        set((s) => ({
          customThemes: s.customThemes.filter((f) => f.id !== id),
          themeId: s.themeId === id ? "dark" : s.themeId,
        }));
        applyTheme(resolveActiveFamily(get()), get().mode);
      },
      duplicateAsCustom: (sourceId, name) => {
        const source =
          allThemes(get()).find((f) => f.id === sourceId) ?? BUILT_IN_THEMES[0];
        const id = customThemeId();
        const cloned: ThemeFamily = {
          id,
          name,
          builtin: false,
          light: { ...source.light },
          dark: { ...source.dark },
        };
        set((s) => ({
          customThemes: [...s.customThemes, cloned],
          themeId: id,
        }));
        applyTheme(cloned, get().mode);
        return id;
      },
      updateActiveColor: (key, value, variant) => {
        const family = resolveActiveFamily(get());
        const targetVariant = variant ?? get().mode;
        if (family.builtin) {
          // Auto-fork into a custom theme so built-ins stay pristine — both
          // variants are cloned as-is, only the target one receives the edit.
          const id = customThemeId();
          const cloned: ThemeFamily = {
            id,
            name: `${family.name} (custom)`,
            builtin: false,
            light: { ...family.light },
            dark: { ...family.dark },
          };
          cloned[targetVariant] = { ...cloned[targetVariant], [key]: value };
          set((s) => ({
            customThemes: [...s.customThemes, cloned],
            themeId: id,
          }));
          applyTheme(cloned, get().mode);
          return;
        }
        const updated: ThemeFamily = {
          ...family,
          [targetVariant]: { ...family[targetVariant], [key]: value },
        };
        set((s) => ({
          customThemes: s.customThemes.map((f) =>
            f.id === family.id ? updated : f,
          ),
        }));
        applyTheme(updated, get().mode);
      },
      setActiveMode: (mode) => {
        // O(1): the active family's `light-dark()` variables already contain
        // both variants — only which one the browser paints needs to change.
        if (get().mode === mode) return;
        set({ mode });
        applyColorScheme(mode);
      },
      resetActive: () => {
        const family = resolveActiveFamily(get());
        if (family.builtin) return;
        const baseline = BUILT_IN_THEMES[0];
        const reset: ThemeFamily = {
          ...family,
          light: { ...baseline.light },
          dark: { ...baseline.dark },
        };
        set((s) => ({
          customThemes: s.customThemes.map((f) =>
            f.id === family.id ? reset : f,
          ),
        }));
        applyTheme(reset, get().mode);
      },
    }),
    {
      name: STORAGE_KEYS.theme,
      version: 1, // no `version` was configured before this refactor — zustand treats an unversioned blob as 0
      migrate: migrateThemeState,
      partialize: (state) => ({
        themeId: state.themeId,
        mode: state.mode,
        customThemes: state.customThemes,
      }),
      onRehydrateStorage: () => (state) => {
        if (state) applyTheme(resolveActiveFamily(state as ThemeState), (state as ThemeState).mode);
      },
    },
  ),
);

// Returns a reference-stable ThemeFamily object (an element of BUILT_IN_THEMES
// or state.customThemes). Safe to use as a zustand selector.
export function selectActiveTheme(state: ThemeState): ThemeFamily {
  return resolveActiveFamily(state);
}
// The global mode — a primitive, already reference-stable via Object.is.
export function selectActiveMode(state: ThemeState): ThemeMode {
  return state.mode;
}
// Note: do NOT add a selector that returns the concatenation of built-ins
// + customThemes, nor one that wraps family+mode in a fresh object — either
// would return a new reference every render and trigger an infinite
// re-render loop. Concatenate at the component level inside a useMemo over
// state.customThemes; read family and mode as two separate selectors.
