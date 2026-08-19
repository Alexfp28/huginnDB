/**
 * Open state for the "delete this environment" confirm dialog.
 *
 * Two call sites need it — `EnvironmentRail`'s context menu and
 * `EnvironmentSwitcher`'s dropdown — and both used to fire the identical
 * `window.confirm` prompt independently. Same pattern as
 * `environmentEditor.ts`/`connectionDialog.ts`: a small store both surfaces
 * read/write, with the dialog itself rendered once (in `App.tsx`, next to
 * `EnvironmentEditorDialog`).
 */

import { create } from "zustand";

interface PendingDelete {
  id: string;
  /** Already resolved via `environmentLabel()` — the dialog has no reason to
   *  know about the empty-name convention. */
  label: string;
}

interface EnvironmentDeleteConfirmState {
  pending: PendingDelete | null;
  open: (id: string, label: string) => void;
  close: () => void;
}

export const useEnvironmentDeleteConfirm = create<EnvironmentDeleteConfirmState>(
  (set) => ({
    pending: null,
    open: (id, label) => set({ pending: { id, label } }),
    close: () => set({ pending: null }),
  }),
);
