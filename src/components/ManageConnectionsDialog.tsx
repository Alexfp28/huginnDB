/**
 * Modal wrapper around the ConnectionList. Opened from the FileMenu's
 * "Manage connections" entry. Reuses the full list UI (add / edit /
 * delete / connect / disconnect) so we keep one source of truth for
 * the connection management surface.
 */

import { useTranslation } from "react-i18next";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { ConnectionList } from "@/components/ConnectionList";

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  selectedConnectionId: string | null;
  onSelect: (id: string | null) => void;
}

export function ManageConnectionsDialog({
  open,
  onOpenChange,
  selectedConnectionId,
  onSelect,
}: Props) {
  const { t } = useTranslation();
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl p-0">
        <DialogHeader className="border-b border-border px-4 py-3">
          <DialogTitle className="text-sm">
            {t("connections.manageTitle")}
          </DialogTitle>
        </DialogHeader>
        <div className="h-[480px] overflow-hidden">
          <ConnectionList
            selectedConnectionId={selectedConnectionId}
            onSelect={onSelect}
          />
        </div>
      </DialogContent>
    </Dialog>
  );
}
