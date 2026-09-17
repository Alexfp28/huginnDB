/**
 * JSONC parsing and `include` resolution for VS Code theme files.
 *
 * Theme files are JSON *with comments* — the format VS Code calls JSONC —
 * and they use the privilege freely: of the five themes kept as fixtures,
 * Tokyo Night carries line comments and Nord block ones, and neither parses
 * with `JSON.parse`. That is why `jsonc-parser` is a
 * dependency rather than a regex: a comment stripper that does not track
 * string state corrupts any value that contains `//`, and colour themes are
 * full of URLs and scope selectors.
 */

import { parse as parseJsonc, type ParseError } from "jsonc-parser";
import { parseHex, relativeLuminance } from "./color";
import {
  VsCodeThemeError,
  type VsCodeThemeFile,
  type VsCodeTokenColor,
  type VsixPayload,
  type VsixThemeContribution,
  type VsCodeUiTheme,
} from "./types";

/** Strip the `./` prefix and normalise separators so a path written as
 *  `./themes/x.json` in the manifest and `themes/x.json` in an `include`
 *  land on the same key. */
export function canonicalPath(path: string): string {
  return path.replace(/\\/g, "/").replace(/^\.\//, "").replace(/^\/+/, "");
}

/** Resolve an `include` relative to the file that declared it, collapsing
 *  `.` and `..` segments. Returns a canonical key for `VsixPayload.files`. */
export function resolveRelative(fromPath: string, include: string): string {
  const base = canonicalPath(fromPath).split("/").slice(0, -1);
  const parts = canonicalPath(include).split("/");
  for (const part of parts) {
    if (part === "." || part === "") continue;
    if (part === "..") base.pop();
    else base.push(part);
  }
  return base.join("/");
}

/** Parse JSONC, throwing `VsCodeThemeError` with an i18n key on failure.
 *  `jsonc-parser` is lenient by design and reports problems out-of-band, so
 *  the error list is checked explicitly instead of trusting a non-null
 *  result. */
export function parseThemeJson(raw: string): unknown {
  const errors: ParseError[] = [];
  const value = parseJsonc(raw, errors, {
    allowTrailingComma: true,
    disallowComments: false,
  });
  if (errors.length > 0 || value === undefined) throw new VsCodeThemeError("notJson");
  return value;
}

const UI_THEMES: VsCodeUiTheme[] = ["vs", "vs-dark", "hc-black", "hc-light"];

/**
 * Read a `.vsix` manifest's `contributes.themes`. Entries missing a usable
 * `path` are dropped rather than failing the whole import — an extension may
 * contribute an icon theme alongside colour themes, and `categories` is not
 * reliable enough to tell them apart (the `Themes` category covers both).
 * An unknown `uiTheme` falls back to `vs-dark`, VS Code's own default.
 */
export function readManifestThemes(manifest: unknown): VsixThemeContribution[] {
  const root = manifest as { contributes?: { themes?: unknown } } | null;
  const raw = root?.contributes?.themes;
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((entry): VsixThemeContribution[] => {
    const e = entry as Partial<VsixThemeContribution>;
    if (typeof e?.path !== "string" || !e.path.trim()) return [];
    const uiTheme =
      typeof e.uiTheme === "string" && (UI_THEMES as string[]).includes(e.uiTheme)
        ? (e.uiTheme as VsCodeUiTheme)
        : "vs-dark";
    const label =
      typeof e.label === "string" && e.label.trim()
        ? e.label.trim()
        : canonicalPath(e.path).split("/").pop() || e.path;
    return [{ label, uiTheme, path: e.path }];
  });
}

/** True when a variant belongs on the light side of a `ThemeFamily`. */
export function isLightVariant(uiTheme: VsCodeUiTheme): boolean {
  return uiTheme === "vs" || uiTheme === "hc-light";
}

/** Fallback side detection for a theme file with no `type`: a background
 *  brighter than mid-grey is a light theme. Defaults to dark when the colour
 *  is missing or unparseable, matching VS Code's own default. */
export function isLightBackground(background: string | undefined): boolean {
  const rgb = parseHex(background);
  return rgb ? relativeLuminance(rgb) > 0.25 : false;
}

function asTokenColors(value: unknown): VsCodeTokenColor[] {
  // `tokenColors` may legally be a path to a .tmTheme instead of an array.
  // That form is not supported (it would mean parsing property lists), and
  // it is rarer than the array by a wide margin — treated as "none".
  return Array.isArray(value) ? (value as VsCodeTokenColor[]) : [];
}

/**
 * Load one contributed theme file and fold in whatever it `include`s,
 * recursively. Merge rules follow VS Code's: the *including* file wins on
 * `colors` key by key, and its `tokenColors` are appended after the base's,
 * because a later TextMate rule overrides an earlier one for the same scope.
 *
 * A cycle, a missing include, or a depth over 10 stops the walk and keeps
 * what has been merged so far — a theme that renders slightly wrong beats an
 * import that refuses over a broken base file the user cannot fix.
 */
export function loadThemeFile(
  entryPath: string,
  files: Record<string, string>,
  seen: Set<string> = new Set(),
  depth = 0,
): VsCodeThemeFile {
  const key = canonicalPath(entryPath);
  const raw = files[key];
  if (raw === undefined) throw new VsCodeThemeError("themeFileMissing");
  if (seen.has(key) || depth > 10) throw new VsCodeThemeError("themeFileMissing");
  seen.add(key);

  const parsed = parseThemeJson(raw);
  if (typeof parsed !== "object" || parsed === null) throw new VsCodeThemeError("notATheme");
  const self = parsed as VsCodeThemeFile;

  let base: VsCodeThemeFile = {};
  if (typeof self.include === "string" && self.include.trim()) {
    try {
      base = loadThemeFile(resolveRelative(key, self.include), files, seen, depth + 1);
    } catch {
      base = {};
    }
  }

  return {
    name: self.name ?? base.name,
    type: self.type ?? base.type,
    colors: { ...(base.colors ?? {}), ...(self.colors ?? {}) },
    tokenColors: [...asTokenColors(base.tokenColors), ...asTokenColors(self.tokenColors)],
    semanticTokenColors: {
      ...(base.semanticTokenColors ?? {}),
      ...(self.semanticTokenColors ?? {}),
    },
  };
}

/**
 * Accept a bare `*-color-theme.json` dropped on the importer — no `.vsix`,
 * no manifest — by synthesising the one contribution it represents.
 *
 * Which side it belongs on is decided by `type` when the file states it and
 * by the LUMINANCE of its own `editor.background` when it does not. The
 * fallback is not a nicety: `type` is optional in the format and GitHub
 * Light Default omits it, so trusting the field alone files a white theme
 * under "dark" — which is both wrong and invisible until the user switches
 * modes.
 */
export function payloadFromBareThemeFile(raw: string, fileName: string): VsixPayload {
  const parsed = parseThemeJson(raw);
  if (typeof parsed !== "object" || parsed === null) throw new VsCodeThemeError("notATheme");
  const file = parsed as VsCodeThemeFile;
  if (!file.colors && !file.tokenColors) throw new VsCodeThemeError("notATheme");

  const path = canonicalPath(fileName) || "theme.json";
  const label =
    (typeof file.name === "string" && file.name.trim()) ||
    path.split("/").pop()?.replace(/\.json$/i, "") ||
    "Imported theme";
  const light =
    file.type === "light" || file.type === "hcLight"
      ? true
      : file.type === "dark" || file.type === "hc" || file.type === "hcBlack"
        ? false
        : isLightBackground(file.colors?.["editor.background"]);

  return {
    displayName: label,
    identifier: "",
    version: "",
    themes: [{ label, uiTheme: light ? "vs" : "vs-dark", path }],
    files: { [path]: raw },
  };
}
