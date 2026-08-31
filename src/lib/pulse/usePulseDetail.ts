/**
 * The on-demand half of Pulse: the two reads that are too expensive to poll.
 *
 * `pulse_top_queries` scans `performance_schema`'s digest table and
 * `pulse_storage` ranks a whole `SHOW TABLE STATUS` result set. Neither answers
 * a question anyone asks every five seconds, so they are fetched when Pulse
 * becomes visible and then at most every fifteen minutes.
 *
 * Two behaviours worth knowing:
 *
 *  - **A cached answer is reused.** Toggling the right dock between Saved and
 *    Pulse repeatedly must not re-issue the most expensive statement Pulse
 *    knows how to send; anything younger than the refresh interval is left
 *    alone.
 *  - **A failed refresh keeps the last good answer.** `performance_schema`
 *    being off makes the first read fail forever, and a server can refuse one
 *    of the two while happily answering the other, so each read carries its own
 *    error next to its own items rather than blanking a section that was fine a
 *    minute ago.
 */

import { useCallback, useEffect, useRef } from "react";
import { api } from "@/lib/tauri";
import { usePulse } from "@/stores/session/pulse";

/** Refresh cadence for the on-demand reads while Pulse stays visible. */
export const PULSE_DETAIL_INTERVAL_MS = 15 * 60 * 1000;

export function usePulseDetail(
  connectionId: string | null,
  active: boolean,
  intervalMs: number = PULSE_DETAIL_INTERVAL_MS,
): { refresh: () => void } {
  const inFlight = useRef(false);

  const load = useCallback(
    async (id: string, force: boolean) => {
      if (inFlight.current) return;

      const store = usePulse.getState();
      const now = Date.now();
      const fresh = (atMs: number | undefined) =>
        atMs !== undefined && now - atMs < intervalMs;
      const needQueries = force || !fresh(store.topQueries[id]?.atMs);
      const needStorage = force || !fresh(store.storage[id]?.atMs);
      if (!needQueries && !needStorage) return;

      inFlight.current = true;
      // Both at once: they hit different catalogues and the panel shows them
      // together, so serialising them would only make the section that came
      // second appear late for no benefit.
      await Promise.all([
        needQueries
          ? api
              .pulseTopQueries(id)
              .then((items) =>
                usePulse.getState().setTopQueries(id, { items, atMs: Date.now() }),
              )
              .catch((e) =>
                usePulse.getState().setTopQueries(id, {
                  // Keep whatever was already there; only the stamp and the
                  // error move, so a transient failure does not empty the list.
                  items: usePulse.getState().topQueries[id]?.items ?? [],
                  atMs: Date.now(),
                  error: String(e),
                }),
              )
          : Promise.resolve(),
        needStorage
          ? api
              .pulseStorage(id)
              .then((items) =>
                usePulse.getState().setStorage(id, { items, atMs: Date.now() }),
              )
              .catch((e) =>
                usePulse.getState().setStorage(id, {
                  items: usePulse.getState().storage[id]?.items ?? [],
                  atMs: Date.now(),
                  error: String(e),
                }),
              )
          : Promise.resolve(),
      ]);
      inFlight.current = false;
    },
    [intervalMs],
  );

  useEffect(() => {
    if (!connectionId || !active) return;
    void load(connectionId, false);
    const timer = setInterval(() => void load(connectionId, true), intervalMs);
    return () => clearInterval(timer);
  }, [connectionId, active, intervalMs, load]);

  const refresh = useCallback(() => {
    if (connectionId) void load(connectionId, true);
  }, [connectionId, load]);

  return { refresh };
}
