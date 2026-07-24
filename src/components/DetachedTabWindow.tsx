/**
 * Root rendered instead of `<App />` in a "sacar como ventana flotante"
 * window (see `main.tsx`) — a bare, native OS window hosting exactly one
 * workspace tab, no sidebar/menus/tab-strip. Unlike dockview's
 * `addFloatingGroup` (still used for in-app splits), this is a real
 * `WebviewWindow`: fully independent of the main window's bounds, movable
 * across the whole desktop.
 *
 * The window is a fresh JS runtime with its own empty `useTabs` — there is
 * nothing to reconcile against a dockview instance here, so we simply seed
 * that store with the one tab this window was opened for
 * (`replaceAll([tab], tab.id)`) and mount the same panel component
 * `TabbedArea` would have used. Every panel already reads its tab via
 * `useTabs` by id (see `QueryEditorTab`, `StructureEditorTab`,
 * `ViewEditorTab`), so this "just works" the same way opening that tab fresh
 * in the main window would — same cold, empty schema cache and all.
 *
 * Ephemeral by design (CLAUDE.md gotcha #8's secondary-window pattern):
 * nothing here touches `tab_state.json`, and closing the OS window is the
 * whole story — the tab was already removed from the main window's
 * `useTabs` at the moment it was popped out (see `TabbedArea`'s
 * "floatPanel" action), so there's nothing left to reconcile back.
 */

import { useEffect, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useTranslation } from "react-i18next";
import { Toaster } from "sonner";
import { CheckCircle2, Info, TriangleAlert, XCircle } from "lucide-react";
import { TooltipProvider } from "@/components/ui/tooltip";
import { ConnectionErrorBoundary } from "@/components/ConnectionErrorBoundary";
import { SandboxRibbon } from "@/components/SandboxRibbon";
import { TableDataTab } from "@/components/TableDataTab";
import { QueryEditorTab } from "@/components/QueryEditorTab";
import { StructureEditorTab } from "@/components/StructureEditorTab";
import { ViewEditorTab } from "@/components/ViewEditorTab";
import { SecurityTab } from "@/components/SecurityTab";
import { useTabs } from "@/stores/tabs";
import { useConnections } from "@/stores/connections";
import { usePreferences } from "@/stores/preferences";
import { useAppFlavor } from "@/stores/appFlavor";
import { useThemeStore, selectActiveTheme } from "@/stores/theme";
import { setLanguage } from "@/lib/i18n";
import { api } from "@/lib/tauri";
import type { AppTab } from "@/types";

function TabBody({ tab }: { tab: AppTab }) {
  switch (tab.kind) {
    case "table":
      return (
        <TableDataTab
          tabId={tab.id}
          connectionId={tab.connectionId}
          schema={tab.schema}
          table={tab.table ?? ""}
        />
      );
    case "query":
      return <QueryEditorTab tabId={tab.id} connectionId={tab.connectionId} />;
    case "structure":
      return (
        <StructureEditorTab
          tabId={tab.id}
          connectionId={tab.connectionId}
          schema={tab.schema}
          table={tab.table}
          mode={tab.structureMode ?? "edit"}
        />
      );
    case "view":
      return (
        <ViewEditorTab
          tabId={tab.id}
          connectionId={tab.connectionId}
          schema={tab.schema}
          view={tab.view}
          mode={tab.viewMode ?? "edit"}
        />
      );
    case "security":
      return <SecurityTab tabId={tab.id} connectionId={tab.connectionId} />;
  }
}

export function DetachedTabWindow() {
  const { t } = useTranslation();
  const [tab, setTab] = useState<AppTab | null | undefined>(undefined);
  const activeTheme = useThemeStore(selectActiveTheme);
  const language = usePreferences((s) => s.prefs.ui.language);

  // Minimal bootstrap — just enough state for the panel components to run
  // standalone, without the main window's launch-restore / reconnect flow
  // (this window never initiates a connection; the pool it needs is already
  // open in the shared backend `AppState`).
  useEffect(() => {
    void useAppFlavor.getState().load();
    void usePreferences.getState().hydrate();
    void useConnections.getState().refresh();
    const label = getCurrentWindow().label;
    void api.takeDetachedTabIntent(label).then((payload) => {
      if (payload) useTabs.getState().replaceAll([payload], payload.id);
      setTab(payload);
    });
  }, []);

  useEffect(() => {
    setLanguage(language);
  }, [language]);

  return (
    <TooltipProvider>
      <div className="flex h-screen flex-col overflow-hidden bg-background text-foreground">
        <SandboxRibbon />
        <div className="min-h-0 flex-1">
          {tab === undefined ? null : tab === null ? (
            <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
              {t("tabs.detachedUnavailable")}
            </div>
          ) : (
            <ConnectionErrorBoundary resetKey={tab.connectionId}>
              <TabBody tab={tab} />
            </ConnectionErrorBoundary>
          )}
        </div>
        <Toaster
          position="bottom-right"
          theme={activeTheme.mode === "dark" ? "dark" : "light"}
          closeButton
          icons={{
            success: <CheckCircle2 className="h-4 w-4 text-brand" />,
            error: <XCircle className="h-4 w-4 text-destructive" />,
            info: <Info className="h-4 w-4 text-muted-foreground" />,
            warning: <TriangleAlert className="h-4 w-4 text-warning" />,
          }}
        />
      </div>
    </TooltipProvider>
  );
}
