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
 *   ├── ── Profiles ──
 *   │     Import profiles…
 *   │     Export profiles…
 *   ├── ── Environments ──
 *   │     Import environments…
 *   │     Export environments…
 *   └── ── JSON Schemas ──
 *         Import JSON Schemas…
 *         Export JSON Schemas…
 *
 * The three import/export pairs are grouped under a section header each
 * (same inline-div idiom as `ViewMenu`'s "Panels"/"Schema tree" headers,
 * itself mirroring `ContextMenuLabel`'s styling) instead of bare separators —
 * with six lookalike items in a row, an empty separator reads as "unrelated
 * item boundary", not "new category". Import is listed before export in
 * every section (the profiles pair already read that way; environments and
 * JSON Schemas are reordered here to match).
 *
 * `ExportEnvironmentDialog` is also opened from a per-row shortcut in
 * `EnvironmentSwitcher` (pre-checking just that row) — this is still its only
 * *mount* point, matching every other dialog here, since where a dialog
 * mounts and what triggers it are independent (`useEnvironmentTransfer` is
 * the shared store both trigger points write to).
 */

import { useTranslation } from "react-i18next";
import {
  ChevronDown,
  Download,
  FolderOpen,
  Plus,
  Settings,
  Upload,
} from "lucide-react";
import { useConnections } from "@/stores/session/connections";
import { useConnectionDialog } from "@/stores/dialogs/connectionDialog";
import { useEnvironmentTransfer } from "@/stores/dialogs/environmentTransfer";
import { Button } from "@/components/ui/button";
import { ShortcutHint } from "@/components/menus/ShortcutHint";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuItem,
  DropdownMenuSeparator,
} from "@/components/ui/dropdown";
import { ConnectionDialog } from "@/components/connection/dialogs/ConnectionDialog";
import { ExportProfilesDialog } from "@/components/connection/dialogs/ExportProfilesDialog";
import { ImportProfilesDialog } from "@/components/connection/dialogs/ImportProfilesDialog";
import { ExportEnvironmentDialog } from "@/components/connection/dialogs/ExportEnvironmentDialog";
import { ImportEnvironmentDialog } from "@/components/connection/dialogs/ImportEnvironmentDialog";
import { ExportJsonSchemasDialog } from "@/components/jsonSchema/dialogs/ExportJsonSchemasDialog";
import { ImportJsonSchemasDialog } from "@/components/jsonSchema/dialogs/ImportJsonSchemasDialog";
import { useJsonSchemaTransfer } from "@/stores/dialogs/jsonSchemaTransfer";

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
  const exportEnvOpen = useEnvironmentTransfer((s) => s.exportOpen);
  const exportEnvPreselect = useEnvironmentTransfer((s) => s.exportPreselect);
  const openExportEnv = useEnvironmentTransfer((s) => s.openExport);
  const closeExportEnv = useEnvironmentTransfer((s) => s.closeExport);
  const exportSchemasOpen = useJsonSchemaTransfer((s) => s.exportOpen);
  const exportSchemasPreselect = useJsonSchemaTransfer(
    (s) => s.exportPreselect,
  );
  const openExportSchemas = useJsonSchemaTransfer((s) => s.openExport);
  const closeExportSchemas = useJsonSchemaTransfer((s) => s.closeExport);
  const importSchemasOpen = useJsonSchemaTransfer((s) => s.importOpen);
  const setImportSchemasOpen = useJsonSchemaTransfer((s) => s.setImportOpen);
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
            <ShortcutHint action="newConnection" />
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => openManage(selectedConnectionId)}>
            <Settings className="mr-2 h-3.5 w-3.5" />
            {t("menu.file.manageConnections")}
            <ShortcutHint action="manageConnections" />
          </DropdownMenuItem>
          <DropdownMenuSeparator />

          <DropdownMenuLabel>
            {t("menu.file.sectionProfiles")}
          </DropdownMenuLabel>
          <DropdownMenuItem onSelect={() => setImportOpen(true)}>
            <Upload className="mr-2 h-3.5 w-3.5" />
            {t("menu.file.importProfiles")}
            <ShortcutHint action="importProfiles" />
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => setExportOpen(true)}>
            <Download className="mr-2 h-3.5 w-3.5" />
            {t("menu.file.exportProfiles")}
            <ShortcutHint action="exportProfiles" />
          </DropdownMenuItem>

          <DropdownMenuSeparator />

          <DropdownMenuLabel>
            {t("menu.file.sectionEnvironments")}
          </DropdownMenuLabel>
          <DropdownMenuItem onSelect={() => setImportEnvOpen(true)}>
            <Upload className="mr-2 h-3.5 w-3.5" />
            {t("menu.file.importEnvironment")}
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => openExportEnv()}>
            <Download className="mr-2 h-3.5 w-3.5" />
            {t("menu.file.exportEnvironments")}
          </DropdownMenuItem>

          <DropdownMenuSeparator />

          <DropdownMenuLabel>
            {t("menu.file.sectionJsonSchemas")}
          </DropdownMenuLabel>
          <DropdownMenuItem onSelect={() => setImportSchemasOpen(true)}>
            <Upload className="mr-2 h-3.5 w-3.5" />
            {t("menu.file.importJsonSchemas")}
            <ShortcutHint action="importJsonSchemas" />
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => openExportSchemas()}>
            <Download className="mr-2 h-3.5 w-3.5" />
            {t("menu.file.exportJsonSchemas")}
            <ShortcutHint action="exportJsonSchemas" />
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
      <ExportEnvironmentDialog
        open={exportEnvOpen}
        preselect={exportEnvPreselect}
        onClose={closeExportEnv}
      />
      <ImportEnvironmentDialog
        open={importEnvOpen}
        onOpenChange={setImportEnvOpen}
      />
      {/* Mounted here and nowhere else, like the environment pair above: the
          Settings section reaches them through the store rather than rendering a
          second copy, which would double-render and steal focus. */}
      <ExportJsonSchemasDialog
        open={exportSchemasOpen}
        preselect={exportSchemasPreselect}
        onClose={closeExportSchemas}
      />
      <ImportJsonSchemasDialog
        open={importSchemasOpen}
        onOpenChange={setImportSchemasOpen}
      />
    </>
  );
}
