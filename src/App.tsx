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

import { useEffect, useMemo, useState } from "react";
import "dockview-react/dist/styles/dockview.css";
import {
  DockviewReact,
  themeAbyss,
  themeLight,
  type DockviewReadyEvent,
  type IDockviewPanelProps,
} from "dockview-react";
import { Moon, Settings, Sun } from "lucide-react";
import { useConnections } from "@/stores/connections";
import { useUi } from "@/stores/ui";
import { useThemeStore, selectActiveTheme } from "@/stores/theme";
import { FileMenu } from "@/components/FileMenu";
import { SchemaExplorer } from "@/components/SchemaExplorer";
import { TabbedArea } from "@/components/TabbedArea";
import { StatusBar } from "@/components/StatusBar";
import { SettingsDialog } from "@/components/SettingsDialog";
import { SavedQueriesPanel } from "@/components/SavedQueriesPanel";
import { Button } from "@/components/ui/button";
import { TooltipProvider } from "@/components/ui/tooltip";
import {
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
  if (!id) {
    return (
      <div className="flex h-full items-center justify-center px-3 text-center text-xs text-muted-foreground">
        Connect to a database from the File menu to browse its schema.
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
  const [settingsOpen, setSettingsOpen] = useState(false);

  // Initial profile load — used to live inside ConnectionList, which is
  // no longer mounted at startup.
  useEffect(() => {
    refreshConnections();
  }, [refreshConnections]);

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
          {/* Left — File menu */}
          <FileMenu selectedConnectionId={selected} onSelect={setSelected} />

          {/* Centred breadcrumb — absolutely positioned so it stays in the
              middle of the bar regardless of action button widths. */}
          <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
            <div className="flex items-center gap-2 font-mono text-sm">
              <span className="font-semibold tracking-tight">huginndb</span>
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
                  alpha
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
              title="Toggle light / dark"
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
              onClick={() => setSettingsOpen(true)}
              title="Settings & themes"
            >
              <Settings className="h-4 w-4" />
            </Button>
          </div>
        </header>
        <SettingsDialog open={settingsOpen} onOpenChange={setSettingsOpen} />
        <div className="flex-1 overflow-hidden">
          <DockviewReact
            components={COMPONENTS}
            onReady={onDockviewReady}
            theme={activeTheme.mode === "dark" ? themeAbyss : themeLight}
          />
        </div>
        <StatusBar />
      </div>
    </TooltipProvider>
  );
}
