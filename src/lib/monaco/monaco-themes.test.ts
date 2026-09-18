/**
 * Characterization tests for the theme id → colours path.
 *
 * Both cases here are the bug that shipped: an imported VS Code theme's id
 * resolves to itself (the registry accepts it) but is *not* a key of the
 * compile-time catalogue, so every consumer that indexed that record directly
 * threw the moment someone picked one.
 */

import { beforeEach, describe, expect, it } from "vitest";

import {
  getMonacoPreviewColors,
  registerImportedMonacoThemes,
  resolveMonacoTheme,
  unregisterImportedMonacoThemes,
} from "./monaco-themes";

const IMPORTED_ID = "vscode-abc123-dark";

const IMPORTED = {
  base: "vs-dark" as const,
  inherit: true,
  rules: [
    { token: "", foreground: "f8f8f2" },
    { token: "comment", foreground: "6272a4" },
    { token: "keyword", foreground: "ff79c6" },
    { token: "string", foreground: "f1fa8c" },
    { token: "number", foreground: "bd93f9" },
  ],
  colors: {
    "editor.background": "#282a36",
    "editorLineNumber.foreground": "#6272a4",
  },
};

describe("resolveMonacoTheme", () => {
  beforeEach(() => unregisterImportedMonacoThemes([IMPORTED_ID]));

  it("falls back to the brand theme for an id nothing defines", () => {
    expect(resolveMonacoTheme(IMPORTED_ID)).toBe("huginn-dark");
    expect(resolveMonacoTheme(undefined)).toBe("huginn-dark");
  });

  it("accepts an imported id once its definition has been registered", () => {
    registerImportedMonacoThemes([{ id: IMPORTED_ID, data: IMPORTED }]);
    expect(resolveMonacoTheme(IMPORTED_ID)).toBe(IMPORTED_ID);
  });
});

describe("getMonacoPreviewColors", () => {
  beforeEach(() => unregisterImportedMonacoThemes([IMPORTED_ID]));

  it("reads an imported theme's own palette instead of throwing", () => {
    registerImportedMonacoThemes([{ id: IMPORTED_ID, data: IMPORTED }]);
    const c = getMonacoPreviewColors(IMPORTED_ID);
    expect(c.background).toBe("#282a36");
    expect(c.keyword).toBe("#ff79c6");
    expect(c.lineNumber).toBe("#6272a4");
  });

  it("survives an imported definition with neither rules nor colors", () => {
    registerImportedMonacoThemes([
      { id: IMPORTED_ID, data: { base: "vs-dark", inherit: true } as never },
    ]);
    expect(() => getMonacoPreviewColors(IMPORTED_ID)).not.toThrow();
  });

  it("still serves the curated catalogue and the two built-ins", () => {
    expect(getMonacoPreviewColors("monokai").background).toBe("#272822");
    expect(getMonacoPreviewColors("vs-light").background).toBe("#ffffff");
    // Unknown ids land on the brand theme, same as `resolveMonacoTheme`.
    expect(getMonacoPreviewColors("nope").background).toBe(
      getMonacoPreviewColors("huginn-dark").background,
    );
  });
});
