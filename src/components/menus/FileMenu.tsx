/**
 * Top-left "File" dropdown. The connection tree itself lives in the Schema
 * panel (`ConnectionsTree`, #107) — this menu only holds connection
 * *management* actions to avoid duplicating that browsing UI. "Disconnect
 * all" lives there too now, as a tree-wide action above its filter box.
 *
 * Menu structure:
 *   File ▾
 *   ├── New connection…
 *   ├── Manage connections…
 *   ├── Import profiles…
 *   └── Export profiles…
 */

import { useState } from "react";
import { useTranslation } from "react-i18next";
import { ChevronDown, Download, FolderOpen, Plus, Settings, Upload } from "lucide-react";
import { useConnections } from "@/stores/connections";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
} from "@/components/ui/dropdown";
import { ConnectionDialog } from "@/components/connection/dialogs/ConnectionDialog";
import { ExportProfilesDialog } from "@/components/connection/dialogs/ExportProfilesDialog";
import { ImportProfilesDialog } from "@/components/connection/dialogs/ImportProfilesDialog";
import type { ConnectionProfile } from "@/types";

interface Props {
  selectedConnectionId: string | null;
  onSelect: (id: string | null) => void;
}

export function FileMenu({ selectedConnectionId, onSelect }: Props) {
  const profiles = useConnections((s) => s.profiles);

  const [connDialogOpen, setConnDialogOpen] = useState(false);
  // Which profile the manager opens focused on: `null` starts a new draft
  // ("New connection"), a profile preselects it ("Manage connections").
  const [dialogInitial, setDialogInitial] = useState<ConnectionProfile | null>(
    null,
  );
  const [exportOpen, setExportOpen] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const { t } = useTranslation();

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            size="sm"
            className="h-7 gap-1.5 px-2 text-xs"
          >
            <FolderOpen className="h-3.5 w-3.5" />
            {t("menu.file.label")}
            <ChevronDown className="h-3 w-3 opacity-60" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="w-64">
          <DropdownMenuItem
            onSelect={() => {
              setDialogInitial(null);
              setConnDialogOpen(true);
            }}
          >
            <Plus className="mr-2 h-3.5 w-3.5" />
            {t("menu.file.newConnection")}
          </DropdownMenuItem>
          <DropdownMenuItem
            onSelect={() => {
              setDialogInitial(
                profiles.find((p) => p.id === selectedConnectionId) ?? null,
              );
              setConnDialogOpen(true);
            }}
          >
            <Settings className="mr-2 h-3.5 w-3.5" />
            {t("menu.file.manageConnections")}
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => setImportOpen(true)}>
            <Upload className="mr-2 h-3.5 w-3.5" />
            {t("menu.file.importProfiles")}
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => setExportOpen(true)}>
            <Download className="mr-2 h-3.5 w-3.5" />
            {t("menu.file.exportProfiles")}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <ConnectionDialog
        open={connDialogOpen}
        onOpenChange={setConnDialogOpen}
        initial={dialogInitial}
        onConnected={onSelect}
      />
      <ExportProfilesDialog open={exportOpen} onOpenChange={setExportOpen} />
      <ImportProfilesDialog open={importOpen} onOpenChange={setImportOpen} />
    </>
  );
}
