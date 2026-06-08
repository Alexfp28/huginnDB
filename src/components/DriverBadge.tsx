/**
 * Compact tile that identifies the database driver for a connection profile
 * with its official brand logo. Reused across the file menu, the status-bar
 * connections dropdown, the connection manager, and the schema explorer.
 *
 * Logos are bundled locally under `public/image/db/` (simple-icons, brand
 * colours baked in) — no CDN at runtime. They sit on a light tile with a
 * faint ring so the darker marks (e.g. SQLite's navy) stay legible on both
 * the light and dark themes.
 */

import type { Driver } from "@/types";

const DRIVER_LOGO: Record<Driver, { src: string; label: string }> = {
  postgres: { src: "/image/db/postgresql.svg", label: "PostgreSQL" },
  mysql: { src: "/image/db/mysql.svg", label: "MySQL" },
  sqlite: { src: "/image/db/sqlite.svg", label: "SQLite" },
};

export function DriverBadge({ driver }: { driver: Driver }) {
  const { src, label } = DRIVER_LOGO[driver];
  return (
    <span
      title={label}
      className="inline-flex h-4 w-4 shrink-0 items-center justify-center rounded-[3px] bg-white ring-1 ring-black/10"
    >
      <img src={src} alt={label} className="h-3 w-3" draggable={false} />
    </span>
  );
}
