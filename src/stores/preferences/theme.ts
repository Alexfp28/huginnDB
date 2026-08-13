/**
 * Theme store — drives the look of the entire app.
 *
 * Conceptually there is exactly one "active" theme at any moment. The
 * store knows which one it is via `themeId` plus a list of any
 * user-defined custom themes. Built-in themes are referenced by id and
 * never mutated; editing one auto-forks into a new custom theme so the
 * presets stay pristine.
 *
 * CSS variable updates are flushed eagerly inside each action so the
 * UI re-paints synchronously — the persisted localStorage write
 * happens asynchronously via the `persist` middleware.
 */

import { create } from "zustand";
import { persist } from "zustand/middleware";
import { STORAGE_KEYS } from "@/lib/constants";
import {
  BUILT_IN_THEMES,
  applyTheme,
  type Theme,
  type ThemeColors,
} from "@/lib/themes";

interface ThemeState {
  themeId: string;
  customThemes: Theme[];
  /**
   * Theme id the *active environment* wants applied instead of `themeId`, or
   * `null` for "no override — use the default". Set by
   * `useEnvironments.restoreSession`/`switchTo`/`update`, never persisted
   * here: it describes the current environment, not a user preference, and
   * environments already persist their own `themeId` on the backend
   * (`Environment.themeId`, tab_state.json). Kept transient so a fresh
   * install or a rehydrate before environments load never shows a stale
   * override.
   */
  environmentOverrideId: string | null;
  setThemeId: (id: string) => void;
  upsertCustom: (theme: Theme) => void;
  deleteCustom: (id: string) => void;
  duplicateAsCustom: (sourceId: string, name: string) => string;
  updateActiveColor: (key: keyof ThemeColors, value: string) => void;
  setActiveMode: (mode: "light" | "dark") => void;
  resetActive: () => void;
  /** Apply (or clear) the active environment's theme override. Re-resolves
   *  and re-paints immediately; a `themeId` that no longer matches any theme
   *  (a deleted custom theme) falls back to the default, same as `themeId`
   *  going stale would. */
  setEnvironmentOverride: (themeId: string | null) => void;
}

function allThemes(state: ThemeState): Theme[] {
  return [...BUILT_IN_THEMES, ...state.customThemes];
}

function resolveActive(state: ThemeState): Theme {
  // The environment override wins over the persisted default whenever it
  // resolves to a real theme — this is what makes assigning a theme to an
  // environment stick even if the user later changes their default theme
  // elsewhere (Settings > Appearance) while that environment stays active.
  if (state.environmentOverrideId) {
    const overridden = allThemes(state).find(
      (t) => t.id === state.environmentOverrideId,
    );
    if (overridden) return overridden;
  }
  return (
    allThemes(state).find((t) => t.id === state.themeId) ??
    BUILT_IN_THEMES[0]
  );
}

export const useThemeStore = create<ThemeState>()(
  persist(
    (set, get) => ({
      themeId: "dark",
      customThemes: [],
      environmentOverrideId: null,
      setEnvironmentOverride: (themeId) => {
        set({ environmentOverrideId: themeId });
        applyTheme(resolveActive(get()));
      },
      setThemeId: (id) => {
        set({ themeId: id });
        applyTheme(resolveActive(get()));
      },
      upsertCustom: (theme) => {
        set((s) => {
          const customThemes = s.customThemes.some((t) => t.id === theme.id)
            ? s.customThemes.map((t) => (t.id === theme.id ? theme : t))
            : [...s.customThemes, theme];
          return { customThemes };
        });
        applyTheme(resolveActive(get()));
      },
      deleteCustom: (id) => {
        set((s) => ({
          customThemes: s.customThemes.filter((t) => t.id !== id),
          themeId: s.themeId === id ? "dark" : s.themeId,
        }));
        applyTheme(resolveActive(get()));
      },
      duplicateAsCustom: (sourceId, name) => {
        const source =
          allThemes(get()).find((t) => t.id === sourceId) ?? BUILT_IN_THEMES[0];
        const id = `custom-${Math.random().toString(36).slice(2, 8)}`;
        const cloned: Theme = {
          ...source,
          id,
          name,
          builtin: false,
          colors: { ...source.colors },
        };
        set((s) => ({
          customThemes: [...s.customThemes, cloned],
          themeId: id,
        }));
        applyTheme(cloned);
        return id;
      },
      updateActiveColor: (key, value) => {
        const active = resolveActive(get());
        if (active.builtin) {
          // Auto-fork into a custom theme so built-ins stay pristine.
          const id = `custom-${Math.random().toString(36).slice(2, 8)}`;
          const cloned: Theme = {
            ...active,
            id,
            name: `${active.name} (custom)`,
            builtin: false,
            colors: { ...active.colors, [key]: value },
          };
          set((s) => ({
            customThemes: [...s.customThemes, cloned],
            themeId: id,
          }));
          applyTheme(cloned);
          return;
        }
        const updated: Theme = {
          ...active,
          colors: { ...active.colors, [key]: value },
        };
        set((s) => ({
          customThemes: s.customThemes.map((t) =>
            t.id === active.id ? updated : t,
          ),
        }));
        applyTheme(updated);
      },
      setActiveMode: (mode) => {
        const active = resolveActive(get());
        if (active.mode === mode) return;
        if (active.builtin) {
          // Switch to the corresponding built-in (dark <-> light) if possible.
          const target = BUILT_IN_THEMES.find((t) => t.id === mode);
          if (target) {
            set({ themeId: target.id });
            applyTheme(target);
            return;
          }
        }
        const updated: Theme = { ...active, mode };
        set((s) => ({
          customThemes: s.customThemes.map((t) =>
            t.id === active.id ? updated : t,
          ),
        }));
        applyTheme(updated);
      },
      resetActive: () => {
        // Reset the active custom theme to its name's matching built-in if any.
        const active = resolveActive(get());
        if (active.builtin) return;
        const baseline = BUILT_IN_THEMES[0];
        const reset: Theme = {
          ...active,
          colors: { ...baseline.colors },
          mode: baseline.mode,
        };
        set((s) => ({
          customThemes: s.customThemes.map((t) =>
            t.id === active.id ? reset : t,
          ),
        }));
        applyTheme(reset);
      },
    }),
    {
      name: STORAGE_KEYS.theme,
      partialize: (state) => ({
        themeId: state.themeId,
        customThemes: state.customThemes,
      }),
      onRehydrateStorage: () => (state) => {
        if (state) applyTheme(resolveActive(state as ThemeState));
      },
    },
  ),
);

// Returns a reference-stable Theme object (an element of BUILT_IN_THEMES
// or state.customThemes). Safe to use as a zustand selector.
export function selectActiveTheme(state: ThemeState): Theme {
  return resolveActive(state);
}
// Note: do NOT add a selector that returns the concatenation of built-ins
// + customThemes — that would return a fresh array every render and
// trigger an infinite re-render loop. Concatenate at the component level
// inside a useMemo over state.customThemes.
