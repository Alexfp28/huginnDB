// Theme presets + helpers.
// Each theme FAMILY declares both its light and dark variant together, and
// both are written to <html> at once via CSS `light-dark()` — the browser
// picks the right one based on `color-scheme`, set explicitly by the app
// (never `prefers-color-scheme`, since the light/dark toggle is manual).
// Values are hex (for the native color input); converted to full `hsl(...)`
// colors at apply time.

export type ThemeMode = "light" | "dark";

export interface ThemeFamily {
  id: string;
  name: string;
  builtin?: boolean;
  light: ThemeColors;
  dark: ThemeColors;
}

export interface ThemeColors {
  background: string;
  foreground: string;
  card: string;
  cardForeground: string;
  popover: string;
  popoverForeground: string;
  primary: string;
  primaryForeground: string;
  secondary: string;
  secondaryForeground: string;
  muted: string;
  mutedForeground: string;
  accent: string;
  accentForeground: string;
  /**
   * Action / state accent ("brand"). Distinct from `accent`, which is a
   * neutral hover surface. `brand` is the one saturated colour the app is
   * allowed to use for affordances that mean "do this" or "this is live"
   * (primary buttons, focus ring, the active-connection dot). Each theme
   * sets its own so the colour matches the theme's character instead of a
   * single hard-coded blue clashing with e.g. the Claude / Solarized palettes.
   */
  brand: string;
  brandForeground: string;
  /**
   * The `brand` surface under the pointer. The brand palette used to be a
   * single colour and every hover was `bg-brand/90` — a *transparency*, which
   * on a dark surface reads as the accent fading into the background instead of
   * lighting up. The brand language calls for the opposite (dark: a lighter,
   * more electric blue; light: a deeper one), and that direction can't be
   * derived from one hex, so each theme states it.
   */
  brandHover: string;
  /**
   * Semantic state accents, distinct from `brand` and `destructive`.
   * `success` = healthy / confirmed (live connection dot, valid JSON, active
   * DB); `warning` = caution that isn't an error (destructive-rebuild notice,
   * superuser flag). Previously hard-coded per component as emerald-400 /
   * amber-500, which ignored the active theme — now each theme sets its own so
   * custom themes recolour them like every other token.
   */
  success: string;
  successForeground: string;
  warning: string;
  warningForeground: string;
  /**
   * Data-semantic accent hues (text/icon only, so no foreground pair):
   * `pk` marks a primary-key column, `fk` a foreign-key column, `numeric`
   * numeric cell values. Kept out of `COLOR_KEYS` (not shown in the Appearance
   * editor) as niche system accents, but still per-theme so custom themes
   * recolour them. See index.css for the light/dark default rationale.
   */
  pk: string;
  fk: string;
  numeric: string;
  destructive: string;
  destructiveForeground: string;
  border: string;
  input: string;
  ring: string;
}

/**
 * The editable colour tokens, in declaration order, each with the i18n key
 * for its display name. The names are user-facing copy, so they live in the
 * locale files rather than here — a literal English string here would render
 * untranslated in the Appearance editor no matter what language the app is
 * set to, which is exactly what it used to do.
 */
export const COLOR_KEYS: { key: keyof ThemeColors; labelKey: string }[] = [
  { key: "background", labelKey: "settings.appearance.color.background" },
  { key: "foreground", labelKey: "settings.appearance.color.foreground" },
  { key: "card", labelKey: "settings.appearance.color.card" },
  { key: "cardForeground", labelKey: "settings.appearance.color.cardForeground" },
  { key: "primary", labelKey: "settings.appearance.color.primary" },
  { key: "primaryForeground", labelKey: "settings.appearance.color.primaryForeground" },
  { key: "secondary", labelKey: "settings.appearance.color.secondary" },
  { key: "secondaryForeground", labelKey: "settings.appearance.color.secondaryForeground" },
  { key: "muted", labelKey: "settings.appearance.color.muted" },
  { key: "mutedForeground", labelKey: "settings.appearance.color.mutedForeground" },
  { key: "accent", labelKey: "settings.appearance.color.accent" },
  { key: "accentForeground", labelKey: "settings.appearance.color.accentForeground" },
  { key: "brand", labelKey: "settings.appearance.color.brand" },
  { key: "brandForeground", labelKey: "settings.appearance.color.brandForeground" },
  { key: "brandHover", labelKey: "settings.appearance.color.brandHover" },
  { key: "popover", labelKey: "settings.appearance.color.popover" },
  { key: "popoverForeground", labelKey: "settings.appearance.color.popoverForeground" },
  { key: "success", labelKey: "settings.appearance.color.success" },
  { key: "successForeground", labelKey: "settings.appearance.color.successForeground" },
  { key: "warning", labelKey: "settings.appearance.color.warning" },
  { key: "warningForeground", labelKey: "settings.appearance.color.warningForeground" },
  { key: "destructive", labelKey: "settings.appearance.color.destructive" },
  { key: "destructiveForeground", labelKey: "settings.appearance.color.destructiveForeground" },
  { key: "border", labelKey: "settings.appearance.color.border" },
  { key: "input", labelKey: "settings.appearance.color.input" },
  { key: "ring", labelKey: "settings.appearance.color.ring" },
];

/**
 * Groups COLOR_KEYS for the Appearance colour editor, replacing the old flat
 * 26-row grid (every token in declaration order, unrelated ones side by
 * side) with sections a user can actually scan: surfaces paired with their
 * own text colour, then actions/brand, semantic status colours, and finally
 * borders/focus. Order here is display order; COLOR_KEYS stays the single
 * source of truth for label keys and for themeTransfer.ts's key enumeration
 * (which doesn't care about grouping).
 */
export const COLOR_GROUPS: { id: string; titleKey: string; keys: (keyof ThemeColors)[] }[] = [
  {
    id: "surfaces",
    titleKey: "settings.appearance.colorGroup.surfaces",
    keys: [
      "background",
      "foreground",
      "card",
      "cardForeground",
      "popover",
      "popoverForeground",
      "secondary",
      "secondaryForeground",
      "muted",
      "mutedForeground",
      "accent",
      "accentForeground",
    ],
  },
  {
    id: "actions",
    titleKey: "settings.appearance.colorGroup.actions",
    keys: ["primary", "primaryForeground", "brand", "brandForeground", "brandHover"],
  },
  {
    id: "status",
    titleKey: "settings.appearance.colorGroup.status",
    keys: [
      "success",
      "successForeground",
      "warning",
      "warningForeground",
      "destructive",
      "destructiveForeground",
    ],
  },
  {
    id: "borders",
    titleKey: "settings.appearance.colorGroup.borders",
    keys: ["border", "input", "ring"],
  },
];

export const BUILT_IN_THEMES: ThemeFamily[] = [
  {
    // The HuginnDB family. Dark: a slate/navy ramp under one electric blue —
    // four surface levels in depth order, background #020617 (the deepest,
    // what the editor and grid sit on), card #0b1220 (panels, cards, rails),
    // popover/secondary #111827 (menus, dialogs, the tab-strip trench) and
    // accent #1e293b (the pointer/selected surface). `border` shares that
    // last step: at this contrast a hairline that reads as a border and a
    // hover fill that reads as a surface are the same value. Light: `card`
    // (#f8fafc) is deliberately *darker* than `background` (#ffffff) —
    // surfaces recede from a white page instead of lifting off a grey one —
    // and the pointer/selected surface is the blue-tinted #eef5ff rather
    // than a neutral grey, which is what makes a selected grid row or menu
    // item read as "azul muy suave" in light mode without spending the
    // brand blue on it.
    id: "dark",
    name: "HuginnDB",
    builtin: true,
    dark: {
      background: "#020617",
      foreground: "#f8fafc",
      card: "#0b1220",
      cardForeground: "#f8fafc",
      popover: "#111827",
      popoverForeground: "#f8fafc",
      primary: "#f8fafc",
      primaryForeground: "#0b1220",
      secondary: "#111827",
      secondaryForeground: "#f8fafc",
      muted: "#111827",
      mutedForeground: "#94a3b8",
      accent: "#1e293b",
      accentForeground: "#f8fafc",
      brand: "#2563eb",
      brandForeground: "#ffffff",
      brandHover: "#3b82f6",
      success: "#22c55e",
      successForeground: "#04140a",
      warning: "#f59e0b",
      warningForeground: "#1a1204",
      pk: "#fbbf24",
      // Kept in the brand's blue family (was sky #38bdf8) so a foreign key
      // reads as "a link to elsewhere in the app's own accent", not a third
      // unrelated hue next to the amber key markers.
      fk: "#60a5fa",
      numeric: "#fbbf24",
      destructive: "#ef4444",
      destructiveForeground: "#ffffff",
      border: "#1e293b",
      input: "#1e293b",
      ring: "#2563eb",
    },
    light: {
      background: "#ffffff",
      foreground: "#0f172a",
      card: "#f8fafc",
      cardForeground: "#0f172a",
      popover: "#ffffff",
      popoverForeground: "#0f172a",
      primary: "#0f172a",
      primaryForeground: "#f8fafc",
      secondary: "#eef5ff",
      secondaryForeground: "#0f172a",
      muted: "#f8fafc",
      mutedForeground: "#475569",
      accent: "#eef5ff",
      accentForeground: "#0f172a",
      brand: "#2563eb",
      brandForeground: "#ffffff",
      brandHover: "#1d4ed8",
      success: "#16a34a",
      successForeground: "#ffffff",
      warning: "#d97706",
      warningForeground: "#ffffff",
      pk: "#b45309",
      fk: "#1d4ed8",
      numeric: "#b45309",
      destructive: "#dc2626",
      destructiveForeground: "#ffffff",
      border: "#d6e4f5",
      input: "#d6e4f5",
      ring: "#2563eb",
    },
  },
  {
    // Inspired by Anthropic's Claude product palette: warm paper-cream
    // background, terracotta-orange accent, soft sepia greys for text and
    // borders. Aims for the same calm, document-like feel as Claude.ai.
    id: "claude",
    name: "Claude",
    builtin: true,
    light: {
      background: "#f5f4ed",
      foreground: "#3d3929",
      card: "#fbfaf3",
      cardForeground: "#3d3929",
      popover: "#fbfaf3",
      popoverForeground: "#3d3929",
      primary: "#c96442",
      primaryForeground: "#fbfaf3",
      secondary: "#ecebe2",
      secondaryForeground: "#3d3929",
      muted: "#ecebe2",
      mutedForeground: "#7a7460",
      accent: "#e4e1d2",
      accentForeground: "#3d3929",
      brand: "#c96442",
      brandForeground: "#fbfaf3",
      brandHover: "#b0512f",
      success: "#5a8250",
      successForeground: "#fbfaf3",
      warning: "#bf7d2e",
      warningForeground: "#fbfaf3",
      pk: "#b5761f",
      fk: "#3f6f9f",
      numeric: "#b5761f",
      destructive: "#b1342a",
      destructiveForeground: "#fbfaf3",
      border: "#d9d5c1",
      input: "#d9d5c1",
      ring: "#c96442",
    },
    dark: {
      background: "#1f1e1b",
      foreground: "#e8e3d4",
      card: "#26241f",
      cardForeground: "#e8e3d4",
      popover: "#26241f",
      popoverForeground: "#e8e3d4",
      primary: "#d97757",
      primaryForeground: "#1f1e1b",
      secondary: "#2d2b25",
      secondaryForeground: "#e8e3d4",
      muted: "#2d2b25",
      mutedForeground: "#a39a83",
      accent: "#3a3730",
      accentForeground: "#e8e3d4",
      brand: "#d97757",
      brandForeground: "#1f1e1b",
      brandHover: "#e89575",
      success: "#7fa86f",
      successForeground: "#1f1e1b",
      warning: "#d9a441",
      warningForeground: "#1f1e1b",
      pk: "#d9a441",
      fk: "#8fb7d4",
      numeric: "#d9a441",
      destructive: "#d4684a",
      destructiveForeground: "#1f1e1b",
      border: "#3a3730",
      input: "#3a3730",
      ring: "#d97757",
    },
  },
  {
    // A near-black, high-saturation dark theme built around a signature
    // neon green — deliberately more vivid than every other built-in theme
    // (which stay in muted/desaturated ranges), including the semantic
    // accents (fk/warning/destructive) picked as neon cyan/amber/pink so the
    // whole palette reads as one coherent "neon" family rather than a single
    // green accent dropped into an otherwise ordinary dark theme. Light: same
    // lab-on-paper energy but on a bright mint-white surface, so the
    // saturated hues have to deepen to stay legible (a raw #39ff14 on white
    // has poor contrast) while keeping the family's signature — green
    // primary/brand, cyan fk, yellow pk/numeric, hot-pink destructive —
    // recognisable at a glance.
    id: "neon",
    name: "Neon",
    builtin: true,
    dark: {
      background: "#05080a",
      foreground: "#e8fff2",
      card: "#0a1710",
      cardForeground: "#e8fff2",
      popover: "#0a1710",
      popoverForeground: "#e8fff2",
      primary: "#39ff14",
      primaryForeground: "#04120a",
      secondary: "#101a13",
      secondaryForeground: "#e8fff2",
      muted: "#101a13",
      mutedForeground: "#7fa693",
      accent: "#173325",
      accentForeground: "#39ff14",
      brand: "#39ff14",
      brandForeground: "#04120a",
      brandHover: "#6bff54",
      success: "#00e676",
      successForeground: "#04120a",
      warning: "#ffea00",
      warningForeground: "#1a1204",
      pk: "#faff00",
      fk: "#00eaff",
      numeric: "#faff00",
      destructive: "#ff1053",
      destructiveForeground: "#1a0208",
      border: "#1b2a20",
      input: "#1b2a20",
      ring: "#39ff14",
    },
    light: {
      background: "#f3fff8",
      foreground: "#04170d",
      card: "#ffffff",
      cardForeground: "#04170d",
      popover: "#ffffff",
      popoverForeground: "#04170d",
      primary: "#12a150",
      primaryForeground: "#f3fff8",
      secondary: "#e3fbea",
      secondaryForeground: "#073c1c",
      muted: "#eafcf1",
      mutedForeground: "#3c6b52",
      accent: "#d8f7e3",
      accentForeground: "#0a3d1f",
      brand: "#12a150",
      brandForeground: "#ffffff",
      brandHover: "#0d7d3e",
      success: "#12a150",
      successForeground: "#ffffff",
      warning: "#c98a00",
      warningForeground: "#241a00",
      pk: "#9c7c00",
      fk: "#0089a8",
      numeric: "#9c7c00",
      destructive: "#d81b46",
      destructiveForeground: "#ffffff",
      border: "#cdeedb",
      input: "#cdeedb",
      ring: "#12a150",
    },
  },
  {
    // Warm "beach" palette. Light: sun-bleached sand background, a single
    // saturated ocean-teal brand/ring accent, and coral for destructive
    // actions — reads as bright daylight, not a night palette. Dark: a
    // night-beach counterpart (deep ocean-teal surfaces, sand-cream text)
    // keeping the same coral primary and teal brand hues, both brightened
    // slightly to stay vivid against the dark background the way Claude Dark
    // brightens Claude Light's terracotta.
    id: "summer",
    name: "Summer",
    builtin: true,
    light: {
      background: "#fef9ef",
      foreground: "#22333b",
      card: "#fffdf6",
      cardForeground: "#22333b",
      popover: "#fffdf6",
      popoverForeground: "#22333b",
      primary: "#ff6b4a",
      primaryForeground: "#fff8f2",
      secondary: "#eaf6f6",
      secondaryForeground: "#14514f",
      muted: "#f3ecd9",
      mutedForeground: "#8a7f66",
      accent: "#d9f2ef",
      accentForeground: "#0f4c46",
      brand: "#00b8a9",
      brandForeground: "#ffffff",
      brandHover: "#009b8f",
      success: "#2fae60",
      successForeground: "#f5fff8",
      warning: "#f4a300",
      warningForeground: "#241300",
      pk: "#e2711d",
      fk: "#1c8c9c",
      numeric: "#e2711d",
      destructive: "#e5484d",
      destructiveForeground: "#fff5f5",
      border: "#f0e2c0",
      input: "#f0e2c0",
      ring: "#00b8a9",
    },
    dark: {
      background: "#0b2027",
      foreground: "#fdf6e8",
      card: "#102a32",
      cardForeground: "#fdf6e8",
      popover: "#102a32",
      popoverForeground: "#fdf6e8",
      primary: "#ff7a5c",
      primaryForeground: "#1a0b06",
      secondary: "#163a40",
      secondaryForeground: "#bfeae6",
      muted: "#13343b",
      mutedForeground: "#8db3ae",
      accent: "#1d4a50",
      accentForeground: "#bdf0ea",
      brand: "#1fd8c4",
      brandForeground: "#062521",
      brandHover: "#4de9d8",
      success: "#4ecb84",
      successForeground: "#06210f",
      warning: "#ffbf4d",
      warningForeground: "#2b1900",
      pk: "#ffbf6b",
      fk: "#5fd0e0",
      numeric: "#ffbf6b",
      destructive: "#ff6161",
      destructiveForeground: "#2b0505",
      border: "#1d4a50",
      input: "#1d4a50",
      ring: "#1fd8c4",
    },
  },
  {
    // Maximum-contrast idiom: pure black/white inverted, solid black border
    // and text (or the reverse), no greyscale softening, and the identical
    // signal yellow for primary/brand/ring on both sides — a yellow chip
    // with black text reads as "high contrast" regardless of which side is
    // inverted.
    id: "high-contrast",
    name: "High Contrast",
    builtin: true,
    dark: {
      background: "#000000",
      foreground: "#ffffff",
      card: "#0a0a0a",
      cardForeground: "#ffffff",
      popover: "#0a0a0a",
      popoverForeground: "#ffffff",
      primary: "#ffeb3b",
      primaryForeground: "#000000",
      secondary: "#1a1a1a",
      secondaryForeground: "#ffffff",
      muted: "#1a1a1a",
      mutedForeground: "#cccccc",
      accent: "#2a2a2a",
      accentForeground: "#ffeb3b",
      brand: "#ffeb3b",
      brandForeground: "#000000",
      brandHover: "#fff59d",
      success: "#00e676",
      successForeground: "#000000",
      warning: "#ffb300",
      warningForeground: "#000000",
      pk: "#ffd54f",
      fk: "#40c4ff",
      numeric: "#ffd54f",
      destructive: "#ff5252",
      destructiveForeground: "#000000",
      border: "#ffffff",
      input: "#ffffff",
      ring: "#ffeb3b",
    },
    light: {
      background: "#ffffff",
      foreground: "#000000",
      card: "#f5f5f5",
      cardForeground: "#000000",
      popover: "#f5f5f5",
      popoverForeground: "#000000",
      primary: "#ffeb3b",
      primaryForeground: "#000000",
      secondary: "#f0f0f0",
      secondaryForeground: "#000000",
      muted: "#eeeeee",
      mutedForeground: "#333333",
      accent: "#e0e0e0",
      accentForeground: "#000000",
      brand: "#ffeb3b",
      brandForeground: "#000000",
      brandHover: "#fbc02d",
      success: "#00873c",
      successForeground: "#ffffff",
      warning: "#ff6f00",
      warningForeground: "#000000",
      pk: "#8a6d00",
      fk: "#0066cc",
      numeric: "#8a6d00",
      destructive: "#c62828",
      destructiveForeground: "#ffffff",
      border: "#000000",
      input: "#000000",
      ring: "#7a5d00",
    },
  },
];

/**
 * Ids of the pre-consolidation themes (one per light/dark variant, linked by
 * a `pairId` field that no longer exists) mapped to the family id that now
 * covers them. Applied wherever a `themeId` arrives from outside the store
 * (an environment's persisted/imported `theme_id`, a locally persisted
 * `themeId`) — Rust never interprets this string (see `Environment.theme_id`
 * in `src-tauri/src/tab_state.rs`), so the shim lives here only.
 */
export const LEGACY_THEME_ID_MAP: Record<string, string> = {
  dark: "dark",
  light: "dark",
  "claude-light": "claude",
  "claude-dark": "claude",
  neon: "neon",
  "neon-light": "neon",
  summer: "summer",
  "summer-dark": "summer",
  "high-contrast": "high-contrast",
  "high-contrast-light": "high-contrast",
};

/** The mode each pre-consolidation id implied — used only to derive the
 *  initial global `mode` when migrating a persisted `themeId`. */
export const LEGACY_THEME_MODE_MAP: Record<string, ThemeMode> = {
  dark: "dark",
  light: "light",
  "claude-light": "light",
  "claude-dark": "dark",
  neon: "dark",
  "neon-light": "light",
  summer: "light",
  "summer-dark": "dark",
  "high-contrast": "dark",
  "high-contrast-light": "light",
};

export function resolveLegacyThemeId(id: string): string {
  return LEGACY_THEME_ID_MAP[id] ?? id;
}

const VAR_NAMES: Record<keyof ThemeColors, string> = {
  background: "--background",
  foreground: "--foreground",
  card: "--card",
  cardForeground: "--card-foreground",
  popover: "--popover",
  popoverForeground: "--popover-foreground",
  primary: "--primary",
  primaryForeground: "--primary-foreground",
  secondary: "--secondary",
  secondaryForeground: "--secondary-foreground",
  muted: "--muted",
  mutedForeground: "--muted-foreground",
  accent: "--accent",
  accentForeground: "--accent-foreground",
  brand: "--brand",
  brandForeground: "--brand-foreground",
  brandHover: "--brand-hover",
  success: "--success",
  successForeground: "--success-foreground",
  warning: "--warning",
  warningForeground: "--warning-foreground",
  pk: "--pk",
  fk: "--fk",
  numeric: "--numeric",
  destructive: "--destructive",
  destructiveForeground: "--destructive-foreground",
  border: "--border",
  input: "--input",
  ring: "--ring",
};

/**
 * Rewrites every CSS variable on <html> as `light-dark(light, dark)` — one
 * write covers both modes. Call whenever the DATA of the active family
 * changes (family switch, colour edit, fork, reset, environment override,
 * rehydrate). For a pure mode toggle (family unchanged) use
 * `applyColorScheme` instead — that's the whole point of storing both
 * variants in one variable: the toggle becomes O(1) instead of reapplying
 * all ~28 tokens.
 */
export function applyTheme(family: { light: ThemeColors; dark: ThemeColors }, mode: ThemeMode) {
  const root = document.documentElement;
  for (const key of Object.keys(VAR_NAMES) as (keyof ThemeColors)[]) {
    const light = hexToHslColor(family.light[key]);
    const dark = hexToHslColor(family.dark[key]);
    // Both sides must resolve — a custom theme persisted before a token
    // existed (or with an invalid hex) is missing it on at least one side,
    // and a `light-dark()` with only one real argument makes no sense.
    // Removing the property lets the index.css stylesheet default take over.
    if (light && dark) {
      root.style.setProperty(VAR_NAMES[key], `light-dark(${light}, ${dark})`);
    } else {
      root.style.removeProperty(VAR_NAMES[key]);
    }
  }
  applyColorScheme(mode);
}

/**
 * The O(1) mode toggle: never touches a colour variable (each already
 * contains both variants via `light-dark()`) — only decides which one the
 * browser paints, plus the Tailwind `.dark` class hook (`darkMode:["class"]`,
 * consumed by `dark:` variants in several components — independent of
 * `color-scheme`, neither mechanism substitutes for the other).
 */
export function applyColorScheme(mode: ThemeMode) {
  const root = document.documentElement;
  // A single keyword, not "light dark" — the toggle is manual, so
  // `light-dark()` must resolve to what the user picked, never to
  // `prefers-color-scheme`.
  root.style.setProperty("color-scheme", mode);
  root.classList.toggle("dark", mode === "dark");
}

function hexToHslColor(hex: string | undefined): string | null {
  if (!hex) return null;
  const triple = hexToHslTriple(hex);
  return triple ? `hsl(${triple})` : null;
}

export function hexToHslTriple(hex: string): string | null {
  const rgb = hexToRgb(hex);
  if (!rgb) return null;
  const [h, s, l] = rgbToHsl(rgb[0], rgb[1], rgb[2]);
  return `${Math.round(h)} ${Math.round(s)}% ${Math.round(l)}%`;
}

function hexToRgb(hex: string): [number, number, number] | null {
  const m = /^#?([a-f\d]{6}|[a-f\d]{3})$/i.exec(hex.trim());
  if (!m) return null;
  let v = m[1];
  if (v.length === 3) v = v.split("").map((c) => c + c).join("");
  const num = parseInt(v, 16);
  return [(num >> 16) & 255, (num >> 8) & 255, num & 255];
}

function rgbToHsl(r: number, g: number, b: number): [number, number, number] {
  r /= 255;
  g /= 255;
  b /= 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  let h = 0;
  let s = 0;
  const l = (max + min) / 2;
  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    switch (max) {
      case r:
        h = (g - b) / d + (g < b ? 6 : 0);
        break;
      case g:
        h = (b - r) / d + 2;
        break;
      case b:
        h = (r - g) / d + 4;
        break;
    }
    h /= 6;
  }
  return [h * 360, s * 100, l * 100];
}
