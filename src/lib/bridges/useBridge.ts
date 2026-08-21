/**
 * Subscribe to a Rust event bridge for the lifetime of the component.
 *
 * Every `start*Bridge` resolves to its own unlisten function, so subscribing
 * means awaiting a promise inside an effect — and doing that safely means
 * handling the case where the effect is torn down *before* the promise settles.
 * `App.tsx` had this dance written out six times:
 *
 *     let unlisten: (() => void) | null = null;
 *     let cancelled = false;
 *     void startXBridge().then((fn) => { if (cancelled) fn(); else unlisten = fn; });
 *     return () => { cancelled = true; unlisten?.(); };
 *
 * The `cancelled` flag is the part worth keeping in one place. Without it a
 * StrictMode double-mount (or a Vite HMR reload) resolves a listener into a
 * component that has already unmounted, and nothing ever unlistens it — every
 * Console entry then arrives twice, which is the duplication CLAUDE.md gotcha
 * #25 describes from the other direction.
 *
 * `start` is intentionally not a dependency: these bridges are module-level
 * functions with stable identity, and re-subscribing on a changed reference
 * would be a bug rather than a feature. Pass a stable function.
 */

import { useEffect } from "react";

export function useBridge(start: () => Promise<() => void>): void {
  useEffect(() => {
    let unlisten: (() => void) | null = null;
    let cancelled = false;
    void start().then((fn) => {
      if (cancelled) fn();
      else unlisten = fn;
    });
    return () => {
      cancelled = true;
      unlisten?.();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
}
