/**
 * The notification card — one visual language for every notification the app
 * raises, on screen and (compressed to a row) in the history panel.
 *
 * It is rendered *inside* Sonner via `toast.custom` (see `lib/notify.tsx`),
 * which is the whole point of the arrangement: Sonner keeps the parts that are
 * genuinely hard (stacking, swipe-to-dismiss, timers, the six positions,
 * focus handling) and paints nothing, because a `jsx` toast is marked
 * `data-styled="false"` and skips every rule in the library's stylesheet. What
 * used to be ~60 lines of `!important` in `index.css` fighting a hardcoded
 * white card is now this component owning the surface outright.
 *
 * Anatomy, all of it from theme tokens so a custom or warm theme recolours it
 * without touching this file:
 *
 * * a 3px semantic rail — the only carrier of the outcome, at the same weight
 *   for every kind so colour is the single variable;
 * * a 28px medallion holding the icon;
 * * title (13px/600) over an optional body line (11px, muted, monospaced for
 *   driver errors and identifiers);
 * * for a `file` notification, the file name as a real control and the
 *   directory beneath it;
 * * at most one brand-coloured action, the rest ghost;
 * * a 2px hairline draining left-to-right for the remaining lifetime, paused
 *   while the pointer is anywhere in the stack (see `index.css`).
 */

import { useState } from "react";
import {
  CheckCircle2,
  Copy,
  FileDown,
  FolderOpen,
  Info,
  Loader2,
  TriangleAlert,
  X,
  XCircle,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import { api } from "@/lib/tauri";
import { copyToClipboard } from "@/lib/grid/clipboard";
import { dirName } from "@/lib/filePath";
import { cn } from "@/lib/utils";
import type { NotificationFile, NotificationKind } from "@/stores/notifications";
import type { NotificationDensity } from "@/types";

/** A button on the card. At most one should be `primary`. */
export interface NotificationAction {
  label: string;
  onClick: () => void;
  variant?: "primary" | "ghost";
  /** Dismiss the card once `onClick` has run. Default `true`. */
  dismiss?: boolean;
}

/** The one kind the history/preferences layer never sees — a live card only. */
export type CardKind = NotificationKind | "progress";

interface Props {
  kind: CardKind;
  title: string;
  description?: string;
  /** Render the description monospaced — errors, identifiers, raw values. */
  mono?: boolean;
  /** Occurrences folded into this card; anything above 1 shows a counter. */
  count?: number;
  file?: NotificationFile;
  actions?: NotificationAction[];
  /** Lifetime in ms, for the drain hairline. Omit for a persistent card. */
  durationMs?: number;
  /** `kind: "progress"` only — done/total for the determinate fill. Omit for
   *  the indeterminate spinner (no bar, just the spinning medallion icon). */
  progress?: { done: number; total: number };
  density: NotificationDensity;
  onDismiss: () => void;
  /** The reveal failed: the file is no longer where it was written. */
  onFileMissing?: () => void;
}

/**
 * Rail, medallion, icon tint and drain colour per kind.
 *
 * Exported because the history panel renders the same kinds one row tall and
 * has to reach for the same icon and the same tint — a second map there is how
 * a `warning` ends up amber on screen and grey in the panel.
 */
export const NOTIFICATION_KIND_VISUALS: Record<
  CardKind,
  {
    rail: string;
    medallion: string;
    icon: string;
    drain: string;
    Icon: typeof CheckCircle2;
  }
> = {
  success: {
    rail: "bg-success",
    medallion: "bg-success/15",
    icon: "text-success",
    drain: "bg-success/55",
    Icon: CheckCircle2,
  },
  error: {
    rail: "bg-destructive",
    medallion: "bg-destructive/15",
    icon: "text-destructive",
    drain: "bg-destructive/55",
    Icon: XCircle,
  },
  warning: {
    rail: "bg-warning",
    medallion: "bg-warning/15",
    icon: "text-warning",
    drain: "bg-warning/55",
    Icon: TriangleAlert,
  },
  // The one kind that spends the brand blue: `info` is the app telling the user
  // something, which is the same register as an affordance. A confirmation is
  // `success` and gets the green — that mix-up is exactly what the old toast's
  // `text-brand` check mark got wrong.
  info: {
    rail: "bg-brand",
    medallion: "bg-brand/15",
    icon: "text-brand",
    drain: "bg-brand/60",
    Icon: Info,
  },
  file: {
    rail: "bg-success",
    medallion: "bg-success/15",
    icon: "text-success",
    drain: "bg-success/55",
    Icon: FileDown,
  },
  // Never persisted — a progress card resolves into one of the kinds above
  // before it ever reaches history (see `notify.progress`).
  progress: {
    rail: "bg-brand",
    medallion: "bg-brand/15",
    icon: "text-brand",
    drain: "bg-brand/55",
    Icon: Loader2,
  },
};

export function NotificationCard({
  kind,
  title,
  description,
  mono,
  count = 1,
  file,
  actions,
  durationMs,
  progress,
  density,
  onDismiss,
  onFileMissing,
}: Props) {
  const { t } = useTranslation();
  const k = NOTIFICATION_KIND_VISUALS[kind];
  const compact = density === "compact";
  const pct =
    kind === "progress" && progress && progress.total > 0
      ? Math.min(100, Math.round((progress.done / progress.total) * 100))
      : 0;
  // Set once a reveal comes back rejected, so the name stops looking clickable
  // in the card the user is still looking at (the history row is marked through
  // `onFileMissing`).
  const [missing, setMissing] = useState(false);
  const dir = file ? dirName(file.path) : "";

  const reveal = async () => {
    if (!file || missing) return;
    try {
      await api.revealItemInDir(file.path);
    } catch {
      // The export wrote it, so a failure here means it has since been moved or
      // deleted. Saying so beats a button that silently does nothing — and the
      // path is still worth copying, so the card stays.
      setMissing(true);
      onFileMissing?.();
    }
  };

  const run = (action: NotificationAction) => {
    action.onClick();
    if (action.dismiss !== false) onDismiss();
  };

  // No `role`/`aria-live` on the card: the library's own `<ol>` is already the
  // polite live region, and a nested one double-announces.
  return (
    <div className="relative w-full overflow-hidden rounded-lg border border-border bg-popover text-popover-foreground shadow-elevation-3">
      <span aria-hidden className={cn("absolute inset-y-0 left-0 w-[3px]", k.rail)} />

      <div
        className={cn(
          "flex gap-[11px] px-[14px]",
          compact ? "py-2" : "pb-[13px] pt-3",
        )}
      >
        <div
          className={cn(
            "flex h-7 w-7 shrink-0 items-center justify-center rounded-md",
            k.medallion,
          )}
        >
          <k.Icon className={cn("h-4 w-4", k.icon, kind === "progress" && "animate-spin")} />
        </div>

        <div className="min-w-0 flex-1 pr-5">
          <div className="flex items-center gap-2">
            <span className="text-[13px] font-semibold leading-[18px] tracking-[-0.01em]">
              {title}
            </span>
            {count > 1 && (
              <span className="rounded-sm bg-accent px-1.5 font-mono text-3xs font-semibold text-foreground">
                ×{count}
              </span>
            )}
          </div>

          {description && !compact && (
            <div
              className={cn(
                "mt-0.5 text-muted-foreground",
                mono ? "font-mono text-3xs leading-[15px]" : "text-2xs leading-4",
              )}
            >
              {description}
            </div>
          )}

          {file && (
            <>
              <button
                type="button"
                onClick={() => void reveal()}
                disabled={missing}
                title={file.path}
                className={cn(
                  "mt-1 flex max-w-full items-center gap-1.5 rounded-sm font-mono text-2xs font-medium underline decoration-brand/45 underline-offset-2 transition-colors",
                  missing
                    ? "text-muted-foreground line-through decoration-muted-foreground/40"
                    : "text-brand hover:bg-accent hover:text-brand-hover hover:decoration-current focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                )}
              >
                <FolderOpen className="h-3 w-3 shrink-0" />
                <span className="truncate">{file.name}</span>
              </button>
              {dir && !compact && (
                // `rtl` keeps the *end* of the path — the folder the file is
                // actually in — visible when it has to be truncated.
                <div
                  dir="rtl"
                  className="mt-0.5 truncate text-left font-mono text-3xs text-muted-foreground/70"
                >
                  {dir}
                </div>
              )}
              {missing && (
                <div className="mt-0.5 text-3xs leading-[15px] text-warning">
                  {t("notifications.fileMissing")}
                </div>
              )}
            </>
          )}

          {kind === "progress" && progress && (
            <div className="mt-2.5 flex items-center justify-end">
              <span className="font-mono text-3xs text-muted-foreground">{pct}%</span>
            </div>
          )}

          {(actions?.length || file) && (
            <div className="mt-2.5 flex items-center gap-2">
              {file && (
                <>
                  <button
                    type="button"
                    onClick={() => void reveal()}
                    disabled={missing}
                    className="inline-flex h-[26px] items-center gap-1.5 rounded-md bg-brand px-2.5 text-2xs font-semibold text-brand-foreground transition-colors hover:bg-brand-hover disabled:pointer-events-none disabled:opacity-40"
                  >
                    <FolderOpen className="h-3 w-3" />
                    {t("notifications.openFolder")}
                  </button>
                  <button
                    type="button"
                    onClick={() => void copyToClipboard(file.path)}
                    className="inline-flex h-[26px] items-center gap-1.5 rounded-md px-2 text-2xs font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                  >
                    <Copy className="h-3 w-3" />
                    {t("notifications.copyPath")}
                  </button>
                </>
              )}
              {actions?.map((action) => (
                <button
                  key={action.label}
                  type="button"
                  onClick={() => run(action)}
                  className={cn(
                    "inline-flex h-[26px] items-center rounded-md text-2xs transition-colors",
                    action.variant === "primary"
                      ? "bg-brand px-2.5 font-semibold text-brand-foreground hover:bg-brand-hover"
                      : "px-2 font-medium text-muted-foreground hover:bg-accent hover:text-foreground",
                  )}
                >
                  {action.label}
                </button>
              ))}
              {file?.size && (
                <span className="ml-auto font-mono text-3xs text-muted-foreground/70">
                  {file.size}
                </span>
              )}
            </div>
          )}
        </div>

        {kind !== "progress" && (
          <button
            type="button"
            aria-label={t("common.close")}
            onClick={onDismiss}
            className="absolute right-2 top-2 flex h-5 w-5 items-center justify-center rounded-sm text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          >
            <X className="h-3 w-3" />
          </button>
        )}
      </div>

      {kind === "progress" ? (
        progress && (
          <>
            <span
              aria-hidden
              className="absolute bottom-0 left-[3px] right-0 h-0.5 bg-muted-foreground/15"
            />
            <span
              aria-hidden
              className="absolute bottom-0 left-[3px] h-0.5 bg-brand transition-[width] duration-200 ease-out"
              style={{ width: `${pct}%` }}
            />
          </>
        )
      ) : durationMs ? (
        <>
          <span
            aria-hidden
            className="absolute bottom-0 left-[3px] right-0 h-0.5 bg-muted-foreground/15"
          />
          <span
            aria-hidden
            className={cn("notif-drain absolute bottom-0 left-[3px] right-0 h-0.5", k.drain)}
            style={{ animationDuration: `${durationMs}ms` }}
          />
        </>
      ) : null}
    </div>
  );
}
