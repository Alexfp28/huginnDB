/**
 * Open state for the three connection-management modals owned by the File menu
 * (`ConnectionDialog`, `ImportProfilesDialog`, `ExportProfilesDialog`).
 *
 * They used to be plain `useState` booleans inside `FileMenu`, which made them
 * unreachable from anywhere else — the command palette needs to offer "New
 * connection…" / "Manage connections…" / "Import profiles…" / "Export
 * profiles…" without reproducing the dialogs (and their onConnected wiring) at
 * a second mount point. Same pattern as `docsDialog` / `feedbackDialog`:
 * `FileMenu` stays the single place that renders them, and any surface can ask
 * for one. `TabbedArea` keeps its own local `ConnectionDialog` instance — that
 * one is a different, tab-scoped flow and is intentionally not routed here.
 *
 * The manager carries a profile *id* rather than the profile object so the
 * caller doesn't have to look one up; `FileMenu` resolves it against the live
 * profile list at render time, which also means a profile deleted between the
 * request and the render simply falls back to a new draft.
 */

import { create } from "zustand";

interface ConnectionDialogState {
  open: boolean;
  /** Profile the manager opens focused on. `null` starts a new draft. */
  initialId: string | null;
  importOpen: boolean;
  exportOpen: boolean;
  /** Open the dialog on a blank "New connection" draft. */
  openNew: () => void;
  /** Open the manager, optionally focused on a specific profile. */
  openManage: (profileId?: string | null) => void;
  setOpen: (open: boolean) => void;
  setImportOpen: (open: boolean) => void;
  setExportOpen: (open: boolean) => void;
}

export const useConnectionDialog = create<ConnectionDialogState>((set) => ({
  open: false,
  initialId: null,
  importOpen: false,
  exportOpen: false,
  openNew: () => set({ open: true, initialId: null }),
  openManage: (profileId) => set({ open: true, initialId: profileId ?? null }),
  setOpen: (open) => set({ open }),
  setImportOpen: (importOpen) => set({ importOpen }),
  setExportOpen: (exportOpen) => set({ exportOpen }),
}));
