/**
 * Open/close + selected-doc state for the Documentation viewer
 * ({@link ../components/DocsDialog}). Its own tiny store so the Help menu (or
 * any future entry point) can open it — optionally to a specific doc — without
 * prop-drilling through `App.tsx`. Mirrors `stores/feedbackDialog.ts`.
 */

import { create } from "zustand";

interface DocsDialogState {
  open: boolean;
  /** Currently previewed doc id; `null` falls back to the first entry. */
  activeId: string | null;
  /** Open the viewer, optionally selecting a specific doc. */
  openTo: (id?: string) => void;
  setOpen: (open: boolean) => void;
  setActive: (id: string) => void;
}

export const useDocsDialog = create<DocsDialogState>()((set) => ({
  open: false,
  activeId: null,
  openTo: (id) => set({ open: true, activeId: id ?? null }),
  setOpen: (open) => set({ open }),
  setActive: (id) => set({ activeId: id }),
}));
