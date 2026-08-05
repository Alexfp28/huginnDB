/**
 * Compact tile that identifies the database driver for a connection profile
 * with its official brand logo. Reused across the file menu, the status-bar
 * connections dropdown, the connection manager, and the schema explorer.
 *
 * Logos are bundled locally under `public/image/db/` (simple-icons, brand
 * colours baked in) — no CDN at runtime, and each is a transparent SVG with
 * no baked-in backing, so the tile is free to use the theme's own surface
 * colour (`bg-muted`) instead of a hard-coded light/white tile — it now
 * blends into dark themes instead of sitting on top as a white square.
 * The one exception is `needsLightBacking`: a logo whose brand colour is too
 * dark to read against a dark theme's `--muted` (currently only SQLite's
 * navy, #003B57) still gets a fixed light backing plate so it stays legible
 * regardless of theme. The `.dark` class is toggled by `applyTheme`, so the
 * `dark:` variants below track the active theme's mode.
 */

import { cn } from "@/lib/utils";
import type { Driver } from "@/types";

const DRIVER_LOGO: Record<
  Driver,
  { src: string; label: string; needsLightBacking?: boolean }
> = {
  postgres: { src: "/image/db/postgresql.svg", label: "PostgreSQL" },
  mysql: { src: "/image/db/mysql.svg", label: "MySQL" },
  sqlite: {
    src: "/image/db/sqlite.svg",
    label: "SQLite",
    needsLightBacking: true,
  },
  mongodb: { src: "/image/db/mongodb.svg", label: "MongoDB" },
  // Not the official Microsoft mark: a neutral database glyph in SQL Server's
  // brand red, so the tile reads as "a database engine" without shipping a
  // trademarked logo. Swap in the simple-icons `microsoftsqlserver` file if
  // brand parity with the other four is wanted.
  sqlserver: { src: "/image/db/sqlserver.svg", label: "SQL Server" },
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
  const { src, label, needsLightBacking } = DRIVER_LOGO[driver];
  const { tile, img } = DRIVER_BADGE_SIZE[size];
  return (
    <span
      title={label}
      className={cn(
        "inline-flex shrink-0 items-center justify-center ring-1 ring-border",
        needsLightBacking
          ? "bg-white dark:bg-zinc-200/90 dark:ring-white/10"
          : "bg-muted",
        tile,
      )}
    >
      <img src={src} alt={label} className={img} draggable={false} />
    </span>
  );
}
