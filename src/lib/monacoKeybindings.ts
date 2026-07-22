/**
 * Shared redispatch for the customizable actions Monaco would otherwise
 * swallow inside its own focus area (gotcha #9 in CLAUDE.md).
 *
 * `editor.addCommand` can't work here: it resolves a fixed keybinding
 * bitmask once, inside Monaco's own keybinding service, before the handler
 * ever runs — there's no way to re-check a user-rebindable combo at call
 * time. `editor.onKeyDown` gives us the raw `KeyboardEvent` instead, so we
 * can compare it against the live preference on every keystroke via the
 * same `matchesBinding` helper every other dispatch site uses.
 */

import { usePreferences } from "@/stores/preferences";
import { type ActionId, getBinding, matchesBinding } from "@/lib/keybindings";

interface MonacoKeyDownEvent {
  browserEvent: KeyboardEvent;
}

interface EditorLike {
  onKeyDown: (fn: (e: MonacoKeyDownEvent) => void) => { dispose: () => void };
}

/** Registers one `onKeyDown` listener that redispatches to whichever of
 *  `actions` matches the user's current binding. Returns a disposer. */
export function registerEditorActionRedispatch(
  editor: EditorLike,
  actions: { id: ActionId; run: () => void }[],
): () => void {
  const disposable = editor.onKeyDown((e) => {
    if (e.browserEvent.isComposing) return;
    const keybindings = usePreferences.getState().prefs.keybindings;
    for (const { id, run } of actions) {
      if (matchesBinding(e.browserEvent, getBinding(keybindings, id))) {
        e.browserEvent.preventDefault();
        e.browserEvent.stopPropagation();
        run();
        return;
      }
    }
  });
  return () => disposable.dispose();
}
