/**
 * The half-typed chord sequence, so the status bar can say what the app is
 * waiting for.
 *
 * A store rather than a return value from `useKeybindingDispatcher` because
 * the dispatcher is mounted in `App.tsx`: returning the pending prefix from
 * there would re-render the entire shell on every keystroke of a chord, to
 * update one line of text in the status bar.
 *
 * Not persisted — a pending prefix expires in two seconds and means nothing
 * across a restart.
 */

import { create } from "zustand";

interface PendingChordState {
  /** Chords typed so far, or `[]` when nothing is pending. */
  chords: string[];
  setChords: (chords: string[]) => void;
  clear: () => void;
}

export const usePendingChord = create<PendingChordState>((set) => ({
  chords: [],
  setChords: (chords) => set({ chords }),
  clear: () => set((s) => (s.chords.length === 0 ? s : { chords: [] })),
}));
