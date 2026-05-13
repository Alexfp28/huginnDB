import { useEffect, useState } from "react";
import { Panel, PanelGroup, PanelResizeHandle } from "react-resizable-panels";
import { Moon, Sun } from "lucide-react";
import { useConnections } from "@/stores/connections";
import { useThemeStore } from "@/stores/theme";
import { ConnectionList } from "@/components/ConnectionList";
import { SchemaExplorer } from "@/components/SchemaExplorer";
import { TabbedArea } from "@/components/TabbedArea";
import { StatusBar } from "@/components/StatusBar";
import { Button } from "@/components/ui/button";
import { TooltipProvider } from "@/components/ui/tooltip";

export default function App() {
  const theme = useThemeStore((s) => s.theme);
  const toggleTheme = useThemeStore((s) => s.toggle);
  const active = useConnections((s) => s.active);
  const [selected, setSelected] = useState<string | null>(null);

  useEffect(() => {
    const root = document.documentElement;
    if (theme === "dark") root.classList.add("dark");
    else root.classList.remove("dark");
  }, [theme]);

  useEffect(() => {
    if (selected && !active.has(selected)) setSelected(null);
    if (!selected && active.size > 0) setSelected(Array.from(active)[0]);
  }, [active, selected]);

  return (
    <TooltipProvider>
      <div className="flex h-screen flex-col overflow-hidden bg-background text-foreground">
        <header className="flex h-9 items-center justify-between border-b border-border px-3">
          <div className="flex items-center gap-2">
            <span className="text-sm font-semibold tracking-tight">Huginn</span>
            <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] uppercase text-muted-foreground">
              alpha
            </span>
          </div>
          <Button
            size="icon"
            variant="ghost"
            onClick={toggleTheme}
            title="Toggle theme"
          >
            {theme === "dark" ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
          </Button>
        </header>
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
                  {selected ? (
                    <SchemaExplorer connectionId={selected} />
                  ) : (
                    <div className="flex h-full items-center justify-center px-3 text-center text-xs text-muted-foreground">
                      Connect to a database to browse its schema.
                    </div>
                  )}
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
