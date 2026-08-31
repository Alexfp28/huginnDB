/**
 * Open state for the environment create/rename dialog (name, color, icon,
 * theme override, replicate-on-create options).
 *
 * Used to be local state inside `EnvironmentSwitcher`, unreachable from
 * anywhere else. `EnvironmentRail`'s "+" button needs to open the exact
 * same create flow without duplicating the form, so this follows the same
 * pattern as `connectionDialog.ts` — a small store both surfaces read/write,
 * with the dialog itself rendered once (`EnvironmentEditorDialog`).
 */

import { create } from "zustand";

export interface EnvironmentDraft {
  /** `null` creates; an id edits that environment. */
  id: string | null;
  name: string;
  color: string | null;
  icon: string | null;
  /** Theme override for this environment. `null` = no override, keep the
   *  app's default theme. */
  themeId: string | null;
  /**
   * The mirrored environment's origin, when editing one — always `null` for
   * a create, or for an ordinary local environment. Tells
   * `EnvironmentEditorDialog` to write a local cosmetic override
   * (`setEnvironmentLocalOverrides`) instead of the synced fields
   * (`saveEnvironment`) on submit.
   */
  originId: string | null;
}

interface EnvironmentEditorState {
  editing: EnvironmentDraft | null;
  /** Seeded from `useEnvironments.lastReplicate` each time the create
   *  dialog opens; only meaningful while `editing?.id` is null. */
  replicate: { connections: boolean; layout: boolean };
  openCreate: (replicate: { connections: boolean; layout: boolean }) => void;
  openEdit: (draft: EnvironmentDraft) => void;
  setReplicate: (replicate: { connections: boolean; layout: boolean }) => void;
  update: (patch: Partial<EnvironmentDraft>) => void;
  close: () => void;
}

export const useEnvironmentEditor = create<EnvironmentEditorState>((set) => ({
  editing: null,
  replicate: { connections: true, layout: true },
  openCreate: (replicate) =>
    set({
      editing: {
        id: null,
        name: "",
        color: null,
        icon: null,
        themeId: null,
        originId: null,
      },
      replicate,
    }),
  openEdit: (draft) => set({ editing: draft }),
  setReplicate: (replicate) => set({ replicate }),
  update: (patch) =>
    set((s) => ({ editing: s.editing ? { ...s.editing, ...patch } : s.editing })),
  close: () => set({ editing: null }),
}));
