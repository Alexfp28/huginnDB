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
      style={{
        [axis]: open ? size : 0,
        // Only while a drag is live — a permanent `will-change` pins a
        // compositor layer for a panel that resizes maybe once a session.
        // NOT `contain: paint` here: `AppShell`'s two-layer shadow on this
        // panel's own border box paints outside it, and `paint` containment
        // would clip that shadow.
        willChange: dragging ? axis : undefined,
      }}
      className={cn(
        "shrink-0 overflow-hidden",
        !dragging && "transition-[width,height] duration-200 ease-out",
        className,
      )}
    >
      {/* Fixed to the panel's own size (not 100%) on the animated axis, so
          content doesn't reflow/squeeze while the wrapper eases through 0 —
          it just slides offscreen. The cross axis fills the wrapper.
          `contain: layout style` is safe here specifically because the size
          is fixed (not 100%) and the parent already clips with
          `overflow-hidden`: a resize-driven reflow of this panel's own
          content can't affect anything outside this box. */}
      <div
        style={{
          [axis]: size,
          [axis === "width" ? "height" : "width"]: "100%",
          contain: "layout style",
        }}
      >
        {children}
      </div>
    </div>
  );
}
