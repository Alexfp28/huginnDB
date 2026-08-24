/**
 * The six notification positions, in the order the settings picker draws them
 * (two rows of three, top row first), plus their label keys.
 *
 * Shared because three places have to agree on the same list and the same
 * spelling: the picker grid in `NotificationsSection`, the command palette's
 * settings index (which shows the current value as a badge), and the
 * `NotificationPosition` union in `types.ts` that both are typed against.
 * Sonner's own `Position` accepts these exact strings, which is why the
 * preference stores them verbatim rather than mapping at the boundary.
 */

import type { NotificationPosition } from "@/types";

export const NOTIFICATION_POSITIONS: readonly NotificationPosition[] = [
  "top-left",
  "top-center",
  "top-right",
  "bottom-left",
  "bottom-center",
  "bottom-right",
] as const;

/** `settings.notifications.position.<key>` for each position. */
export const POSITION_LABEL_KEYS: Record<NotificationPosition, string> = {
  "top-left": "topLeft",
  "top-center": "topCenter",
  "top-right": "topRight",
  "bottom-left": "bottomLeft",
  "bottom-center": "bottomCenter",
  "bottom-right": "bottomRight",
};
