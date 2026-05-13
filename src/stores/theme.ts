import { create } from "zustand";
import { persist } from "zustand/middleware";
import {
  BUILT_IN_THEMES,
  applyTheme,
  type Theme,
  type ThemeColors,
} from "@/lib/themes";

interface ThemeState {
  themeId: string;
  customThemes: Theme[];
  setThemeId: (id: string) => void;
  upsertCustom: (theme: Theme) => void;
  deleteCustom: (id: string) => void;
  duplicateAsCustom: (sourceId: string, name: string) => string;
  updateActiveColor: (key: keyof ThemeColors, value: string) => void;
  setActiveMode: (mode: "light" | "dark") => void;
  resetActive: () => void;
}

function allThemes(state: ThemeState): Theme[] {
  return [...BUILT_IN_THEMES, ...state.customThemes];
}

function resolveActive(state: ThemeState): Theme {
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
      name: "huginn.theme.v2",
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
