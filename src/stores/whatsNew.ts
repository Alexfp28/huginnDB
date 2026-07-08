/**
 * "What's new" store — drives the post-update highlights dialog.
 *
 * `lastSeenVersion` is the only persisted field (localStorage, same approach
 * as `stores/update.ts`'s `lastDismissedVersion` — this is transient UI state,
 * not a user preference, so it deliberately stays out of `prefs.json`). It
 * records the newest version whose notes the user has already dismissed, so
 * the dialog fires exactly once per major release.
 *
 * The trigger contract: on launch the app calls `notifyLaunch(currentVersion)`
 * once (main window only — see App.tsx). If that version has a `major` entry
 * in `releaseNotes.ts` and it hasn't been seen, the dialog opens. Dismissing
 * marks it seen. Help → "What's new" reopens the current (or latest) note via
 * `openLatest`, bypassing the seen gate.
 *
 * Selector note: components read raw primitives (`openVersion`), never a
 * derived array — the same reference-stability rule as the other stores.
 */

import { create } from "zustand";
import { persist } from "zustand/middleware";
import { STORAGE_KEYS } from "@/lib/constants";
import {
  getReleaseNote,
  latestReleaseNote,
} from "@/lib/releaseNotes";

interface WhatsNewState {
  /** Newest version whose notes were dismissed. Persisted. */
  lastSeenVersion: string | null;
  /** Running app version, captured on `notifyLaunch`. Ephemeral. */
  currentVersion: string | null;
  /** Version whose notes are currently on screen; `null` = closed. */
  openVersion: string | null;

  /** Auto-present on first launch after updating to a `major` version. */
  notifyLaunch: (currentVersion: string) => void;
  /** Manual entry (Help menu): show the current — or latest — note. */
  openLatest: () => void;
  /** Close and remember the open version as seen. */
  dismiss: () => void;
}

export const useWhatsNew = create<WhatsNewState>()(
  persist(
    (set, get) => ({
      lastSeenVersion: null,
      currentVersion: null,
      openVersion: null,

      notifyLaunch: (currentVersion) => {
        set({ currentVersion });
        if (get().openVersion) return; // already showing something
        const note = getReleaseNote(currentVersion);
        if (
          note?.major &&
          currentVersion !== get().lastSeenVersion
        ) {
          set({ openVersion: currentVersion });
        }
      },

      openLatest: () => {
        const { currentVersion } = get();
        const note =
          (currentVersion ? getReleaseNote(currentVersion) : null) ??
          latestReleaseNote();
        if (note) set({ openVersion: note.version });
      },

      dismiss: () => {
        const v = get().openVersion;
        set({ openVersion: null, ...(v ? { lastSeenVersion: v } : {}) });
      },
    }),
    {
      name: STORAGE_KEYS.whatsNew,
      partialize: (state) => ({ lastSeenVersion: state.lastSeenVersion }),
    },
  ),
);
