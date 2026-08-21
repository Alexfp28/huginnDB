/**
 * Factory for an export/import dialog pair's open state.
 *
 * Three features now ship the same pair of dialogs — connection profiles,
 * environments, JSON Schemas — and two of them had a byte-identical store for
 * it (`environmentTransfer.ts` and `jsonSchemaTransfer.ts`, down to the
 * `preselect ?? null`). The shape is the same because the requirement is: an
 * export dialog reachable from more than one place, opening either with
 * everything checked (the File-menu entry point, which targets nothing in
 * particular) or pre-checking one row (a per-row shortcut); and an import
 * dialog that is always global, since importing only ever creates new items.
 *
 * A store rather than local state because those dialogs must be mounted exactly
 * once — two mount points would render two copies and the second would steal
 * focus from the first — while their triggers live in unrelated components that
 * would otherwise have to thread props to a common ancestor.
 */

import { create } from "zustand";

export interface TransferDialogState {
  exportOpen: boolean;
  /**
   * Ids pre-checked when the export dialog opens. `null` means "default to
   * everything" — distinct from `[]`, which would be a deliberate empty
   * selection.
   */
  exportPreselect: string[] | null;
  importOpen: boolean;
  openExport: (preselect?: string[]) => void;
  closeExport: () => void;
  setImportOpen: (open: boolean) => void;
}

export function createTransferDialogStore() {
  return create<TransferDialogState>((set) => ({
    exportOpen: false,
    exportPreselect: null,
    importOpen: false,
    openExport: (preselect) =>
      set({ exportOpen: true, exportPreselect: preselect ?? null }),
    closeExport: () => set({ exportOpen: false, exportPreselect: null }),
    setImportOpen: (importOpen) => set({ importOpen }),
  }));
}
