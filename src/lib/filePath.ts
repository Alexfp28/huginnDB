/**
 * Splitting an OS path into the two halves a notification shows.
 *
 * Paths here come back from the Rust save/export commands, so they are native:
 * `C:\Users\me\exports\artist.csv` on Windows, `/home/me/exports/artist.csv`
 * elsewhere. Both separators are accepted regardless of platform — a profile
 * exported on one machine and imported on another can carry the other one, and
 * a wrong guess would show the whole path as the "file name".
 *
 * Nothing here touches the filesystem: it is string work, so it is safe to run
 * while rendering and cheap enough to run per notification.
 */

/** Last separator index, whichever separator that is, or `-1`. */
function lastSep(path: string): number {
  return Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
}

/**
 * The file name at the end of `path`.
 *
 * Trailing separators are ignored (`/tmp/out/` → `out`) so a directory the user
 * picked still reads as something, and a path that is nothing but separators
 * falls back to the input rather than to an empty label.
 */
export function baseName(path: string): string {
  const trimmed = path.replace(/[/\\]+$/, "");
  if (!trimmed) return path;
  const i = lastSep(trimmed);
  return i === -1 ? trimmed : trimmed.slice(i + 1);
}

/**
 * The directory `path` sits in, without its trailing separator, or `""` when
 * `path` is a bare file name. The empty string is meaningful: the card omits
 * the location line entirely rather than showing a lone separator.
 */
export function dirName(path: string): string {
  const trimmed = path.replace(/[/\\]+$/, "");
  const i = lastSep(trimmed);
  if (i === -1) return "";
  // Keep the root's separator (`/x` → `/`, `C:\x` → `C:\`); dropping it would
  // turn an absolute path into something that reads as relative.
  return i === 0 ? trimmed.slice(0, 1) : trimmed.slice(0, i);
}
