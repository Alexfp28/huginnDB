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

/** One colour-theme extension as a registry lists it. Mirrors
 *  `themes::registry::RegistryTheme`. */
export interface RegistryTheme {
  namespace: string;
  name: string;
  displayName: string;
  description: string;
  version: string;
  license?: string | null;
  downloadCount: number;
  averageRating?: number | null;
  reviewCount: number;
  verified: boolean;
  iconUrl?: string | null;
  downloadUrl: string;
  sha256Url?: string | null;
  /** What the extension contributes — also the proof it is a colour theme. */
  variants: VsixThemeContribution[];
}

export interface RegistrySearchPage {
  items: RegistryTheme[];
  /**
   * The registry's own count for the query, **before** icon themes are
   * filtered out — so an upper bound, not a total. The UI says "about" for
   * this reason: an exact count would mean fetching every manifest in the
   * result set.
   */
  total: number;
  offset: number;
}

/** Where an installed theme came from. Mirrors `themes::store::ThemeSource`. */
export interface InstalledThemeSource {
  registryUrl: string;
  namespace: string;
  name: string;
  version: string;
  lightPath?: string | null;
  darkPath?: string | null;
}

/** One record in `installed_themes.json`. */
export interface InstalledTheme {
  /** Join key with the custom family in the frontend theme store. */
  familyId: string;
  name: string;
  source?: InstalledThemeSource | null;
  /** The extension's `publisher.name` from its manifest, recorded for every
   *  install so a locally imported `.vsix` is still matched to its registry
   *  listing. */
  identifier?: string | null;
  /** The package version this install came from. */
  version?: string | null;
  installedAt: string;
  /** Set once the user edits any token of the derived palette; an update
   *  then leaves the palette alone. Never cleared by an update. */
  paletteEdited: boolean;
  editorThemes: { light: unknown; dark: unknown };
}

export interface InstalledThemeLibrary {
  version: number;
  themes: InstalledTheme[];
}

export interface ThemeUpdate {
  familyId: string;
  name: string;
  installedVersion: string;
  availableVersion: string;
  paletteEdited: boolean;
  theme: RegistryTheme;
}

export interface ThemeUpdateReport {
  updates: ThemeUpdate[];
  /** Installed themes the registry could not be asked about. Surfaced so
   *  "no updates" and "no updates, 3 unreachable" read differently. */
  unchecked: number;
}
