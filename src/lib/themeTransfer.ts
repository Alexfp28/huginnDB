// Theme export/import — pure logic (no dialog, no I/O). Kept separate from
// AppearanceSection.tsx so the file-format decisions are testable and don't
// get lost inside the component.
//
// A theme is plain JSON already living entirely in the frontend's
// localStorage-backed store (no backend struct, no migration story) — so the
// on-disk shape is this module's own, versioned so a future colour-token
// addition can still tell an old export apart without guessing.

import { BUILT_IN_THEMES, type ThemeFamily, type ThemeColors, type ThemeMode } from "@/lib/themes";
import { customThemeId } from "@/lib/utils";

const KIND = "huginndb-theme";
const CURRENT_VERSION = 2;

interface ThemeExportFileV2 {
  kind: typeof KIND;
  version: 2;
  theme: {
    name: string;
    light: Record<string, string>;
    dark: Record<string, string>;
  };
}

/** Shape written before the light-dark() refactor — one variant per file. */
interface ThemeExportFileV1 {
  kind: typeof KIND;
  version: 1;
  theme: {
    name: string;
    mode: string;
    colors: Record<string, string>;
  };
}

/** Suggested filename for a theme export — used as the save dialog's default. */
export function themeFileName(theme: ThemeFamily): string {
  const slug = theme.name.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  return `${slug || "theme"}.huginndb-theme.json`;
}

/** Serialise a theme family for export. Strips `id`/`builtin` — those are
 *  local bookkeeping, not part of the theme's look, and the importing side
 *  always mints its own id (see `parseThemeFile`) so two exports of "the
 *  same" theme never collide. */
export function serializeTheme(theme: ThemeFamily): string {
  const file: ThemeExportFileV2 = {
    kind: KIND,
    version: CURRENT_VERSION,
    theme: {
      name: theme.name,
      light: { ...theme.light },
      dark: { ...theme.dark },
    },
  };
  return JSON.stringify(file, null, 2);
}

export class ThemeImportError extends Error {}

/** Fills every key from `baseline` into a fresh `ThemeColors`, taking
 *  `raw[key]` when it's a string and falling back to the baseline's value
 *  otherwise (missing/invalid). Enumerating from the baseline — not from
 *  `COLOR_KEYS`, which holds only the tokens the Appearance editor *shows* —
 *  is what keeps the non-editable accents (pk/fk/numeric) from being
 *  silently dropped on import. */
function fillColors(raw: unknown, baseline: ThemeColors): ThemeColors {
  const rawColors =
    typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>) : {};
  return (Object.keys(baseline) as (keyof ThemeColors)[]).reduce((acc, key) => {
    const value = rawColors[key];
    acc[key] = typeof value === "string" ? value : baseline[key];
    return acc;
  }, {} as ThemeColors);
}

/**
 * Parse a previously exported theme file into a ready-to-use `ThemeFamily` —
 * always `builtin: false` and with a fresh id, never one that could collide
 * with an existing built-in or custom theme. A v1 file (exported before the
 * light-dark() refactor — a single palette + mode) is accepted too: its one
 * palette is duplicated into both variants as a starting point, same as the
 * local persist migration does for a pre-refactor custom theme. Missing
 * colour keys fall back to the default theme's matching variant, rather than
 * rejecting the whole file over one absent accent — but the file has to at
 * least look like a theme export, or this throws `ThemeImportError` with a
 * message fit to show the user directly.
 */
export function parseThemeFile(raw: string): ThemeFamily {
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
  const file = parsed as ThemeExportFileV1 | ThemeExportFileV2;
  const baseline = BUILT_IN_THEMES[0];
  const name =
    typeof file.theme.name === "string" && file.theme.name.trim()
      ? file.theme.name.trim()
      : "Imported theme";

  let light: ThemeColors;
  let dark: ThemeColors;
  if (file.version === 2 && "light" in file.theme) {
    light = fillColors(file.theme.light, baseline.light);
    dark = fillColors(file.theme.dark, baseline.dark);
  } else {
    // v1 (or unrecognised — same lax fallback the old parser already used):
    // one palette, duplicated into both variants.
    const legacy = file.theme as ThemeExportFileV1["theme"];
    const legacyMode: ThemeMode = legacy.mode === "light" ? "light" : "dark";
    const single = fillColors(legacy.colors, baseline[legacyMode]);
    light = { ...single };
    dark = { ...single };
  }

  return { id: customThemeId(), name, builtin: false, light, dark };
}
