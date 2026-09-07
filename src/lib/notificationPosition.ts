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

/**
 * Distance from the window edge every notification host is inset by. Passed to
 * `<Toaster offset>` and mirrored by `NotificationOverflowBadge`, which is a
 * separately positioned fixed element rather than a child of Sonner's own DOM.
 *
 * It lives here because those two have to agree and used to be four copies of
 * the same literal.
 */
export const NOTIFICATION_OFFSET = { top: 12, bottom: 32, left: 16, right: 16 };

/**
 * Rough footprint of a collapsed (non-hovered) stack peeking out behind the
 * front notification — how far past the edge inset the "+N more" badge has to
 * sit. An approximation on purpose: Sonner keeps per-toast heights as private
 * component state, not a public API, so there is nothing exact to ask for.
 */
export const CARD_STACK_PEEK_PX = 88;

/**
 * `<Toaster id>` of the pill host, and the `toasterId` every pill toast is
 * raised with. Sonner routes by exact match (`toast.toasterId === id`), and a
 * `<Toaster>` with no `id` renders only toasts with no `toasterId` — which is
 * what lets the card host stay the default and the pill host be opt-in.
 */
export const PILL_TOASTER_ID = "huginn-pills";

/** {@link CARD_STACK_PEEK_PX} for the pill stack: 32px tall plus its gap. */
export const PILL_STACK_PEEK_PX = 44;
