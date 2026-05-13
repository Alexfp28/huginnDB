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

/** Format a byte count as `1.2 KB`, `345.6 MB`, etc. */
export function formatBytes(n: number) {
  const units = ["B", "KB", "MB", "GB"];
  let i = 0;
  while (n > 1024 && i < units.length - 1) {
    n /= 1024;
    i++;
  }
  return `${n.toFixed(1)} ${units[i]}`;
}
