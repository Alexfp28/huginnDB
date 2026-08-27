/**
 * Open state for the shared-origin document editor (#155).
 *
 * Same shape and the same reason as `connectionDialog.ts`: the overlay has more
 * than one entry point — Settings → Origins, and the read-only banner in
 * `ConnectionDialog` for a connection an origin publishes — and a local
 * `useState` in either would make it unreachable from the other.
 *
 * Only the *identity* of the document lives here. The draft itself is local
 * state inside `OriginEditorOverlay`: it is a document being composed, not
 * application state, and putting it in a store would invite exactly the thing
 * `origin_doc`'s first invariant forbids — a draft that leaks into (or reads
 * from) this machine's own `profiles.json` / `tab_state.json`.
 *
 * `open` closes the Settings dialog on the way in (`closeSettings`), because the
 * overlay is a full-screen sibling of it and not a dialog stacked on one.
 */

import { create } from "zustand";

import { useSettingsDialog } from "@/components/settings/useSettingsDialog";

interface OriginEditorState {
  /** The origin whose document is open, or `null` when nothing is. */
  originId: string | null;
  /** Open the editor on an origin's document. */
  open: (originId: string) => void;
  close: () => void;
}

export const useOriginEditor = create<OriginEditorState>((set) => ({
  originId: null,
  open: (originId) => {
    // Never a dialog on top of a dialog: this is a full-screen surface, and
    // Radix would trap focus in whichever mounted last.
    useSettingsDialog.getState().setOpen(false);
    set({ originId });
  },
  close: () => set({ originId: null }),
}));
