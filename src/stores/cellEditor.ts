/**
 * Shared "currently editing cell" state for the JetBrains-style side-panel
 * editor. The data grid and the side panel live in different dockview panels
 * (separate React subtrees), so a small Zustand store is the clean bridge
 * between "user asked to edit this cell" and "the side panel renders it".
 *
 * The target carries the commit context as an `onSave` callback supplied by
 * the originating tab (the same `onCellSave` closure the modal already uses).
 * It is captured per open-session, so staleness is bounded to one edit — the
 * same contract the modal `CellEditor` relies on.
 *
 * Subscribe with the single-object selector `s => s.target` so the value stays
 * reference-stable between opens (CLAUDE.md gotcha #1).
 */

import { create } from "zustand";

export interface CellEditorTarget {
  /**
   * Id of the tab that opened this cell. The docked side panel lives outside
   * the tab's React subtree, so it uses this to close itself when the source
   * tab is closed (otherwise it lingers with a stale value). Absent for
   * targets with no owning tab.
   */
  ownerId?: string;
  /** Column label shown in the panel header. */
  columnName: string;
  /** Initial text value to edit. */
  value: string;
  /** When true the editor is a read-only viewer (no save button). */
  readonly?: boolean;
  /**
   * Commit handler. Absent for read-only targets. Receives the edited text;
   * the panel closes the editing session on success.
   */
  onSave?: (value: string) => Promise<void> | void;
}

interface CellEditorState {
  target: CellEditorTarget | null;
  open: (target: CellEditorTarget) => void;
  close: () => void;
}

export const useCellEditor = create<CellEditorState>((set) => ({
  target: null,
  open: (target) => set({ target }),
  close: () => set({ target: null }),
}));
