/**
 * Top-level layout: header (File menu + centered breadcrumb + theme /
 * settings actions), a dockview-based workspace in the middle, and the
 * status bar at the bottom.
 *
 * The workspace is fully customisable — Schema, Saved queries, and the
 * Workspace (TabbedArea) each live in their own dockview panel and can
 * be moved, resized, tabbed together, or hidden. The arrangement is
 * persisted to localStorage; the FileMenu's "Reset window layout" entry
 * wipes it back to the default.
 */

import { useEffect, useMemo } from "react";
import "dockview-react/dist/styles/dockview.css";
import {
  DockviewReact,
  type DockviewReadyEvent,
  type IDockviewPanelProps,
} from "dockview-react";
import { Moon, Settings, Sun } from "lucide-react";
import { Toaster, toast } from "sonner";
import {
  selectUpdateNotificationVisible,
  useUpdateStore,
} from "@/stores/update";
import { useConnections } from "@/stores/connections";
import { useUi } from "@/stores/ui";
import { useThemeStore, selectActiveTheme } from "@/stores/theme";
import { usePreferences } from "@/stores/preferences";
import { useSettingsDialog } from "@/components/settings/useSettingsDialog";
import { useTranslation } from "react-i18next";
import { setLanguage } from "@/lib/i18n";
import { FileMenu } from "@/components/FileMenu";
import { ViewMenu } from "@/components/ViewMenu";
import { SchemaExplorer } from "@/components/SchemaExplorer";
import { TabbedArea } from "@/components/TabbedArea";
import { StatusBar } from "@/components/StatusBar";
import { SettingsDialog } from "@/components/SettingsDialog";
import { SavedQueriesPanel } from "@/components/SavedQueriesPanel";
import { Console } from "@/components/Console";
import { startLogBridge } from "@/lib/log-bridge";
import { Button } from "@/components/ui/button";
import { TooltipProvider } from "@/components/ui/tooltip";
import {
  huginnDockviewTheme,
  persistLayout,
  registerDockviewApi,
  restoreOrInitLayout,
} from "@/lib/dockview";

// ---------------------------------------------------------------------------
// Panel components — thin wrappers that pull the current connection from
// the UI store and delegate rendering to the existing feature components.
// ---------------------------------------------------------------------------

function SchemaPanel() {
  const id = useUi((s) => s.selectedConnectionId);
  const { t } = useTranslation();
  if (!id) {
    return (
      <div className="flex h-full items-center justify-center px-3 text-center text-xs text-muted-foreground">
        {t("common.emptyConnectDatabase")}
      </div>
    );
  }
  return <SchemaExplorer connectionId={id} />;
}

function SavedPanel() {
  const id = useUi((s) => s.selectedConnectionId);
  return <SavedQueriesPanel connectionId={id} />;
}

function WorkspacePanel() {
  const id = useUi((s) => s.selectedConnectionId);
  return <TabbedArea connectionId={id} />;
}

function ConsolePanel() {
  return <Console />;
}

/**
 * Component registry passed to DockviewReact. Defined at module scope
 * so the reference is stable across renders — recreating it inside the
 * component body would cause dockview to unmount and re-mount every
 * panel on each App re-render.
 */
const COMPONENTS: Record<
  string,
  React.FunctionComponent<IDockviewPanelProps>
> = {
  schema: SchemaPanel,
  saved: SavedPanel,
  workspace: WorkspacePanel,
  console: ConsolePanel,
};

// ---------------------------------------------------------------------------

export default function App() {
  const profiles = useConnections((s) => s.profiles);
  const active = useConnections((s) => s.active);
  const refreshConnections = useConnections((s) => s.refresh);
  const selected = useUi((s) => s.selectedConnectionId);
  const setSelected = useUi((s) => s.setSelectedConnectionId);
  const activeTheme = useThemeStore(selectActiveTheme);
  const setMode = useThemeStore((s) => s.setActiveMode);
  const hydratePreferences = usePreferences((s) => s.hydrate);
  const language = usePreferences((s) => s.prefs.ui.language);
  const openSettings = useSettingsDialog((s) => s.openAt);
  const updateNotificationVisible = useUpdateStore(
    selectUpdateNotificationVisible,
  );
  const availableVersion = useUpdateStore((s) => s.availableVersion);
  const { t } = useTranslation();

  // Initial profile load — used to live inside ConnectionList, which is
  // no longer mounted at startup.
  useEffect(() => {
    refreshConnections();
  }, [refreshConnections]);

  // Hydrate preferences from disk before the user can interact with the
  // settings UI. Failures fall back to defaults inside the store itself,
  // so we don't gate the rest of the boot on this promise.
  useEffect(() => {
    void hydratePreferences();
  }, [hydratePreferences]);

  // Forward the user's language choice into i18next whenever it changes
  // (on hydrate, or when the user picks a different option in Settings).
  useEffect(() => {
    setLanguage(language);
  }, [language]);

  // One-shot update check on launch. Failures inside the store are
  // swallowed and surfaced only inside Settings → About; we never block
  // boot or show an error toast.
  useEffect(() => {
    void useUpdateStore.getState().checkOnLaunch();
  }, []);

  // Subscribe to the Rust `huginndb://log` Tauri event so the Console
  // panel sees every SQL + connection event. Unlisten on unmount keeps
  // HMR clean — without it React's StrictMode + Vite's reloads would
  // attach multiple listeners and duplicate every entry.
  useEffect(() => {
    let unlisten: (() => void) | null = null;
    let cancelled = false;
    void startLogBridge().then((fn) => {
      if (cancelled) fn();
      else unlisten = fn;
    });
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, []);

  // Toast notification the first time we detect a new version per session.
  // "Later" persists the dismissal so the toast doesn't reappear next launch,
  // but the badge on the settings gear stays until the user installs.
  useEffect(() => {
    if (!updateNotificationVisible || !availableVersion) return;
    const toastId = toast(
      t("update.toastTitle", { version: availableVersion }),
      {
        description: t("update.toastDescription"),
        duration: Infinity,
        action: {
          label: t("update.install"),
          onClick: () => {
            void useUpdateStore.getState().installAndRelaunch();
          },
        },
        cancel: {
          label: t("update.later"),
          onClick: () => {
            useUpdateStore.getState().dismiss();
          },
        },
      },
    );
    return () => {
      toast.dismiss(toastId);
    };
  }, [updateNotificationVisible, availableVersion, t]);

  // Global Ctrl/Cmd+, opens the preferences dialog. We attach to `window`
  // so the binding works regardless of focus inside the panel layout.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === ",") {
        e.preventDefault();
        openSettings();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [openSettings]);

  // Stable derived breadcrumb metadata; both inputs are reference-stable
  // store values, so this satisfies the Zustand selector invariant.
  const selectedProfile = useMemo(
    () => profiles.find((p) => p.id === selected) ?? null,
    [profiles, selected],
  );

  // Keep `selected` in sync with the live connection set:
  //   • clear when the selected pool disconnects
  //   • auto-select the first active pool when nothing is selected
  useEffect(() => {
    if (selected && !active.has(selected)) setSelected(null);
    if (!selected && active.size > 0) setSelected(Array.from(active)[0]);
  }, [active, selected, setSelected]);

  /**
   * Wire up the dockview instance: stash the API for reset-layout, run
   * layout restoration (or default), and persist every subsequent
   * change back to localStorage.
   */
  const onDockviewReady = (event: DockviewReadyEvent) => {
    registerDockviewApi(event.api);
    restoreOrInitLayout(event.api);
    event.api.onDidLayoutChange(() => persistLayout(event.api));
  };

  return (
    <TooltipProvider>
      <div className="flex h-screen flex-col overflow-hidden bg-background text-foreground">
        <header className="relative flex h-9 items-center border-b border-border px-2">
          {/* Left — File + View menus */}
          <FileMenu selectedConnectionId={selected} onSelect={setSelected} />
          <ViewMenu />

          {/* Centred breadcrumb — absolutely positioned so it stays in the
              middle of the bar regardless of action button widths. */}
          <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
            <div className="flex items-center gap-2 font-mono text-sm">
              <span className="font-semibold tracking-tight">
                {t("common.brand")}
              </span>
              {selectedProfile && (
                <>
                  <span className="text-muted-foreground/40">·</span>
                  <span className="text-muted-foreground">
                    {selectedProfile.driver === "sqlite"
                      ? (selectedProfile.database.split(/[/\\]/).pop() ??
                        selectedProfile.database)
                      : selectedProfile.database}
                  </span>
                  <span className="text-muted-foreground/40">·</span>
                  <span className="text-muted-foreground">
                    {selectedProfile.driver}
                  </span>
                </>
              )}
              {!selectedProfile && (
                <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] font-sans uppercase text-muted-foreground">
                  {t("common.alpha")}
                </span>
              )}
            </div>
          </div>

          {/* Right — theme + settings */}
          <div className="ml-auto flex items-center gap-1">
            <Button
              size="icon"
              variant="ghost"
              onClick={() =>
                setMode(activeTheme.mode === "dark" ? "light" : "dark")
              }
              title={t("common.tooltipToggleTheme")}
            >
              {activeTheme.mode === "dark" ? (
                <Sun className="h-4 w-4" />
              ) : (
                <Moon className="h-4 w-4" />
              )}
            </Button>
            <Button
              size="icon"
              variant="ghost"
              onClick={() =>
                // Jump straight to the About panel only when there's a
                // pending update to act on; otherwise restore the default
                // behaviour (open at whichever section the user last used).
                updateNotificationVisible
                  ? openSettings("about")
                  : openSettings()
              }
              title={
                updateNotificationVisible
                  ? t("update.tooltipUpdateAvailable", {
                      version: availableVersion,
                    })
                  : t("common.tooltipOpenPreferences")
              }
              className="relative"
            >
              <Settings className="h-4 w-4" />
              {updateNotificationVisible && (
                <span
                  aria-hidden
                  className="pointer-events-none absolute right-1 top-1 h-1.5 w-1.5 rounded-full bg-red-500 ring-2 ring-background"
                />
              )}
            </Button>
          </div>
        </header>
        <SettingsDialog />
        <div className="flex-1 overflow-hidden">
          <DockviewReact
            components={COMPONENTS}
            onReady={onDockviewReady}
            theme={huginnDockviewTheme}
          />
        </div>
        <StatusBar />
      </div>
      <Toaster
        position="bottom-right"
        theme={activeTheme.mode === "dark" ? "dark" : "light"}
        closeButton
      />
    </TooltipProvider>
  );
}
