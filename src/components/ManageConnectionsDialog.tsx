/**
 * Modal wrapper around the ConnectionList. Opened from the FileMenu's
 * "Manage connections" entry. Reuses the full list UI (add / edit /
 * delete / connect / disconnect) so we keep one source of truth for
 * the connection management surface.
 */

import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Download, Upload } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { ConnectionList } from "@/components/ConnectionList";
import { ExportProfilesDialog } from "@/components/ExportProfilesDialog";
import { ImportProfilesDialog } from "@/components/ImportProfilesDialog";

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
  const [exportOpen, setExportOpen] = useState(false);
  const [importOpen, setImportOpen] = useState(false);

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="max-w-2xl p-0">
          <DialogHeader className="border-b border-border px-4 py-3">
            <div className="flex items-center justify-between">
              <DialogTitle className="text-sm">
                {t("connections.manageTitle")}
              </DialogTitle>
              <div className="flex items-center gap-1">
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-6 w-6"
                      onClick={() => setImportOpen(true)}
                    >
                      <Upload className="h-3.5 w-3.5" />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent side="bottom">
                    {t("transfer.import.tooltip")}
                  </TooltipContent>
                </Tooltip>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-6 w-6"
                      onClick={() => setExportOpen(true)}
                    >
                      <Download className="h-3.5 w-3.5" />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent side="bottom">
                    {t("transfer.export.tooltip")}
                  </TooltipContent>
                </Tooltip>
              </div>
            </div>
          </DialogHeader>
          <div className="h-[480px] overflow-hidden">
            <ConnectionList
              selectedConnectionId={selectedConnectionId}
              onSelect={onSelect}
            />
          </div>
        </DialogContent>
      </Dialog>

      <ExportProfilesDialog open={exportOpen} onOpenChange={setExportOpen} />
      <ImportProfilesDialog open={importOpen} onOpenChange={setImportOpen} />
    </>
  );
}
