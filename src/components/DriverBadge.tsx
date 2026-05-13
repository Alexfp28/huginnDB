/**
 * Compact pill that identifies the database driver for a connection profile.
 * Reused across the file menu, the manage-connections dialog, and the
 * connection list inside the schema explorer.
 */

import { cn } from "@/lib/utils";
import type { Driver } from "@/types";

/** Visual metadata for each supported database driver. */
const DRIVER_BADGE: Record<Driver, { label: string; className: string }> = {
  postgres: {
    label: "PG",
    className: "bg-blue-600/80 text-white",
  },
  mysql: {
    label: "MY",
    className: "bg-orange-500/80 text-white",
  },
  sqlite: {
    label: "SQL",
    className: "bg-amber-500/80 text-black",
  },
};

export function DriverBadge({ driver }: { driver: Driver }) {
  const { label, className } = DRIVER_BADGE[driver];
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center rounded px-1.5 py-0.5 font-mono text-[10px] font-bold tracking-wide",
        className,
      )}
    >
      {label}
    </span>
  );
}
