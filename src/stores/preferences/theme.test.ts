import { describe, expect, it } from "vitest";

import { migrateThemeState } from "./theme";

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
