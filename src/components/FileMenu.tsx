/**
 * Top-left "File" dropdown. Replaces the persistent Connections sidebar
 * panel — once a user has configured their profiles this is the single
 * entry point for connecting, switching, and managing them.
 *
 * Menu structure:
 *   File ▾
 *   ├── New connection…
 *   ├── Manage connections…
 *   ├── ────────────
 *   │   CONNECTIONS  (label)
 *   ├── ● Chinook   (active — green dot, click to select)
 *   ├── ○ Northwind (inactive — click to connect)
 *   ├── ────────────
 *   └── Disconnect all  (disabled when nothing is connected)
 */

import { useState } from "react";
import { useTranslation } from "react-i18next";
import {
  Check,
  ChevronDown,
  Download,
  FolderOpen,
  PlugZap,
  Plus,
  Settings,
  Upload,
} from "lucide-react";
import { useConnections } from "@/stores/connections";
import { useSchema } from "@/stores/schema";
import { useTabs } from "@/stores/tabs";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
} from "@/components/ui/dropdown";
import { ConnectionDialog } from "@/components/ConnectionDialog";
import { ExportProfilesDialog } from "@/components/ExportProfilesDialog";
import { ImportProfilesDialog } from "@/components/ImportProfilesDialog";
import { DriverBadge } from "@/components/DriverBadge";
import { driverMismatchHint } from "@/lib/driver";
import { cn } from "@/lib/utils";
import type { ConnectionProfile } from "@/types";

interface Props {
  selectedConnectionId: string | null;
  onSelect: (id: string | null) => void;
}

export function FileMenu({ selectedConnectionId, onSelect }: Props) {
  const profiles = useConnections((s) => s.profiles);
  const active = useConnections((s) => s.active);
  const connect = useConnections((s) => s.connect);
  const disconnect = useConnections((s) => s.disconnect);
  const refreshSchema = useSchema((s) => s.refresh);
  const dropSchema = useSchema((s) => s.drop);
  const closeTabs = useTabs((s) => s.closeForConnection);

  const [connDialogOpen, setConnDialogOpen] = useState(false);
  // Which profile the manager opens focused on: `null` starts a new draft
  // ("New connection"), a profile preselects it ("Manage connections").
  const [dialogInitial, setDialogInitial] = useState<ConnectionProfile | null>(
    null,
  );
  const [exportOpen, setExportOpen] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const { t } = useTranslation();

  /** Connect to a profile (or just select it if it's already active). */
  async function handleSelect(p: ConnectionProfile) {
    if (active.has(p.id)) {
      onSelect(p.id);
      return;
    }
    try {
      await connect(p.id);
      await refreshSchema(p.id);
      onSelect(p.id);
    } catch (e) {
      const msg = String(e);
      const hint = driverMismatchHint(msg);
      alert(`Connect failed: ${hint ? `${msg} — ${hint}` : msg}`);
    }
  }

  /** Tear down every live pool and clear the selected connection. */
  async function handleDisconnectAll() {
    for (const id of Array.from(active)) {
      try {
        await disconnect(id);
        dropSchema(id);
        closeTabs(id);
      } catch {
        // Continue on partial failures so one bad pool doesn't block the rest.
      }
    }
    onSelect(null);
  }

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

          <DropdownMenuSeparator />
          <div className="px-2 py-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
            {t("menu.file.sectionConnections")}
          </div>
          {profiles.length === 0 ? (
            <div className="px-2 py-1.5 text-xs text-muted-foreground">
              {t("menu.file.noConnections")}
            </div>
          ) : (
            profiles.map((p) => {
              const isActive = active.has(p.id);
              const isSelected = selectedConnectionId === p.id;
              return (
                <DropdownMenuItem
                  key={p.id}
                  onSelect={() => handleSelect(p)}
                  className="gap-2"
                >
                  <span
                    className={cn(
                      "h-1.5 w-1.5 shrink-0 rounded-full",
                      isActive ? "bg-brand" : "bg-muted-foreground/40",
                    )}
                  />
                  <span
                    className={cn(
                      "flex-1 truncate text-xs",
                      isSelected && "font-semibold",
                    )}
                  >
                    {p.name}
                  </span>
                  <DriverBadge driver={p.driver} />
                  {isSelected && (
                    <Check className="h-3.5 w-3.5 shrink-0 text-brand" />
                  )}
                </DropdownMenuItem>
              );
            })
          )}

          <DropdownMenuSeparator />
          <DropdownMenuItem
            disabled={active.size === 0}
            onSelect={handleDisconnectAll}
            className="text-xs"
          >
            <PlugZap className="mr-2 h-3.5 w-3.5" />
            {t("menu.file.disconnectAll")}
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
