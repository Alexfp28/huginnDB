/**
 * A real confirm modal, for actions destructive enough to deserve more than a
 * native `window.confirm` — visible title/body layout, a themed destructive
 * button, and (via `confirming`) a busy state the browser dialog can't show.
 *
 * Same primitives and shape as the row-delete dialog in
 * `grid/TableDataTab.tsx` — this is that pattern extracted so bulk-deleting
 * connections, deleting an environment, and removing a shared origin don't
 * each reimplement it.
 *
 * Three additions let the schema explorer's own confirmations use it rather than
 * keep their hand-rolled copies, since what they had over this were only ever
 * details: an `error` slot (a failed DROP has to say why, in the dialog — the
 * modal stays open, so a toast would be the wrong surface), `children` for the
 * odd extra control (`EmptyTableDialog`'s "don't ask again"), and
 * `confirmingLabel` for a dialog that says "Dropping…" instead of showing a
 * spinner. Pair it with `useAsyncSubmit`, which owns `confirming`/`error`.
 */

import { useTranslation } from "react-i18next";
import { Loader2 } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import type { ReactNode } from "react";

export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  confirmLabel,
  cancelLabel,
  onConfirm,
  confirming = false,
  confirmingLabel,
  confirmAutoFocus = false,
  error,
  children,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: ReactNode;
  description: ReactNode;
  confirmLabel: string;
  cancelLabel?: string;
  onConfirm: () => void;
  /** Disables both buttons and swaps the confirm icon for a spinner while an
   *  async action triggered by this dialog is in flight. */
  confirming?: boolean;
  /** Shown in place of the spinner + `confirmLabel` while `confirming`. */
  confirmingLabel?: string;
  /** Focus the destructive button on open. Off by default: for a confirmation
   *  reached by a keyboard shortcut, a focused destructive button turns the next
   *  Enter into the action itself. */
  confirmAutoFocus?: boolean;
  /** Failure message, rendered above the footer while the dialog stays open. */
  error?: string | null;
  /** Extra controls between the description and the footer. */
  children?: ReactNode;
}) {
  const { t } = useTranslation();

  return (
    <Dialog open={open} onOpenChange={(next) => !confirming && onOpenChange(next)}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
        </DialogHeader>
        <div className="text-xs text-muted-foreground">{description}</div>
        {error && <div className="text-xs text-destructive">{error}</div>}
        {children}
        <DialogFooter>
          <Button
            variant="ghost"
            disabled={confirming}
            onClick={() => onOpenChange(false)}
          >
            {cancelLabel ?? t("common.cancel")}
          </Button>
          <Button
            variant="destructive"
            autoFocus={confirmAutoFocus}
            disabled={confirming}
            onClick={onConfirm}
          >
            {confirming && !confirmingLabel && (
              <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
            )}
            {confirming ? (confirmingLabel ?? confirmLabel) : confirmLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
