/**
 * A cell value's plain-string projection.
 *
 * The one place a `CellValue` becomes text for anything that is not a typed
 * write: rendering it in the grid, matching it against the client-side search,
 * and serialising it into a clipboard payload that has no JSON of its own.
 * `null`/`undefined` collapse to the empty string rather than the word "null",
 * because the grid renders its own NULL affordance and a search for "null"
 * should not match every empty cell.
 *
 * It existed twice, byte for byte: as `DataGrid`'s `formatValue` ("for display
 * and search") and as `copyFormats`'s `plain` ("for serialising to
 * JSON-incompatible payloads"). Two framings of one function, which is why the
 * doc above covers both.
 */

import type { CellValue, GridPrefs } from "@/types";
import { formatBitValue } from "@/lib/grid/columnKinds";

export function formatValue(v: CellValue): string {
  if (v === null || v === undefined) return "";
  if (typeof v === "object") return JSON.stringify(v);
  return String(v);
}

/**
 * The text a grid cell shows for `v`, before the length cap.
 *
 * The BIT branch is the whole reason this exists as a function: a MySQL `BIT`
 * arrives as a number and renders through the user's `bitDisplay` preference,
 * and the rule was written out twice — once in the `cell` renderer and once in
 * the auto-fit measurement that has to reproduce it exactly. A column measured
 * as `1` and painted as `true` is fitted two characters too narrow.
 *
 * `null` is the caller's business: the renderer paints its own italic NULL
 * affordance, so it never asks; the measurement passes `nullDisplay` in.
 */
export function rawCellText(
  v: CellValue,
  isBit: boolean,
  bitDisplay: GridPrefs["bitDisplay"],
): string {
  return isBit && typeof v === "number"
    ? formatBitValue(v, bitDisplay)
    : formatValue(v);
}

/**
 * Apply the grid's `truncateLongTextAt` cap, which keeps a multi-megabyte cell
 * from bloating the DOM (the full value stays reachable through the preview
 * panel and the editor). `<= 0` disables the cap.
 */
export function truncateForDisplay(text: string, at: number): string {
  return at > 0 && text.length > at ? `${text.slice(0, at)}…` : text;
}
