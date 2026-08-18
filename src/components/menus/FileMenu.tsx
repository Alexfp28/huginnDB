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
 *   ├── Export profiles…
 *   └── Import environment…
 *
 * ("Export environment…" is per-environment, so it lives in
 * `EnvironmentSwitcher`'s per-row menu instead of here — this menu has no
 * particular environment to act on.)
 */

import { useTranslation } from "react-i18next";
import { ChevronDown, Download, FolderOpen, Plus, Settings, Upload } from "lucide-react";
import { useConnections } from "@/stores/session/connections";
import { useConnectionDialog } from "@/stores/dialogs/connectionDialog";
import { useEnvironmentTransfer } from "@/stores/dialogs/environmentTransfer";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
} from "@/components/ui/dropdown";
import { ConnectionDialog } from "@/components/connection/dialogs/ConnectionDialog";
import { ExportProfilesDialog } from "@/components/connection/dialogs/ExportProfilesDialog";
import { ImportProfilesDialog } from "@/components/connection/dialogs/ImportProfilesDialog";
import { ImportEnvironmentDialog } from "@/components/connection/dialogs/ImportEnvironmentDialog";

interface Props {
  selectedConnectionId: string | null;
  onSelect: (id: string | null) => void;
}

export function FileMenu({ selectedConnectionId, onSelect }: Props) {
  const profiles = useConnections((s) => s.profiles);

  // Open state for the three dialogs below lives in a store rather than local
  // component state so the command palette can request them too (see
  // `stores/dialogs/connectionDialog.ts`); this stays their only mount point.
  const connDialogOpen = useConnectionDialog((s) => s.open);
  const setConnDialogOpen = useConnectionDialog((s) => s.setOpen);
  const dialogInitialId = useConnectionDialog((s) => s.initialId);
  const openNew = useConnectionDialog((s) => s.openNew);
  const openManage = useConnectionDialog((s) => s.openManage);
  const exportOpen = useConnectionDialog((s) => s.exportOpen);
  const setExportOpen = useConnectionDialog((s) => s.setExportOpen);
  const importOpen = useConnectionDialog((s) => s.importOpen);
  const setImportOpen = useConnectionDialog((s) => s.setImportOpen);
  const importEnvOpen = useEnvironmentTransfer((s) => s.importOpen);
  const setImportEnvOpen = useEnvironmentTransfer((s) => s.setImportOpen);
  const { t } = useTranslation();

  // Which profile the manager opens focused on: `null` starts a new draft
  // ("New connection"), a resolved profile preselects it ("Manage
  // connections"). Resolved at render so a profile deleted in between falls
  // back to a new draft instead of a dangling reference.
  const dialogInitial = profiles.find((p) => p.id === dialogInitialId) ?? null;

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
          <DropdownMenuItem onSelect={() => openNew()}>
            <Plus className="mr-2 h-3.5 w-3.5" />
            {t("menu.file.newConnection")}
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => openManage(selectedConnectionId)}>
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
          <DropdownMenuSeparator />
          <DropdownMenuItem onSelect={() => setImportEnvOpen(true)}>
            <Upload className="mr-2 h-3.5 w-3.5" />
            {t("menu.file.importEnvironment")}
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
      <ImportEnvironmentDialog open={importEnvOpen} onOpenChange={setImportEnvOpen} />
    </>
  );
}
