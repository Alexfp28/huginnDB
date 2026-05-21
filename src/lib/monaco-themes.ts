/**
 * Monaco theme catalogue for HuginnDB's SQL / cell editors.
 *
 * We define a handful of curated themes — One Dark Pro (Atom), GitHub
 * Dark/Light, Monokai, Solarized Dark/Light — alongside Monaco's
 * built-in `vs-dark` / `vs-light`. Each entry is a self-contained
 * `IStandaloneThemeData` blob so we don't depend on the
 * `monaco-themes` npm package (the project's policy is to keep the
 * dep tree small and audited — see CLAUDE.md).
 *
 * Token list intentionally minimal: keyword, string, number, comment,
 * operator, type, identifier. Monaco's SQL tokenizer maps statements
 * onto these so this covers ~all visible colour in a query editor.
 * If we ever need finer grain we can extend on demand — colour
 * palettes for the popular themes are public.
 *
 * Registration happens once in `monaco-setup.ts` right after
 * `loader.init()` resolves; the user-selected theme is applied via the
 * `<Editor theme={...}>` prop in each editor instance.
 */

import type * as monaco from "monaco-editor";

/** Stable id passed to `monaco.editor.setTheme` / `<Editor theme=...>`. */
export type MonacoThemeId =
  | "vs-dark"
  | "vs-light"
  | "one-dark-pro"
  | "github-dark"
  | "github-light"
  | "monokai"
  | "solarized-dark"
  | "solarized-light";

/** Human-readable label used in the Preferences picker. */
export interface MonacoThemeOption {
  id: MonacoThemeId;
  label: string;
  /** Built-in Monaco themes don't need `defineTheme()`. */
  builtin?: boolean;
}

export const MONACO_THEME_OPTIONS: MonacoThemeOption[] = [
  { id: "one-dark-pro", label: "One Dark Pro" },
  { id: "github-dark", label: "GitHub Dark" },
  { id: "github-light", label: "GitHub Light" },
  { id: "monokai", label: "Monokai" },
  { id: "solarized-dark", label: "Solarized Dark" },
  { id: "solarized-light", label: "Solarized Light" },
  { id: "vs-dark", label: "VS Dark", builtin: true },
  { id: "vs-light", label: "VS Light", builtin: true },
];

/**
 * Custom theme definitions. The keys match `MonacoThemeId` for the
 * non-builtin entries.
 *
 * Palettes come from the canonical sources (Atom One Dark Pro,
 * GitHub Primer, Wimer Hazenberg's Monokai, Ethan Schoonover's
 * Solarized). Tokens use the minimal Monaco names so SQL highlighting
 * picks them up: `keyword`, `string`, `number`, `comment`, `operator`,
 * `type`, `identifier`, plus a couple of TextMate-style fallbacks.
 */
export const MONACO_THEME_DEFINITIONS: Record<
  Exclude<
    MonacoThemeId,
    "vs-dark" | "vs-light"
  >,
  monaco.editor.IStandaloneThemeData
> = {
  "one-dark-pro": {
    base: "vs-dark",
    inherit: true,
    rules: [
      { token: "", foreground: "abb2bf" },
      { token: "comment", foreground: "5c6370", fontStyle: "italic" },
      { token: "keyword", foreground: "c678dd" },
      { token: "operator", foreground: "56b6c2" },
      { token: "string", foreground: "98c379" },
      { token: "number", foreground: "d19a66" },
      { token: "type", foreground: "e5c07b" },
      { token: "identifier", foreground: "e06c75" },
      { token: "delimiter", foreground: "abb2bf" },
      { token: "predefined", foreground: "61afef" },
    ],
    colors: {
      "editor.background": "#282c34",
      "editor.foreground": "#abb2bf",
      "editorLineNumber.foreground": "#4b5263",
      "editorLineNumber.activeForeground": "#abb2bf",
      "editor.selectionBackground": "#3e4451",
      "editor.lineHighlightBackground": "#2c313c",
      "editorCursor.foreground": "#528bff",
      "editorIndentGuide.background1": "#3b4048",
      "editorIndentGuide.activeBackground1": "#545862",
    },
  },
  "github-dark": {
    base: "vs-dark",
    inherit: true,
    rules: [
      { token: "", foreground: "c9d1d9" },
      { token: "comment", foreground: "8b949e", fontStyle: "italic" },
      { token: "keyword", foreground: "ff7b72" },
      { token: "operator", foreground: "ff7b72" },
      { token: "string", foreground: "a5d6ff" },
      { token: "number", foreground: "79c0ff" },
      { token: "type", foreground: "ffa657" },
      { token: "identifier", foreground: "c9d1d9" },
      { token: "predefined", foreground: "d2a8ff" },
    ],
    colors: {
      "editor.background": "#0d1117",
      "editor.foreground": "#c9d1d9",
      "editorLineNumber.foreground": "#484f58",
      "editorLineNumber.activeForeground": "#c9d1d9",
      "editor.selectionBackground": "#264f78",
      "editor.lineHighlightBackground": "#161b22",
      "editorCursor.foreground": "#58a6ff",
    },
  },
  "github-light": {
    base: "vs",
    inherit: true,
    rules: [
      { token: "", foreground: "24292f" },
      { token: "comment", foreground: "6e7781", fontStyle: "italic" },
      { token: "keyword", foreground: "cf222e" },
      { token: "operator", foreground: "cf222e" },
      { token: "string", foreground: "0a3069" },
      { token: "number", foreground: "0550ae" },
      { token: "type", foreground: "953800" },
      { token: "identifier", foreground: "24292f" },
      { token: "predefined", foreground: "8250df" },
    ],
    colors: {
      "editor.background": "#ffffff",
      "editor.foreground": "#24292f",
      "editorLineNumber.foreground": "#8c959f",
      "editorLineNumber.activeForeground": "#24292f",
      "editor.selectionBackground": "#b6d9fe",
      "editor.lineHighlightBackground": "#f6f8fa",
      "editorCursor.foreground": "#0969da",
    },
  },
  monokai: {
    base: "vs-dark",
    inherit: true,
    rules: [
      { token: "", foreground: "f8f8f2" },
      { token: "comment", foreground: "75715e", fontStyle: "italic" },
      { token: "keyword", foreground: "f92672" },
      { token: "operator", foreground: "f92672" },
      { token: "string", foreground: "e6db74" },
      { token: "number", foreground: "ae81ff" },
      { token: "type", foreground: "66d9ef", fontStyle: "italic" },
      { token: "identifier", foreground: "f8f8f2" },
      { token: "predefined", foreground: "a6e22e" },
    ],
    colors: {
      "editor.background": "#272822",
      "editor.foreground": "#f8f8f2",
      "editorLineNumber.foreground": "#90908a",
      "editorLineNumber.activeForeground": "#f8f8f2",
      "editor.selectionBackground": "#49483e",
      "editor.lineHighlightBackground": "#3e3d32",
      "editorCursor.foreground": "#f8f8f0",
    },
  },
  "solarized-dark": {
    base: "vs-dark",
    inherit: true,
    rules: [
      { token: "", foreground: "839496" },
      { token: "comment", foreground: "586e75", fontStyle: "italic" },
      { token: "keyword", foreground: "859900" },
      { token: "operator", foreground: "859900" },
      { token: "string", foreground: "2aa198" },
      { token: "number", foreground: "d33682" },
      { token: "type", foreground: "b58900" },
      { token: "identifier", foreground: "268bd2" },
      { token: "predefined", foreground: "cb4b16" },
    ],
    colors: {
      "editor.background": "#002b36",
      "editor.foreground": "#839496",
      "editorLineNumber.foreground": "#586e75",
      "editorLineNumber.activeForeground": "#93a1a1",
      "editor.selectionBackground": "#073642",
      "editor.lineHighlightBackground": "#073642",
      "editorCursor.foreground": "#93a1a1",
    },
  },
  "solarized-light": {
    base: "vs",
    inherit: true,
    rules: [
      { token: "", foreground: "657b83" },
      { token: "comment", foreground: "93a1a1", fontStyle: "italic" },
      { token: "keyword", foreground: "859900" },
      { token: "operator", foreground: "859900" },
      { token: "string", foreground: "2aa198" },
      { token: "number", foreground: "d33682" },
      { token: "type", foreground: "b58900" },
      { token: "identifier", foreground: "268bd2" },
      { token: "predefined", foreground: "cb4b16" },
    ],
    colors: {
      "editor.background": "#fdf6e3",
      "editor.foreground": "#657b83",
      "editorLineNumber.foreground": "#93a1a1",
      "editorLineNumber.activeForeground": "#586e75",
      "editor.selectionBackground": "#eee8d5",
      "editor.lineHighlightBackground": "#eee8d5",
      "editorCursor.foreground": "#586e75",
    },
  },
};

/**
 * Register every custom theme with the Monaco runtime. Must be called
 * after `loader.init()` resolves so the global `monaco` namespace is
 * the same one `@monaco-editor/react` will pick up. Calling it more
 * than once is harmless — `defineTheme` overwrites existing ids.
 */
export function registerMonacoThemes(m: typeof monaco) {
  for (const [id, def] of Object.entries(MONACO_THEME_DEFINITIONS)) {
    m.editor.defineTheme(id, def);
  }
}

/**
 * Resolve a user-supplied theme id to one Monaco will accept, defaulting
 * to `one-dark-pro` when the value is unknown (e.g. the user hand-edited
 * `prefs.json` to garbage, or a future release dropped a theme they had
 * selected). Keeps the editor renderable rather than blank.
 */
export function resolveMonacoTheme(id: string | undefined): MonacoThemeId {
  const known = MONACO_THEME_OPTIONS.find((o) => o.id === id);
  return known ? (known.id as MonacoThemeId) : "one-dark-pro";
}
