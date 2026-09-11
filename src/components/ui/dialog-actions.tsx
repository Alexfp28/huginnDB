import * as React from "react";
import { Button } from "@/components/ui/button";
import { DialogFooter } from "@/components/ui/dialog";

/**
 * The footer nearly every dialog has: a ghost Cancel and one primary action,
 * with the busy state on the action.
 *
 * Twenty-six footers were re-typing this, and the two details they most often
 * got subtly different are why it is worth sharing: whether Cancel is disabled
 * while the action is in flight (it must be — a dialog dismissable mid-write
 * leaves the user unsure whether it happened), and whether the action spins
 * when it also has a busy label (it should).
 *
 * In its own file rather than inside `dialog.tsx` so that the 33 call sites
 * importing a Dialog don't pull `Button` in behind it.
 *
 * `cancelLabel` is required rather than defaulting to `t("common.cancel")`,
 * which is what keeps this directory free of i18n — see `README.md`.
 * `ConfirmDialog` supplies that default for the destructive case.
 *
 * Buttons are always `sm`. This used to be a `size` prop defaulting to
 * `"md"` — half the app's footers passed `sm` and half took the default,
 * a divergence nobody had settled — but what one prop can decide, nobody
 * downstream can un-decide by accident, so it is gone rather than merely
 * redefaulted.
 */
export function DialogActions({
  onCancel,
  cancelLabel,
  confirmLabel,
  onConfirm,
  confirming = false,
  confirmingLabel,
  confirmVariant = "default",
  confirmAutoFocus = false,
  confirmDisabled = false,
  children,
}: {
  onCancel: () => void;
  cancelLabel: string;
  confirmLabel: React.ReactNode;
  onConfirm: () => void;
  confirming?: boolean;
  confirmingLabel?: string;
  confirmVariant?: "default" | "destructive";
  /**
   * Focus the action on open. Off by default: for a dialog reached by a
   * keyboard shortcut, a focused destructive button turns the next Enter into
   * the action itself.
   */
  confirmAutoFocus?: boolean;
  /** Blocked for a reason other than the action being in flight — an empty
   *  required field, say. `confirming` already disables on its own. */
  confirmDisabled?: boolean;
  /** Extra controls, rendered to the left of the pair. */
  children?: React.ReactNode;
}) {
  return (
    <DialogFooter>
      {children}
      <Button
        variant="ghost"
        size="sm"
        disabled={confirming}
        onClick={onCancel}
      >
        {cancelLabel}
      </Button>
      <Button
        variant={confirmVariant}
        size="sm"
        autoFocus={confirmAutoFocus}
        loading={confirming}
        loadingLabel={confirmingLabel}
        disabled={confirmDisabled}
        onClick={onConfirm}
      >
        {confirmLabel}
      </Button>
    </DialogFooter>
  );
}
