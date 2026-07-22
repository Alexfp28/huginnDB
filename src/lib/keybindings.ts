/**
 * Central registry + matcher for the app's customizable keyboard shortcuts
 * (issue #75). Combos are stored as platform-neutral strings (`"Ctrl"` always
 * means `ctrlKey || metaKey` — the app has never distinguished Mac from
 * Windows/Linux at the binding layer); `formatComboForDisplay` is the only
 * place that renders `Ctrl` as `⌘` for macOS.
 *
 * The frontend owns the default-combo table (`ACTIONS`) — `prefs.json` only
 * ever stores *overrides*, so a missing/empty map is a fully valid state
 * (see `getBinding`).
 */

export type ActionId =
  | "openSettings"
  | "toggleCommandPalette"
  | "toggleTabSwitcher"
  | "refreshData"
  | "runQuery"
  | "expandSelectedCell";

/** Common shape of a native `KeyboardEvent`, React's synthetic wrapper, and
 *  Monaco's `IKeyboardEvent.browserEvent` — every call site matches one of
 *  these, so the helpers below accept this instead of a concrete type. */
export interface KeyLike {
  key: string;
  code: string;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
}

export interface ActionSpec {
  id: ActionId;
  defaultCombo: string;
  labelKey: string;
}

export const ACTIONS: ActionSpec[] = [
  { id: "openSettings", defaultCombo: "Ctrl+,", labelKey: "settings.shortcuts.openSettings" },
  { id: "toggleCommandPalette", defaultCombo: "Ctrl+K", labelKey: "settings.shortcuts.toggleCommandPalette" },
  { id: "toggleTabSwitcher", defaultCombo: "Ctrl+P", labelKey: "settings.shortcuts.toggleTabSwitcher" },
  { id: "refreshData", defaultCombo: "F5", labelKey: "settings.shortcuts.refreshData" },
  { id: "runQuery", defaultCombo: "Ctrl+Enter", labelKey: "settings.shortcuts.runQuery" },
  { id: "expandSelectedCell", defaultCombo: "Space", labelKey: "settings.shortcuts.expandSelectedCell" },
];

const DEFAULT_BY_ID = new Map(ACTIONS.map((a) => [a.id, a.defaultCombo]));

/** Named keys whose `e.key` is already stable regardless of Shift state. */
const NAMED_KEYS = new Set([
  "Enter",
  "Escape",
  "Tab",
  "Home",
  "End",
  "PageUp",
  "PageDown",
  "ArrowUp",
  "ArrowDown",
  "ArrowLeft",
  "ArrowRight",
  "Delete",
  "Backspace",
]);

/** Resolve the non-modifier "key" token for a keydown event, or `null` when
 *  the event is a bare modifier keydown (not yet a complete combo). */
export function keyTokenFromEvent(e: KeyLike): string | null {
  if (e.code.startsWith("Key")) return e.code.slice(3); // "KeyK" -> "K"
  if (e.code.startsWith("Digit")) return e.code.slice(5); // "Digit1" -> "1"
  if (e.key === " " || e.code === "Space") return "Space";
  if (/^F([1-9]|1[0-9])$/.test(e.key)) return e.key; // F1-F19
  if (NAMED_KEYS.has(e.key)) return e.key;
  if (["Control", "Shift", "Alt", "Meta"].includes(e.key)) return null;
  // Fall back to the raw key for anything else (e.g. punctuation like ",").
  return e.key;
}

/** Build the canonical combo string for a keydown event, or `null` if it's
 *  just a modifier being pressed on its own. */
export function comboFromEvent(e: KeyLike): string | null {
  const token = keyTokenFromEvent(e);
  if (token === null) return null;
  const parts: string[] = [];
  if (e.ctrlKey || e.metaKey) parts.push("Ctrl");
  if (e.shiftKey) parts.push("Shift");
  if (e.altKey) parts.push("Alt");
  parts.push(token);
  return parts.join("+");
}

/** Pure predicate: does this event match the given combo string? Never
 *  calls `preventDefault` — every call site does that itself right after a
 *  match, matching the app's existing convention. */
export function matchesBinding(e: KeyLike, combo: string): boolean {
  return comboFromEvent(e) === combo;
}

/** Look up the effective combo for an action: the user's override, or the
 *  action's default when unset. */
export function getBinding(
  keybindings: Record<string, string>,
  id: ActionId,
): string {
  return keybindings[id] ?? DEFAULT_BY_ID.get(id) ?? "";
}

const isMac =
  typeof navigator !== "undefined" &&
  navigator.userAgent.toLowerCase().includes("mac");

/** Render a stored combo for display, swapping `Ctrl` for `⌘` on macOS. */
export function formatComboForDisplay(combo: string, mac: boolean = isMac): string {
  return combo
    .split("+")
    .map((part) => (part === "Ctrl" && mac ? "⌘" : part))
    .join("+");
}
