/**
 * Workbench colours -> the app's own colour tokens.
 *
 * The two vocabularies do not line up, and cannot: VS Code names ~600 keys
 * after the widget each paints (`sideBar.background`, `list.hoverBackground`),
 * while `ThemeColors` names 30 after the ROLE each plays (`card`, `accent`,
 * `brand`). So this is a derivation, not a translation, and the import path
 * presents its result as an editable starting point rather than as "your
 * theme" - which is what makes an imperfect mapping a feature instead of a
 * bug report.
 *
 * Two rules keep it honest:
 *
 * 1. **Every fallback stays inside the theme.** A key the theme omits - and
 *    the sampled themes omit 3 to 7 of the ones needed, `menu.*` in all of
 *    them - resolves down a chain of related keys the theme DOES state, and
 *    finally to a value derived from its own `editor.background` /
 *    `editor.foreground`. Embedding VS Code's own defaults was the
 *    alternative and is worse: it injects VS Code's blue `focusBorder` into
 *    a Gruvbox import, producing a palette coherent with neither.
 *
 * 2. **Every foreground is contrast-checked against the surface it sits on**
 *    (`ensureContrast`). VS Code can rescue a bad pair with a per-widget
 *    override; this palette has no such escape hatch, so a theme whose hover
 *    surface nearly matches its text colour would otherwise ship an
 *    unreadable selected row.
 */

import type { ThemeColors } from "@/lib/themes";
import { contrastRatio, ensureContrast, flattenAlpha, mix, shift } from "./color";
import type { VsCodeThemeFile } from "./types";

/** WCAG AA for body text. Applied to every surface/foreground pair. */
const TEXT_CONTRAST = 4.5;
/** WCAG AA for non-text UI (borders, focus rings, status dots). */
const UI_CONTRAST = 3;

type Colors = Record<string, string>;

/**
 * First key that both exists and parses, flattened against `backdrop` so a
 * translucent workbench colour becomes the opaque hex `applyTheme` needs.
 * An unparseable value (a named colour, an `rgba()` string) is skipped like
 * an absent one rather than poisoning the token.
 */
function pick(colors: Colors, backdrop: string, keys: string[]): string | null {
  for (const key of keys) {
    const flattened = flattenAlpha(colors[key] ?? "", backdrop);
    if (flattened) return flattened;
  }
  return null;
}

/** Lift or sink a surface away from the base background, by the amount a
 *  panel needs to read as a distinct plane. Direction follows the variant:
 *  on dark, surfaces lift toward white; on light they sink toward black -
 *  which is also why the app's own light theme makes `card` darker than
 *  `background` rather than lighter. */
function plane(background: string, isLight: boolean, amount: number): string {
  return shift(background, isLight ? -amount : amount) ?? background;
}

/**
 * Derive one `ThemeColors` from one parsed VS Code theme variant.
 *
 * `isLight` comes from the manifest's `uiTheme` rather than from the file's
 * own `type`, because the manifest is what VS Code itself trusts and the two
 * disagree in practice.
 */
export function mapVariant(theme: VsCodeThemeFile, isLight: boolean): ThemeColors {
  const colors: Colors = theme.colors ?? {};

  // The backdrop every translucent value flattens against. It has to be
  // resolved first and unconditionally - everything below depends on it.
  const background =
    flattenAlpha(colors["editor.background"] ?? "", isLight ? "#ffffff" : "#000000") ??
    (isLight ? "#ffffff" : "#0b0b0b");
  const foregroundRaw =
    pick(colors, background, ["editor.foreground", "foreground"]) ??
    (isLight ? "#1f2328" : "#e6e6e6");
  const foreground = ensureContrast(foregroundRaw, background, TEXT_CONTRAST);

  // -- Surfaces ------------------------------------------------------------
  const card =
    pick(colors, background, [
      "sideBar.background",
      "editorWidget.background",
      "panel.background",
    ]) ?? plane(background, isLight, 0.03);
  const cardForeground = ensureContrast(
    pick(colors, card, ["sideBar.foreground", "panel.foreground"]) ?? foreground,
    card,
    TEXT_CONTRAST,
  );

  const popover =
    pick(colors, background, [
      "menu.background",
      "dropdown.background",
      "editorWidget.background",
      "quickInput.background",
    ]) ?? plane(background, isLight, 0.05);
  const popoverForeground = ensureContrast(
    pick(colors, popover, [
      "menu.foreground",
      "dropdown.foreground",
      "editorWidget.foreground",
    ]) ?? foreground,
    popover,
    TEXT_CONTRAST,
  );

  const secondary =
    pick(colors, background, [
      "editorGroupHeader.tabsBackground",
      "tab.inactiveBackground",
      "sideBarSectionHeader.background",
    ]) ?? plane(background, isLight, 0.04);
  const secondaryForeground = ensureContrast(foreground, secondary, TEXT_CONTRAST);

  const muted =
    pick(colors, background, ["input.background", "editorWidget.background"]) ??
    plane(background, isLight, 0.04);
  // `mutedForeground` is the app's de-emphasised text. A theme that states
  // none gets a mix of its own foreground into its own background - the one
  // derivation that reads as dimmed rather than as a different hue.
  const mutedForeground = ensureContrast(
    pick(colors, muted, ["descriptionForeground", "editorLineNumber.foreground"]) ??
      mix(foreground, background, 0.4) ??
      foreground,
    muted,
    UI_CONTRAST,
  );

  // `accent` is the pointer/selected surface, and the single most likely key
  // to arrive translucent (`#44475A75` in Dracula) - hence the flatten.
  const accent =
    pick(colors, background, [
      "list.activeSelectionBackground",
      "list.hoverBackground",
      "editor.selectionBackground",
    ]) ?? plane(background, isLight, 0.08);
  const accentForeground = ensureContrast(
    pick(colors, accent, ["list.activeSelectionForeground", "list.hoverForeground"]) ??
      foreground,
    accent,
    TEXT_CONTRAST,
  );

  // -- Actions -------------------------------------------------------------
  // `primary` in this palette is the high-contrast pair (shadcn's sense),
  // not the brand colour - so it is the foreground, inverted.
  const primary = foreground;
  const primaryForeground = ensureContrast(background, primary, TEXT_CONTRAST);

  const brand =
    pick(colors, background, [
      "button.background",
      "focusBorder",
      "textLink.foreground",
      "progressBar.background",
    ]) ?? (isLight ? "#2563eb" : "#3b82f6");
  const brandForeground = ensureContrast(
    pick(colors, brand, ["button.foreground"]) ?? "#ffffff",
    brand,
    TEXT_CONTRAST,
  );
  // Direction, not opacity: the brand surface under the pointer lightens on
  // dark and deepens on light. See the `brandHover` note in lib/themes.ts.
  const brandHover =
    pick(colors, background, ["button.hoverBackground"]) ??
    shift(brand, isLight ? -0.15 : 0.18) ??
    brand;

  // -- Status --------------------------------------------------------------
  const success = ensureContrast(
    pick(colors, background, [
      "gitDecoration.addedResourceForeground",
      "charts.green",
      "terminal.ansiGreen",
      "debugIcon.startForeground",
    ]) ?? (isLight ? "#16a34a" : "#22c55e"),
    background,
    UI_CONTRAST,
  );
  const warning = ensureContrast(
    pick(colors, background, [
      "editorWarning.foreground",
      "charts.yellow",
      "terminal.ansiYellow",
      "list.warningForeground",
    ]) ?? (isLight ? "#d97706" : "#f59e0b"),
    background,
    UI_CONTRAST,
  );
  const destructive = ensureContrast(
    pick(colors, background, [
      "editorError.foreground",
      "errorForeground",
      "charts.red",
      "terminal.ansiRed",
    ]) ?? (isLight ? "#dc2626" : "#ef4444"),
    background,
    UI_CONTRAST,
  );

  // -- Borders / focus -----------------------------------------------------
  const border =
    pick(colors, background, [
      "panel.border",
      "editorGroup.border",
      "contrastBorder",
      "sideBar.border",
      "widget.border",
    ]) ?? plane(background, isLight, 0.12);
  const input = pick(colors, background, ["input.border", "dropdown.border"]) ?? border;
  const ring = pick(colors, background, ["focusBorder"]) ?? brand;

  // -- Data-semantic accents (text only, no foreground pair) ---------------
  const pk = ensureContrast(
    pick(colors, background, [
      "charts.orange",
      "terminal.ansiYellow",
      "symbolIcon.keywordForeground",
    ]) ?? warning,
    background,
    UI_CONTRAST,
  );
  const fk = ensureContrast(
    pick(colors, background, ["textLink.foreground", "charts.blue", "terminal.ansiBlue"]) ??
      brand,
    background,
    UI_CONTRAST,
  );
  const numeric = ensureContrast(
    pick(colors, background, ["charts.orange", "terminal.ansiYellow"]) ?? pk,
    background,
    UI_CONTRAST,
  );

  return {
    background,
    foreground,
    card,
    cardForeground,
    popover,
    popoverForeground,
    primary,
    primaryForeground,
    secondary,
    secondaryForeground,
    muted,
    mutedForeground,
    accent,
    accentForeground,
    brand,
    brandForeground,
    brandHover,
    success,
    // The status foregrounds are what sits ON the status colour when it is
    // used as a fill, so they are derived for contrast against it rather
    // than taken from the theme - no workbench key means "text on a success
    // chip", and guessing one from an unrelated widget is how those end up
    // illegible.
    successForeground: ensureContrast(background, success, TEXT_CONTRAST),
    warning,
    warningForeground: ensureContrast(background, warning, TEXT_CONTRAST),
    pk,
    fk,
    numeric,
    destructive,
    destructiveForeground: ensureContrast(background, destructive, TEXT_CONTRAST),
    border,
    input,
    ring,
    // The scrim is the darkest neutral the theme already owns: its own
    // background on a dark variant, its own foreground on a light one -
    // the same rule the built-in families follow.
    scrim: isLight ? foreground : background,
  };
}

/** Exposed for the importer's preview: which derived pairs still sit below
 *  the readability floor, so the dialog can say so before the user commits.
 *  `ensureContrast` fixes what it can, but a mid-grey surface cannot reach
 *  4.5 against anything - those survive to here. */
export function paletteWarnings(colors: ThemeColors): string[] {
  const pairs: [keyof ThemeColors, keyof ThemeColors, number][] = [
    ["foreground", "background", TEXT_CONTRAST],
    ["cardForeground", "card", TEXT_CONTRAST],
    ["popoverForeground", "popover", TEXT_CONTRAST],
    ["accentForeground", "accent", TEXT_CONTRAST],
    ["brandForeground", "brand", TEXT_CONTRAST],
    ["mutedForeground", "muted", UI_CONTRAST],
  ];
  return pairs
    .filter(([fg, bg, min]) => contrastRatio(colors[fg], colors[bg]) < min)
    .map(([fg, bg]) => `${fg}/${bg}`);
}
