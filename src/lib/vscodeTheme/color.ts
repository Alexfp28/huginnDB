/**
 * Colour maths for the VS Code theme importer.
 *
 * The app's own colour pipeline (`applyTheme` in `lib/themes.ts`) takes an
 * OPAQUE hex per token and runs it through `hexToHslTriple`, whose regex
 * accepts `#RGB`/`#RRGGBB` and nothing else. VS Code themes do not honour
 * that: the sampled themes carry between 26 and 52 eight-digit `#RRGGBBAA`
 * values each (`list.hoverBackground: "#44475A75"` in Dracula), because in
 * VS Code those colours are *composited over whatever is behind them* at
 * paint time.
 *
 * So the alpha is resolved HERE, at import, by flattening each translucent
 * value against the variant's own background — and `applyTheme` keeps
 * receiving exactly what it already expects. Widening the regex instead
 * would have pushed alpha into `light-dark()` and into every consumer of a
 * colour token, to express something the app's palette has no concept of.
 */

/** Straight RGB plus straight (non-premultiplied) alpha in 0..1. */
export interface Rgba {
  r: number;
  g: number;
  b: number;
  a: number;
}

const HEX_RE = /^#?([0-9a-f]{3,8})$/i;

/**
 * Parse any hex form VS Code themes use: `#RGB`, `#RGBA`, `#RRGGBB` and
 * `#RRGGBBAA`. Returns `null` for anything else — including the named CSS
 * colours and `rgba()` strings the format technically tolerates, which the
 * caller must treat as "key absent" rather than guessing.
 */
export function parseHex(value: string | undefined | null): Rgba | null {
  if (!value) return null;
  const m = HEX_RE.exec(value.trim());
  if (!m) return null;
  let v = m[1];
  if (v.length === 3 || v.length === 4) {
    v = v
      .split("")
      .map((c) => c + c)
      .join("");
  }
  if (v.length !== 6 && v.length !== 8) return null;
  const n = parseInt(v.slice(0, 6), 16);
  const a = v.length === 8 ? parseInt(v.slice(6, 8), 16) / 255 : 1;
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255, a };
}

/** Back to an opaque `#rrggbb` — alpha is dropped, so callers flatten first. */
export function toHex({ r, g, b }: Pick<Rgba, "r" | "g" | "b">): string {
  const hx = (n: number) =>
    Math.max(0, Math.min(255, Math.round(n)))
      .toString(16)
      .padStart(2, "0");
  return `#${hx(r)}${hx(g)}${hx(b)}`;
}

/**
 * Composite `value` over `backdrop` using `value`'s alpha — the "source over"
 * operator, which is what VS Code's renderer does with these colours.
 * `backdrop` is expected to be opaque (the variant's `editor.background`);
 * any alpha on it is ignored rather than producing a still-translucent
 * result the app could not use.
 */
export function flattenAlpha(value: string, backdrop: string): string | null {
  const fg = parseHex(value);
  const bg = parseHex(backdrop);
  if (!fg) return null;
  if (fg.a >= 1) return toHex(fg);
  if (!bg) return null;
  return toHex({
    r: fg.r * fg.a + bg.r * (1 - fg.a),
    g: fg.g * fg.a + bg.g * (1 - fg.a),
    b: fg.b * fg.a + bg.b * (1 - fg.a),
  });
}

/** WCAG relative luminance of an opaque colour. */
export function relativeLuminance({ r, g, b }: Pick<Rgba, "r" | "g" | "b">): number {
  const lin = (c: number) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

/** WCAG contrast ratio, 1..21. Returns 1 when either colour fails to parse,
 *  so an unparseable pair reads as "worst case" and gets corrected. */
export function contrastRatio(a: string, b: string): number {
  const ca = parseHex(a);
  const cb = parseHex(b);
  if (!ca || !cb) return 1;
  const la = relativeLuminance(ca);
  const lb = relativeLuminance(cb);
  const [hi, lo] = la > lb ? [la, lb] : [lb, la];
  return (hi + 0.05) / (lo + 0.05);
}

/** Mix two opaque colours, `amount` = how much of `b` (0..1). */
export function mix(a: string, b: string, amount: number): string | null {
  const ca = parseHex(a);
  const cb = parseHex(b);
  if (!ca || !cb) return null;
  const t = Math.max(0, Math.min(1, amount));
  return toHex({
    r: ca.r + (cb.r - ca.r) * t,
    g: ca.g + (cb.g - ca.g) * t,
    b: ca.b + (cb.b - ca.b) * t,
  });
}

/**
 * Nudge a colour toward white (`amount > 0`) or black (`amount < 0`).
 * Used to derive `brandHover` when the theme states no `button.hoverBackground`
 * — the app's brand language wants a *lighter* hover on a dark variant and a
 * deeper one on a light variant, which is a direction one hex cannot imply
 * (see the `brandHover` note in `lib/themes.ts`).
 */
export function shift(hex: string, amount: number): string | null {
  return mix(hex, amount >= 0 ? "#ffffff" : "#000000", Math.abs(amount));
}

/**
 * Push `fg` away from `bg` until the pair clears `minRatio`, stopping at the
 * first step that does — so a colour that only just fails is nudged, not
 * flattened to black or white. Returns `fg` untouched when it already
 * passes, and the pole itself when even that falls short (AAA against a
 * mid-grey, say); a short pair still beats an unreadable one.
 *
 * **Which pole is decided by measuring, not by a luminance threshold.** The
 * intuitive `luminance > 0.5 ? black : white` is wrong, and wrong precisely
 * in the mid-greys where it matters: WCAG relative luminance is not
 * perceptual lightness, so `#808080` sits at 0.216 and gets sent toward
 * white for a ratio of 3.9 — when black would have given it 5.3. The
 * break-even point is near 0.179, and rather than hard-code that constant
 * both poles are simply tried.
 *
 * This is the step that keeps an imported theme legible. Without it a theme
 * whose `list.hoverBackground` is nearly its `editor.foreground` produces a
 * selected grid row with invisible text — and unlike VS Code, this palette
 * has no per-widget override to rescue it afterwards.
 */
export function ensureContrast(fg: string, bg: string, minRatio: number): string {
  if (contrastRatio(fg, bg) >= minRatio) return fg;
  if (!parseHex(bg) || !parseHex(fg)) return fg;
  const pole = contrastRatio("#000000", bg) >= contrastRatio("#ffffff", bg) ? "#000000" : "#ffffff";
  let best = fg;
  for (let step = 1; step <= 20; step += 1) {
    const candidate = mix(fg, pole, step / 20);
    if (!candidate) break;
    best = candidate;
    if (contrastRatio(candidate, bg) >= minRatio) return candidate;
  }
  return best;
}
