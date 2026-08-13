/**
 * The workspace island — replaces the old "workspace" outer-dockview panel.
 * Wraps `TabbedArea` (the nested dockview of open table/query tabs, gotcha
 * #10 in CLAUDE.md — untouched, still fully self-contained and
 * `height/width: 100%`) in a card with its own border/shadow so it reads
 * as a fixed canvas rather than one interchangeable panel among five.
 *
 * The cell editor (`SideEditorPanel`) used to dock as a sibling dockview
 * group to the island's right; it now lives here as a plain flex split
 * with a hand-rolled `Sash`, so opening/closing it can never trigger
 * dockview's proportional-reflow-of-siblings behaviour (the very hack
 * `trackSchemaWidthAroundSideEditor` used to patch around).
 */

import { useState } from "react";
import { TabbedArea } from "@/components/shell/TabbedArea";
import { SideEditorPanel } from "@/components/grid/SideEditorPanel";
import { Sash } from "@/components/shell/Sash";
import { CollapsiblePanel } from "@/components/shell/CollapsiblePanel";
import { useSessionPanelLayout } from "@/stores/session/panelLayout";
import { cn } from "@/lib/utils";

interface IslandShellProps {
  connectionId: string | null;
}

export function IslandShell({ connectionId }: IslandShellProps) {
  const sideEditorOpen = useSessionPanelLayout((s) => s.sideEditorOpen);
  const sideEditorWidth = useSessionPanelLayout((s) => s.sideEditorWidth);
  const setSideEditorWidth = useSessionPanelLayout((s) => s.setSideEditorWidth);
  const [dragging, setDragging] = useState(false);

  return (
    <div
      className={cn(
        "flex min-h-0 min-w-0 flex-1 overflow-hidden rounded-[var(--radius)] border border-border bg-background",
        "shadow-[0_1px_2px_hsl(var(--foreground)/0.04),0_6px_20px_hsl(var(--foreground)/0.05)]",
      )}
    >
      <div className="min-w-0 flex-1">
        <TabbedArea connectionId={connectionId} />
      </div>
      {sideEditorOpen && (
        <Sash
          orientation="vertical"
          onResize={(delta) => setSideEditorWidth(sideEditorWidth - delta)}
          onDraggingChange={setDragging}
        />
      )}
      <CollapsiblePanel
        open={sideEditorOpen}
        size={sideEditorWidth}
        axis="width"
        dragging={dragging}
        className={cn(sideEditorOpen && "border-l border-border")}
      >
        <SideEditorPanel />
      </CollapsiblePanel>
    </div>
  );
}
