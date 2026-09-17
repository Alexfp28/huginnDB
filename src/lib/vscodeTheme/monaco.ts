/**
 * VS Code theme -> Monaco `IStandaloneThemeData`.
 *
 * This is the half of the import that is a real translation rather than a
 * derivation: Monaco IS VS Code's editor, so `tokenColors` and the `editor.*`
 * colour keys mean exactly what they mean upstream. What the user sees in the
 * SQL editor after importing Dracula is Dracula, not an approximation of it.
 *
 * Two shape differences have to be handled anyway:
 *
 * - **Token rules take a bare 6-digit hex, no `#` and no alpha.** Monaco
 *   throws on anything else, so a translucent `settings.foreground` is
 *   flattened against the theme's editor background first.
 * - **Editor colours keep their alpha** (`editor.selectionBackground` is
 *   *meant* to be translucent - the app's own `huginn-dark` already ships
 *   `#2563eb59`). They are passed through, only validated.
 *
 * Unknown `colors` keys are dropped rather than forwarded: Monaco validates
 * against its own registry at `defineTheme` time, and one stray workbench key
 * takes the whole theme down with it.
 */

import type * as monaco from "monaco-editor";
import { flattenAlpha, parseHex } from "./color";
import type { VsCodeThemeFile, VsCodeUiTheme } from "./types";

/**
 * Colour-key prefixes Monaco's standalone build understands. VS Code themes
 * carry ~600 keys, the overwhelming majority of them workbench chrome Monaco
 * has no concept of (`activityBar.*`, `sideBar.*`, `statusBar.*`).
 */
const MONACO_COLOR_PREFIXES = [
  "editor.",
  "editorLineNumber.",
  "editorCursor.",
  "editorWhitespace.",
  "editorIndentGuide.",
  "editorBracketMatch.",
  "editorBracketHighlight.",
  "editorGutter.",
  "editorOverviewRuler.",
  "editorError.",
  "editorWarning.",
  "editorInfo.",
  "editorHoverWidget.",
  "editorSuggestWidget.",
  "editorWidget.",
  "editorLink.",
  "editorCodeLens.",
  "editorRuler.",
  "editorUnnecessaryCode.",
  "diffEditor.",
  "scrollbar.",
  "scrollbarSlider.",
  "minimap.",
  "minimapSlider.",
  "peekView.",
  "input.",
  "inputOption.",
  "inputValidation.",
  "dropdown.",
  "list.",
  "widget.",
  "focusBorder",
  "foreground",
  "selection.",
  "contrastBorder",
  "contrastActiveBorder",
];

function isMonacoColorKey(key: string): boolean {
  return MONACO_COLOR_PREFIXES.some((p) => (p.endsWith(".") ? key.startsWith(p) : key === p));
}

/** Monaco's base theme for a given `uiTheme`. `inherit: true` then fills
 *  every rule and colour the imported theme leaves unstated. */
export function monacoBase(uiTheme: VsCodeUiTheme): monaco.editor.BuiltinTheme {
  switch (uiTheme) {
    case "vs":
      return "vs";
    case "hc-black":
      return "hc-black";
    case "hc-light":
      // Monaco's light high-contrast base is only present in newer builds;
      // plain `vs` is the safe floor and `inherit` covers the difference.
      return "vs";
    default:
      return "vs-dark";
  }
}

/** Split a TextMate scope field into individual scopes. Themes write this
 *  three ways - a string, a comma-separated string, or an array - and all
 *  three occur across the sampled fixtures. */
export function splitScopes(scope: string | string[] | undefined): string[] {
  if (Array.isArray(scope)) return scope.flatMap((s) => splitScopes(s));
  if (typeof scope !== "string") return [];
  return scope
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Monaco wants `fontStyle` as a space-separated subset of italic/bold/
 *  underline. Anything else (`strikethrough`, which VS Code allows) is
 *  dropped rather than passed through and rejected. */
function normalizeFontStyle(raw: string | undefined): string | undefined {
  if (typeof raw !== "string") return undefined;
  const allowed = ["italic", "bold", "underline"];
  const parts = raw
    .toLowerCase()
    .split(/\s+/)
    .filter((p) => allowed.includes(p));
  // An explicit empty string means "clear inherited styling" and is
  // meaningful to Monaco, so it survives; an unparseable value does not.
  if (parts.length === 0) return raw.trim() === "" ? "" : undefined;
  return parts.join(" ");
}

/** Bare 6-digit hex, no `#`, no alpha - the only form Monaco's token rules
 *  accept. Returns `undefined` when the value cannot be reduced to one. */
function ruleColor(value: string | undefined, backdrop: string): string | undefined {
  if (!value) return undefined;
  const flat = flattenAlpha(value, backdrop);
  return flat ? flat.slice(1) : undefined;
}

/**
 * Build the Monaco theme for one variant.
 *
 * The leading `{ token: "" }` rule is what paints everything the tokenizer
 * does not classify, so it is emitted from `editor.foreground` before the
 * theme's own rules - which then override it per scope, in file order,
 * matching TextMate's last-rule-wins semantics.
 */
export function toMonacoTheme(
  theme: VsCodeThemeFile,
  uiTheme: VsCodeUiTheme,
): monaco.editor.IStandaloneThemeData {
  const colors = theme.colors ?? {};
  const isLight = uiTheme === "vs" || uiTheme === "hc-light";
  const backdrop =
    flattenAlpha(colors["editor.background"] ?? "", isLight ? "#ffffff" : "#000000") ??
    (isLight ? "#ffffff" : "#000000");

  const rules: monaco.editor.ITokenThemeRule[] = [];
  const baseForeground = ruleColor(colors["editor.foreground"], backdrop);
  if (baseForeground) rules.push({ token: "", foreground: baseForeground });

  for (const entry of theme.tokenColors ?? []) {
    const settings = entry?.settings;
    if (!settings) continue;
    const foreground = ruleColor(settings.foreground, backdrop);
    const background = ruleColor(settings.background, backdrop);
    const fontStyle = normalizeFontStyle(settings.fontStyle);
    if (!foreground && !background && fontStyle === undefined) continue;
    for (const token of splitScopes(entry.scope)) {
      rules.push({
        token,
        ...(foreground ? { foreground } : {}),
        ...(background ? { background } : {}),
        ...(fontStyle !== undefined ? { fontStyle } : {}),
      });
    }
  }

  const editorColors: Record<string, string> = {};
  for (const [key, value] of Object.entries(colors)) {
    // Alpha is preserved here on purpose - `editor.selectionBackground` and
    // the line highlight are meant to be translucent.
    if (isMonacoColorKey(key) && typeof value === "string" && parseHex(value)) {
      editorColors[key] = value;
    }
  }

  return { base: monacoBase(uiTheme), inherit: true, rules, colors: editorColors };
}
