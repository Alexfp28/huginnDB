/**
 * The notification history: a bell in the header toolbar and the panel behind
 * it.
 *
 * This is what makes short-lived toasts defensible. A notification that named a
 * file, an error worth copying or a count worth checking used to be gone the
 * moment it faded; here the same card, compressed to one row, stays reachable
 * for the rest of the session — and a `file` row is still a live control, so an
 * export from twenty minutes ago is one click from the file manager.
 *
 * Notes on the details:
 *
 * * Entries are grouped by day and derived with `useMemo`, never in a selector
 *   (gotcha #1) — the store hands out the raw array and nothing else.
 * * Opening the panel is what marks everything read, which is why the unread
 *   dot is on the bell and not on individual rows: the question the badge
 *   answers is "did something happen while I was looking elsewhere".
 * * The bell hides itself when the history is off (`historyLimit: 0`) or the
 *   user turned it off — the store keeps working either way, and the command
 *   palette still reaches the panel.
 * * It lives with the chrome controls (immediately left of `LayoutToggles`),
 *   not in the status bar. It is a thing you click and its unread badge has to
 *   be *noticed*; the status bar's 10px row gave it neither the hit area nor the
 *   contrast for either, which is why it moved.
 */

import { useMemo, useState } from "react";
import { Bell, Trash2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown";
import { SimpleTooltip } from "@/components/ui/tooltip";
import { NOTIFICATION_KIND_VISUALS } from "@/components/shell/NotificationCard";
import { api } from "@/lib/tauri";
import { notify } from "@/lib/notify";
import { cn } from "@/lib/utils";
import {
  selectNotificationPrefs,
  usePreferences,
} from "@/stores/preferences/preferences";
import { useNotifications } from "@/stores/notifications";
import type { NotificationEntry } from "@/stores/notifications";

/** Day buckets, newest first. */
type Bucket = "today" | "yesterday" | "earlier";

function bucketOf(at: number, startOfToday: number): Bucket {
  if (at >= startOfToday) return "today";
  if (at >= startOfToday - 86_400_000) return "yesterday";
  return "earlier";
}

export function NotificationCenter() {
  const { t } = useTranslation();
  const entries = useNotifications((s) => s.entries);
  const prefs = usePreferences(selectNotificationPrefs);
  const [open, setOpen] = useState(false);

  const unread = useMemo(() => entries.filter((e) => !e.read).length, [entries]);

  // One pass, in store order (already newest-first), so a bucket header is
  // emitted the first time its day appears.
  const sections = useMemo(() => {
    const start = new Date();
    start.setHours(0, 0, 0, 0);
    const startOfToday = start.getTime();
    const out: { bucket: Bucket; items: NotificationEntry[] }[] = [];
    for (const entry of entries) {
      const bucket = bucketOf(entry.at, startOfToday);
      const last = out[out.length - 1];
      if (last?.bucket === bucket) last.items.push(entry);
      else out.push({ bucket, items: [entry] });
    }
    return out;
  }, [entries]);

  if (!prefs.showBell || prefs.historyLimit === 0) return null;

  const onOpenChange = (next: boolean) => {
    setOpen(next);
    if (next) useNotifications.getState().markAllRead();
  };

  return (
    <DropdownMenu open={open} onOpenChange={onOpenChange}>
      <SimpleTooltip
        label={
          unread > 0
            ? t("notifications.center.unread", { count: unread })
            : t("notifications.center.open")
        }
        side="bottom"
      >
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            aria-label={t("notifications.center.open")}
            // Same on/off language as the panel toggles it sits next to
            // (`LayoutToggles`): 28px square, `rounded-md`, muted until hovered.
            // Open counts as active, so the header shows where the panel came
            // from while it is on screen.
            className={cn(
              "relative flex h-7 w-7 items-center justify-center rounded-md transition-colors",
              "hover:bg-foreground/[0.06] hover:text-foreground",
              open ? "bg-foreground/[0.08] text-foreground" : "text-muted-foreground",
            )}
          >
            <Bell className="h-4 w-4" />
            {unread > 0 && (
              // Reads against the header, not the status bar it used to sit in:
              // a 15px brand pill with an 11px numeral and a background-coloured
              // ring punching it out of the icon.
              <span className="absolute -right-1 -top-1 flex h-[15px] min-w-[15px] items-center justify-center rounded-full bg-brand px-1 font-mono text-[10px] font-bold leading-none text-brand-foreground ring-2 ring-background">
                {unread > 9 ? "9+" : unread}
              </span>
            )}
          </button>
        </DropdownMenuTrigger>
      </SimpleTooltip>

      <DropdownMenuContent side="bottom" align="end" className="w-96 p-0">
        <div className="flex items-center gap-2 border-b border-border px-3 py-2">
          <span className="text-xs font-semibold text-foreground">
            {t("notifications.center.title")}
          </span>
          {unread > 0 && (
            <span className="rounded-full bg-brand px-1.5 font-mono text-3xs font-bold text-brand-foreground">
              {unread}
            </span>
          )}
          <div className="flex-1" />
          {entries.length > 0 && (
            <button
              type="button"
              onClick={() => useNotifications.getState().clear()}
              className="inline-flex h-6 items-center gap-1.5 rounded-md px-2 text-3xs font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
            >
              <Trash2 className="h-3 w-3" />
              {t("notifications.center.clear")}
            </button>
          )}
        </div>

        {entries.length === 0 ? (
          <div className="px-3 py-6 text-center">
            <div className="text-xs text-muted-foreground">
              {t("notifications.center.empty")}
            </div>
            <div className="mt-1 text-3xs text-muted-foreground/70">
              {t("notifications.center.emptyHint")}
            </div>
          </div>
        ) : (
          <div className="max-h-80 overflow-auto">
            {sections.map((section) => (
              <div key={section.bucket}>
                <div className="bg-background/40 px-3.5 pb-1 pt-1.5 text-3xs font-semibold uppercase tracking-wider text-muted-foreground/70">
                  {t(`notifications.center.${section.bucket}`)}
                </div>
                {section.items.map((entry) => (
                  <HistoryRow key={entry.id} entry={entry} />
                ))}
              </div>
            ))}
          </div>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function HistoryRow({ entry }: { entry: NotificationEntry }) {
  const { t } = useTranslation();
  const k = NOTIFICATION_KIND_VISUALS[entry.kind];
  const clickable = Boolean(entry.file) && !entry.missing;

  const time = new Date(entry.at).toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
  });

  const onSelect = (e: Event) => {
    if (!entry.file) {
      // Nothing to act on; keep the panel open so the user can read the rest.
      e.preventDefault();
      return;
    }
    if (entry.missing) {
      e.preventDefault();
      return;
    }
    void api.revealItemInDir(entry.file.path).catch(() => {
      useNotifications.getState().markMissing(entry.id);
      notify.warning(t("notifications.fileMissing"), {
        description: entry.file?.path,
        mono: true,
      });
    });
  };

  return (
    <DropdownMenuItem
      onSelect={onSelect}
      className={cn(
        "flex items-start gap-2.5 border-b border-border/50 px-3.5 py-2.5 last:border-b-0",
        !clickable && "cursor-default",
      )}
    >
      <div
        className={cn(
          "mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-[7px]",
          k.medallion,
        )}
      >
        <k.Icon className={cn("h-3.5 w-3.5", k.icon)} />
      </div>

      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5">
          <span className="truncate text-xs font-semibold leading-4 tracking-[-0.01em] text-foreground">
            {entry.title}
          </span>
          {entry.count > 1 && (
            <span className="shrink-0 rounded-sm bg-accent px-1 font-mono text-3xs font-semibold text-foreground">
              ×{entry.count}
            </span>
          )}
        </div>
        {entry.file ? (
          <div
            className={cn(
              "mt-0.5 truncate font-mono text-3xs",
              entry.missing
                ? "text-muted-foreground line-through"
                : "text-brand underline decoration-brand/40 underline-offset-2",
            )}
          >
            {entry.file.name}
          </div>
        ) : (
          entry.description && (
            <div
              className={cn(
                "mt-0.5 line-clamp-2 text-muted-foreground",
                entry.mono ? "font-mono text-3xs" : "text-3xs",
              )}
            >
              {entry.description}
            </div>
          )
        )}
        {entry.missing && (
          <div className="mt-0.5 text-3xs text-warning">
            {t("notifications.fileMissing")}
          </div>
        )}
      </div>

      <span className="shrink-0 font-mono text-3xs text-muted-foreground/70">
        {time}
      </span>
    </DropdownMenuItem>
  );
}
