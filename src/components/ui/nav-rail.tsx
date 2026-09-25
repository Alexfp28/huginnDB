import * as React from "react";
import { cn } from "@/lib/utils";
import { CONTROL_FOCUS_TIGHT } from "@/components/ui/styles";

/**
 * One entry of a workbench's left rail: icon, a label and a one-line
 * description, full width, with the active entry marked by a 2px edge.
 *
 * Settings and the shared-origin editor each wrote this out by hand, and the
 * policy editor's third copy, made from `Button`, drifted: rounded corners, an
 * inset, and a hover that no longer lined up with the other two. One primitive
 * keeps the three rails the same rail.
 */
export interface NavRailItemProps
  extends Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, "children"> {
  /** A lucide glyph, or any icon component that takes a `className`. */
  icon: React.ComponentType<{ className?: string }>;
  label: React.ReactNode;
  description?: React.ReactNode;
  active?: boolean;
  /** Drawn over the icon's corner (Settings' "update available" dot). */
  badge?: React.ReactNode;
}

export const NavRailItem = React.forwardRef<HTMLButtonElement, NavRailItemProps>(
  ({ icon: Icon, label, description, active, badge, className, ...props }, ref) => (
    <button
      ref={ref}
      type="button"
      aria-current={active ? "page" : undefined}
      className={cn(
        "flex w-full items-center gap-2 border-l-2 px-3 py-2 text-left transition-colors",
        CONTROL_FOCUS_TIGHT,
        "focus-visible:ring-inset",
        active ? "border-primary bg-accent/40" : "border-transparent hover:bg-accent",
        className,
      )}
      {...props}
    >
      <span aria-hidden className="relative shrink-0">
        <Icon className="h-3.5 w-3.5 text-muted-foreground" />
        {badge}
      </span>
      <span className="flex min-w-0 flex-1 flex-col leading-tight">
        <span className="text-sm">{label}</span>
        {description && (
          <span className="text-3xs text-muted-foreground">{description}</span>
        )}
      </span>
    </button>
  ),
);
NavRailItem.displayName = "NavRailItem";
