import { describe, expect, it } from "vitest";

import { ThemeImportError, parseThemeFile } from "./themeTransfer";
import { BUILT_IN_THEMES, COLOR_KEYS, type ThemeColors } from "./themes";

const baseline = BUILT_IN_THEMES[0].colors;
const allKeys = Object.keys(baseline) as (keyof ThemeColors)[];

function file(colors: Partial<ThemeColors>, extra: Record<string, unknown> = {}) {
  return JSON.stringify({
    kind: "huginndb-theme",
    version: 1,
    theme: { name: "Imported", mode: "dark", colors, ...extra },
  });
}

describe("parseThemeFile", () => {
  it("fills every token, not just the editable ones", () => {
    const theme = parseThemeFile(file({ background: "#101010" }));
    for (const key of allKeys) {
      expect(theme.colors[key], `missing ${key}`).toBeTruthy();
    }
    expect(theme.colors.background).toBe("#101010");
  });

  // The regression this enumeration exists for: `pk`/`fk`/`numeric` are part of
  // a theme but absent from COLOR_KEYS (the editor doesn't show them), and used
  // to be carried by a hand-written list. Deriving from the baseline means a
  // fourth non-editable token cannot be silently dropped.
  it("carries the non-editable accent tokens", () => {
    const nonEditable = allKeys.filter(
      (k) => !COLOR_KEYS.some((c) => c.key === k),
    );
    expect(nonEditable.length).toBeGreaterThan(0);

    const theme = parseThemeFile(
      file(Object.fromEntries(nonEditable.map((k) => [k, "#abcdef"]))),
    );
    for (const key of nonEditable) {
      expect(theme.colors[key], `dropped ${key}`).toBe("#abcdef");
    }
  });

  it("substitutes the baseline for a missing or non-string value", () => {
    const theme = parseThemeFile(file({ background: 42 as unknown as string }));
    expect(theme.colors.background).toBe(baseline.background);
    expect(theme.colors.foreground).toBe(baseline.foreground);
  });

  it("rejects a file that is not a theme export", () => {
    expect(() => parseThemeFile("not json")).toThrow(ThemeImportError);
    expect(() =>
      parseThemeFile(JSON.stringify({ kind: "huginndb-profiles" })),
    ).toThrow(ThemeImportError);
  });

  it("defaults the mode to dark and never marks an import built-in", () => {
    const theme = parseThemeFile(file({}, { mode: "nonsense" }));
    expect(theme.mode).toBe("dark");
    expect(theme.builtin).toBe(false);
  });
});
