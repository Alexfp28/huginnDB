/**
 * Trailing debounces and module-level repeating timers.
 *
 * Both shapes were hand-rolled per site — three copies of
 * `if (timer) clearTimeout(timer); timer = setTimeout(() => { timer = null; … })`
 * and two of `if (timer) return; timer = setInterval(…)`. The bookkeeping is
 * where the bugs live, not the timing: forgetting to null the handle inside the
 * callback leaves a stale one that `cancel` then clears for nothing, and a
 * missing "already running" guard lets React StrictMode's double-effect stack
 * two intervals that both fire forever.
 *
 * Delays stay at the call site. Two of the callers happen to poll every four
 * hours, but each justifies that number on its own grounds (a release feed and
 * a shared-origin sweep), so a shared constant would tie them together for no
 * reason beyond the coincidence.
 */

/** A trailing debounce over one recurring call. */
export interface Debounce<A extends unknown[]> {
  /**
   * Arm the trailing call, replacing any pending one. The *last* arguments win,
   * which is what makes this safe for "save whatever the current state is".
   */
  schedule: (...args: A) => void;
  /**
   * Drop a pending call without running it. Returns whether one was armed —
   * enough for a caller that wants to flush instead ("there were unsaved edits,
   * write them now") without also running the debounced body.
   */
  cancel: () => boolean;
  /** Whether a call is currently armed. */
  readonly pending: boolean;
}

export function debounce<A extends unknown[]>(
  delayMs: number,
  run: (...args: A) => void,
): Debounce<A> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  return {
    schedule(...args: A) {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        // Cleared *before* the body runs, so a `run` that re-schedules (or a
        // `cancel` racing it) sees an accurate handle rather than a spent one.
        timer = null;
        run(...args);
      }, delayMs);
    },
    cancel() {
      if (!timer) return false;
      clearTimeout(timer);
      timer = null;
      return true;
    },
    get pending() {
      return timer !== null;
    },
  };
}

/** A module-level repeating timer that can only ever have one tick in flight. */
export interface Repeating {
  /**
   * Start ticking, or do nothing if already started. Idempotent by design: the
   * callers are effects, and React StrictMode runs those twice in development.
   */
  start: () => void;
  stop: () => void;
  /**
   * Whether the timer is running. Lets a caller do its own once-only work
   * alongside the first `start` (an immediate first sweep, say) without keeping
   * a second flag for it.
   */
  readonly running: boolean;
}

export function repeating(delayMs: number, run: () => void): Repeating {
  let timer: ReturnType<typeof setInterval> | null = null;
  return {
    start() {
      if (timer) return;
      timer = setInterval(run, delayMs);
    },
    stop() {
      if (!timer) return;
      clearInterval(timer);
      timer = null;
    },
    get running() {
      return timer !== null;
    },
  };
}
