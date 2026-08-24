/**
 * F11 toggles fullscreen; Escape leaves it.
 *
 * Both cell editors — the modal (`CellEditor`) and the docked panel
 * (`SideEditorPanel`) — carried this listener identically, differing only in
 * how they decide whether they are the one that should react.
 *
 * `isActive` is a callback rather than a boolean because it is read *at event
 * time*: `SideEditorPanel` gates on a ref (`loadedTargetRef`), not on state, so
 * that a keypress consults the current target rather than whatever was captured
 * when the listener was attached. Passing a boolean would silently break that.
 *
 * Escape is only claimed while already fullscreen — otherwise it would swallow
 * the key from the dialog underneath, which expects it to close.
 */

import { useEffect, useState, type Dispatch, type SetStateAction } from "react";

export function useFullscreenToggle(
  isActive: () => boolean,
): [boolean, Dispatch<SetStateAction<boolean>>] {
  const [fullscreen, setFullscreen] = useState(false);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (!isActive()) return;
      if (e.key === "F11") {
        e.preventDefault();
        setFullscreen((v) => !v);
      } else if (e.key === "Escape" && fullscreen) {
        e.preventDefault();
        setFullscreen(false);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // `isActive` is read inside the handler, so a changed identity needs no
    // re-subscribe; `fullscreen` does, because Escape's branch depends on it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fullscreen]);

  return [fullscreen, setFullscreen];
}
