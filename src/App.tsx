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

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import "dockview-react/dist/styles/dockview.css";
import {
  DockviewReact,
  type DockviewReadyEvent,
  type IDockviewPanelProps,
} from "dockview-react";
import { Moon, Settings, Sun } from "lucide-react";
import { Toaster } from "sonner";
import {
  selectUpdateNotificationVisible,
  useUpdateStore,
} from "@/stores/update";
import { UpdateBanner } from "@/components/UpdateBanner";
import { useConnections } from "@/stores/connections";
import { useSchema } from "@/stores/schema";
import { useUi } from "@/stores/ui";
import { useThemeStore, selectActiveTheme } from "@/stores/theme";
import { usePreferences } from "@/stores/preferences";
import { useSettingsDialog } from "@/components/settings/useSettingsDialog";
import { useTranslation } from "react-i18next";
import { setLanguage } from "@/lib/i18n";
import { FileMenu } from "@/components/FileMenu";
import { ViewMenu } from "@/components/ViewMenu";
import { WorkspaceSwitcher } from "@/components/WorkspaceSwitcher";
import { SchemaExplorer } from "@/components/SchemaExplorer";
import { TabbedArea } from "@/components/TabbedArea";
import { StatusBar } from "@/components/StatusBar";
import { CommandPalette, useCommandPalette } from "@/components/CommandPalette";
import { SettingsDialog } from "@/components/SettingsDialog";
import { ConnectionErrorBoundary } from "@/components/ConnectionErrorBoundary";
import { SideEditorPanel } from "@/components/SideEditorPanel";
import { SavedQueriesPanel } from "@/components/SavedQueriesPanel";
import { Console } from "@/components/Console";
import { startLogBridge } from "@/lib/log-bridge";
import { api } from "@/lib/tauri";
import { useLogs } from "@/stores/logs";
import { normalizeDriver, driverMismatchHint } from "@/lib/driver";
import { DEFAULT_PORTS } from "@/lib/constants";
import { AdHocDriverDialog } from "@/components/AdHocDriverDialog";
import type { ConnectionProfile, Driver, StartupArgs } from "@/types";
import { Button } from "@/components/ui/button";
import { TooltipProvider } from "@/components/ui/tooltip";
import {
  huginnDockviewTheme,
  persistLayout,
  registerDockviewApi,
  restoreOrInitLayout,
  trackSchemaWidthAroundSideEditor,
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
  return (
    <ConnectionErrorBoundary resetKey={id}>
      <SchemaExplorer connectionId={id} />
    </ConnectionErrorBoundary>
  );
}

function SavedPanel() {
  const id = useUi((s) => s.selectedConnectionId);
  return <SavedQueriesPanel connectionId={id} />;
}

function WorkspacePanel() {
  const id = useUi((s) => s.selectedConnectionId);
  return (
    <ConnectionErrorBoundary resetKey={id ?? undefined}>
      <TabbedArea connectionId={id} />
    </ConnectionErrorBoundary>
  );
}

function ConsolePanel() {
  return <Console />;
}

function SideEditorPanelWrapper() {
  return <SideEditorPanel />;
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
  "side-editor": SideEditorPanelWrapper,
};

// ---------------------------------------------------------------------------

/** Ad-hoc connection params staged while we prompt the user for a driver
 *  (CLI launch without `--driver` and no configured default). */
interface PendingAdhoc {
  name: string;
  host: string;
  port?: number;
  database: string;
  username: string;
  ssl: boolean;
  password?: string;
  /** MongoDB connection URI from `--uri`/`--connection-string`, if any. */
  connectionString?: string;
}

export default function App() {
  const profiles = useConnections((s) => s.profiles);
  const active = useConnections((s) => s.active);
  const refreshConnections = useConnections((s) => s.refresh);
  const connectProfile = useConnections((s) => s.connect);
  const refreshSchema = useSchema((s) => s.refresh);
  const selected = useUi((s) => s.selectedConnectionId);
  const setSelected = useUi((s) => s.setSelectedConnectionId);
  const cliArgsHandled = useRef(false);
  /** Set when a CLI ad-hoc launch has no `--driver` and no configured default
   *  — opens the driver picker; the params resume once the user chooses. */
  const [driverPrompt, setDriverPrompt] = useState<PendingAdhoc | null>(null);

  /** Emit a visible Console entry for CLI diagnostics. */
  const cliLog = useCallback((message: string, error?: string) => {
    useLogs.getState().push({
      id: -Date.now(),
      timestamp_ms: Date.now(),
      kind: "connection",
      message: `[cli] ${message}`,
      error,
    });
  }, []);

  /** Create the ad-hoc profile with a now-known driver, then connect when a
   *  password was supplied. Shared by the CLI path and the driver picker. */
  const createAndConnectAdhoc = useCallback(
    async (p: PendingAdhoc, driver: Driver) => {
      const profile: ConnectionProfile = {
        id: "",
        name: p.name,
        driver,
        host: p.host,
        port: p.port ?? DEFAULT_PORTS[driver],
        database: p.database,
        username: p.username,
        ssl: p.ssl,
        // Only meaningful for MongoDB; the backend ignores it for SQL drivers.
        connection_string: p.connectionString ?? null,
        // Connections opened from the CLI are temporary by design: the backend
        // keeps them in memory for the session but never writes them to
        // profiles.json (see ConnectionProfile.ephemeral / store::save_profiles).
        ephemeral: true,
      };
      try {
        const saved = await useConnections.getState().save(profile);
        await refreshConnections();
        setSelected(saved.id);
        if (p.password) {
          await connectProfile(saved.id, p.password);
          await refreshSchema(saved.id);
        } else {
          cliLog(
            `ad-hoc profile "${saved.name}" created; no --password given, connect manually`,
          );
        }
      } catch (e) {
        const err = String(e);
        const hint = driverMismatchHint(err);
        cliLog(
          `failed to set up ad-hoc connection${hint ? ` — ${hint}` : ""}`,
          err,
        );
      }
    },
    [cliLog, connectProfile, refreshConnections, refreshSchema, setSelected],
  );
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

  // Handle command-line arguments exactly once, on mount. Crucially this is
  // NOT gated on `profiles` being non-empty: ad-hoc launches (`--host …`) must
  // work on a machine with zero saved profiles, and the old guard silently
  // skipped them. For the profile-by-name/id path we await a fresh
  // `refreshConnections()` so the lookup sees the loaded list regardless of
  // boot timing. Failures are surfaced in the Console panel instead of being
  // swallowed — "nothing happened with no feedback" was the original bug.
  useEffect(() => {
    if (cliArgsHandled.current) return;
    cliArgsHandled.current = true;

    async function handleCliArgs() {
      let args: StartupArgs;
      try {
        args = await api.getStartupArgs();
      } catch (e) {
        console.error("[cli] failed to read startup args", e);
        return;
      }
      // A `--password` on the CLI is used in-memory only: passed straight to
      // `connect`, never written to the keychain. `undefined` keeps the
      // normal keychain / password-dialog flow.
      const cliPassword = args.adhoc_password ?? undefined;

      if (args.connect_profile) {
        // Ensure the profile list is loaded before matching; the boot-time
        // refresh may not have resolved yet on a cold start.
        await refreshConnections();
        const loaded = useConnections.getState().profiles;
        const target = args.connect_by_id
          ? loaded.find((p) => p.id === args.connect_profile)
          : loaded.find((p) => p.name === args.connect_profile);
        if (!target) {
          cliLog(
            `no profile matched ${
              args.connect_by_id ? "id" : "name"
            } "${args.connect_profile}"`,
            "profile not found",
          );
          return;
        }
        try {
          await connectProfile(target.id, cliPassword);
          await refreshSchema(target.id);
          setSelected(target.id);
        } catch (e) {
          const err = String(e);
          const hint = driverMismatchHint(err);
          cliLog(
            `failed to connect profile "${target.name}"${
              hint ? ` — ${hint}` : ""
            }`,
            err,
          );
        }
        return;
      }

      // An ad-hoc launch is triggered by either `--host` or a `--uri`
      // connection string (the MongoDB-primary path, which needs no host).
      if (args.adhoc_host || args.adhoc_connection_string) {
        const pending: PendingAdhoc = {
          name:
            args.adhoc_name ??
            (args.adhoc_host
              ? `${args.adhoc_host}/${args.adhoc_database ?? ""}`
              : "MongoDB"),
          host: args.adhoc_host ?? "",
          port: args.adhoc_port ?? undefined,
          database: args.adhoc_database ?? "",
          username: args.adhoc_username ?? "",
          ssl: false,
          password: cliPassword,
          connectionString: args.adhoc_connection_string ?? undefined,
        };
        // Resolve the driver: an explicit `--driver` wins; a connection string
        // implies MongoDB; then the configured default; if none, prompt the
        // user rather than silently guessing Postgres.
        const explicit = normalizeDriver(args.adhoc_driver);
        if (args.adhoc_driver && !explicit) {
          cliLog(
            `unrecognized --driver "${args.adhoc_driver}"; asking which to use`,
          );
        }
        const configured = usePreferences.getState().prefs.ui.defaultDriver;
        const driver =
          explicit ??
          (args.adhoc_connection_string ? "mongodb" : null) ??
          configured ??
          null;
        if (driver) {
          await createAndConnectAdhoc(pending, driver);
        } else {
          setDriverPrompt(pending);
        }
        return;
      }
    }

    void handleCliArgs();
  // eslint-disable-next-line react-hooks/exhaustive-deps
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

  // Update notifications now render as a custom `UpdateBanner` at the
  // top of the window (see the JSX below). The previous implementation
  // used a corner Sonner toast, but the toast was easy to miss and its
  // styling didn't match the rest of the app chrome — see CHANGELOG
  // entry for 0.4.0. Sonner stays available for short-lived toasts
  // (errors, copy-success confirmations, etc.).

  // Global Ctrl/Cmd+, opens preferences; Ctrl/Cmd+K toggles the command
  // palette. Attached to `window` so they fire regardless of focus inside the
  // panel layout — except inside Monaco, which swallows Ctrl+K; the editor
  // registers its own command for that case (see QueryEditorTab, gotcha #9).
  const togglePalette = useCommandPalette((s) => s.toggle);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === ",") {
        e.preventDefault();
        openSettings();
      } else if ((e.ctrlKey || e.metaKey) && (e.key === "k" || e.key === "K")) {
        e.preventDefault();
        togglePalette();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [openSettings, togglePalette]);

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
    trackSchemaWidthAroundSideEditor(event.api);
    event.api.onDidLayoutChange(() => persistLayout(event.api));
  };

  return (
    <TooltipProvider>
      <div className="flex h-screen flex-col overflow-hidden bg-background text-foreground">
        <header className="relative flex h-9 items-center border-b border-border px-2">
          {/* Left — File + View menus + workspace switcher */}
          <FileMenu selectedConnectionId={selected} onSelect={setSelected} />
          <ViewMenu />
          <WorkspaceSwitcher />

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
        <div className="outer-dock flex-1 overflow-hidden">
          <DockviewReact
            components={COMPONENTS}
            onReady={onDockviewReady}
            theme={huginnDockviewTheme}
          />
        </div>
        <StatusBar />
      </div>
      <CommandPalette />
      <AdHocDriverDialog
        open={driverPrompt !== null}
        connectionName={driverPrompt?.name ?? ""}
        onPick={(driver) => {
          const pending = driverPrompt;
          setDriverPrompt(null);
          if (pending) void createAndConnectAdhoc(pending, driver);
        }}
        onCancel={() => setDriverPrompt(null)}
      />
      <Toaster
        position="bottom-right"
        theme={activeTheme.mode === "dark" ? "dark" : "light"}
        closeButton
      />
      {updateNotificationVisible && availableVersion && (
        <UpdateBanner version={availableVersion} />
      )}
    </TooltipProvider>
  );
}
