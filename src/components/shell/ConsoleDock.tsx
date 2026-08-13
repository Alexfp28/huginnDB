/**
 * Bottom console dock — replaces the old "console" outer-dockview panel.
 * Owns its own header (title + collapse button) and a persisted height;
 * `StatusBar`'s `ConsoleToggle` is the other way to reopen it once
 * collapsed (see gotcha-style note in that file).
 */

import { useState } from "react";
import { ChevronDown } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Console } from "@/components/query/Console";
import { SimpleTooltip } from "@/components/ui/tooltip";
import { useSessionPanelLayout } from "@/stores/session/panelLayout";
import { Sash } from "@/components/shell/Sash";
import { CollapsiblePanel } from "@/components/shell/CollapsiblePanel";
import { cn } from "@/lib/utils";

export function ConsoleDock() {
  const { t } = useTranslation();
  const open = useSessionPanelLayout((s) => s.consoleOpen);
  const height = useSessionPanelLayout((s) => s.consoleHeight);
  const toggleConsole = useSessionPanelLayout((s) => s.toggleConsole);
  const setConsoleHeight = useSessionPanelLayout((s) => s.setConsoleHeight);
  const [dragging, setDragging] = useState(false);

  return (
    <>
      {open && (
        <Sash
          orientation="horizontal"
          onResize={(delta) => setConsoleHeight(height - delta)}
          onDraggingChange={setDragging}
        />
      )}
      <CollapsiblePanel open={open} size={height} axis="height" dragging={dragging}>
        <div
          className={cn(
            "flex h-full flex-col overflow-hidden rounded-[var(--radius)] border border-border bg-background",
            "shadow-[0_1px_2px_hsl(var(--foreground)/0.04),0_6px_20px_hsl(var(--foreground)/0.05)]",
          )}
        >
          <div className="flex h-8 shrink-0 items-center justify-between border-b border-border px-2.5">
            <span className="text-[10.5px] font-semibold uppercase tracking-wider text-muted-foreground">
              {t("panels.console")}
            </span>
            <SimpleTooltip label={t("shell.console.collapse")} side="top">
              <button
                type="button"
                onClick={toggleConsole}
                className="flex h-5 w-5 items-center justify-center rounded text-muted-foreground hover:bg-foreground/[0.08] hover:text-foreground"
              >
                <ChevronDown className="h-3.5 w-3.5" />
              </button>
            </SimpleTooltip>
          </div>
          <div className="min-h-0 flex-1 overflow-hidden">
            <Console />
          </div>
        </div>
      </CollapsiblePanel>
    </>
  );
}
