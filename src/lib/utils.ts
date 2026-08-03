/** Generic UI helpers. */

import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

/**
 * Tailwind-aware `classnames`. Use anywhere two or more class strings
 * are conditionally combined so conflicting utilities (`p-2` vs `p-4`)
 * resolve to the last one passed.
 */
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

/** Format a byte count as `1.2 KB`, `345.6 MB`, etc. Returns `""` for a
 *  missing/non-finite input (e.g. a `null` stat that slipped through) so the
 *  caller renders no badge instead of crashing on `null.toFixed`. */
export function formatBytes(n: number) {
  if (!Number.isFinite(n)) return "";
  const units = ["B", "KB", "MB", "GB"];
  let i = 0;
  while (n > 1024 && i < units.length - 1) {
    n /= 1024;
    i++;
  }
  return `${n.toFixed(1)} ${units[i]}`;
}

/**
 * Format a row/record count for compact display in the schema explorer.
 *
 * @param n - The count to format.
 * @returns Human-readable string: raw below 1 000, `1.2k` up to 1 M,
 *   `1.2M` above that.
 */
export function formatCount(n: number): string {
  if (!Number.isFinite(n)) return "";
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

/**
 * Return `true` if the SQL data-type string represents a numeric type.
 *
 * Matches the normalised type names produced by all three drivers:
 * - Postgres: `integer`, `bigint`, `numeric`, `real`, `double precision`, etc.
 * - MySQL: `int(11)`, `float`, `decimal(10,2)`, etc.
 * - SQLite: `INT`, `REAL`, `NUMERIC`, etc. (case-insensitive affinity names).
 * - MongoDB: `int`, `long` (int64), `double`, `decimal128` (see
 *   `bson_type_name`).
 *
 * @param dataType - The `data_type` string from `ColumnMeta`.
 */
export function isNumericType(dataType: string): boolean {
  const t = dataType.toLowerCase();
  return (
    // "point"/"multipoint" (MySQL spatial types) contain the substring
    // "int" by accident — exclude them so those columns don't lose
    // text-match operators to a false numeric classification.
    (t.includes("int") && !t.includes("point")) ||
    t.includes("float") ||
    t.includes("double") ||
    t.includes("decimal") ||
    t.includes("numeric") ||
    t.includes("real") ||
    t.includes("money") ||
    t.includes("serial") ||
    t === "long" ||
    t === "number"
  );
}

/**
 * True for MySQL `BIT` / `BIT(n)` columns. The backend ships BIT values as
 * numbers (see `mysql_value`), so the grid needs the column type to decide
 * whether to apply the user's BIT rendering preference.
 */
export function isBitType(dataType: string): boolean {
  return /^bit\b/i.test(dataType.trim());
}

/**
 * True for a boolean-ish column type: Postgres/MongoDB `boolean`/`bool`, or
 * MySQL's `BOOLEAN` display name for `TINYINT(1)` (see the MySQL boolean
 * decode note in `CLAUDE.md`).
 */
export function isBooleanType(dataType: string): boolean {
  const t = dataType.toLowerCase();
  return t === "bool" || t === "boolean";
}

/**
 * A predictable initial column width (px), based on the SQL type alone.
 * Boolean, numeric, date/time and UUID columns render a bounded range of
 * characters, so they can be sized up front instead of starting at the
 * grid's generic default — which exists for free-text columns, where the
 * content length genuinely isn't predictable from the type. Returns `null`
 * for anything else (text/varchar/char, json, blob, …), so the caller falls
 * back to its own default for those.
 */
export function defaultColumnWidth(dataType: string): number | null {
  const t = dataType.toLowerCase();
  if (isBitType(dataType) || isBooleanType(dataType)) return 70;
  if (t === "uuid" || t === "uniqueidentifier" || t === "objectid") return 260;
  // Check the combined forms before the plain "date"/"time" substrings they
  // both contain, or e.g. "timestamptz" would be misclassified as "date".
  if (t.includes("timestamp") || t.includes("datetime")) return 170;
  if (t === "date") return 130;
  if (t === "time" || t.includes("time")) return 110;
  if (t === "year") return 70;
  if (isNumericType(dataType)) return 100;
  return null;
}

/**
 * Render a numeric BIT value per the grid's `bitDisplay` preference.
 * In `true_false` mode, 0/1 become `false`/`true`; any wider BIT(n) value
 * falls back to its integer form. `zero_one` always shows the raw number.
 */
export function formatBitValue(
  value: number,
  mode: "true_false" | "zero_one",
): string {
  if (mode === "true_false") {
    if (value === 0) return "false";
    if (value === 1) return "true";
  }
  return String(value);
}

/**
 * Format a duration in milliseconds for compact, glanceable display:
 * `842 ms`, `1.24 s`, `12.3 s`, `1m 04s`. Used by the query editor's
 * running/elapsed timer and by query-history entries.
 */
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "0 ms";
  if (ms < 1000) return `${Math.round(ms)} ms`;
  const totalSeconds = ms / 1000;
  if (totalSeconds < 60) {
    return `${totalSeconds.toFixed(totalSeconds < 10 ? 2 : 1)} s`;
  }
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = Math.round(totalSeconds % 60);
  return `${minutes}m ${seconds.toString().padStart(2, "0")}s`;
}

/**
 * Bucket items by their free-text `group` field (e.g. `ConnectionProfile`).
 * Ungrouped items (`group` null/empty) come back separately so callers can
 * render them flat, with no header — groups are sorted alphabetically by
 * name for a stable, locale-aware order.
 */
export function bucketByGroup<T extends { group?: string | null }>(
  items: T[],
): { ungrouped: T[]; groups: Array<{ name: string; items: T[] }> } {
  const ungrouped: T[] = [];
  const byGroup = new Map<string, T[]>();
  for (const item of items) {
    if (item.group) {
      const list = byGroup.get(item.group) ?? [];
      list.push(item);
      byGroup.set(item.group, list);
    } else {
      ungrouped.push(item);
    }
  }
  const groups = Array.from(byGroup.entries())
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([name, groupItems]) => ({ name, items: groupItems }));
  return { ungrouped, groups };
}
