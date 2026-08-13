/**
 * Hand-rolled resize handle for the outer shell (activity-bar side panels,
 * console dock, cell-editor split) — the panels that used to be dockview
 * groups and got sash-resize for free. See `stores/session/panelLayout.ts`
 * for why dockview was dropped for these.
 *
 * Pointer-capture drag, clamped by the caller (`onResize` receives the raw
 * delta; clamping to a panel's min/max lives in the store, same as
 * dockview's own constraints used to). No transition while dragging —
 * matches the existing `.inner-dock` convention in `index.css` where a
 * manual drag stays instant and only a completed drop/programmatic toggle
 * eases into place.
 */

import { useCallback, useRef } from "react";
import { cn } from "@/lib/utils";

interface SashProps {
  orientation: "vertical" | "horizontal";
  onResize: (delta: number) => void;
  /** Fired on drag start/end so a wrapping panel can suspend its own
   *  open/close width transition for the duration — a live drag must stay
   *  1:1 with the pointer, never eased. */
  onDraggingChange?: (dragging: boolean) => void;
  className?: string;
}

export function Sash({ orientation, onResize, onDraggingChange, className }: SashProps) {
  const lastPos = useRef(0);

  const handlePointerDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      e.preventDefault();
      const el = e.currentTarget;
      el.setPointerCapture(e.pointerId);
      lastPos.current = orientation === "vertical" ? e.clientX : e.clientY;
      document.body.style.userSelect = "none";
      document.body.style.cursor =
        orientation === "vertical" ? "col-resize" : "row-resize";
      onDraggingChange?.(true);
    },
    [orientation, onDraggingChange],
  );

  const handlePointerMove = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (e.buttons === 0) return;
      const pos = orientation === "vertical" ? e.clientX : e.clientY;
      const delta = pos - lastPos.current;
      lastPos.current = pos;
      if (delta !== 0) onResize(delta);
    },
    [orientation, onResize],
  );

  const handlePointerUp = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      e.currentTarget.releasePointerCapture(e.pointerId);
      document.body.style.userSelect = "";
      document.body.style.cursor = "";
      onDraggingChange?.(false);
    },
    [onDraggingChange],
  );

  return (
    <div
      role="separator"
      aria-orientation={orientation}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      className={cn(
        "group shrink-0 select-none",
        orientation === "vertical"
          ? "w-1.5 cursor-col-resize"
          : "h-1.5 cursor-row-resize",
        className,
      )}
    >
      <div
        className={cn(
          "h-full w-full bg-transparent transition-colors group-hover:bg-primary/30 group-active:bg-primary/50",
        )}
      />
    </div>
  );
}
