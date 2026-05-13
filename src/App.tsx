/**
 * Top-level layout: header with theme/settings buttons, two-column
 * body (resizable sidebar + main workspace), status bar at the bottom.
 *
 * The sidebar itself contains a Connections panel above a Schema/Saved
 * panel; both halves are independently resizable.
 */

import { useEffect, useMemo, useState } from "react";
import { Panel, PanelGroup, PanelResizeHandle } from "react-resizable-panels";
import { Moon, Settings, Sun } from "lucide-react";
import { useConnections } from "@/stores/connections";
import { useThemeStore, selectActiveTheme } from "@/stores/theme";
import { ConnectionList } from "@/components/ConnectionList";
import { SchemaExplorer } from "@/components/SchemaExplorer";
import { TabbedArea } from "@/components/TabbedArea";
import { StatusBar } from "@/components/StatusBar";
import { SettingsDialog } from "@/components/SettingsDialog";
import { SavedQueriesPanel } from "@/components/SavedQueriesPanel";
import { Button } from "@/components/ui/button";
import { TooltipProvider } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

type SidebarMode = "schema" | "saved";

export default function App() {
  const active = useConnections((s) => s.active);
  const profiles = useConnections((s) => s.profiles);
  const activeTheme = useThemeStore(selectActiveTheme);
  const setMode = useThemeStore((s) => s.setActiveMode);
  const [selected, setSelected] = useState<string | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [sidebarMode, setSidebarMode] = useState<SidebarMode>("schema");

  // Derived from stable store references; safe against the Zustand
  // infinite-re-render gotcha because both inputs are stable references.
  const selectedProfile = useMemo(
    () => profiles.find((p) => p.id === selected) ?? null,
    [profiles, selected],
  );

  useEffect(() => {
    if (selected && !active.has(selected)) setSelected(null);
    if (!selected && active.size > 0) setSelected(Array.from(active)[0]);
  }, [active, selected]);

  return (
    <TooltipProvider>
      <div className="flex h-screen flex-col overflow-hidden bg-background text-foreground">
        <header className="flex h-9 items-center justify-between border-b border-border px-3">
          <div className="flex items-center gap-2 font-mono text-sm">
            <span className="font-semibold tracking-tight">huginn</span>
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
          <div className="flex items-center gap-1">
            <Button
              size="icon"
              variant="ghost"
              onClick={() => setMode(activeTheme.mode === "dark" ? "light" : "dark")}
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
          <PanelGroup direction="horizontal">
            <Panel defaultSize={20} minSize={14} maxSize={40}>
              <PanelGroup direction="vertical" className="h-full">
                <Panel defaultSize={40} minSize={20}>
                  <ConnectionList
                    selectedConnectionId={selected}
                    onSelect={setSelected}
                  />
                </Panel>
                <PanelResizeHandle className="h-1 bg-border hover:bg-primary/30" />
                <Panel defaultSize={60} minSize={20}>
                  <div className="flex h-full flex-col">
                    <div className="flex items-center gap-0.5 border-b border-border bg-card/40 px-2 py-1">
                      <SidebarTab
                        active={sidebarMode === "schema"}
                        onClick={() => setSidebarMode("schema")}
                      >
                        Schema
                      </SidebarTab>
                      <SidebarTab
                        active={sidebarMode === "saved"}
                        onClick={() => setSidebarMode("saved")}
                      >
                        Saved
                      </SidebarTab>
                    </div>
                    <div className="flex-1 overflow-hidden">
                      {sidebarMode === "schema" ? (
                        selected ? (
                          <SchemaExplorer connectionId={selected} />
                        ) : (
                          <div className="flex h-full items-center justify-center px-3 text-center text-xs text-muted-foreground">
                            Connect to a database to browse its schema.
                          </div>
                        )
                      ) : (
                        <SavedQueriesPanel connectionId={selected} />
                      )}
                    </div>
                  </div>
                </Panel>
              </PanelGroup>
            </Panel>
            <PanelResizeHandle className="w-1 bg-border hover:bg-primary/30" />
            <Panel defaultSize={80}>
              <TabbedArea connectionId={selected} />
            </Panel>
          </PanelGroup>
        </div>
        <StatusBar />
      </div>
    </TooltipProvider>
  );
}

function SidebarTab({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      className={cn(
        "rounded-sm px-2 py-0.5 text-[11px] uppercase tracking-wider transition-colors",
        active
          ? "bg-accent text-foreground"
          : "text-muted-foreground hover:bg-accent/40 hover:text-foreground",
      )}
    >
      {children}
    </button>
  );
}
