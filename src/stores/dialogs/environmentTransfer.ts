/**
 * Open state for the environment export/import dialogs.
 *
 * Export is a single dialog that can select **multiple** environments at
 * once — reachable both from the File menu (opens with everything selected,
 * mirroring `ExportProfilesDialog`) and from a per-row shortcut in
 * `EnvironmentSwitcher` (opens pre-selecting just that one row). Import is a
 * single global action (triggered from the File menu, which doesn't target
 * any environment in particular — it always creates new ones). Same pattern
 * as `connectionDialog.ts`: a small store so every trigger point and the
 * single render site (`App.tsx`/`FileMenu.tsx`) can agree on state without
 * threading props through unrelated components.
 */

import { create } from "zustand";

interface EnvironmentTransferState {
  exportOpen: boolean;
  /** Environment ids pre-checked when the export dialog opens. `null` means
   *  "default to every environment" (the File-menu entry point). */
  exportPreselect: string[] | null;
  importOpen: boolean;
  openExport: (preselect?: string[]) => void;
  closeExport: () => void;
  setImportOpen: (open: boolean) => void;
}

export const useEnvironmentTransfer = create<EnvironmentTransferState>((set) => ({
  exportOpen: false,
  exportPreselect: null,
  importOpen: false,
  openExport: (preselect) => set({ exportOpen: true, exportPreselect: preselect ?? null }),
  closeExport: () => set({ exportOpen: false, exportPreselect: null }),
  setImportOpen: (importOpen) => set({ importOpen }),
}));
