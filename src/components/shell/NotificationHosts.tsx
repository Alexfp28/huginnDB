/**
 * Every notification surface a window needs, in one element.
 *
 * The three window roots (`App`, `DetachedTabWindow`, `PulseWindow`) used to
 * carry an identical copy of the `<Toaster>` invocation plus its overflow
 * badge, with the edge offset written out a fourth time inside the badge
 * itself. That is four places to keep in sync for one decision, and it is also
 * why `lib/notify.tsx`'s opening claim — "the one entry point, nothing outside
 * this module imports `sonner` any more" — had quietly stopped being true.
 * With the container owned here, it is true again.
 *
 * Transport only: every visual decision belongs to `NotificationCard`, and the
 * props below are the user's own (Settings → Notifications). `icons` and
 * `closeButton` are deliberately absent — the library draws neither for a
 * custom toast, and its stock `success` icon spends the brand blue on a
 * confirmation. `duration` is per notification (`lib/notify` scales it per
 * kind), so it is not set here either.
 */

import { Toaster } from "sonner";
import { NotificationOverflowBadge } from "@/components/shell/NotificationOverflowBadge";
import {
  NOTIFICATION_OFFSET,
  PILL_TOASTER_ID,
} from "@/lib/notificationPosition";
import {
  selectNotificationPrefs,
  usePreferences,
} from "@/stores/preferences/preferences";
import { selectActiveMode, useThemeStore } from "@/stores/preferences/theme";

export function NotificationHosts() {
  const prefs = usePreferences(selectNotificationPrefs);
  const themeMode = useThemeStore(selectActiveMode);
  const theme = themeMode === "dark" ? "dark" : "light";

  /**
   * Both anatomies pointed at the same corner is not a collision to arbitrate
   * — it is the user asking for one stack. The pill host simply is not
   * mounted, and `toasterIdFor` in `lib/notify` stops tagging pills, so they
   * fall into the card host and Sonner stacks the two heights together.
   */
  const merged = prefs.pillPosition === prefs.position;

  return (
    <>
      {/* The card host is the *default* one: no `id`, so Sonner gives it every
          toast raised without a `toasterId`. That is what makes the pill host
          opt-in and the merged case above work without a second code path. */}
      <Toaster
        position={prefs.position}
        visibleToasts={prefs.maxVisible}
        expand={prefs.expandOnHover}
        gap={10}
        offset={NOTIFICATION_OFFSET}
        theme={theme}
      />
      <NotificationOverflowBadge host="card" />

      {!merged && (
        <>
          <Toaster
            id={PILL_TOASTER_ID}
            className="notif-pill-stack"
            position={prefs.pillPosition}
            visibleToasts={prefs.maxVisible}
            expand={prefs.expandOnHover}
            // Tighter than the cards': a 32px pill with a 10px gutter reads as
            // a list of unrelated things rather than one stack.
            gap={8}
            offset={NOTIFICATION_OFFSET}
            theme={theme}
          />
          <NotificationOverflowBadge host="pill" />
        </>
      )}
    </>
  );
}
