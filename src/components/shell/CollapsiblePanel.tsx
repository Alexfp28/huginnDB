/**
 * Animates a side/bottom panel between 0 and its persisted size on open/
 * close — the mockup's collapse/expand motion, lost when the outer shell
 * moved off dockview (see `stores/session/panelLayout.ts`) since the
 * panels went from "mount/unmount" to plain conditional rendering with no
 * transition.
 *
 * The transition is suspended while the adjacent `Sash` is being dragged
 * (`dragging`) — a live resize must track the pointer 1:1, never ease —
 * and re-enabled the instant the drag ends, matching the `.inner-dock`
 * convention in `index.css` (instant during interactive drag, eased only
 * on a completed toggle/drop).
 */

import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

interface CollapsiblePanelProps {
  open: boolean;
  size: number;
  axis: "width" | "height";
  dragging?: boolean;
  className?: string;
  children: ReactNode;
}

export function CollapsiblePanel({
  open,
  size,
  axis,
  dragging,
  className,
  children,
}: CollapsiblePanelProps) {
  return (
    <div
      style={{ [axis]: open ? size : 0 }}
      className={cn(
        "shrink-0 overflow-hidden",
        !dragging && "transition-[width,height] duration-200 ease-out",
        className,
      )}
    >
      {/* Fixed to the panel's own size (not 100%) on the animated axis, so
          content doesn't reflow/squeeze while the wrapper eases through 0 —
          it just slides offscreen. The cross axis fills the wrapper. */}
      <div
        style={{ [axis]: size, [axis === "width" ? "height" : "width"]: "100%" }}
      >
        {children}
      </div>
    </div>
  );
}
