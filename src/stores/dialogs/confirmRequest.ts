/**
 * Pending state for the app's one shared confirm dialog — the replacement
 * for `window.confirm`, which `lib/confirmDestructive.ts` used to call
 * directly. Same shape as `environmentEditor.ts`/`connectionDialog.ts`: a
 * small store the caller and the dialog both read/write, with the dialog
 * itself rendered once per window (`ConfirmHost`).
 *
 * The one thing a plain boolean-returning `window.confirm` never had to
 * think about: a *second* request arriving while one is still pending —
 * two destructive actions fired close together, or a user double-clicking
 * before the first dialog paints. `current` is what `ConfirmHost` shows;
 * anything else queues in `queue` rather than overwriting `current`, so a
 * request already in flight always gets its answer before the next one is
 * even shown. `resolve()` always advances the queue, so no promise this
 * store hands out is ever left unsettled.
 */

import { create } from "zustand";

export type ConfirmTone = "destructive" | "irreversible";

interface ConfirmRequest {
  tone: ConfirmTone;
  message: string;
}

interface PendingConfirm extends ConfirmRequest {
  resolve: (value: boolean) => void;
}

interface ConfirmRequestState {
  /** The one request `ConfirmHost` renders, or `null` when nothing is open. */
  current: PendingConfirm | null;
  queue: PendingConfirm[];
  /** Resolves once the user answers (or the dialog is dismissed, as `false`). */
  request: (req: ConfirmRequest) => Promise<boolean>;
  /** Answers `current` and promotes the next queued request, if any. */
  resolve: (value: boolean) => void;
}

export const useConfirmRequest = create<ConfirmRequestState>((set, get) => ({
  current: null,
  queue: [],
  request: (req) =>
    new Promise<boolean>((resolve) => {
      const pending: PendingConfirm = { ...req, resolve };
      set((s) =>
        s.current ? { queue: [...s.queue, pending] } : { current: pending },
      );
    }),
  resolve: (value) => {
    const { current, queue } = get();
    current?.resolve(value);
    const [next, ...rest] = queue;
    set({ current: next ?? null, queue: rest });
  },
}));
