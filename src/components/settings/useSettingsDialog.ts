/**
 * Open/close + active-section state for the Settings dialog.
 *
 * Lives in its own tiny store so `ViewMenu`, `ThemeMenu`, the keyboard
 * shortcut handler (`Ctrl/Cmd+,`), and the topbar button can all open the
 * dialog without prop-drilling through `App.tsx`.
 */

import { create } from "zustand";

import type { PrefId } from "@/lib/prefId";

export type SettingsSection =
  | "general"
  | "editor"
  | "grid"
  | "connections"
  | "appearance"
  | "shortcuts"
  | "jsonSchemas"
  | "origins"
  | "mcp"
  | "about";

interface SettingsDialogState {
  open: boolean;
  section: SettingsSection;
  /**
   * `prefId` of a single setting the dialog should scroll to and flash, or
   * `null`. Set by the command palette's "go to this setting" entries; cleared
   * by the `PrefRow` that consumes it (see `clearHighlight`), so the flash plays
   * once per request rather than every time that section is revisited.
   */
  highlightPrefId: PrefId | null;
  openAt: (section?: SettingsSection) => void;
  /** Open `section` and highlight the row registered under `prefId`. */
  openAtPref: (section: SettingsSection, prefId: PrefId) => void;
  setOpen: (open: boolean) => void;
  setSection: (section: SettingsSection) => void;
  clearHighlight: () => void;
}

export const useSettingsDialog = create<SettingsDialogState>()((set) => ({
  open: false,
  section: "general",
  highlightPrefId: null,
  openAt: (section) =>
    set((s) => ({
      open: true,
      section: section ?? s.section,
      highlightPrefId: null,
    })),
  openAtPref: (section, prefId) =>
    set({ open: true, section, highlightPrefId: prefId }),
  setOpen: (open) => set({ open }),
  // Switching section by hand abandons any pending highlight: the user is
  // navigating somewhere else, and a stale flash on return would be noise.
  setSection: (section) => set({ section, highlightPrefId: null }),
  clearHighlight: () => set({ highlightPrefId: null }),
}));
