/**
 * The live clock behind Pulse.
 *
 * One interval per connection, running only while someone is looking. Three
 * rules make it safe to point at a production server:
 *
 *  - **It stops when Pulse is not visible.** `active` is false the moment the
 *    right dock shows another panel or is collapsed, and the hook additionally
 *    stands down while the document is hidden — a minimised or occluded
 *    window. Deliberately `visibilitychange` and not `blur`: someone can leave
 *    Pulse on a second monitor and work in another app, and freezing a panel
 *    they are looking at is worse than the probe it saves.
 *  - **It never overlaps itself.** A sample still in flight when the next tick
 *    fires skips that tick. A slow server therefore stretches the interval
 *    instead of accumulating a queue of probes against the thing that is
 *    already struggling.
 *  - **A failure does not become a retry storm.** The error is recorded and
 *    the interval carries on at its normal cadence; there is no backoff to get
 *    wrong because there is no acceleration to back off from.
 */

import { useEffect, useRef, useState } from "react";
import { api } from "@/lib/tauri";
import { usePulse } from "@/stores/session/pulse";

/** Live cadence. Fast enough for a chart to feel live, slow enough that the
 *  probe is a rounding error next to the traffic it is measuring. */
export const PULSE_LIVE_INTERVAL_MS = 5000;

/** Whether this document is on screen at all. */
function useDocumentVisible(): boolean {
  const [visible, setVisible] = useState(
    () => typeof document === "undefined" || document.visibilityState === "visible",
  );
  useEffect(() => {
    const onChange = () => setVisible(document.visibilityState === "visible");
    document.addEventListener("visibilitychange", onChange);
    return () => document.removeEventListener("visibilitychange", onChange);
  }, []);
  return visible;
}

export function usePulseLive(
  connectionId: string | null,
  active: boolean,
  intervalMs: number = PULSE_LIVE_INTERVAL_MS,
): void {
  // Guards the overlap rule across renders without making the effect depend on
  // a piece of state that changes twice per sample.
  const inFlight = useRef(false);
  const documentVisible = useDocumentVisible();

  useEffect(() => {
    if (!connectionId || !active || !documentVisible) return;

    let cancelled = false;
    inFlight.current = false;

    async function sample(id: string) {
      if (inFlight.current) return;
      inFlight.current = true;
      try {
        const health = await api.pulseHealth(id);
        if (!cancelled) usePulse.getState().push(id, health);
      } catch (e) {
        if (!cancelled) usePulse.getState().fail(id, String(e));
      } finally {
        inFlight.current = false;
      }
    }

    // Sample immediately: waiting a full interval before the first reading
    // makes opening the panel feel broken.
    void sample(connectionId);
    const timer = setInterval(() => void sample(connectionId), intervalMs);

    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [connectionId, active, documentVisible, intervalMs]);
}
