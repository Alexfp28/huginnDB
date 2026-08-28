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
 *
 * The drag mechanics (pointer capture, rAF-coalesced `onResize`) live in
 * `useSashDrag` — this component is a thin view over it.
 */

import { useSashDrag } from "@/lib/shell/useSashDrag";
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
  const { onPointerDown, onPointerMove, onPointerUp } = useSashDrag({
    orientation,
    onResize,
    onDraggingChange,
  });

  return (
    <div
      role="separator"
      aria-orientation={orientation}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      className={cn(
        "group shrink-0 select-none",
        orientation === "vertical"
          ? "w-1.5 cursor-col-resize"
          : "h-1.5 cursor-row-resize",
        className,
      )}
    >
      {/* Rounded ends and the brand accent on hover/drag: a separator the user
          can grab is an affordance, and the brand language wants those blue and
          soft-cornered rather than a square grey bar. */}
      <div
        className={cn(
          "h-full w-full rounded-full bg-transparent transition-colors duration-150 group-hover:bg-brand/40 group-active:bg-brand/60",
        )}
      />
    </div>
  );
}
