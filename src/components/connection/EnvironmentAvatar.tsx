/**
 * Teams-style environment avatar: initials over the environment's accent
 * colour (or a neutral fallback when none is set), as a rounded square
 * (not a circle — the user asked for the squarer, app-icon-like shape).
 * See `environmentInitials` in `stores/session/environments.ts` for the
 * initials algorithm.
 *
 * `env.icon` is deliberately NOT read here. It used to hold a lucide icon
 * key (`EnvironmentSwitcher.ENV_ICONS`); the field is kept, just unread, as
 * where a future custom image will live — no data migration was needed to
 * drop the icon picker, since existing values simply stop being consulted.
 * When image upload lands, this component gains an `env.icon`-backed `<img>`
 * branch that takes priority over the initials, and every call site here
 * stays unchanged.
 */

import { environmentInitials } from "@/stores/session/environments";
import { cn } from "@/lib/utils";

interface EnvironmentAvatarProps {
  name: string;
  color: string | null;
  size?: number;
  className?: string;
}

export function EnvironmentAvatar({
  name,
  color,
  size = 36,
  className,
}: EnvironmentAvatarProps) {
  const initials = environmentInitials(name);
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
        backgroundColor: color ?? "hsl(var(--muted))",
        color: color ? pickReadableForeground(color) : "hsl(var(--muted-foreground))",
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
