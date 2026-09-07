/**
 * The six notification corners, as six miniature windows.
 *
 * A grid rather than a `<Select>` because the choice is spatial: "bottom
 * right" in a dropdown asks the user to picture it, while a rectangle with a
 * bar in the corner just shows it.
 *
 * It is its own component because there are two stacks to place — the cards
 * and the one-line pills — and the second one arrived as a copy of the first.
 * Two copies of a picker is also two more native `title=` attributes and two
 * more hand-rolled buttons against the adoption budgets in
 * `ui/uiAdoption.test.ts`.
 */

import { useTranslation } from "react-i18next";
import {
  NOTIFICATION_POSITIONS,
  POSITION_LABEL_KEYS,
} from "@/lib/notificationPosition";
import { cn } from "@/lib/utils";
import type { NotificationPosition } from "@/types";

/** Where the bar sits inside a tile, mirroring the real placement. */
const TILE_BAR: Record<NotificationPosition, string> = {
  "top-left": "top-1.5 left-1.5",
  "top-center": "top-1.5 left-1/2 -translate-x-1/2",
  "top-right": "top-1.5 right-1.5",
  "bottom-left": "bottom-1.5 left-1.5",
  "bottom-center": "bottom-1.5 left-1/2 -translate-x-1/2",
  "bottom-right": "bottom-1.5 right-1.5",
};

interface Props {
  value: NotificationPosition;
  onChange: (position: NotificationPosition) => void;
  /** Round the bar into a pill, for the stack that renders one. */
  shape?: "card" | "pill";
}

export function NotificationPositionPicker({
  value,
  onChange,
  shape = "card",
}: Props) {
  const { t } = useTranslation();

  return (
    <div className="grid grid-cols-3 gap-1.5">
      {NOTIFICATION_POSITIONS.map((pos) => {
        const active = value === pos;
        return (
          <button
            key={pos}
            type="button"
            aria-pressed={active}
            title={t(
              `settings.notifications.position.${POSITION_LABEL_KEYS[pos]}`,
            )}
            onClick={() => onChange(pos)}
            className={cn(
              "relative h-[42px] w-[62px] rounded-md border bg-background transition-colors",
              active
                ? "border-brand ring-1 ring-brand/35"
                : "border-border hover:border-muted-foreground/40",
            )}
          >
            <span
              className={cn(
                "absolute h-1.5 transition-colors",
                shape === "pill" ? "w-3.5 rounded-full" : "w-5 rounded-sm",
                TILE_BAR[pos],
                active ? "bg-brand" : "bg-muted-foreground/40",
              )}
            />
          </button>
        );
      })}
    </div>
  );
}
