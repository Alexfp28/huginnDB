import { describe, expect, it } from "vitest";

import { ThemeImportError, parseThemeFile } from "./themeTransfer";
import { BUILT_IN_THEMES, COLOR_KEYS, type ThemeColors } from "./themes";

const baseline = BUILT_IN_THEMES[0];
const allKeys = Object.keys(baseline.dark) as (keyof ThemeColors)[];

function fileV2(
  light: Partial<ThemeColors>,
  dark: Partial<ThemeColors>,
  extra: Record<string, unknown> = {},
) {
  return JSON.stringify({
    kind: "huginndb-theme",
    version: 2,
    theme: { name: "Imported", light, dark, ...extra },
  });
}

function fileV1(colors: Partial<ThemeColors>, extra: Record<string, unknown> = {}) {
  return JSON.stringify({
    kind: "huginndb-theme",
    version: 1,
    theme: { name: "Imported", mode: "dark", colors, ...extra },
  });
}

describe("parseThemeFile — v2 (light-dark)", () => {
  it("fills every token on both variants, not just the editable ones", () => {
    const theme = parseThemeFile(fileV2({ background: "#101010" }, { background: "#202020" }));
    for (const key of allKeys) {
      expect(theme.light[key], `light missing ${key}`).toBeTruthy();
      expect(theme.dark[key], `dark missing ${key}`).toBeTruthy();
    }
    expect(theme.light.background).toBe("#101010");
    expect(theme.dark.background).toBe("#202020");
  });

  // The regression this enumeration exists for: `pk`/`fk`/`numeric` are part
  // of a theme but absent from COLOR_KEYS (the editor doesn't show them),
  // and used to be carried by a hand-written list. Deriving from the
  // baseline means a fourth non-editable token cannot be silently dropped.
  it("carries the non-editable accent tokens", () => {
    const nonEditable = allKeys.filter((k) => !COLOR_KEYS.some((c) => c.key === k));
    expect(nonEditable.length).toBeGreaterThan(0);

    const patch = Object.fromEntries(nonEditable.map((k) => [k, "#abcdef"]));
    const theme = parseThemeFile(fileV2(patch, patch));
    for (const key of nonEditable) {
      expect(theme.light[key], `dropped ${key} (light)`).toBe("#abcdef");
      expect(theme.dark[key], `dropped ${key} (dark)`).toBe("#abcdef");
    }
  });

  it("substitutes the matching baseline variant for a missing or non-string value", () => {
    const theme = parseThemeFile(fileV2({ background: 42 as unknown as string }, {}));
    expect(theme.light.background).toBe(baseline.light.background);
    expect(theme.light.foreground).toBe(baseline.light.foreground);
    expect(theme.dark.background).toBe(baseline.dark.background);
  });

  it("never marks an import built-in", () => {
    const theme = parseThemeFile(fileV2({}, {}));
    expect(theme.builtin).toBe(false);
  });
});

describe("parseThemeFile — v1 compat (pre-refactor, single palette)", () => {
  it("duplicates the single palette into both variants", () => {
    const theme = parseThemeFile(fileV1({ background: "#101010" }));
    expect(theme.light.background).toBe("#101010");
    expect(theme.dark.background).toBe("#101010");
  });

  it("falls back to the baseline variant matching the legacy mode", () => {
    const themeDark = parseThemeFile(fileV1({}, { mode: "dark" }));
    expect(themeDark.light.background).toBe(baseline.dark.background);
    expect(themeDark.dark.background).toBe(baseline.dark.background);

    const themeLight = parseThemeFile(fileV1({}, { mode: "light" }));
    expect(themeLight.light.background).toBe(baseline.light.background);
    expect(themeLight.dark.background).toBe(baseline.light.background);
  });

  it("defaults an unrecognised mode to dark and never marks an import built-in", () => {
    const theme = parseThemeFile(fileV1({}, { mode: "nonsense" }));
    expect(theme.light.background).toBe(baseline.dark.background);
    expect(theme.builtin).toBe(false);
  });
});

describe("parseThemeFile — malformed input", () => {
  it("rejects a file that is not a theme export", () => {
    expect(() => parseThemeFile("not json")).toThrow(ThemeImportError);
    expect(() =>
      parseThemeFile(JSON.stringify({ kind: "huginndb-profiles" })),
    ).toThrow(ThemeImportError);
  });
});
