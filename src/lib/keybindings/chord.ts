/**
 * The key lexicon: turning a keyboard event into a canonical chord string, and
 * back into something a human can read. Pure — no React, no store, no DOM.
 *
 * A *chord* is one keypress with its modifiers (`"Mod+K"`). A *sequence* is one
 * or more chords separated by a space (`"Mod+K Mod+S"`), VS Code style. The
 * matcher in `resolve.ts` works in sequences; everything a user binds is a
 * sequence of length 1 unless they deliberately record a second chord.
 *
 * `Mod` is the platform-neutral "the one you actually press" modifier —
 * `ctrlKey || metaKey`, which is what the app has always meant. It used to be
 * spelled `Ctrl`, which was a lie on macOS and left no way to bind the *real*
 * Control key; `Ctrl` and `Meta` now exist as exact tokens alongside it, and
 * `normalizeChord` folds the legacy spelling into `Mod` on read.
 */

import { isMac } from "@/lib/platform";

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

/** Canonical modifier order. Anything not in here is the key token, and there
 *  is exactly one of those per chord. */
const MODIFIER_ORDER = ["Mod", "Ctrl", "Meta", "Shift", "Alt"] as const;
const MODIFIERS = new Set<string>(MODIFIER_ORDER);

/** Separator between the chords of a sequence. */
const SEQUENCE_SEP = " ";

/** Resolve the non-modifier "key" token for a keydown event, or `null` when
 *  the event is a bare modifier keydown (not yet a complete chord). */
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

/** Build the canonical chord string for a keydown event, or `null` if it's
 *  just a modifier being pressed on its own.
 *
 *  Note `ctrlKey || metaKey` collapses to a single `Mod`: the app has never
 *  distinguished the two at the *event* end, only at the binding end, and
 *  changing that would silently unbind every Windows user's `Ctrl+K` the first
 *  time a macOS-shaped binding reached them. */
export function chordFromEvent(e: KeyLike): string | null {
  const token = keyTokenFromEvent(e);
  if (token === null) return null;
  const parts: string[] = [];
  if (e.ctrlKey || e.metaKey) parts.push("Mod");
  if (e.shiftKey) parts.push("Shift");
  if (e.altKey) parts.push("Alt");
  parts.push(token);
  return parts.join("+");
}

/**
 * Put a hand-written or previously-stored chord into canonical form: modifiers
 * in `MODIFIER_ORDER`, deduplicated, key token last. Also migrates the legacy
 * `Ctrl` spelling to `Mod` — every combo written before this module existed
 * meant `ctrlKey || metaKey`, which is what `Mod` means now.
 *
 * Returns `""` for input with no key token, which never matches an event.
 */
export function normalizeChord(chord: string): string {
  const seen = new Set<string>();
  let token = "";
  for (const raw of chord.split("+")) {
    const part = raw.trim();
    if (!part) continue;
    // Legacy: a stored `Ctrl` always meant "the platform's command modifier".
    const mod = part === "Ctrl" ? "Mod" : part;
    if (MODIFIERS.has(mod)) {
      seen.add(mod);
      continue;
    }
    token = part;
  }
  if (!token) return "";
  const mods = MODIFIER_ORDER.filter((m) => seen.has(m));
  return [...mods, token].join("+");
}

/** Split a stored binding into its chords, normalizing each. An empty or
 *  unparseable binding yields `[]`, which can never match. */
export function parseSequence(binding: string): string[] {
  return binding
    .split(SEQUENCE_SEP)
    .map((c) => normalizeChord(c))
    .filter((c) => c.length > 0);
}

/** Join chords back into a stored binding. Inverse of `parseSequence`. */
export function formatSequence(chords: string[]): string {
  return chords.join(SEQUENCE_SEP);
}

/** True when the binding needs two or more keypresses. */
export function isChordSequence(binding: string): boolean {
  return parseSequence(binding).length > 1;
}

/** How a chord's key token is drawn. Purely cosmetic — the stored token is
 *  always the plain name. */
const TOKEN_GLYPHS: Record<string, string> = {
  Enter: "↵",
  Backspace: "⌫",
  Delete: "⌦",
  ArrowUp: "↑",
  ArrowDown: "↓",
  ArrowLeft: "←",
  ArrowRight: "→",
  Escape: "Esc",
};

/** Render a stored binding for display: `Mod` becomes `⌘` on macOS and `Ctrl`
 *  everywhere else, `Shift` becomes `⇧` on macOS, and the sequence separator
 *  stays a space so `Mod+K Mod+S` reads as two caps. */
export function formatForDisplay(binding: string, mac: boolean = isMac()): string {
  return parseSequence(binding)
    .map((chord) =>
      chord
        .split("+")
        .map((part) => {
          if (part === "Mod") return mac ? "⌘" : "Ctrl";
          if (part === "Meta") return mac ? "⌘" : "Win";
          if (part === "Alt") return mac ? "⌥" : "Alt";
          if (part === "Shift") return mac ? "⇧" : "Shift";
          return TOKEN_GLYPHS[part] ?? part;
        })
        .join("+"),
    )
    .join(SEQUENCE_SEP);
}
