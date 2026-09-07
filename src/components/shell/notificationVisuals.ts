/**
 * Rail, medallion, icon tint, drain colour and pill surface per notification
 * kind — the one place a kind is turned into colour.
 *
 * It lives in its own module rather than inside `NotificationCard` because
 * three surfaces now render the same kinds and have to agree: the card, the
 * one-line pill (`NotificationPill`) and the history row
 * (`NotificationCenter`). A second map anywhere is how a `warning` ends up
 * amber on screen and grey in the panel.
 *
 * Not in `components/ui/`: these are semantic Tailwind classes keyed by a type
 * that comes from `@/stores`, which the `ui/` dependency rule forbids.
 */

import {
  CheckCircle2,
  FileDown,
  Info,
  Loader2,
  TriangleAlert,
  XCircle,
} from "lucide-react";
import type { NotificationKind } from "@/stores/notifications";

/**
 * Every kind a live notification can render as.
 *
 * `progress` is the one that never reaches the history or the preferences
 * layer — it resolves into one of the persisted kinds before it is recorded
 * (see `notify.progress`).
 */
export type NotificationSurfaceKind = NotificationKind | "progress";

export interface NotificationKindVisual {
  /** Card only: the 3px semantic rail down the left edge. */
  rail: string;
  /** Card only: the 28px medallion behind the icon. */
  medallion: string;
  /** Shared: the icon's own tint. */
  icon: string;
  /** Card only: the draining hairline at the bottom. */
  drain: string;
  /** Pill only: border and wash of the pill surface itself. */
  pill: string;
  /** Shared. */
  Icon: typeof CheckCircle2;
}

export const NOTIFICATION_KIND_VISUALS: Record<
  NotificationSurfaceKind,
  NotificationKindVisual
> = {
  success: {
    rail: "bg-success",
    medallion: "bg-success/15",
    icon: "text-success",
    drain: "bg-success/55",
    pill: "border-success/30",
    Icon: CheckCircle2,
  },
  error: {
    rail: "bg-destructive",
    medallion: "bg-destructive/15",
    icon: "text-destructive",
    drain: "bg-destructive/55",
    pill: "border-destructive/30",
    Icon: XCircle,
  },
  warning: {
    rail: "bg-warning",
    medallion: "bg-warning/15",
    icon: "text-warning",
    drain: "bg-warning/55",
    pill: "border-warning/30",
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
    pill: "border-brand/30",
    Icon: Info,
  },
  file: {
    rail: "bg-success",
    medallion: "bg-success/15",
    icon: "text-success",
    drain: "bg-success/55",
    pill: "border-success/30",
    Icon: FileDown,
  },
  // Never persisted — a progress notification resolves into one of the kinds
  // above before it ever reaches history (see `notify.progress`).
  progress: {
    rail: "bg-brand",
    medallion: "bg-brand/15",
    icon: "text-brand",
    drain: "bg-brand/55",
    pill: "border-brand/30",
    Icon: Loader2,
  },
};
