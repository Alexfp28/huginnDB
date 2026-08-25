/**
 * The one place a keystroke turns into an action.
 *
 * Before this, four surfaces each had their own listener and their own
 * conventions: `App.tsx` walked a chain of six `if`s against six Zustand
 * selectors, `monacoKeybindings` looped its own action list, the data grid
 * hand-filtered modified chords, and one panel resorted to
 * `stopImmediatePropagation` to win a `Mod+S` race against another. They
 * disagreed about repeats, about focus, and about who goes first.
 *
 * `createKeyDispatcher` is the shared core — deliberately not a hook, so the
 * window listener, Monaco's `onKeyDown` and the grid's React handler can all
 * feed it the same way. It owns exactly one piece of state: the half-typed
 * prefix of a chord sequence.
 */

import { chordFromEvent, type KeyLike } from "./chord";
import type { ActionId, Scope } from "./actions";
import type { Binding, ResolvedBindings } from "./resolve";

/** What to run when an action fires. An action with no handler is inert — the
 *  keystroke falls through as if nothing were bound. */
export type ActionHandlers = Partial<Record<ActionId, () => void>>;

/** How long a half-typed sequence waits for its next chord. Matches VS Code. */
export const CHORD_TIMEOUT_MS = 2000;

export interface DispatchOptions {
  /** The live index. Read on every keystroke so a rebind takes effect at once,
   *  without re-registering any listener. */
  getResolved: () => ResolvedBindings;
  /** The live handler table, read the same way and for the same reason. */
  getHandlers: () => ActionHandlers;
  /** Reports the pending prefix (`[]` when nothing is pending) so the status
   *  bar can show it. Called only when the prefix actually changes. */
  onPendingChange?: (chords: string[]) => void;
}

export interface KeyDispatcher {
  /** Returns `true` when the keystroke was consumed. The caller is responsible
   *  for `preventDefault` — every dispatch site in this app already does that
   *  itself, and Monaco additionally needs `stopPropagation`. */
  handleKey: (e: KeyLike, scopes: Iterable<Scope>) => boolean;
  /** Drop any half-typed sequence (e.g. on blur). */
  reset: () => void;
}

/**
 * The scopes a keystroke can reach, given where the focus is.
 *
 * A surface declares itself with `data-kb-scope="grid"`; the nearest such
 * ancestor of the focused element wins, and `global` is always included.
 *
 * Note there is no special case for `overlay`. When the command palette is
 * open the focus is inside it, so the nearest declared scope is `overlay` and
 * the grid's and editor's bindings are already out of reach — which is the
 * behaviour that used to depend on those surfaces not being focused. `global`
 * staying reachable is deliberate: the palette's own toggle is a global
 * action, and it has to keep being able to close the palette.
 */
export function scopesAt(element: Element | null): Set<Scope> {
  const host = element?.closest<HTMLElement>("[data-kb-scope]");
  const scope = host?.dataset.kbScope as Scope | undefined;
  return scope ? new Set<Scope>(["global", scope]) : new Set<Scope>(["global"]);
}

/** Elements that swallow ordinary typing. */
const TEXT_ENTRY = "input, textarea, select, [contenteditable='true']";

/**
 * Would this chord be indistinguishable from typing?
 *
 * Only a chord with no command-ish modifier and a *printable* token qualifies:
 * `A`, `1`, `,`, `Space`, and their Shift variants. `F5`, `Escape` and the
 * arrows carry no modifier either but are not typeable, so they keep working
 * inside a text field — which is what makes "refresh" still work while the
 * cursor sits in the grid's search box.
 */
export function isTypeableChord(chord: string): boolean {
  const parts = chord.split("+");
  const token = parts[parts.length - 1];
  const mods = parts.slice(0, -1);
  if (mods.some((m) => m === "Mod" || m === "Ctrl" || m === "Meta" || m === "Alt")) {
    return false;
  }
  return token === "Space" || token.length === 1;
}

/** Does the event's target sit inside something that expects raw typing? */
function inTextEntry(e: KeyLike): boolean {
  if (e.target instanceof Element) return e.target.closest(TEXT_ENTRY) !== null;
  // Monaco hands us a browser event whose target is inside its own textarea,
  // so the check above already covers it; anything else falls back to focus.
  return document.activeElement?.closest(TEXT_ENTRY) != null;
}

function reachable(binding: Binding, scopes: Iterable<Scope>): boolean {
  for (const scope of scopes) if (binding.scope === scope) return true;
  return false;
}

export function createKeyDispatcher(options: DispatchOptions): KeyDispatcher {
  const { getResolved, getHandlers, onPendingChange } = options;

  let pending: string[] = [];
  let timer: ReturnType<typeof setTimeout> | null = null;

  function setPending(next: string[]) {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
    const changed = next.length !== pending.length || next.some((c, i) => c !== pending[i]);
    pending = next;
    if (changed) onPendingChange?.(next);
    if (next.length > 0) {
      timer = setTimeout(() => {
        timer = null;
        pending = [];
        onPendingChange?.([]);
      }, CHORD_TIMEOUT_MS);
    }
  }

  function run(binding: Binding): boolean {
    const handler = getHandlers()[binding.actionId];
    if (!handler) return false;
    handler();
    return true;
  }

  return {
    reset: () => setPending([]),

    handleKey(e, scopes) {
      if (e.isComposing === true) return false;
      // Auto-repeat firing a shortcut over and over is never what anyone
      // wants; `App.tsx` used to guard the two refresh actions individually
      // and let the rest through.
      if (e.repeat === true) return false;

      const chord = chordFromEvent(e);
      if (chord === null) return false; // bare modifier — not a chord yet

      // Mid-sequence: only the pending branch matters, and an unmatched key
      // cancels rather than starting a new sequence, so a mistyped second
      // chord can never fire something else by accident.
      if (pending.length > 0) {
        const candidate = [...pending, chord];
        const bucket = getResolved().index.get(pending[0]) ?? [];
        const live = bucket.filter(
          (b) =>
            reachable(b, scopes) &&
            candidate.every((c, i) => b.sequence[i] === c),
        );
        const exact = live.find((b) => b.sequence.length === candidate.length);
        if (exact) {
          setPending([]);
          run(exact);
          return true;
        }
        if (live.length > 0) {
          setPending(candidate);
          return true;
        }
        setPending([]);
        return true; // swallow the key that ended the sequence
      }

      const bucket = getResolved().index.get(chord);
      if (!bucket || bucket.length === 0) return false;

      const typeable = isTypeableChord(chord);
      const live = bucket.filter((b) => {
        if (!reachable(b, scopes)) return false;
        // A binding a user could not tell from typing must not fire inside a
        // text field. Without this, binding an action to a bare letter makes
        // that letter untypeable across half the app.
        if (typeable && inTextEntry(e)) return false;
        return true;
      });
      if (live.length === 0) return false;

      const exact = live.find((b) => b.sequence.length === 1);
      if (exact) return run(exact);

      // Everything that matched needs a second chord.
      setPending([chord]);
      return true;
    },
  };
}
