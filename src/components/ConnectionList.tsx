/**
 * Top half of the sidebar: list of saved connection profiles with
 * connect / disconnect / edit / delete actions and a "+" button to
 * launch the connection dialog.
 */

import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Plug, PlugZap, Plus, Pencil, Trash2 } from "lucide-react";
import { useConnections } from "@/stores/connections";
import { useSchema } from "@/stores/schema";
import { useTabs } from "@/stores/tabs";
import { Button } from "@/components/ui/button";
import { ConnectionDialog } from "@/components/ConnectionDialog";
import { ConnectPasswordDialog } from "@/components/ConnectPasswordDialog";
import { DriverBadge } from "@/components/DriverBadge";
import { cn } from "@/lib/utils";
import { api } from "@/lib/tauri";
import type { ConnectionProfile } from "@/types";

export function ConnectionList({
  selectedConnectionId,
  onSelect,
}: {
  selectedConnectionId: string | null;
  onSelect: (id: string | null) => void;
}) {
  const { t } = useTranslation();
  const { profiles, active, refresh, connect, disconnect, remove } =
    useConnections();
  const refreshSchema = useSchema((s) => s.refresh);
  const dropSchema = useSchema((s) => s.drop);
  const closeTabs = useTabs((s) => s.closeForConnection);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<ConnectionProfile | null>(null);
  const [pwPromptProfile, setPwPromptProfile] =
    useState<ConnectionProfile | null>(null);

  useEffect(() => {
    refresh();
  }, [refresh]);

  async function handleConnect(p: ConnectionProfile) {
    try {
      await connect(p.id);
      await refreshSchema(p.id);
      onSelect(p.id);
    } catch (e) {
      const msg = String(e);
      if (msg.includes("no stored password for keychain account")) {
        setPwPromptProfile(p);
      } else {
        alert(t("connections.connectFailed", { message: msg }));
      }
    }
  }

  async function handleConnectWithPassword(password: string) {
    if (!pwPromptProfile) return;
    await connect(pwPromptProfile.id, password);
    try {
      await api.saveProfile(pwPromptProfile, password, undefined);
    } catch {
      // keychain write failure does not block an already-open connection
    }
    await refreshSchema(pwPromptProfile.id);
    onSelect(pwPromptProfile.id);
    setPwPromptProfile(null);
  }

  async function handleDisconnect(p: ConnectionProfile) {
    await disconnect(p.id);
    dropSchema(p.id);
    closeTabs(p.id);
    if (selectedConnectionId === p.id) onSelect(null);
  }

  async function handleDelete(p: ConnectionProfile) {
    if (!confirm(t("connections.deleteConfirm", { name: p.name }))) return;
    if (active.has(p.id)) await handleDisconnect(p);
    await remove(p.id);
  }

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between px-3 py-2">
        <div className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
          {t("connections.sidebarTitle")}
        </div>
        <Button
          size="icon"
          variant="ghost"
          onClick={() => {
            setEditing(null);
            setDialogOpen(true);
          }}
          title={t("connections.newTooltip")}
        >
          <Plus className="h-4 w-4" />
        </Button>
      </div>
      <div className="flex-1 overflow-y-auto">
        {profiles.length === 0 && (
          <div className="px-3 py-4 text-xs text-muted-foreground">
            {t("connections.empty")}
          </div>
        )}
        {profiles.map((p) => {
          const isActive = active.has(p.id);
          const isSelected = selectedConnectionId === p.id;
          return (
            <div
              key={p.id}
              className={cn(
                "group flex items-center gap-2 border-l-2 px-3 py-2 text-sm transition-colors",
                isSelected
                  ? "border-primary bg-accent/40"
                  : "border-transparent hover:bg-accent/30",
              )}
              onClick={() => isActive && onSelect(p.id)}
            >
              {/* Status dot */}
              <span
                className={cn(
                  "h-1.5 w-1.5 shrink-0 rounded-full",
                  isActive ? "bg-emerald-400" : "bg-muted-foreground/40",
                )}
              />

              {/* Name + subtitle */}
              <div className="min-w-0 flex-1 cursor-default">
                <div className="flex items-center gap-1.5">
                  <span className="truncate text-sm font-medium">{p.name}</span>
                  <DriverBadge driver={p.driver} />
                </div>
                <div className="truncate text-[11px] text-muted-foreground">
                  {p.driver === "sqlite"
                    ? p.database.split(/[/\\]/).pop() ?? p.database
                    : `${p.host}:${p.port}/${p.database}`}
                </div>
              </div>

              {/* Hover actions */}
              <div className="flex items-center gap-1 opacity-0 transition-opacity group-hover:opacity-100">
                {isActive ? (
                  <Button
                    size="icon"
                    variant="ghost"
                    onClick={(e) => {
                      e.stopPropagation();
                      handleDisconnect(p);
                    }}
                    title={t("connections.disconnectTooltip")}
                  >
                    <PlugZap className="h-3.5 w-3.5 text-emerald-400" />
                  </Button>
                ) : (
                  <Button
                    size="icon"
                    variant="ghost"
                    onClick={(e) => {
                      e.stopPropagation();
                      handleConnect(p);
                    }}
                    title={t("connections.connectTooltip")}
                  >
                    <Plug className="h-3.5 w-3.5" />
                  </Button>
                )}
                <Button
                  size="icon"
                  variant="ghost"
                  onClick={(e) => {
                    e.stopPropagation();
                    setEditing(p);
                    setDialogOpen(true);
                  }}
                  title={t("connections.editTooltip")}
                >
                  <Pencil className="h-3.5 w-3.5" />
                </Button>
                <Button
                  size="icon"
                  variant="ghost"
                  onClick={(e) => {
                    e.stopPropagation();
                    handleDelete(p);
                  }}
                  title={t("connections.deleteTooltip")}
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </Button>
              </div>
            </div>
          );
        })}
      </div>
      <ConnectionDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        initial={editing}
      />
      <ConnectPasswordDialog
        open={pwPromptProfile !== null}
        profile={pwPromptProfile}
        onCancel={() => setPwPromptProfile(null)}
        onConnect={handleConnectWithPassword}
      />
    </div>
  );
}
