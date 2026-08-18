/**
 * Open state for the environment export/import dialogs.
 *
 * Export is per-environment (triggered from `EnvironmentSwitcher`'s per-row
 * menu, which only knows an id) while import is a single global action
 * (triggered from the File menu, which doesn't target any environment in
 * particular — it creates a new one). Same pattern as `connectionDialog.ts`:
 * a small store so both trigger points and the single render site
 * (`App.tsx`) can agree on state without threading props through unrelated
 * components.
 */

import { create } from "zustand";

interface EnvironmentTransferState {
  /** Environment id to export, or `null` when the dialog is closed. */
  exportEnvId: string | null;
  importOpen: boolean;
  openExport: (id: string) => void;
  closeExport: () => void;
  setImportOpen: (open: boolean) => void;
}

export const useEnvironmentTransfer = create<EnvironmentTransferState>((set) => ({
  exportEnvId: null,
  importOpen: false,
  openExport: (id) => set({ exportEnvId: id }),
  closeExport: () => set({ exportEnvId: null }),
  setImportOpen: (importOpen) => set({ importOpen }),
}));
