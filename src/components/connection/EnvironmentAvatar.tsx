/**
 * Teams-style environment avatar: a custom image if the environment has one,
 * otherwise initials over its accent colour (or a neutral fallback when no
 * colour is set), as a rounded-sm square (not a circle — the user asked for the
 * squarer, app-icon-like shape). See `environmentInitials` in
 * `stores/session/environments.ts` for the initials algorithm.
 *
 * `icon` is the image slot. It holds a `data:` URL, already cropped square and
 * downscaled by `lib/environmentAvatar.ts` — this component never resizes
 * anything, it just fills the tile. The field used to hold a lucide icon key
 * (`EnvironmentSwitcher.ENV_ICONS`) and old profiles may still carry one, so
 * the `<img>` branch is gated on `isAvatarImage` rather than on the field being
 * non-empty: a legacy `"database"` value falls through to the initials exactly
 * as it did while the field went unread, and no migration was ever needed.
 */

import { isAvatarImage } from "@/lib/environmentAvatar";
import { environmentInitials } from "@/stores/session/environments";
import { cn } from "@/lib/utils";

interface EnvironmentAvatarProps {
  name: string;
  color: string | null;
  /** Custom avatar image as a `data:` URL, or `null`/a legacy icon key to fall
   *  back to the initials tile. */
  icon?: string | null;
  size?: number;
  className?: string;
}

export function EnvironmentAvatar({
  name,
  color,
  icon,
  size = 36,
  className,
}: EnvironmentAvatarProps) {
  const initials = environmentInitials(name);

  if (isAvatarImage(icon)) {
    return (
      <img
        src={icon}
        alt=""
        aria-hidden
        draggable={false}
        width={size}
        height={size}
        style={{
          width: size,
          height: size,
          // Same radius curve as the initials tile below, so swapping one for
          // the other never changes the silhouette.
          borderRadius: size * 0.28,
        }}
        // `object-cover` is belt-and-braces: the stored pixels are already a
        // square, but a hand-edited `tab_state.json` shouldn't be able to
        // stretch the rail's geometry.
        className={cn("shrink-0 object-cover", className)}
      />
    );
  }

  return (
    <div
      aria-hidden
      style={{
        width: size,
        height: size,
        // Rounded square, not a circle — scales with size instead of a
        // fixed px radius so it reads consistently across call sites (36px
        // in the rail, 48px in the editor preview, 32px in the workspace
        // picker). `EnvironmentSwitcher` uses a plain colour dot instead of
        // this component — too small at status-bar scale for initials to
        // read cleanly.
        borderRadius: size * 0.28,
        backgroundColor: color ?? "var(--muted)",
        color: color ? pickReadableForeground(color) : "var(--muted-foreground)",
      }}
      className={cn("flex shrink-0 items-center justify-center font-semibold", className)}
    >
      {/* A separate leaf span, not text directly on the flex container:
          `line-height: 1` here (rather than relying on the parent's
          flex centering alone) keeps the glyph's own ascent/descent from
          nudging it off-centre — font metrics vary enough between
          platforms' default sans-serif that `items-center` alone left it
          visibly low in some of them. */}
      <span style={{ fontSize: size * 0.42, lineHeight: 1 }}>{initials}</span>
    </div>
  );
}

/**
 * Cheap relative-luminance check so initials stay legible against any of
 * the fixed `ENV_COLORS` swatches (all mid-tone, but worth being defensive
 * if that palette ever grows lighter/darker entries). White text unless the
 * background is already light.
 */
function pickReadableForeground(hex: string): string {
  const m = /^#([0-9a-f]{6})$/i.exec(hex);
  if (!m) return "#fff";
  const n = parseInt(m[1], 16);
  const r = (n >> 16) & 255;
  const g = (n >> 8) & 255;
  const b = n & 255;
  const luminance = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  return luminance > 0.6 ? "#1a1a1a" : "#fff";
}
