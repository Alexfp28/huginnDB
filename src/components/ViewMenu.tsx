/**
 * Top-bar "View" dropdown — toggles UI display preferences (schema
 * metric) and exposes panel-level actions (show/hide each dockview
 * panel, float the active panel). New display preferences should land
 * here so persistence stays centralised in `useViewPrefs`; panel-level
 * actions stay derived from the dockview API.
 */

import { useEffect, useState } from "react";
import { ChevronDown, Eye } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuCheckboxItem,
  DropdownMenuItem,
  DropdownMenuSeparator,
} from "@/components/ui/dropdown";
import {
  useViewPrefs,
  type SchemaTableMetric,
} from "@/stores/viewPrefs";
import {
  PANELS,
  type PanelId,
  floatActivePanel,
  isPanelOpen,
  onDockviewApiReady,
  togglePanel,
} from "@/lib/dockview";

const METRIC_OPTIONS: { value: SchemaTableMetric; label: string }[] = [
  { value: "none", label: "Hide table metric" },
  { value: "row-count", label: "Show row count" },
  { value: "size", label: "Show table size" },
];

export function ViewMenu() {
  const metric = useViewPrefs((s) => s.schemaTableMetric);
  const setMetric = useViewPrefs((s) => s.setSchemaTableMetric);
  const [, setTick] = useState(0);

  // Bump local state on every dockview layout change so the panel
  // checkboxes reflect the current state even when the user closes a
  // panel via the tab's X button. `onDockviewApiReady` handles the
  // case where the menu mounts before App.tsx registers the API.
  useEffect(() => {
    let layoutSub: { dispose: () => void } | null = null;
    const unsubReady = onDockviewApiReady((api) => {
      layoutSub = api.onDidLayoutChange(() => setTick((n) => n + 1));
    });
    return () => {
      unsubReady();
      layoutSub?.dispose();
    };
  }, []);

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          className="h-7 gap-1.5 px-2 text-xs"
        >
          <Eye className="h-3.5 w-3.5" />
          View
          <ChevronDown className="h-3 w-3 opacity-60" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-60">
        <div className="px-2 py-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
          Panels
        </div>
        {PANELS.map((p) => (
          <DropdownMenuCheckboxItem
            key={p.id}
            checked={isPanelOpen(p.id as PanelId)}
            onSelect={(e) => {
              e.preventDefault();
              togglePanel(p.id as PanelId);
            }}
          >
            {p.title}
          </DropdownMenuCheckboxItem>
        ))}
        <DropdownMenuItem
          onSelect={(e) => {
            e.preventDefault();
            floatActivePanel();
          }}
        >
          Float active panel
        </DropdownMenuItem>

        <DropdownMenuSeparator />

        <div className="px-2 py-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
          Schema tree
        </div>
        {METRIC_OPTIONS.map((opt) => (
          <DropdownMenuCheckboxItem
            key={opt.value}
            checked={metric === opt.value}
            onSelect={(e) => {
              e.preventDefault();
              setMetric(opt.value);
            }}
          >
            {opt.label}
          </DropdownMenuCheckboxItem>
        ))}

        <DropdownMenuSeparator />
        <div className="px-2 py-1 text-[10px] leading-snug text-muted-foreground/70">
          Drag panel tabs to rearrange. Drop outside the dock area to
          float a panel. Counts and sizes are engine estimates.
        </div>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
