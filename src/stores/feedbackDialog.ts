/**
 * Open/close + prefill state for the in-app issue reporter (FeedbackDialog).
 *
 * Lives in its own tiny store so any entry point — the File menu, a
 * "Report this error" action on a Console log entry, a toast — can open the
 * dialog (optionally pre-filled) without prop-drilling through `App.tsx`.
 */

import { create } from "zustand";
import type { FeedbackKind } from "@/types";

/** Optional initial values when opening the dialog from a context that
 *  already knows what the report is about (e.g. a failed query). */
export interface FeedbackPrefill {
  kind?: FeedbackKind;
  title?: string;
  description?: string;
}

interface FeedbackDialogState {
  open: boolean;
  prefill: FeedbackPrefill | null;
  /** Open the dialog, optionally pre-filled. */
  openWith: (prefill?: FeedbackPrefill) => void;
  setOpen: (open: boolean) => void;
}

export const useFeedbackDialog = create<FeedbackDialogState>()((set) => ({
  open: false,
  prefill: null,
  openWith: (prefill) => set({ open: true, prefill: prefill ?? null }),
  setOpen: (open) => set({ open }),
}));
