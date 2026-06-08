/**
 * Status-bar connections control. Replaces the old comma-joined list of
 * active connection names with a dropdown: active pools at the top (click to
 * jump to that workspace, or disconnect), saved-but-idle profiles below for
 * quick-connect. The trigger shows a brand-coloured dot + a live count.
 *
 * Connect / disconnect mirror the FileMenu flow (best-effort connect with the
 * keychain-stored secret; disconnect tears down the schema cache + tabs) so
 * the two entry points behave identically.
 */

import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { Check, ChevronUp, Plug, X } from "lucide-react";
import { useConnections } from "@/stores/connections";
import { useSchema } from "@/stores/schema";
import { useTabs } from "@/stores/tabs";
import { useUi } from "@/stores/ui";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
} from "@/components/ui/dropdown";
import { DriverBadge } from "@/components/DriverBadge";
import { driverMismatchHint } from "@/lib/driver";
import { cn } from "@/lib/utils";
import type { ConnectionProfile } from "@/types";

export function StatusConnections() {
  const { t } = useTranslation();
  const profiles = useConnections((s) => s.profiles);
  const active = useConnections((s) => s.active);
  const versions = useConnections((s) => s.versions);
  const connect = useConnections((s) => s.connect);
  const disconnect = useConnections((s) => s.disconnect);
  const refreshSchema = useSchema((s) => s.refresh);
  const dropSchema = useSchema((s) => s.drop);
  const closeTabs = useTabs((s) => s.closeForConnection);
  const selected = useUi((s) => s.selectedConnectionId);
  const setSelected = useUi((s) => s.setSelectedConnectionId);

  // Split profiles into active / idle. Both inputs are reference-stable, so
  // deriving here (rather than via a store selector) honours the Zustand rule.
  const { activeProfiles, idleProfiles } = useMemo(() => {
    const a: ConnectionProfile[] = [];
    const idle: ConnectionProfile[] = [];
    for (const p of profiles) (active.has(p.id) ? a : idle).push(p);
    return { activeProfiles: a, idleProfiles: idle };
  }, [profiles, active]);

  // The connection currently in focus (a live pool the workspace points at).
  // Drives the trigger label so the active connection is visible at a glance.
  const current = useMemo(
    () =>
      selected
        ? profiles.find((p) => p.id === selected && active.has(p.id)) ?? null
        : null,
    [selected, profiles, active],
  );

  async function handleConnect(p: ConnectionProfile) {
    if (active.has(p.id)) {
      setSelected(p.id);
      return;
    }
    try {
      await connect(p.id);
      await refreshSchema(p.id);
      setSelected(p.id);
    } catch (e) {
      // Same behaviour as the FileMenu: a profile that needs an
      // interactively-typed password surfaces the failure rather than
      // silently doing nothing.
      const msg = String(e);
      const hint = driverMismatchHint(msg);
      alert(`Connect failed: ${hint ? `${msg} — ${hint}` : msg}`);
    }
  }

  async function handleDisconnect(id: string) {
    try {
      await disconnect(id);
      dropSchema(id);
      closeTabs(id);
      if (selected === id) setSelected(null);
    } catch {
      // Non-fatal: leave the rest of the UI untouched on a teardown error.
    }
  }

  const count = activeProfiles.length;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          className={cn(
            "flex items-center gap-1.5 rounded-sm px-1 py-0.5 outline-none transition-colors hover:bg-accent hover:text-foreground focus-visible:ring-1 focus-visible:ring-ring",
            count > 0 && "text-foreground",
          )}
          title={t("statusBar.connectionsActive")}
        >
          {current ? (
            <DriverBadge driver={current.driver} />
          ) : (
            <span
              className={cn(
                "h-1.5 w-1.5 rounded-full",
                count > 0 ? "bg-brand" : "bg-muted-foreground/40",
              )}
            />
          )}
          <span className="max-w-[12rem] truncate">
            {current
              ? current.name
              : count > 0
                ? t("statusBar.connections", { count })
                : t("statusBar.disconnected")}
          </span>
          <ChevronUp className="h-3 w-3 opacity-60" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        side="top"
        align="start"
        className="w-72"
      >
        <div className="px-2 py-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
          {t("statusBar.connectionsActive")}
        </div>
        {activeProfiles.length === 0 ? (
          <div className="px-2 py-1.5 text-xs text-muted-foreground">
            {t("statusBar.noConnections")}
          </div>
        ) : (
          activeProfiles.map((p) => (
            <DropdownMenuItem
              key={p.id}
              onSelect={() => setSelected(p.id)}
              className="gap-2"
            >
              {selected === p.id ? (
                <Check className="h-3.5 w-3.5 shrink-0 text-brand" />
              ) : (
                <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-brand" />
              )}
              <span
                className={cn(
                  "flex-1 truncate text-xs",
                  selected === p.id && "font-semibold",
                )}
              >
                {p.name}
              </span>
              {versions[p.id] && (
                <span className="max-w-[6rem] truncate font-mono text-[10px] text-muted-foreground">
                  {versions[p.id]}
                </span>
              )}
              <DriverBadge driver={p.driver} />
              <button
                type="button"
                title={t("statusBar.disconnect")}
                className="ml-0.5 rounded-sm p-0.5 text-muted-foreground transition-colors hover:bg-destructive/15 hover:text-destructive"
                onClick={(e) => {
                  // Don't let the click bubble to the row's onSelect (jump).
                  e.preventDefault();
                  e.stopPropagation();
                  void handleDisconnect(p.id);
                }}
              >
                <X className="h-3 w-3" />
              </button>
            </DropdownMenuItem>
          ))
        )}

        {idleProfiles.length > 0 && (
          <>
            <DropdownMenuSeparator />
            <div className="px-2 py-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
              {t("statusBar.connectionsAvailable")}
            </div>
            {idleProfiles.map((p) => (
              <DropdownMenuItem
                key={p.id}
                onSelect={() => void handleConnect(p)}
                className="gap-2"
              >
                <Plug className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                <span className="flex-1 truncate text-xs">{p.name}</span>
                <DriverBadge driver={p.driver} />
              </DropdownMenuItem>
            ))}
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
