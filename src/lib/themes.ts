// Theme presets + helpers.
// Each theme is a flat record of CSS variable values applied to <html>.
// Values are hex (for the native color input). They are converted to
// "H S% L%" at apply time because that's what the Tailwind config expects.

export type ThemeMode = "light" | "dark";

export interface Theme {
  id: string;
  name: string;
  mode: ThemeMode;
  builtin?: boolean;
  colors: ThemeColors;
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
  destructive: string;
  destructiveForeground: string;
  border: string;
  input: string;
  ring: string;
}

export const COLOR_KEYS: { key: keyof ThemeColors; label: string }[] = [
  { key: "background", label: "Background" },
  { key: "foreground", label: "Foreground" },
  { key: "card", label: "Card" },
  { key: "cardForeground", label: "Card text" },
  { key: "primary", label: "Primary" },
  { key: "primaryForeground", label: "Primary text" },
  { key: "secondary", label: "Secondary" },
  { key: "secondaryForeground", label: "Secondary text" },
  { key: "muted", label: "Muted" },
  { key: "mutedForeground", label: "Muted text" },
  { key: "accent", label: "Accent" },
  { key: "accentForeground", label: "Accent text" },
  { key: "brand", label: "Brand" },
  { key: "brandForeground", label: "Brand text" },
  { key: "popover", label: "Popover" },
  { key: "popoverForeground", label: "Popover text" },
  { key: "destructive", label: "Destructive" },
  { key: "destructiveForeground", label: "Destructive text" },
  { key: "border", label: "Border" },
  { key: "input", label: "Input border" },
  { key: "ring", label: "Focus ring" },
];

export const BUILT_IN_THEMES: Theme[] = [
  {
    id: "dark",
    name: "HuginnDB Dark",
    mode: "dark",
    builtin: true,
    colors: {
      background: "#0e1116",
      foreground: "#f5f5f7",
      card: "#13161c",
      cardForeground: "#f5f5f7",
      popover: "#13161c",
      popoverForeground: "#f5f5f7",
      primary: "#f5f5f7",
      primaryForeground: "#13161c",
      secondary: "#1a1d24",
      secondaryForeground: "#f5f5f7",
      muted: "#1f232b",
      mutedForeground: "#8b8f99",
      accent: "#262a33",
      accentForeground: "#f5f5f7",
      brand: "#0f83fd",
      brandForeground: "#ffffff",
      destructive: "#b1342a",
      destructiveForeground: "#fafafa",
      border: "#262a33",
      input: "#262a33",
      ring: "#0f83fd",
    },
  },
  {
    id: "light",
    name: "HuginnDB Light",
    mode: "light",
    builtin: true,
    colors: {
      background: "#ffffff",
      foreground: "#0a0a0c",
      card: "#ffffff",
      cardForeground: "#0a0a0c",
      popover: "#ffffff",
      popoverForeground: "#0a0a0c",
      primary: "#18181b",
      primaryForeground: "#fafafa",
      secondary: "#f4f4f5",
      secondaryForeground: "#18181b",
      muted: "#f4f4f5",
      mutedForeground: "#71717a",
      accent: "#e4e4e7",
      accentForeground: "#18181b",
      brand: "#0f83fd",
      brandForeground: "#ffffff",
      destructive: "#dc2626",
      destructiveForeground: "#fafafa",
      border: "#e4e4e7",
      input: "#e4e4e7",
      ring: "#0f83fd",
    },
  },
  {
    id: "dim",
    name: "Dim",
    mode: "dark",
    builtin: true,
    colors: {
      background: "#1c1f26",
      foreground: "#d8dce4",
      card: "#22262e",
      cardForeground: "#d8dce4",
      popover: "#22262e",
      popoverForeground: "#d8dce4",
      primary: "#7dd3fc",
      primaryForeground: "#0c1118",
      secondary: "#2a2f38",
      secondaryForeground: "#d8dce4",
      muted: "#262a32",
      mutedForeground: "#969ca9",
      accent: "#323844",
      accentForeground: "#d8dce4",
      brand: "#7dd3fc",
      brandForeground: "#0c1118",
      destructive: "#ef4444",
      destructiveForeground: "#fef2f2",
      border: "#323844",
      input: "#323844",
      ring: "#7dd3fc",
    },
  },
  {
    id: "solarized-dark",
    name: "Solarized Dark",
    mode: "dark",
    builtin: true,
    colors: {
      background: "#002b36",
      foreground: "#eee8d5",
      card: "#073642",
      cardForeground: "#eee8d5",
      popover: "#073642",
      popoverForeground: "#eee8d5",
      primary: "#b58900",
      primaryForeground: "#002b36",
      secondary: "#0a3a47",
      secondaryForeground: "#eee8d5",
      muted: "#0a3a47",
      mutedForeground: "#93a1a1",
      accent: "#268bd2",
      accentForeground: "#fdf6e3",
      brand: "#268bd2",
      brandForeground: "#fdf6e3",
      destructive: "#dc322f",
      destructiveForeground: "#fdf6e3",
      border: "#0a3a47",
      input: "#0a3a47",
      ring: "#268bd2",
    },
  },
  {
    // Inspired by Anthropic's Claude product palette: warm paper-cream
    // background, terracotta-orange accent, soft sepia greys for text and
    // borders. Aims for the same calm, document-like feel as Claude.ai.
    id: "claude-light",
    name: "Claude Light",
    mode: "light",
    builtin: true,
    colors: {
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
      destructive: "#b1342a",
      destructiveForeground: "#fbfaf3",
      border: "#d9d5c1",
      input: "#d9d5c1",
      ring: "#c96442",
    },
  },
  {
    id: "claude-dark",
    name: "Claude Dark",
    mode: "dark",
    builtin: true,
    colors: {
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
      destructive: "#d4684a",
      destructiveForeground: "#1f1e1b",
      border: "#3a3730",
      input: "#3a3730",
      ring: "#d97757",
    },
  },
  {
    id: "high-contrast",
    name: "High Contrast",
    mode: "dark",
    builtin: true,
    colors: {
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
      destructive: "#ff5252",
      destructiveForeground: "#000000",
      border: "#ffffff",
      input: "#ffffff",
      ring: "#ffeb3b",
    },
  },
];

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
  destructive: "--destructive",
  destructiveForeground: "--destructive-foreground",
  border: "--border",
  input: "--input",
  ring: "--ring",
};

export function applyTheme(theme: Theme) {
  const root = document.documentElement;
  if (theme.mode === "dark") root.classList.add("dark");
  else root.classList.remove("dark");
  for (const key of Object.keys(theme.colors) as (keyof ThemeColors)[]) {
    const hsl = hexToHslTriple(theme.colors[key]);
    if (hsl) root.style.setProperty(VAR_NAMES[key], hsl);
  }
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
