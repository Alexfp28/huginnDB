/**
 * Open state for the managed-policy editor (`PolicyEditorDialog`).
 *
 * The editor is a workbench dialog, like Settings, which it is opened from, so
 * it is mounted in `App` as a sibling of Settings rather than inside Settings →
 * Policy. Stacking the two traps focus in whichever mounted last, and it made
 * the editor a child of the section it was opened from: anything that closed
 * Settings took the editor down with it. `open` puts Settings aside
 * (`suspend`), and `close` gives it back on the Policy section (`resume`),
 * saved or not. This is the rule `originEditor.ts` already followed.
 *
 * `status` is a snapshot of the policy status Settings → Policy was showing,
 * taken when the editor opened. The editor needs it only for the current
 * account (the template's author, and "your own role changes"), and Settings
 * re-reads the status when it comes back.
 */

import { create } from "zustand";

import { useSettingsDialog } from "@/components/settings/useSettingsDialog";
import type { PolicyStatus } from "@/types";

interface PolicyEditorState {
  /** The status the editor was opened with, or `null` when it is closed. */
  status: PolicyStatus | null;
  open: (status: PolicyStatus) => void;
  close: () => void;
}

export const usePolicyEditor = create<PolicyEditorState>((set) => ({
  status: null,
  open: (status) => {
    useSettingsDialog.getState().suspend();
    set({ status });
  },
  close: () => {
    set({ status: null });
    useSettingsDialog.getState().resume();
  },
}));
