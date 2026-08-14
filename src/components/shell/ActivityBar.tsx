/**
 * Vertical icon rail that toggles a docked side panel — the activity-bar
 * half of the outer shell redesign (see `stores/session/panelLayout.ts`).
 * One instance per side; each button is exclusive-looking but not
 * exclusive in behaviour (nothing stops both sides being open at once).
 *
 * `footer` renders a second button group pinned to the bottom (`mt-auto`)
 * — used by the left bar for Settings/Theme, which used to live in the
 * top header (see `AppShell`'s `ChromeFooter`).
 */

import type { ReactNode } from "react";
import type { LucideIcon } from "lucide-react";
import { SimpleTooltip } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

export interface ActivityBarButton {
  id: string;
  icon: LucideIcon;
  label: string;
  active: boolean;
  onClick: () => void;
}

interface ActivityBarProps {
  side: "left" | "right";
  buttons: ActivityBarButton[];
  footer?: ReactNode;
  className?: string;
}

export function ActivityBar({ side, buttons, footer, className }: ActivityBarProps) {
  return (
    <div
      className={cn(
        "flex w-11 shrink-0 flex-col items-center gap-0.5 py-2",
        side === "left" ? "border-r border-border" : "border-l border-border",
        className,
      )}
    >
      {buttons.map((btn) => (
        <SimpleTooltip key={btn.id} label={btn.label} side={side === "left" ? "right" : "left"}>
          <button
            type="button"
            onClick={btn.onClick}
            aria-pressed={btn.active}
            className={cn(
              "relative flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground transition-colors duration-150",
              "hover:bg-accent/60 hover:text-foreground",
              "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/40",
              // Selected: the icon itself goes brand blue over a quiet surface.
              // The colour is the signal, not a loud fill.
              btn.active && "bg-accent/70 text-brand",
            )}
          >
            {btn.active && (
              <span
                aria-hidden
                // The 4px active marker of the brief, flush against the rail's
                // outer edge. The button is centred in a 44px rail (6px of
                // slack per side), so a -6px offset lands the bar exactly on
                // the edge; the previous -8px pushed a 2px sliver off the rail
                // entirely, where the shell's `overflow-hidden` clipped it.
                className={cn(
                  "absolute top-1 bottom-1 w-1 rounded-full bg-brand",
                  side === "left" ? "-left-1.5" : "-right-1.5",
                )}
              />
            )}
            <btn.icon className="h-[17px] w-[17px]" />
          </button>
        </SimpleTooltip>
      ))}
      {footer && (
        <div className="mt-auto flex flex-col items-center gap-0.5">{footer}</div>
      )}
    </div>
  );
}
