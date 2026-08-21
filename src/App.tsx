/**
 * Top-level layout: header (File menu + centered breadcrumb + theme /
 * settings actions), the outer shell in the middle, and the status bar
 * at the bottom.
 *
 * The outer shell (`AppShell`) is an activity-bar-driven layout: Schema
 * and Saved dock to a fixed side and collapse to 0px from their activity
 * bar button, Console docks to the bottom, and the workspace island (open
 * table/query tabs) is the one fixed, unmovable canvas in the middle — see
 * `stores/session/panelLayout.ts` for why this replaced the old 5-panel
 * outer dockview (it visually implied you could spin up more
 * "workspaces", which was never the intent).
 */

import { useEffect, useMemo, useRef } from "react";
import "dockview-react/dist/styles/dockview.css";
import { CheckCircle2, Info, TriangleAlert, XCircle } from "lucide-react";
import { Toaster } from "sonner";
import {
  selectUpdateNotificationVisible,
  useUpdateStore,
} from "@/stores/update";
import { UpdateBanner } from "@/components/shell/UpdateBanner";
import { WindowTitleSync } from "@/components/shell/WindowTitleSync";
import { SandboxRibbon } from "@/components/shell/SandboxRibbon";
import { SplashScreen } from "@/components/shell/SplashScreen";
import { getCurrentVersion } from "@/lib/appInfo/updater";
import { useWhatsNew } from "@/stores/dialogs/whatsNew";
import { WhatsNewDialog } from "@/components/shell/dialogs/WhatsNewDialog";
import { DocsDialog } from "@/components/shell/dialogs/DocsDialog";
import { useConnections } from "@/stores/session/connections";
import { useSchema } from "@/stores/session/schema";
import { useTabs } from "@/stores/session/tabs";
import { useUi } from "@/stores/session/ui";
import { useThemeStore, selectActiveTheme } from "@/stores/preferences/theme";
import { useAppFlavor } from "@/stores/preferences/appFlavor";
import { usePreferences } from "@/stores/preferences/preferences";
import { getBinding, matchesBinding } from "@/lib/keybindings";
import { useSettingsDialog } from "@/components/settings/useSettingsDialog";
import { useTranslation } from "react-i18next";
import { setLanguage } from "@/lib/i18n";
import { FileMenu } from "@/components/menus/FileMenu";
import { WindowMenu } from "@/components/menus/WindowMenu";
import { ViewMenu } from "@/components/menus/ViewMenu";
import { HelpMenu } from "@/components/menus/HelpMenu";
import { AppShell } from "@/components/shell/AppShell";
import { LayoutToggles } from "@/components/shell/LayoutToggles";
import { StatusBar } from "@/components/shell/StatusBar";
import { CommandPalette } from "@/components/shell/CommandPalette";
import { useCommandPalette } from "@/stores/dialogs/commandPalette";
import { TabSwitcher, useTabSwitcher } from "@/components/shell/TabSwitcher";
import { SettingsDialog } from "@/components/settings/dialogs/SettingsDialog";
import { EnvironmentEditorDialog } from "@/components/connection/dialogs/EnvironmentEditorDialog";
import { EnvironmentDeleteConfirmDialog } from "@/components/connection/dialogs/EnvironmentDeleteConfirmDialog";
import { startLogBridge } from "@/lib/bridges/log-bridge";
import {
  intentDisplayName,
  useCliIntents,
} from "@/lib/cli/useCliIntents";
import { startConnectionHealthBridge } from "@/lib/bridges/connection-health-bridge";
import { startConnectionSyncBridge } from "@/lib/bridges/connection-sync-bridge";
import { startPrefsSyncBridge } from "@/lib/bridges/prefs-sync-bridge";
import { startJsonSchemaBridge } from "@/lib/bridges/json-schema-bridge";
import { useJsonSchemas } from "@/stores/jsonSchemas";
import { setModePrefs } from "@/lib/monaco/monacoJson";
import { flushAllTabState, persistLaunchState } from "@/stores/session/persistedTabs";
import { useEnvironments } from "@/stores/session/environments";
import { startPeriodicOriginSync } from "@/stores/sync/originSync";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { isMainWindow } from "@/lib/window";
import { CliConnectChoiceDialog } from "@/components/connection/dialogs/CliConnectChoiceDialog";
import { FeedbackDialog } from "@/components/shell/dialogs/FeedbackDialog";
import { LEGACY_DOCKVIEW_LAYOUT_KEY } from "@/lib/constants";
import { AdHocDriverDialog } from "@/components/connection/dialogs/AdHocDriverDialog";
import { TooltipProvider } from "@/components/ui/tooltip";
import { refreshTable } from "@/lib/grid/tableRefresh";
import { sqliteFileLabel } from "@/lib/connectionLabel";
import { useBridge } from "@/lib/bridges/useBridge";

export default function App() {
  const profiles = useConnections((s) => s.profiles);
  const active = useConnections((s) => s.active);
  const refreshConnections = useConnections((s) => s.refresh);
  const selected = useUi((s) => s.selectedConnectionId);
  const setSelected = useUi((s) => s.setSelectedConnectionId);
  const activeTheme = useThemeStore(selectActiveTheme);
  const canaryFlavor = useAppFlavor((s) => s.canary);
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

  // Launch restore: load the environment list in EVERY window — it's a
  // read-only call, and a secondary "New window" needs it too so its own
  // rail/switcher can render and seed that window's own connection filter
  // from whatever environment is active (see `useEnvironments.load`). Only the
  // main window goes on to bring the active environment's session up — its
  // view filters always, and with `reconnectOnLaunch` on, also reconnect what
  // was live, restore the pane layout and restore focus. (The filters sit
  // before that gate inside `restoreSession`: they say how the environment
  // looks, not what it reopens.)
  //
  // The sequence itself lives in `useEnvironments.restoreSession` because
  // entering an environment at launch and entering one via the switcher are the
  // same operation, and its ordering is load-bearing enough that two copies
  // would eventually drift: the layout `fromJSON` must run AFTER the
  // reconnected tabs are in `useTabs`, or the TabbedArea reconciler deletes the
  // panels it just built (gotcha #10), and focus must come last because
  // `connect()` never sets it and the auto-select effect below would otherwise
  // win with whichever pool opened first. Runs once.
  const launchRestoreDone = useRef(false);
  useEffect(() => {
    if (launchRestoreDone.current) return;
    launchRestoreDone.current = true;
    void (async () => {
      await useEnvironments.getState().load();
      if (!isMainWindow()) return;
      await useEnvironments.getState().restoreSession();
      // Shared origins: first sweep now, then every few hours. After the session
      // is up so a slow or unreachable share can never delay the workspace.
      startPeriodicOriginSync();
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
    if (!isMainWindow()) return;
    void (async () => {
      try {
        const version = await getCurrentVersion();
        useWhatsNew.getState().notifyLaunch(version);
      } catch (e) {
        console.error("[whatsNew] version lookup failed", e);
      }
    })();
  }, []);

  // Command-line connection intents: this window's own startup args, and a
  // second launch of the app forwarded by the single-instance handler. Called
  // HERE, not in a child component: a child's effects mount before its
  // parent's, which would move these ahead of the launch-restore sequence
  // above whose ordering gotchas #8 and #10 pin down. This is the position the
  // code occupied before it moved into the hook.
  const cli = useCliIntents();

  // Flush every active connection's tab/layout state to disk before the
  // window actually closes (issue #80). Without this, only an explicit
  // "disconnect" ever flushed synchronously — a normal window close (let
  // alone anything more abrupt) could lose up to the debounce window's
  // worth of trailing tab/layout edits, including split-panel geometry.
  // Main-window-only: secondary ("New window") instances never touch
  // `tab_state.json` (see CLAUDE.md gotcha #8).
  useEffect(() => {
    if (!isMainWindow()) return;
    let unlisten: (() => void) | null = null;
    let cancelled = false;
    let closing = false;
    void getCurrentWindow()
      .onCloseRequested(async (event) => {
        if (closing) return;
        event.preventDefault();
        closing = true;
        try {
          // Record the launch state (live connections, focused connection,
          // active tab) so the next launch restores it, then flush tabs + the
          // session layout. Awaited — the window destroys right after.
          await persistLaunchState(Array.from(useConnections.getState().active));
        } catch (err) {
          console.error("[connections] save-launch-state-on-close failed:", err);
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

  // Subscribe to the Rust `huginndb://log` Tauri event so the Console panel
  // sees every SQL + connection event. (`useBridge` owns the unlisten; see its
  // doc for why the cancellation flag matters under StrictMode and HMR.)
  useBridge(startLogBridge);

  // Subscribe to the Rust `huginndb://connection-lost` Tauri event so the
  // connection list can surface a reconnect action the moment the
  // background keepalive (`src-tauri/src/keepalive.rs`) detects a dead
  // pool, instead of the user finding out mid-query.
  useBridge(startConnectionHealthBridge);

  // Cross-window sync (issue #18): every window shares one backend
  // AppState, but each window's frontend used to hold a private snapshot
  // of `active`/`profiles`/`prefs` with no way to learn about another
  // window's connect/disconnect/profile edit/settings change.
  useBridge(startConnectionSyncBridge);

  // The other half of #18: preference writes from any window.
  useBridge(startPrefsSyncBridge);

  // Keep the JSON language service in step with the three schema switches.
  // Subscribed as primitives, so this effect fires only when one actually flips
  // (gotcha #1) rather than on every preferences write.
  const jsonSchemaValidation = usePreferences(
    (s) => s.prefs.editor.jsonSchemaValidation,
  );
  const jsonSchemaCompletion = usePreferences(
    (s) => s.prefs.editor.jsonSchemaCompletion,
  );
  const jsonSchemaHover = usePreferences((s) => s.prefs.editor.jsonSchemaHover);
  useEffect(() => {
    setModePrefs({
      validation: jsonSchemaValidation,
      completion: jsonSchemaCompletion,
      hover: jsonSchemaHover,
    });
  }, [jsonSchemaValidation, jsonSchemaCompletion, jsonSchemaHover]);

  // The JSON Schema library: hydrate once, then keep in step with the other
  // windows. Unlike tab state, this is global config every window reads and
  // writes (see the bridge for why its listener is deliberately unscoped), so
  // there is no main-window-only guard here.
  useEffect(() => {
    void useJsonSchemas.getState().load();
  }, []);
  useBridge(startJsonSchemaBridge);

  // Update notifications now render as a custom `UpdateBanner` at the
  // top of the window (see the JSX below). The previous implementation
  // used a corner Sonner toast, but the toast was easy to miss and its
  // styling didn't match the rest of the app chrome — see CHANGELOG
  // entry for 0.4.0. Sonner stays available for short-lived toasts
  // (errors, copy-success confirmations, etc.).

  // Global shortcuts, attached to `window` so they fire regardless of focus
  // inside the panel layout — except inside Monaco, which swallows all of
  // these; the editor registers its own redispatch for that case (see
  // QueryEditorTab/ViewEditorTab, gotcha #9). All of them are user-rebindable
  // (issue #75) via `matchesBinding` against the live `keybindings` pref.
  const togglePalette = useCommandPalette((s) => s.toggle);
  const openPaletteWith = useCommandPalette((s) => s.openWith);
  const toggleSwitcher = useTabSwitcher((s) => s.toggle);
  const openSettingsCombo = usePreferences((s) =>
    getBinding(s.prefs.keybindings, "openSettings"),
  );
  const paletteCombo = usePreferences((s) =>
    getBinding(s.prefs.keybindings, "toggleCommandPalette"),
  );
  const paletteActionsCombo = usePreferences((s) =>
    getBinding(s.prefs.keybindings, "openCommandActions"),
  );
  const switcherCombo = usePreferences((s) =>
    getBinding(s.prefs.keybindings, "toggleTabSwitcher"),
  );
  const refreshCombo = usePreferences((s) =>
    getBinding(s.prefs.keybindings, "refreshData"),
  );
  const refreshSchemaCombo = usePreferences((s) =>
    getBinding(s.prefs.keybindings, "refreshSchema"),
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
      // Same palette, pre-filtered to its actions mode (VS Code's
      // Ctrl+Shift+P), so "run a command" never competes with the tables and
      // settings the catch-all mode also searches.
      if (matchesBinding(e, paletteActionsCombo)) {
        e.preventDefault();
        openPaletteWith(">");
        return;
      }
      if (matchesBinding(e, switcherCombo)) {
        e.preventDefault();
        toggleSwitcher();
        return;
      }
      // Checked *before* `refreshData` below, whose hard-coded `Ctrl/Cmd+R`
      // alias would otherwise swallow the default `Ctrl+Shift+R` (with Shift
      // held, `e.key` is `"R"`).
      if (!e.repeat && matchesBinding(e, refreshSchemaCombo)) {
        e.preventDefault();
        if (selected) void useSchema.getState().refreshTree(selected);
        return;
      }
      // `Ctrl/Cmd+R` is a permanent alias on top of the rebindable
      // `refreshData` combo (default F5) — always intercepting the native
      // WebView reload is a safety necessity, not a preference, so it can't
      // be rebound away.
      if (
        !e.repeat &&
        (matchesBinding(e, refreshCombo) ||
          ((e.ctrlKey || e.metaKey) &&
            !e.shiftKey &&
            (e.key === "r" || e.key === "R")))
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
        // `refreshTree`: `selected` is always a profile id, and a multi-DB
        // connection keeps its tables in the child slices under it.
        if (selected) void useSchema.getState().refreshTree(selected);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [
    openSettings,
    togglePalette,
    openPaletteWith,
    toggleSwitcher,
    selected,
    openSettingsCombo,
    paletteCombo,
    paletteActionsCombo,
    switcherCombo,
    refreshCombo,
    refreshSchemaCombo,
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

  // One-shot cleanup of the old 5-panel outer dockview's persisted layout
  // blob — superseded by `stores/session/panelLayout.ts`. Not migrated
  // field-by-field (see that store's header comment); just discarded.
  useEffect(() => {
    localStorage.removeItem(LEGACY_DOCKVIEW_LAYOUT_KEY);
  }, []);

  return (
    <TooltipProvider>
      {/* Decorative launch overlay, ~0.5s total. Sits outside the layout flow
          and never blocks it — see `SplashScreen` for why it isn't tied to the
          session-restore sequence. */}
      <SplashScreen />
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
                      ? sqliteFileLabel(selectedProfile.database)
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

          <div className="ml-auto">
            <LayoutToggles />
          </div>
        </header>
        <SettingsDialog />
        <EnvironmentEditorDialog />
        <EnvironmentDeleteConfirmDialog />
        <div className="flex-1 overflow-hidden">
          <AppShell />
        </div>
        <StatusBar />
      </div>
      <CommandPalette />
      <TabSwitcher />
      <AdHocDriverDialog
        open={cli.driverPrompt !== null}
        connectionName={cli.driverPrompt?.name ?? ""}
        onPick={(driver) => {
          const pending = cli.driverPrompt;
          cli.setDriverPrompt(null);
          if (pending) void cli.createAndConnectAdhoc(pending, driver);
        }}
        onCancel={() => cli.setDriverPrompt(null)}
      />
      <CliConnectChoiceDialog
        open={cli.cliChoice !== null}
        connectionName={cli.cliChoice ? intentDisplayName(cli.cliChoice) : ""}
        dontAskAgain={cli.cliDontAskAgain}
        onDontAskAgainChange={cli.setCliDontAskAgain}
        onCurrentWindow={() => {
          const args = cli.cliChoice;
          cli.setCliChoice(null);
          if (cli.cliDontAskAgain) {
            cli.updateUiPrefs({ cliConnectDefault: "current" });
          }
          if (args) cli.routeIncomingConnection(args, "current");
        }}
        onNewWindow={() => {
          const args = cli.cliChoice;
          cli.setCliChoice(null);
          if (cli.cliDontAskAgain) {
            cli.updateUiPrefs({ cliConnectDefault: "new" });
          }
          if (args) cli.routeIncomingConnection(args, "new");
        }}
        onCancel={() => cli.setCliChoice(null)}
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
