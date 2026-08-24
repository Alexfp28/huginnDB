/**
 * Notification preferences — where they appear, how long they stay, how many at
 * once, and how much is remembered.
 *
 * Two rows are not plain controls, for reasons the plain controls couldn't
 * cover:
 *
 * * **Position** is a grid of six miniature windows rather than a `<Select>`.
 *   The choice is spatial, and "abajo a la derecha" in a dropdown asks the user
 *   to picture it; a rectangle with a bar in the corner just shows it.
 * * **Duration** pairs presets with the raw millisecond input. The presets are
 *   what anybody actually wants (and one of them is "until dismissed", which is
 *   `0` — not a number a user should have to know), while the input keeps the
 *   underlying value honest and tweakable.
 *
 * The preview fires a *real* notification through `notify`, not a drawing of
 * one: judging six seconds against four is exactly the thing a static mockup
 * cannot help with, and it also proves the position and density took effect.
 */

import { useTranslation } from "react-i18next";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  selectNotificationPrefs,
  usePreferences,
} from "@/stores/preferences/preferences";
import { notify, MAX_DURATION_MS, MIN_DURATION_MS } from "@/lib/notify";
import {
  NOTIFICATION_POSITIONS,
  POSITION_LABEL_KEYS,
} from "@/lib/notificationPosition";
import { cn } from "@/lib/utils";
import type { NotificationDensity, NotificationPosition } from "@/types";
import { PrefRow } from "./PrefRow";

/** The presets offered next to the raw input. `0` is "until dismissed". */
const DURATION_PRESETS = [4000, 6000, 10000, 0] as const;

/** Where the bar sits inside a position tile, mirroring the real placement. */
const TILE_BAR: Record<NotificationPosition, string> = {
  "top-left": "top-1.5 left-1.5",
  "top-center": "top-1.5 left-1/2 -translate-x-1/2",
  "top-right": "top-1.5 right-1.5",
  "bottom-left": "bottom-1.5 left-1.5",
  "bottom-center": "bottom-1.5 left-1/2 -translate-x-1/2",
  "bottom-right": "bottom-1.5 right-1.5",
};

export function NotificationsSection() {
  const prefs = usePreferences(selectNotificationPrefs);
  const update = usePreferences((s) => s.updateNotifications);
  const { t } = useTranslation();

  return (
    <div className="space-y-1">
      {/* Preview ------------------------------------------------------------ */}
      <div className="mb-3 flex gap-4 rounded-lg border border-border bg-background/60 p-3.5">
        <div className="relative h-[138px] w-[232px] shrink-0 overflow-hidden rounded-md border border-border bg-background">
          <div className="h-3.5 border-b border-border bg-card" />
          <div className="flex h-[108px]">
            <div className="w-10 border-r border-border bg-card" />
          </div>
          <div className="h-3 border-t border-border bg-card" />
          <div
            className={cn(
              "absolute w-32 overflow-hidden rounded-md border border-l-[3px] border-border border-l-success bg-popover shadow-elevation-3",
              // Same geometry as the real container: clear of the status bar at
              // the bottom, tight to the title bar at the top.
              prefs.position.startsWith("bottom") ? "bottom-4" : "top-5",
              prefs.position.endsWith("left") && "left-2",
              prefs.position.endsWith("right") && "right-2",
              prefs.position.endsWith("center") && "left-1/2 -translate-x-1/2",
            )}
          >
            <div className="flex items-center gap-1.5 px-1.5 py-1.5">
              <span className="h-3 w-3 shrink-0 rounded-sm bg-success/30" />
              <span className="h-1 w-16 rounded-full bg-muted-foreground/40" />
            </div>
            {prefs.density === "comfortable" && (
              <div className="px-1.5 pb-1.5">
                <span className="block h-1 w-10 rounded-full bg-muted-foreground/25" />
              </div>
            )}
            <div className="h-0.5 w-3/5 bg-success/55" />
          </div>
        </div>

        <div className="flex min-w-0 flex-1 flex-col gap-2">
          <div className="text-xs font-semibold">
            {t("settings.notifications.preview.title")}
          </div>
          <div className="text-2xs leading-4 text-muted-foreground">
            {t("settings.notifications.preview.desc")}
          </div>
          <div className="mt-0.5 flex gap-2">
            <button
              type="button"
              onClick={() =>
                notify.success(t("settings.notifications.preview.sampleTitle"), {
                  description: t("settings.notifications.preview.sampleBody"),
                  group: false,
                })
              }
              className="inline-flex h-7 items-center rounded-md bg-brand px-2.5 text-2xs font-semibold text-brand-foreground transition-colors hover:bg-brand-hover"
            >
              {t("settings.notifications.preview.test")}
            </button>
            <button
              type="button"
              onClick={() =>
                notify.error(
                  t("settings.notifications.preview.sampleErrorTitle"),
                  {
                    description: t(
                      "settings.notifications.preview.sampleErrorBody",
                    ),
                    group: false,
                  },
                )
              }
              className="inline-flex h-7 items-center rounded-md border border-border px-2.5 text-2xs font-medium text-foreground transition-colors hover:bg-accent"
            >
              {t("settings.notifications.preview.testError")}
            </button>
          </div>
        </div>
      </div>

      {/* Position ----------------------------------------------------------- */}
      <PrefRow
        label={t("settings.notifications.position.label")}
        description={t("settings.notifications.position.desc")}
        prefId="notifications.position"
      >
        <div className="grid grid-cols-3 gap-1.5">
          {NOTIFICATION_POSITIONS.map((pos) => {
            const active = prefs.position === pos;
            return (
              <button
                key={pos}
                type="button"
                aria-pressed={active}
                title={t(
                  `settings.notifications.position.${POSITION_LABEL_KEYS[pos]}`,
                )}
                onClick={() => update({ position: pos })}
                className={cn(
                  "relative h-[42px] w-[62px] rounded-md border bg-background transition-colors",
                  active
                    ? "border-brand ring-1 ring-brand/35"
                    : "border-border hover:border-muted-foreground/40",
                )}
              >
                <span
                  className={cn(
                    "absolute h-1.5 w-5 rounded-full transition-colors",
                    TILE_BAR[pos],
                    active ? "bg-brand" : "bg-muted-foreground/40",
                  )}
                />
              </button>
            );
          })}
        </div>
      </PrefRow>

      {/* Duration ----------------------------------------------------------- */}
      <PrefRow
        label={t("settings.notifications.duration.label")}
        description={t("settings.notifications.duration.desc")}
        prefId="notifications.durationMs"
        htmlFor="prefs-notifications-duration"
      >
        <div className="flex items-center gap-2">
          <div className="flex gap-0.5 rounded-lg border border-border bg-background p-0.5">
            {DURATION_PRESETS.map((ms) => (
              <button
                key={ms}
                type="button"
                onClick={() => update({ durationMs: ms })}
                className={cn(
                  "inline-flex h-[26px] items-center rounded-md px-2.5 font-mono text-2xs transition-colors",
                  prefs.durationMs === ms
                    ? "bg-brand font-semibold text-brand-foreground"
                    : "text-muted-foreground hover:bg-accent hover:text-foreground",
                )}
              >
                {ms === 0 ? "∞" : `${ms / 1000} s`}
              </button>
            ))}
          </div>
          <Input
            id="prefs-notifications-duration"
            type="number"
            min={0}
            max={MAX_DURATION_MS}
            step={500}
            value={prefs.durationMs}
            onChange={(e) => {
              const n = Number.parseInt(e.target.value, 10);
              if (!Number.isFinite(n) || n < 0) return;
              // `0` is meaningful (until dismissed) and bypasses the floor;
              // anything else is clamped so a stray keystroke can't produce a
              // notification that is gone before it is painted.
              update({
                durationMs: n === 0 ? 0 : Math.min(Math.max(n, MIN_DURATION_MS), MAX_DURATION_MS),
              });
            }}
            className="h-8 w-20 text-right font-mono text-xs"
          />
          <span className="text-3xs text-muted-foreground">
            {t("settings.notifications.duration.unit")}
          </span>
        </div>
      </PrefRow>

      <PrefRow
        label={t("settings.notifications.errorsPersist.label")}
        description={t("settings.notifications.errorsPersist.desc")}
        prefId="notifications.errorsPersist"
        htmlFor="prefs-notifications-errors-persist"
      >
        <Switch
          id="prefs-notifications-errors-persist"
          checked={prefs.errorsPersist}
          onCheckedChange={(v) => update({ errorsPersist: v })}
        />
      </PrefRow>

      <PrefRow
        label={t("settings.notifications.maxVisible.label")}
        description={t("settings.notifications.maxVisible.desc")}
        prefId="notifications.maxVisible"
        htmlFor="prefs-notifications-max-visible"
      >
        <Input
          id="prefs-notifications-max-visible"
          type="number"
          min={1}
          max={8}
          value={prefs.maxVisible}
          onChange={(e) => {
            const n = Number.parseInt(e.target.value, 10);
            if (Number.isFinite(n) && n >= 1) {
              update({ maxVisible: Math.min(n, 8) });
            }
          }}
          className="h-8 w-20 text-right font-mono text-xs"
        />
      </PrefRow>

      <PrefRow
        label={t("settings.notifications.expandOnHover.label")}
        description={t("settings.notifications.expandOnHover.desc")}
        prefId="notifications.expandOnHover"
        htmlFor="prefs-notifications-expand"
      >
        <Switch
          id="prefs-notifications-expand"
          checked={prefs.expandOnHover}
          onCheckedChange={(v) => update({ expandOnHover: v })}
        />
      </PrefRow>

      <PrefRow
        label={t("settings.notifications.density.label")}
        description={t("settings.notifications.density.desc")}
        prefId="notifications.density"
      >
        <Select
          value={prefs.density}
          onValueChange={(v) => update({ density: v as NotificationDensity })}
        >
          <SelectTrigger className="h-8 w-36 text-xs">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="comfortable">
              {t("settings.notifications.density.comfortable")}
            </SelectItem>
            <SelectItem value="compact">
              {t("settings.notifications.density.compact")}
            </SelectItem>
          </SelectContent>
        </Select>
      </PrefRow>

      <PrefRow
        label={t("settings.notifications.historyLimit.label")}
        description={t("settings.notifications.historyLimit.desc")}
        prefId="notifications.historyLimit"
        htmlFor="prefs-notifications-history"
      >
        <Input
          id="prefs-notifications-history"
          type="number"
          min={0}
          max={500}
          value={prefs.historyLimit}
          onChange={(e) => {
            const n = Number.parseInt(e.target.value, 10);
            if (Number.isFinite(n) && n >= 0) {
              update({ historyLimit: Math.min(n, 500) });
            }
          }}
          className="h-8 w-20 text-right font-mono text-xs"
        />
      </PrefRow>

      <PrefRow
        label={t("settings.notifications.showBell.label")}
        description={t("settings.notifications.showBell.desc")}
        prefId="notifications.showBell"
        htmlFor="prefs-notifications-bell"
      >
        <Switch
          id="prefs-notifications-bell"
          checked={prefs.showBell}
          onCheckedChange={(v) => update({ showBell: v })}
        />
      </PrefRow>
    </div>
  );
}
