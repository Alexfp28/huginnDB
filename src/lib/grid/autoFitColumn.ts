/**
 * Column auto-fit measurement for the data grid — the width math behind
 * HeidiSQL's "double-click a column's edge and it grows to fit its content".
 *
 * Measurement goes through one offscreen canvas instead of the DOM on
 * purpose: `measureText` costs no layout, so a column holding thousands of
 * rows is measured in a single pass. The obvious alternative (a hidden probe
 * element read back through `offsetWidth`) forces a reflow per cell, which on
 * a full page of rows is exactly the kind of stall the grid's own resize path
 * was written to avoid (see `startColumnResize` in `DataGrid.tsx`).
 */

/** Lazily-created, module-shared 2D context. Never drawn into. */
let sharedCtx: CanvasRenderingContext2D | null | undefined;

function measureCtx(): CanvasRenderingContext2D | null {
  if (sharedCtx === undefined) {
    sharedCtx = document.createElement("canvas").getContext("2d");
  }
  return sharedCtx;
}

/**
 * Longest prefix of a cell value we bother measuring. A cell can hold
 * megabytes (a JSON document, a base64 blob), and measuring all of it would
 * be pointless as well as slow: at the grid's smallest font a 512-character
 * string already measures wider than any width the caller's `max` clamp will
 * allow, so the slice can never change the clamped result.
 */
const MEASURE_CHAR_CAP = 512;

/**
 * Build a canvas `font` shorthand matching what a real grid element renders
 * with. The font family comes from the theme's CSS (`font-mono` for cells,
 * the app's sans stack for headers), so it can't be hardcoded here — a
 * throwaway probe element carrying the same class list is appended to `host`
 * and its computed style read back. One reflow per auto-fit, not per cell.
 *
 * @param host - Element to parent the probe to, so it inherits the grid's
 *   cascade. Falls back to `document.body`.
 * @param className - Tailwind classes that decide the family/weight.
 * @param fontSizePx - Rendered size in px (the grid's font sizes are dynamic,
 *   derived from the `rowHeight` zoom preference).
 */
export function resolveCanvasFont(
  host: HTMLElement | null,
  className: string,
  fontSizePx: number,
): string {
  const parent = host ?? document.body;
  const probe = document.createElement("span");
  probe.className = className;
  probe.style.position = "absolute";
  probe.style.visibility = "hidden";
  probe.style.pointerEvents = "none";
  probe.style.fontSize = `${fontSizePx}px`;
  parent.appendChild(probe);
  const cs = getComputedStyle(probe);
  const font = `${cs.fontStyle} ${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;
  probe.remove();
  return font;
}

/** One measurable run of text: its content, its font, and CSS letter-spacing. */
export interface FitText {
  text: string;
  font: string;
  /**
   * `letter-spacing` in px, added per character. Canvas has a `letterSpacing`
   * property but its support is uneven across the WebViews we ship on
   * (WebView2 vs WebKitGTK), so it's applied arithmetically instead.
   */
  letterSpacing?: number;
}

export interface ColumnFitInput {
  /** The column name, as rendered in the header (already upper-cased). */
  header: FitText;
  /** The dimmed data-type hint next to it. */
  type: FitText;
  /**
   * Fixed px the header cell spends on things that aren't text: key icons,
   * the sort glyph, the flex gaps between them.
   */
  headerChrome: number;
  /** Body cells in *display* form — already formatted, truncated, NULL-ified. */
  cells: readonly string[];
  /** Font the body cells render with. */
  cellFont: string;
  /** Horizontal padding + borders wrapping the text in both rows. */
  padding: number;
  min: number;
  max: number;
}

function widthOf(run: FitText): number {
  const ctx = measureCtx();
  if (!ctx || !run.text) return 0;
  ctx.font = run.font;
  return (
    ctx.measureText(run.text).width +
    (run.letterSpacing ?? 0) * run.text.length
  );
}

/**
 * Width (px) that shows a column's widest visible value in full, clamped to
 * `[min, max]`. Both rows are considered — a narrow column of short values
 * under a long name must still show its header, which is what makes the
 * gesture feel like "fit the column" rather than "fit the data".
 */
export function computeColumnFitWidth(input: ColumnFitInput): number {
  const ctx = measureCtx();
  // No canvas (very old WebView, or a non-DOM test env): leave the width
  // alone rather than collapsing every column to `min`.
  if (!ctx) return input.min;

  const headerWidth =
    widthOf(input.header) + widthOf(input.type) + input.headerChrome;

  ctx.font = input.cellFont;
  let bodyWidth = 0;
  for (const raw of input.cells) {
    // Cells render with `truncate` (i.e. `white-space: nowrap`), so runs of
    // whitespace — newlines in a JSON document, tabs in a pasted value —
    // collapse to a single space on screen. Measuring the raw string would
    // massively over-size a multi-line value.
    const text = raw.slice(0, MEASURE_CHAR_CAP).replace(/\s+/g, " ");
    if (!text) continue;
    const w = ctx.measureText(text).width;
    if (w > bodyWidth) bodyWidth = w;
  }

  // +2px of slack: `measureText` is fractional and the browser rounds the
  // rendered box down, which is enough to trigger an ellipsis on the very
  // value we just measured.
  const content = Math.max(headerWidth, bodyWidth) + input.padding + 2;
  return Math.round(Math.min(input.max, Math.max(input.min, content)));
}
