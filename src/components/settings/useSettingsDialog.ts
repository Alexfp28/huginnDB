/**
 * Open/close + active-section state for the Settings dialog.
 *
 * Lives in its own tiny store so `ViewMenu`, `ThemeMenu`, the keyboard
 * shortcut handler (`Ctrl/Cmd+,`), and the topbar button can all open the
 * dialog without prop-drilling through `App.tsx`.
 */

import { create } from "zustand";

export type SettingsSection =
  | "general"
  | "editor"
  | "grid"
  | "appearance"
  | "shortcuts"
  | "mcp"
  | "about";

interface SettingsDialogState {
  open: boolean;
  section: SettingsSection;
  openAt: (section?: SettingsSection) => void;
  setOpen: (open: boolean) => void;
  setSection: (section: SettingsSection) => void;
}

export const useSettingsDialog = create<SettingsDialogState>()((set) => ({
  open: false,
  section: "general",
  openAt: (section) =>
    set((s) => ({ open: true, section: section ?? s.section })),
  setOpen: (open) => set({ open }),
  setSection: (section) => set({ section }),
}));
