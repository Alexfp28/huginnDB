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
import {
  CheckCircle2,
  Info,
  Moon,
  Settings,
  Sun,
  TriangleAlert,
  XCircle,
} from "lucide-react";
import { Toaster } from "sonner";
import {
  selectUpdateNotificationVisible,
  useUpdateStore,
} from "@/stores/update";
import { UpdateBanner } from "@/components/UpdateBanner";
import { WindowTitleSync } from "@/components/WindowTitleSync";
import { SandboxRibbon } from "@/components/SandboxRibbon";
import { getCurrentVersion } from "@/lib/updater";
import { useWhatsNew } from "@/stores/whatsNew";
import { WhatsNewDialog } from "@/components/WhatsNewDialog";
import { DocsDialog } from "@/components/DocsDialog";
import { useConnections } from "@/stores/connections";
import { useSchema } from "@/stores/schema";
import { useTabs } from "@/stores/tabs";
import { useUi } from "@/stores/ui";
import { useThemeStore, selectActiveTheme } from "@/stores/theme";
import { useAppFlavor } from "@/stores/appFlavor";
import { usePreferences } from "@/stores/preferences";
import { getBinding, matchesBinding } from "@/lib/keybindings";
import { useSettingsDialog } from "@/components/settings/useSettingsDialog";
import { useTranslation } from "react-i18next";
import { setLanguage } from "@/lib/i18n";
import { FileMenu } from "@/components/FileMenu";
import { WindowMenu } from "@/components/WindowMenu";
import { ViewMenu } from "@/components/ViewMenu";
import { HelpMenu } from "@/components/HelpMenu";
import { SchemaExplorer } from "@/components/SchemaExplorer";
import { TabbedArea } from "@/components/TabbedArea";
import { StatusBar } from "@/components/StatusBar";
import { CommandPalette, useCommandPalette } from "@/components/CommandPalette";
import { TabSwitcher, useTabSwitcher } from "@/components/TabSwitcher";
import { SettingsDialog } from "@/components/SettingsDialog";
import { ConnectionErrorBoundary } from "@/components/ConnectionErrorBoundary";
import { SideEditorPanel } from "@/components/SideEditorPanel";
import { SavedQueriesPanel } from "@/components/SavedQueriesPanel";
import { Console } from "@/components/Console";
import { startLogBridge } from "@/lib/log-bridge";
import { startCliConnectBridge } from "@/lib/cli-connect-bridge";
import { startConnectionHealthBridge } from "@/lib/connection-health-bridge";
import { startConnectionSyncBridge } from "@/lib/connection-sync-bridge";
import { startPrefsSyncBridge } from "@/lib/prefs-sync-bridge";
import {
  flushAllTabState,
  hydrateWorkspaceLayout,
} from "@/stores/persistedTabs";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { CliConnectChoiceDialog } from "@/components/CliConnectChoiceDialog";
import { FeedbackDialog } from "@/components/FeedbackDialog";
import { api } from "@/lib/tauri";
import { useLogs } from "@/stores/logs";
import { normalizeDriver, driverMismatchHint } from "@/lib/driver";
import { DEFAULT_PORTS } from "@/lib/constants";
import { AdHocDriverDialog } from "@/components/AdHocDriverDialog";
import type { ConnectionProfile, Driver, StartupArgs } from "@/types";
import { Button } from "@/components/ui/button";
import { TooltipProvider, SimpleTooltip } from "@/components/ui/tooltip";
import {
  huginnDockviewTheme,
  persistLayout,
  registerDockviewApi,
  restoreOrInitLayout,
  trackSchemaWidthAroundSideEditor,
} from "@/lib/dockview";
import { refreshTable } from "@/lib/tableRefresh";

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
  /** MongoDB authSource from `--auth-source`, if any. */
  authSource?: string;
}

/** Best-effort display name for a connection intent — used in the
 *  second-launch routing dialog's prompt copy. */
function intentDisplayName(args: StartupArgs): string {
  if (args.adhoc_name) return args.adhoc_name;
  if (args.connect_profile) return args.connect_profile;
  if (args.adhoc_host)
    return `${args.adhoc_host}/${args.adhoc_database ?? ""}`;
  if (args.adhoc_connection_string) return "MongoDB";
  return "connection";
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
  /** Set when a second launch forwards a connection; opens the routing dialog
   *  (this window vs. a new one). */
  const [cliChoice, setCliChoice] = useState<StartupArgs | null>(null);
  const [cliDontAskAgain, setCliDontAskAgain] = useState(false);

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
        auth_source: p.authSource ?? null,
        // Connections opened from the CLI are temporary by design: the backend
        // keeps them in memory for the session but never writes them to
        // profiles.json (see ConnectionProfile.ephemeral / store::save_profiles).
        ephemeral: true,
      };
      try {
        const saved = await useConnections.getState().save(profile);
        await refreshConnections();
        setSelected(saved.id);
        // Always attempt the connect, even without `--password`: SQLite has
        // no password concept at all, and some servers allow passwordless /
        // trust auth. A real auth failure still surfaces via the catch below
        // — same as the saved-profile path just above, which never gated on
        // whether a CLI password was supplied.
        await connectProfile(saved.id, p.password);
        await refreshSchema(saved.id);
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
  const canaryFlavor = useAppFlavor((s) => s.canary);
  const setMode = useThemeStore((s) => s.setActiveMode);
  const hydratePreferences = usePreferences((s) => s.hydrate);
  const language = usePreferences((s) => s.prefs.ui.language);
  const cliConnectDefault = usePreferences((s) => s.prefs.ui.cliConnectDefault);
  const updateUiPrefs = usePreferences((s) => s.updateUi);
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

  // Launch restore (main window only): reapply the session-level workspace
  // layout, then — if the `reconnectOnLaunch` preference is on — reconnect to
  // the connections that were live when the app last closed. Reconnect uses
  // the secrets already in the OS keychain (connect() falls back to them when
  // no password is passed); a connection whose secret is missing or whose
  // host is unreachable simply fails its own promise and is skipped, never
  // blocking boot. Ids already active (e.g. opened by a CLI intent that raced
  // this effect) are filtered out to avoid a double connect. Runs once.
  const launchRestoreDone = useRef(false);
  useEffect(() => {
    if (launchRestoreDone.current) return;
    if (getCurrentWindow().label !== "main") return;
    launchRestoreDone.current = true;
    void (async () => {
      // Stash the persisted geometry for TabbedArea to consume when it mounts
      // (gated on `restoreTabsOnOpen` inside the call).
      await hydrateWorkspaceLayout();

      if (!usePreferences.getState().prefs.ui.reconnectOnLaunch) return;
      let ids: string[];
      try {
        ids = await api.getActiveConnections();
      } catch (e) {
        console.error("[launch] failed to read active connections", e);
        return;
      }
      if (ids.length === 0) return;
      // The boot-time refresh may not have resolved yet; ensure the profile
      // list is loaded so we only reconnect ids that still exist.
      await refreshConnections();
      const loaded = useConnections.getState().profiles;
      const alreadyActive = useConnections.getState().active;
      const toConnect = ids.filter(
        (id) => loaded.some((p) => p.id === id) && !alreadyActive.has(id),
      );
      await Promise.allSettled(
        toConnect.map((id) =>
          connectProfile(id).catch((e) => {
            console.warn(`[launch] auto-reconnect failed for ${id}`, e);
          }),
        ),
      );
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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

  // Update check on launch, plus a recurring background check so an
  // instance that's never closed still catches up on a release published
  // while it was running (see stores/update.ts). Failures inside the store
  // are swallowed and surfaced only inside Settings → About; we never
  // block boot or show an error toast.
  useEffect(() => {
    void useUpdateStore.getState().checkOnLaunch();
    useUpdateStore.getState().startPeriodicChecks();
  }, []);

  // Resolve the build flavor (stable vs canary sandbox) once. Runs in EVERY
  // window — each has its own chrome, and the sandbox ribbon must show in
  // secondary windows too. Idempotent and failure-tolerant (see the store).
  useEffect(() => {
    void useAppFlavor.getState().load();
  }, []);

  // One-shot "What's new" presentation: on the first launch after an update
  // bumped the app to a version flagged `major` in `releaseNotes.ts`, pop the
  // highlights dialog. MAIN-WINDOW-ONLY — the seen-marker is shared, so a
  // secondary ephemeral window shouldn't also fire it (same rationale as the
  // CLI-routing guard below and CLAUDE.md gotcha #8).
  useEffect(() => {
    if (getCurrentWindow().label !== "main") return;
    void (async () => {
      try {
        const version = await getCurrentVersion();
        useWhatsNew.getState().notifyLaunch(version);
      } catch (e) {
        console.error("[whatsNew] version lookup failed", e);
      }
    })();
  }, []);

  // Apply one parsed connection intent: connect a saved profile, or stage an
  // ad-hoc connection (prompting for a driver when one can't be resolved).
  // Shared by the cold-start path and the second-launch routing dialog, which
  // both feed the exact same `StartupArgs`. Whatever workspace is active when
  // this runs is where the connection lands (tab state is workspace-scoped),
  // so the dialog switches workspaces BEFORE calling this. Failures surface in
  // the Console panel instead of being swallowed.
  const applyConnectionIntent = useCallback(
    async (args: StartupArgs) => {
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
          authSource: args.adhoc_auth_source ?? undefined,
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
      }
    },
    [
      cliLog,
      connectProfile,
      createAndConnectAdhoc,
      refreshConnections,
      refreshSchema,
      setSelected,
    ],
  );

  /** Open `args` in a brand new, blank window (the new window's boot effect
   *  picks the intent back up via `takeWindowStartupIntent`). */
  const openInNewWindow = useCallback(
    async (args: StartupArgs) => {
      try {
        await api.openNewWindow(args);
      } catch (e) {
        cliLog("failed to open a new window for incoming connection", String(e));
      }
    },
    [cliLog],
  );

  // Route a second-launch connection intent to this window or a new one.
  // Only the main window ever runs this — it's the one the dialog opens in.
  const routeIncomingConnection = useCallback(
    (args: StartupArgs, target: "current" | "new") => {
      if (target === "new") void openInNewWindow(args);
      else void applyConnectionIntent(args);
    },
    [applyConnectionIntent, openInNewWindow],
  );

  /** Decide how to handle a second-launch intent: apply the remembered
   *  choice silently, or ask via the dialog when the preference is "ask". */
  const handleIncomingConnection = useCallback(
    (args: StartupArgs) => {
      if (cliConnectDefault === "ask") {
        setCliDontAskAgain(false);
        setCliChoice(args);
      } else {
        routeIncomingConnection(args, cliConnectDefault);
      }
    },
    [cliConnectDefault, routeIncomingConnection],
  );
  // The second-launch listener effect below subscribes once on mount, so it
  // would otherwise close over the first render's `handleIncomingConnection`
  // (and thus a stale `cliConnectDefault`) for the rest of the session — see
  // CLAUDE.md gotcha #9 for the same pattern with Monaco's Ctrl+Enter.
  const handleIncomingConnectionRef = useRef(handleIncomingConnection);
  handleIncomingConnectionRef.current = handleIncomingConnection;

  // Handle this window's own startup connection intent exactly once, on
  // mount. The main window reads the process's own CLI args
  // (`get_startup_args`); a secondary window opened via "New window" instead
  // drains the intent stashed for its label by `open_new_window`. Crucially
  // NOT gated on `profiles` being non-empty: ad-hoc launches (`--host …`)
  // must work on a machine with zero saved profiles, and the old guard
  // silently skipped them.
  useEffect(() => {
    if (cliArgsHandled.current) return;
    cliArgsHandled.current = true;
    void (async () => {
      let args: StartupArgs | null;
      try {
        const label = getCurrentWindow().label;
        args =
          label === "main"
            ? await api.getStartupArgs()
            : await api.takeWindowStartupIntent(label);
      } catch (e) {
        console.error("[cli] failed to read startup args", e);
        return;
      }
      if (args) await applyConnectionIntent(args);
    })();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Listen for *second* launches forwarded by the single-instance handler.
  // The main window was already focused in Rust; we route the connection
  // there or to a new window (asking first, unless the user opted out).
  // Drain any intent buffered before this listener existed (a launch that
  // raced our boot) first, then subscribe to the live event.
  //
  // MAIN-WINDOW-ONLY. Both the shared `pending_cli_connect` buffer and the
  // broadcast `cli-connect` event are meant for the running instance's main
  // window, which owns the routing decision. A secondary window handles only
  // its own startup intent (via `window_startup_intents`, in the effect
  // above). If secondary windows also ran this, the intent would be processed
  // twice: a window spawned to satisfy a "new window" route would boot,
  // re-drain the still-full buffer, and route it AGAIN — opening a third
  // window nobody asked for (issue #23). Same guard rationale as CLAUDE.md
  // gotcha #8 (only the main window touches shared session state).
  useEffect(() => {
    if (getCurrentWindow().label !== "main") return;
    let unlisten: (() => void) | null = null;
    let cancelled = false;
    void (async () => {
      try {
        const buffered = await api.takePendingCliConnect();
        if (!cancelled && buffered) handleIncomingConnectionRef.current(buffered);
      } catch (e) {
        console.error("[cli] failed to drain pending connect", e);
      }
      const fn = await startCliConnectBridge((args) =>
        handleIncomingConnectionRef.current(args),
      );
      if (cancelled) fn();
      else unlisten = fn;
    })();
    return () => {
      cancelled = true;
      unlisten?.();
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Flush every active connection's tab/layout state to disk before the
  // window actually closes (issue #80). Without this, only an explicit
  // "disconnect" ever flushed synchronously — a normal window close (let
  // alone anything more abrupt) could lose up to the debounce window's
  // worth of trailing tab/layout edits, including split-panel geometry.
  // Main-window-only: secondary ("New window") instances never touch
  // `tab_state.json` (see CLAUDE.md gotcha #8).
  useEffect(() => {
    if (getCurrentWindow().label !== "main") return;
    let unlisten: (() => void) | null = null;
    let cancelled = false;
    let closing = false;
    void getCurrentWindow()
      .onCloseRequested(async (event) => {
        if (closing) return;
        event.preventDefault();
        closing = true;
        try {
          // Record which connections are live so the next launch can
          // auto-reconnect them, then flush tabs + the session layout.
          await api.saveActiveConnections(
            Array.from(useConnections.getState().active),
          );
        } catch (err) {
          console.error("[connections] save-active-on-close failed:", err);
        }
        try {
          await flushAllTabState();
        } catch (err) {
          console.error("[persistedTabs] flush-on-close failed:", err);
        }
        // `destroy()`, not `close()` — `close()` re-emits close-requested
        // and would loop back into this same handler.
        await getCurrentWindow().destroy();
      })
      .then((fn) => {
        if (cancelled) fn();
        else unlisten = fn;
      });
    return () => {
      cancelled = true;
      unlisten?.();
    };
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

  // Subscribe to the Rust `huginndb://connection-lost` Tauri event so the
  // connection list can surface a reconnect action the moment the
  // background keepalive (`src-tauri/src/keepalive.rs`) detects a dead
  // pool, instead of the user finding out mid-query.
  useEffect(() => {
    let unlisten: (() => void) | null = null;
    let cancelled = false;
    void startConnectionHealthBridge().then((fn) => {
      if (cancelled) fn();
      else unlisten = fn;
    });
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, []);

  // Cross-window sync (issue #18): every window shares one backend
  // AppState, but each window's frontend used to hold a private snapshot
  // of `active`/`profiles`/`prefs` with no way to learn about another
  // window's connect/disconnect/profile edit/settings change.
  useEffect(() => {
    let unlisten: (() => void) | null = null;
    let cancelled = false;
    void startConnectionSyncBridge().then((fn) => {
      if (cancelled) fn();
      else unlisten = fn;
    });
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, []);

  useEffect(() => {
    let unlisten: (() => void) | null = null;
    let cancelled = false;
    void startPrefsSyncBridge().then((fn) => {
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

  // Global shortcuts, attached to `window` so they fire regardless of focus
  // inside the panel layout — except inside Monaco, which swallows all of
  // these; the editor registers its own redispatch for that case (see
  // QueryEditorTab/ViewEditorTab, gotcha #9). All four are user-rebindable
  // (issue #75) via `matchesBinding` against the live `keybindings` pref.
  const togglePalette = useCommandPalette((s) => s.toggle);
  const toggleSwitcher = useTabSwitcher((s) => s.toggle);
  const openSettingsCombo = usePreferences((s) =>
    getBinding(s.prefs.keybindings, "openSettings"),
  );
  const paletteCombo = usePreferences((s) =>
    getBinding(s.prefs.keybindings, "toggleCommandPalette"),
  );
  const switcherCombo = usePreferences((s) =>
    getBinding(s.prefs.keybindings, "toggleTabSwitcher"),
  );
  const refreshCombo = usePreferences((s) =>
    getBinding(s.prefs.keybindings, "refreshData"),
  );
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.isComposing) return;
      if (matchesBinding(e, openSettingsCombo)) {
        e.preventDefault();
        openSettings();
        return;
      }
      if (matchesBinding(e, paletteCombo)) {
        e.preventDefault();
        togglePalette();
        return;
      }
      if (matchesBinding(e, switcherCombo)) {
        e.preventDefault();
        toggleSwitcher();
        return;
      }
      // `Ctrl/Cmd+R` is a permanent alias on top of the rebindable
      // `refreshData` combo (default F5) — always intercepting the native
      // WebView reload is a safety necessity, not a preference, so it can't
      // be rebound away.
      if (
        !e.repeat &&
        (matchesBinding(e, refreshCombo) ||
          ((e.ctrlKey || e.metaKey) && (e.key === "r" || e.key === "R")))
      ) {
        // Redirect to the same "refresh" action already offered as a
        // button: the active table tab's data if one is open, otherwise the
        // schema tree (database + table list) for the selected connection —
        // same target the explorer's own refresh button hits in both
        // single-DB and multi-DB mode.
        e.preventDefault();
        const activeTab = useTabs
          .getState()
          .tabs.find((t) => t.id === useTabs.getState().activeId);
        if (activeTab?.kind === "table" && refreshTable(activeTab.id)) {
          return;
        }
        if (selected) void useSchema.getState().refresh(selected);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [
    openSettings,
    togglePalette,
    toggleSwitcher,
    selected,
    openSettingsCombo,
    paletteCombo,
    switcherCombo,
    refreshCombo,
  ]);

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
        <SandboxRibbon />
        <header className="relative flex h-9 items-center border-b border-border px-2">
          {/* Left — File + Window + View + Help menus */}
          <FileMenu selectedConnectionId={selected} onSelect={setSelected} />
          <WindowMenu />
          <ViewMenu />
          <HelpMenu />

          {/* Centred breadcrumb — absolutely positioned so it stays in the
              middle of the bar regardless of action button widths. */}
          <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
            <div className="flex items-center gap-2 font-mono text-sm">
              <span className="font-semibold tracking-tight">
                {t("common.brand")}
              </span>
              {canaryFlavor && (
                <span className="rounded-sm bg-amber-400 px-1.5 py-0.5 text-[10px] font-bold uppercase leading-none tracking-wider text-amber-950 dark:bg-amber-500 dark:text-black">
                  {t("sandbox.badge")}
                </span>
              )}
              {selectedProfile && (
                <>
                  <span className="text-muted-foreground/40">·</span>
                  <span className="text-muted-foreground">
                    {selectedProfile.driver === "sqlite"
                      ? (selectedProfile.database.split(/[/\\]/).pop() ??
                        selectedProfile.database)
                      : // Multi-DB connections have no single catalog, so
                        // `database` is empty; fall back to the connection
                        // name instead of rendering a blank segment (#51).
                        selectedProfile.database || selectedProfile.name}
                  </span>
                  <span className="text-muted-foreground/40">·</span>
                  <span className="text-muted-foreground">
                    {selectedProfile.driver}
                  </span>
                </>
              )}
            </div>
          </div>

          {/* Right — theme + settings. Standalone chrome buttons → themed
              SimpleTooltip instead of native `title` (see gotcha in tooltip.tsx
              about not bulk-migrating tooltips nested inside menus). */}
          <div className="ml-auto flex items-center gap-1">
            <SimpleTooltip label={t("common.tooltipToggleTheme")} side="bottom">
              <Button
                size="icon"
                variant="ghost"
                onClick={() =>
                  setMode(activeTheme.mode === "dark" ? "light" : "dark")
                }
              >
                {activeTheme.mode === "dark" ? (
                  <Sun className="h-4 w-4" />
                ) : (
                  <Moon className="h-4 w-4" />
                )}
              </Button>
            </SimpleTooltip>
            <SimpleTooltip
              side="bottom"
              label={
                updateNotificationVisible
                  ? t("update.tooltipUpdateAvailable", {
                      version: availableVersion,
                    })
                  : t("common.tooltipOpenPreferences")
              }
            >
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
                className="relative"
              >
                <Settings className="h-4 w-4" />
                {updateNotificationVisible && (
                  <span
                    aria-hidden
                    className="pointer-events-none absolute right-1 top-1 h-1.5 w-1.5 rounded-full bg-destructive ring-2 ring-background"
                  />
                )}
              </Button>
            </SimpleTooltip>
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
      <TabSwitcher />
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
      <CliConnectChoiceDialog
        open={cliChoice !== null}
        connectionName={cliChoice ? intentDisplayName(cliChoice) : ""}
        dontAskAgain={cliDontAskAgain}
        onDontAskAgainChange={setCliDontAskAgain}
        onCurrentWindow={() => {
          const args = cliChoice;
          setCliChoice(null);
          if (cliDontAskAgain) updateUiPrefs({ cliConnectDefault: "current" });
          if (args) routeIncomingConnection(args, "current");
        }}
        onNewWindow={() => {
          const args = cliChoice;
          setCliChoice(null);
          if (cliDontAskAgain) updateUiPrefs({ cliConnectDefault: "new" });
          if (args) routeIncomingConnection(args, "new");
        }}
        onCancel={() => setCliChoice(null)}
      />
      <FeedbackDialog />
      <WhatsNewDialog />
      <DocsDialog />
      <WindowTitleSync />
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
      {updateNotificationVisible && availableVersion && (
        <UpdateBanner version={availableVersion} />
      )}
    </TooltipProvider>
  );
}
