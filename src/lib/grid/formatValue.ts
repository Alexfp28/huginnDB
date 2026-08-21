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

import type { CellValue } from "@/types";

export function formatValue(v: CellValue): string {
  if (v === null || v === undefined) return "";
  if (typeof v === "object") return JSON.stringify(v);
  return String(v);
}
