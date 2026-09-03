/** Generic UI helpers. */

import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

import { usePreferences } from "@/stores/preferences/preferences";

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
  // Through `TB`, not `GB`. While this only ever labelled one table it could
  // not overflow in practice; a whole-database size can, and the old ceiling
  // rendered a 5 TB server as "5120.0 GB".
  const units = ["B", "KB", "MB", "GB", "TB", "PB"];
  let i = 0;
  // `>=`, not `>`: at exactly 1024 the old comparison stopped one unit short
  // and printed "1024.0 B".
  while (n >= 1024 && i < units.length - 1) {
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
 * A short random id for a client-side entity: a tab, a saved query, a
 * query-history entry, a custom theme.
 *
 * Not a UUID on purpose. These ids only have to be unique within one user's own
 * `localStorage`, and they show up in `localStorage` keys and in the command
 * palette's MRU list, where a 36-character uuid is pure noise. Anything that
 * crosses to the backend or into `profiles.json` uses a real uuid instead —
 * `ConnectionDialog` calls `crypto.randomUUID()`, and the Rust side mints its
 * own.
 *
 * Six sites rolled this by hand with two different lengths (8 and 6), which is
 * the sort of split that makes "how long are our ids?" unanswerable.
 */
export function shortId(): string {
  return Math.random().toString(36).slice(2, 10);
}

/**
 * Id for a user-created custom theme. Prefixed so it can never collide with a
 * built-in theme's stable id, which is what `useThemeStore` keys off.
 */
export function customThemeId(): string {
  return `custom-${shortId()}`;
}

/**
 * The locale to format numbers and dates in.
 *
 * Read from `ui.language` rather than left to the platform. A bare
 * `toLocaleString()` uses the *operating system's* locale, which is a different
 * setting from the one the user picked in Settings → General — so an app running
 * in Spanish on an English-locale machine was rendering
 * `1,234` and `8/21/2026, 6:09 PM` inside otherwise-Spanish UI. Twelve call
 * sites did that; one (`DocsDialog`) passed the language and was right.
 *
 * Read imperatively so this is callable from render bodies and plain functions
 * alike. `ui.language` is already a reactive dependency of every component that
 * shows formatted output (it re-renders on a language switch through i18next),
 * so nothing needs to subscribe to it twice.
 */
function uiLocale(): string {
  return usePreferences.getState().prefs.ui.language;
}

/**
 * Format an integer with the user's thousands separators — `1.234` in Spanish,
 * `1,234` in English. For row counts, byte counts and operation tallies.
 */
export function formatNumber(n: number): string {
  if (!Number.isFinite(n)) return "";
  return n.toLocaleString(uiLocale());
}

/** Format an ISO timestamp (or epoch millis) as a full local date and time. */
export function formatDateTime(value: string | number | Date): string {
  return new Date(value).toLocaleString(uiLocale());
}

/** Format an ISO timestamp (or epoch millis) as a local time of day. */
export function formatTime(value: string | number | Date): string {
  return new Date(value).toLocaleTimeString(uiLocale());
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
