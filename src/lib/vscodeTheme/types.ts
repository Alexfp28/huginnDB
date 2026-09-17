/**
 * The subset of the VS Code colour-theme format this importer reads.
 *
 * Deliberately partial: a theme file is a third-party artefact with no
 * schema guarantee at runtime, so every field is optional here and the
 * parser validates rather than trusting the type. Fields the app has no use
 * for (`semanticHighlighting`, extension-private keys like Dracula's own
 * `"dracula"` block) are simply not modelled — they round-trip nowhere.
 */

/** `uiTheme` in the manifest: VS Code's own light/dark/high-contrast axis. */
export type VsCodeUiTheme = "vs" | "vs-dark" | "hc-black" | "hc-light";

/** One `contributes.themes[]` entry of a `.vsix` manifest. */
export interface VsixThemeContribution {
  /** User-facing variant name ("GitHub Light Default"). */
  label: string;
  uiTheme: VsCodeUiTheme;
  /** Path inside the extension, as written (`./themes/foo.json`). */
  path: string;
}

/** What `read_vsix` hands back: the manifest's themes plus the raw text of
 *  every file they reference, keyed by the path exactly as contributed. */
export interface VsixPayload {
  /** `displayName` when present, else `name` — what the picker shows. */
  displayName: string;
  /** `publisher.name`, for attribution in the import dialog. */
  identifier: string;
  version: string;
  /** `null` rather than absent: this crosses the Tauri boundary, where the
   *  backend's `Option<String>` serialises to `null`. */
  license?: string | null;
  themes: VsixThemeContribution[];
  /** Theme file bodies, including any pulled in via `include`. */
  files: Record<string, string>;
}

export interface VsCodeTokenColor {
  name?: string;
  /** TextMate scope(s). A theme may write either form, and both occur in
   *  the sampled themes — sometimes a comma-separated string. */
  scope?: string | string[];
  settings?: {
    foreground?: string;
    background?: string;
    /** Space-separated: "italic bold underline", or "" to clear. */
    fontStyle?: string;
  };
}

/** A parsed theme file, post-JSONC and post-`include` merge. */
export interface VsCodeThemeFile {
  name?: string;
  type?: string;
  /** Relative path to a base theme this one extends. Resolved by the parser;
   *  never present on the merged result. */
  include?: string;
  colors?: Record<string, string>;
  tokenColors?: VsCodeTokenColor[];
  semanticTokenColors?: Record<string, unknown>;
}

/** Import failures the UI shows directly. `message` is an i18n key suffix,
 *  matching how `ThemeImportError` already works in `lib/themeTransfer.ts`. */
export class VsCodeThemeError extends Error {}
