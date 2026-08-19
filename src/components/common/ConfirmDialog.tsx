/**
 * A real confirm modal, for actions destructive enough to deserve more than a
 * native `window.confirm` — visible title/body layout, a themed destructive
 * button, and (via `confirming`) a busy state the browser dialog can't show.
 *
 * Same primitives and shape as the row-delete dialog in
 * `grid/TableDataTab.tsx` — this is that pattern extracted so bulk-deleting
 * connections, deleting an environment, and removing a shared origin don't
 * each reimplement it.
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
}) {
  const { t } = useTranslation();

  return (
    <Dialog open={open} onOpenChange={(next) => !confirming && onOpenChange(next)}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
        </DialogHeader>
        <div className="text-xs text-muted-foreground">{description}</div>
        <DialogFooter>
          <Button
            variant="ghost"
            disabled={confirming}
            onClick={() => onOpenChange(false)}
          >
            {cancelLabel ?? t("common.cancel")}
          </Button>
          <Button variant="destructive" disabled={confirming} onClick={onConfirm}>
            {confirming && <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />}
            {confirmLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
