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
 *
 * Children stay mounted while collapsed by default — a leftover from the
 * dockview days, where every panel was always "open" as far as React knew.
 * A closed schema tree or console still pays for whatever its subtree does
 * on every unrelated re-render. This now unmounts children once the CLOSING
 * transition finishes (not the instant `open` flips, or the content would
 * pop out from under the still-animating wrapper) and remounts them
 * immediately on reopen. A panel whose content owns local state that a
 * remount would lose — an in-progress edit, an unsaved filter — should pass
 * `keepMounted` instead of losing that state; see call sites for which ones
 * need it.
 */

import { useEffect, useState, type ReactNode } from "react";
import { cn } from "@/lib/utils";

interface CollapsiblePanelProps {
  open: boolean;
  size: number;
  axis: "width" | "height";
  dragging?: boolean;
  className?: string;
  /**
   * Skip the unmount-while-collapsed behavior — children stay mounted (and
   * merely visually hidden via `content-visibility`) the whole time. Use
   * this when the panel's content holds local state that must survive a
   * collapse/expand cycle.
   */
  keepMounted?: boolean;
  children: ReactNode;
}

export function CollapsiblePanel({
  open,
  size,
  axis,
  dragging,
  className,
  keepMounted,
  children,
}: CollapsiblePanelProps) {
  const [mounted, setMounted] = useState(open || !!keepMounted);

  useEffect(() => {
    if (open) setMounted(true);
  }, [open]);

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
      onTransitionEnd={(e) => {
        // Only this wrapper's own width/height easing — ignore anything
        // bubbling up from inside `children` (a Monaco editor, a dialog
        // fade, ...). That's also why unmounting waits for the transition
        // rather than a fixed timeout: dragging suspends it (no
        // `transition-` class, gotcha above), and a timeout would either
        // race a slow paint or outlive a duration someone tunes later.
        if (e.target !== e.currentTarget) return;
        if (!open) setMounted(false);
      }}
    >
      {/* Fixed to the panel's own size (not 100%) on the animated axis, so
          content doesn't reflow/squeeze while the wrapper eases through 0 —
          it just slides offscreen. The cross axis fills the wrapper.
          `contain: layout style` is safe here specifically because the size
          is fixed (not 100%) and the parent already clips with
          `overflow-hidden`: a resize-driven reflow of this panel's own
          content can't affect anything outside this box. `contentVisibility`
          skips style/layout/paint for whatever's kept mounted (via
          `keepMounted`) while collapsed — sizing is unaffected since the
          box above already fixes this div's own dimensions. */}
      <div
        style={{
          [axis]: size,
          [axis === "width" ? "height" : "width"]: "100%",
          contain: "layout style",
          contentVisibility: open ? undefined : "hidden",
        }}
      >
        {(mounted || keepMounted) && children}
      </div>
    </div>
  );
}
