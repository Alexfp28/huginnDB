import { describe, expect, it } from "vitest";

import { migrateThemeState, nextEditorTheme } from "./theme";

describe("migrateThemeState", () => {
  it("passes a v1 blob through, defaulting the fields it predates", () => {
    const v1 = {
      themeId: "claude",
      mode: "light",
      customThemes: [],
      environmentOverrideId: null,
    };
    // No longer identity: a v1 blob was written before VS Code theme import
    // existed, so it has no `importedEditorThemes` at all. Defaulting it in
    // the migration — rather than at each read site — is what keeps
    // `deleteCustom`'s object spread from being handed `undefined`.
    expect(migrateThemeState(v1, 1)).toEqual({ ...v1, importedEditorThemes: {} });
  });

  it("resolves a pre-refactor built-in id to its family id and derives the global mode", () => {
    const migrated = migrateThemeState({ themeId: "claude-dark", customThemes: [] }, 0);
    expect(migrated.themeId).toBe("claude");
    expect(migrated.mode).toBe("dark");
    expect(migrated.environmentOverrideId).toBeNull();
  });

  it("resolves the default HuginnDB pair id regardless of which side was active", () => {
    expect(migrateThemeState({ themeId: "light", customThemes: [] }, 0).themeId).toBe("dark");
    expect(migrateThemeState({ themeId: "light", customThemes: [] }, 0).mode).toBe("light");
    expect(migrateThemeState({ themeId: "dark", customThemes: [] }, 0).mode).toBe("dark");
  });

  it("duplicates a pre-refactor custom theme's single palette into both variants", () => {
    const legacyColors = { background: "#101010", foreground: "#eeeeee" };
    const migrated = migrateThemeState(
      {
        themeId: "my-custom",
        customThemes: [
          { id: "my-custom", name: "Mine", mode: "dark", builtin: false, colors: legacyColors },
        ],
      },
      0,
    );
    expect(migrated.customThemes).toHaveLength(1);
    expect(migrated.customThemes[0].light).toEqual(legacyColors);
    expect(migrated.customThemes[0].dark).toEqual(legacyColors);
    // The active custom theme's own `mode` wins over the (irrelevant here)
    // legacy built-in mode table.
    expect(migrated.mode).toBe("dark");
    expect(migrated.themeId).toBe("my-custom");
  });

  it("falls back to the dark family and dark mode for a missing/empty blob", () => {
    const migrated = migrateThemeState(undefined, 0);
    expect(migrated.themeId).toBe("dark");
    expect(migrated.mode).toBe("dark");
    expect(migrated.customThemes).toEqual([]);
  });
});

describe("nextEditorTheme", () => {
  const FAMILY = "abc123";
  const imported = [FAMILY];
  const dark = `vscode-${FAMILY}-dark`;
  const light = `vscode-${FAMILY}-light`;

  it("moves the editor onto a freshly installed theme even from a curated one", () => {
    // The install path passes `force`: it is the explicit "use this theme",
    // and this is the case the app shipped broken — the chrome repainted and
    // every SQL editor stayed on HuginnDB Dark.
    expect(nextEditorTheme("huginn-dark", FAMILY, "dark", imported, true)).toBe(dark);
    expect(nextEditorTheme("monokai", FAMILY, "light", imported, true)).toBe(light);
  });

  it("follows a light/dark flip to the same family's other side", () => {
    expect(nextEditorTheme(dark, FAMILY, "light", imported)).toBe(light);
    expect(nextEditorTheme(light, FAMILY, "dark", imported)).toBe(dark);
  });

  it("leaves a curated editor theme alone when the app theme moves on its own", () => {
    expect(nextEditorTheme("monokai", FAMILY, "dark", imported)).toBeNull();
    expect(nextEditorTheme("vs-light", FAMILY, "light", imported)).toBeNull();
    expect(nextEditorTheme("huginn-dark", FAMILY, "dark", imported)).toBeNull();
  });

  it("returns the brand pair when the editor was following a family that is gone", () => {
    // `deleteCustom`: the family is no longer in the imported list, so the
    // pref would otherwise keep naming an id nothing defines.
    expect(nextEditorTheme(dark, FAMILY, "dark", [], true)).toBe("huginn-dark");
    expect(nextEditorTheme(light, FAMILY, "light", [], true)).toBe("huginn-light");
  });

  it("switches families when the editor was following the one being left", () => {
    const other = "def456";
    expect(
      nextEditorTheme(dark, other, "dark", [FAMILY, other]),
    ).toBe(`vscode-${other}-dark`);
  });

  it("is a no-op when the editor is already on the right id", () => {
    expect(nextEditorTheme(dark, FAMILY, "dark", imported, true)).toBeNull();
  });
});
