/**
 * Open/closed state for the two JSON Schema transfer dialogs.
 *
 * A store rather than local state for the same reason `environmentTransfer.ts`
 * is one: the dialogs are reachable from two places (the File menu and the
 * Settings section) but must be mounted exactly once, or two copies would render
 * and the second would steal focus from the first.
 */

import { create } from "zustand";

interface JsonSchemaTransferState {
  exportOpen: boolean;
  /** Schema ids to pre-check, or `null` for "everything". */
  exportPreselect: string[] | null;
  importOpen: boolean;
  openExport: (preselect?: string[]) => void;
  closeExport: () => void;
  setImportOpen: (open: boolean) => void;
}

export const useJsonSchemaTransfer = create<JsonSchemaTransferState>((set) => ({
  exportOpen: false,
  exportPreselect: null,
  importOpen: false,
  openExport: (preselect) =>
    set({ exportOpen: true, exportPreselect: preselect ?? null }),
  closeExport: () => set({ exportOpen: false, exportPreselect: null }),
  setImportOpen: (open) => set({ importOpen: open }),
}));
