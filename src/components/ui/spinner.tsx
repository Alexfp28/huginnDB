import { Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * The in-flight spinner, for the cases `Button`'s and `IconButton`'s own
 * `loading` prop doesn't cover — a panel waiting on its first fetch, a row
 * mid-reconnect, a tab header.
 *
 * Exists mostly so `animate-spin` can be held at zero outside this directory:
 * it appeared in 39 places across 25 files at three different sizes for what
 * was visually the same thing.
 *
 * `aria-hidden` by default. A spinner beside text that already says "Loading…"
 * is decoration; pass `label` only when it is the *only* thing announcing that
 * something is happening.
 */
const SIZE = {
  xs: "h-3 w-3",
  sm: "h-3.5 w-3.5",
  md: "h-4 w-4",
  lg: "h-5 w-5",
} as const;

export function Spinner({
  size = "sm",
  label,
  className,
}: {
  size?: keyof typeof SIZE;
  /** Announced to screen readers; omit when nearby text already says it. */
  label?: string;
  /** Colour only — the size comes from `size`. */
  className?: string;
}) {
  return (
    <Loader2
      className={cn("animate-spin", SIZE[size], className)}
      role={label ? "status" : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
    />
  );
}
