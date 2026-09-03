/**
 * Deterministic color for a window, derived from its Tauri label.
 *
 * Not stored anywhere and not truly random: every window computes its own
 * color from `getCurrentWindow().label` on the fly, so there is nothing to
 * keep in sync across windows or across a reload. In practice this still
 * reads as "a random color per window" because the label itself is — every
 * "New window" / detached tab / Pulse window gets a fresh UUID at creation
 * (see `open_new_window` and friends in `commands/connection.rs`), so each
 * duplicate lands on its own hue. The one exception is intentional: the main
 * window's label is the fixed string `"main"`, so it always gets the same
 * color, session after session — the one window that never needs telling
 * apart from a "previous self".
 */

const SATURATION = 70;

function hueForWindowLabel(label: string): number {
  let hash = 0;
  for (let i = 0; i < label.length; i++) {
    hash = (hash * 31 + label.charCodeAt(i)) | 0;
  }
  return Math.abs(hash) % 360;
}

/** The saturated accent dot — used against the app's own background. */
export function colorForWindowLabel(label: string): string {
  return `hsl(${hueForWindowLabel(label)} ${SATURATION}% 50%)`;
}

/**
 * A pastel tint of the same hue, light enough for dark text on top — the
 * ribbon's own background, mirroring `SandboxRibbon`'s solid amber bar rather
 * than the thin accent-only strip this replaced.
 */
export function ribbonColorForWindowLabel(label: string): string {
  return `hsl(${hueForWindowLabel(label)} ${SATURATION}% 85%)`;
}
