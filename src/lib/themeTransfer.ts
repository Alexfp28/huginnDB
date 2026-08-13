// Theme export/import — pure logic (no dialog, no I/O). Kept separate from
// AppearanceSection.tsx so the file-format decisions are testable and don't
// get lost inside the component.
//
// A theme is plain JSON already living entirely in the frontend's
// localStorage-backed store (no backend struct, no migration story) — so the
// on-disk shape is this module's own, versioned so a future colour-token
// addition can still tell an old export apart without guessing.

import { BUILT_IN_THEMES, COLOR_KEYS, type Theme, type ThemeColors } from "@/lib/themes";

const KIND = "huginndb-theme";
const CURRENT_VERSION = 1;

interface ThemeExportFile {
  kind: typeof KIND;
  version: number;
  theme: {
    name: string;
    mode: string;
    colors: Record<string, string>;
  };
}

/** Suggested filename for a theme export — used as the save dialog's default. */
export function themeFileName(theme: Theme): string {
  const slug = theme.name.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  return `${slug || "theme"}.huginndb-theme.json`;
}

/** Serialise a theme for export. Strips `id`/`builtin` — those are local
 *  bookkeeping, not part of the theme's look, and the importing side always
 *  mints its own id (see `parseThemeFile`) so two exports of "the same"
 *  theme never collide. */
export function serializeTheme(theme: Theme): string {
  const file: ThemeExportFile = {
    kind: KIND,
    version: CURRENT_VERSION,
    theme: {
      name: theme.name,
      mode: theme.mode,
      colors: { ...theme.colors },
    },
  };
  return JSON.stringify(file, null, 2);
}

export class ThemeImportError extends Error {}

/**
 * Parse a previously exported theme file into a ready-to-use `Theme` — always
 * `builtin: false` and with a fresh id, never one that could collide with an
 * existing built-in or custom theme. Missing colour keys fall back to the
 * default dark theme's value (the same resilience `applyTheme` already
 * affords a theme saved before a token existed), rather than rejecting the
 * whole file over one absent accent — but the file has to at least look like
 * a theme export, or this throws `ThemeImportError` with a message fit to
 * show the user directly.
 */
export function parseThemeFile(raw: string): Theme {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new ThemeImportError("notJson");
  }
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    (parsed as Record<string, unknown>).kind !== KIND ||
    typeof (parsed as Record<string, unknown>).theme !== "object" ||
    (parsed as Record<string, unknown>).theme === null
  ) {
    throw new ThemeImportError("notATheme");
  }
  const { theme } = parsed as ThemeExportFile;
  const rawColors =
    typeof theme.colors === "object" && theme.colors !== null ? theme.colors : {};
  const baseline = BUILT_IN_THEMES[0].colors;
  const colors = COLOR_KEYS.reduce((acc, { key }) => {
    const value = rawColors[key];
    acc[key] = typeof value === "string" ? value : baseline[key];
    return acc;
  }, {} as ThemeColors);
  // Non-editable accents (pk/fk/numeric, see ThemeColors' own doc) aren't in
  // COLOR_KEYS but are still part of the theme — carry them the same way.
  for (const key of ["pk", "fk", "numeric"] as const) {
    const value = rawColors[key];
    colors[key] = typeof value === "string" ? value : baseline[key];
  }

  return {
    id: `custom-${Math.random().toString(36).slice(2, 8)}`,
    name: typeof theme.name === "string" && theme.name.trim() ? theme.name.trim() : "Imported theme",
    mode: theme.mode === "light" ? "light" : "dark",
    builtin: false,
    colors,
  };
}
