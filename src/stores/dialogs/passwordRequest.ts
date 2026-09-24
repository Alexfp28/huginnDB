/**
 * Pending state for the app's password prompt: what a connect shows when the
 * keychain holds no password for the user it signs in as, instead of an error
 * card. Same shape as `confirmRequest.ts` — a store the caller awaits and a
 * host (`PasswordPromptHost`) rendered once per window — and the same promise
 * that every request is answered: a dismissed prompt resolves `null`.
 *
 * One at a time, no queue: two connects racing for a password are two gestures
 * the user made, and the second prompt waits for the first to be answered by
 * being refused (`busy`) rather than stacking up behind it unseen.
 */

import { create } from "zustand";

export interface PasswordAsk {
  profileId: string;
  /** The connection, for the title. */
  name: string;
  /** The database user the password is for — the person's own, when set. */
  username: string;
}

export interface PasswordAnswer {
  password: string;
  /** Store it for next time (in the keychain, under that user's account). */
  remember: boolean;
}

interface PendingAsk extends PasswordAsk {
  resolve: (answer: PasswordAnswer | null) => void;
}

interface PasswordRequestState {
  current: PendingAsk | null;
  /** Resolves with the answer, or `null` when dismissed or already asking. */
  request: (ask: PasswordAsk) => Promise<PasswordAnswer | null>;
  resolve: (answer: PasswordAnswer | null) => void;
}

export const usePasswordRequest = create<PasswordRequestState>((set, get) => ({
  current: null,
  request: (ask) =>
    new Promise((resolve) => {
      if (get().current) {
        resolve(null);
        return;
      }
      set({ current: { ...ask, resolve } });
    }),
  resolve: (answer) => {
    get().current?.resolve(answer);
    set({ current: null });
  },
}));
