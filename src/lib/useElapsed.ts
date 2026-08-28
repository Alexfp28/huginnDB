import { useCallback, useEffect, useRef, useState } from "react";

export interface ElapsedHandle {
  /** Reset to 0 and start ticking every 50ms. */
  start: () => void;
  /** Stop ticking and freeze at the measured round-trip time. */
  stop: (ok: boolean) => void;
}

export interface ElapsedState {
  elapsedMs: number;
  /** `null` before the first run; frozen at the last outcome once stopped. */
  lastOk: boolean | null;
}

/**
 * Wall-clock run timer: ticks every 50ms between `start()` and `stop()`,
 * then freezes at the measured duration. `start`/`stop` are stable
 * (`useCallback` with no deps) so a caller can drive this from a ref
 * without depending on the ticking `elapsedMs` itself — see `QueryTimer`,
 * whose whole reason for owning this hook (rather than a parent owning the
 * state and passing `elapsedMs` down as a prop) is that a value changing
 * every 50ms while a query runs must not re-render the query editor's own
 * component, Monaco included.
 */
export function useElapsed(): ElapsedState & ElapsedHandle {
  const [elapsedMs, setElapsedMs] = useState(0);
  const [lastOk, setLastOk] = useState<boolean | null>(null);
  const runStartRef = useRef(0);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const start = useCallback(() => {
    if (intervalRef.current) clearInterval(intervalRef.current);
    runStartRef.current = Date.now();
    setElapsedMs(0);
    setLastOk(null);
    intervalRef.current = setInterval(() => {
      setElapsedMs(Date.now() - runStartRef.current);
    }, 50);
  }, []);

  const stop = useCallback((ok: boolean) => {
    if (intervalRef.current) {
      clearInterval(intervalRef.current);
      intervalRef.current = null;
    }
    setElapsedMs(Date.now() - runStartRef.current);
    setLastOk(ok);
  }, []);

  useEffect(
    () => () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
    },
    [],
  );

  return { elapsedMs, lastOk, start, stop };
}
