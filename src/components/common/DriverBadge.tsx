/**
 * Compact tile that identifies the database driver for a connection profile
 * with its official brand logo. Reused across the file menu, the status-bar
 * connections dropdown, the connection manager, and the schema explorer.
 *
 * Logos are bundled locally under `public/image/db/` (simple-icons, brand
 * colours baked in) — no CDN at runtime. The brand marks keep their colours,
 * but the tile they sit on is theme-aware: a plain light tile in light themes
 * and a softened (not pure-white) tile in dark themes, so the darker marks
 * (e.g. SQLite's navy) stay legible without a glaring white square clashing
 * with the dark chrome. The `.dark` class is toggled by `applyTheme`, so the
 * `dark:` variants below track the active theme's mode.
 */

import { cn } from "@/lib/utils";
import type { Driver } from "@/types";

const DRIVER_LOGO: Record<Driver, { src: string; label: string }> = {
  postgres: { src: "/image/db/postgresql.svg", label: "PostgreSQL" },
  mysql: { src: "/image/db/mysql.svg", label: "MySQL" },
  sqlite: { src: "/image/db/sqlite.svg", label: "SQLite" },
  mongodb: { src: "/image/db/mongodb.svg", label: "MongoDB" },
};

/** Official display label for a driver (mirrors the logo map). */
export function driverLabel(driver: Driver): string {
  return DRIVER_LOGO[driver].label;
}

/** `sm` (default) matches every existing row/menu call site; `lg` is for the
 *  larger card-style surfaces (e.g. `WorkspacePicker`) where a 4px tile would
 *  look undersized. The mark is an SVG, so the bigger tile stays crisp. */
const DRIVER_BADGE_SIZE = {
  sm: { tile: "h-4 w-4 rounded-[3px]", img: "h-3 w-3" },
  lg: { tile: "h-8 w-8 rounded-md", img: "h-5 w-5" },
} as const;

export function DriverBadge({
  driver,
  size = "sm",
}: {
  driver: Driver;
  size?: keyof typeof DRIVER_BADGE_SIZE;
}) {
  const { src, label } = DRIVER_LOGO[driver];
  const { tile, img } = DRIVER_BADGE_SIZE[size];
  return (
    <span
      title={label}
      className={cn(
        "inline-flex shrink-0 items-center justify-center bg-white ring-1 ring-border dark:bg-zinc-200/90 dark:ring-white/10",
        tile,
      )}
    >
      <img src={src} alt={label} className={img} draggable={false} />
    </span>
  );
}
