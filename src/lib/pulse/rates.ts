/**
 * Turning Pulse snapshots into the numbers a chart can plot.
 *
 * The backend reports counters exactly as the server does — monotonic since
 * its last restart — because deriving a rate needs two samples and the gap
 * between them, and only whoever holds the series has both (see
 * `src-tauri/src/pulse/mod.rs`). This module is that holder's arithmetic.
 *
 * Everything here is pure and takes explicit samples rather than reading the
 * store, so the two rules that are easy to get wrong and impossible to spot on
 * screen — differencing a gauge, and reading a server restart as a cliff — are
 * testable without a database.
 */

import type { PulseHealth, PulseMetricSample } from "@/types";

/** A metric's reading in one snapshot, paired with when it was taken. */
interface Point {
  value: number;
  atMs: number;
}

/** Pull one metric out of a snapshot. `undefined` when the engine does not
 *  report it — which is a different answer from zero, and stays different all
 *  the way to the screen. */
export function metricIn(
  health: PulseHealth,
  name: string,
): PulseMetricSample | undefined {
  return health.metrics.find((m) => m.name === name);
}

export function valueIn(health: PulseHealth, name: string): number | undefined {
  return metricIn(health, name)?.value;
}

/**
 * Whether the counter went backwards between two samples.
 *
 * A monotonic counter can only decrease by being reset, and the only thing
 * that resets one is the server restarting. Treating that as a rate would draw
 * a large negative spike; treating it as zero would draw a plausible-looking
 * lull that never happened. Both are wrong in a way nobody can see, so the
 * interval is reported as a gap instead (`null`) and the caller marks it.
 */
export function isCounterReset(previous: number, next: number): boolean {
  return next < previous;
}

/**
 * Per-second rate between two counter readings.
 *
 * `null` for a reset, for a non-positive interval (two samples that arrived
 * with the same timestamp — a clock that did not move cannot divide), and for
 * a metric missing from either end.
 */
export function rateBetween(
  previous: Point | undefined,
  next: Point | undefined,
): number | null {
  if (!previous || !next) return null;
  const dtMs = next.atMs - previous.atMs;
  if (dtMs <= 0) return null;
  if (isCounterReset(previous.value, next.value)) return null;
  return ((next.value - previous.value) * 1000) / dtMs;
}

/**
 * The series to plot for one metric across a run of snapshots, oldest first.
 *
 * A gauge is plotted as read. A counter is plotted as the rate over each
 * interval, so the result is one point *shorter* than the input — the first
 * sample has nothing to be differenced against. Intervals the rate cannot be
 * computed for (a restart, a clock that stood still) come back as `null` so a
 * chart can break the line there instead of drawing through a fiction.
 */
export function seriesFor(
  samples: readonly PulseHealth[],
  name: string,
): (number | null)[] {
  if (samples.length === 0) return [];

  const kind = samples.map((s) => metricIn(s, name)?.kind).find(Boolean);
  if (!kind) return [];

  if (kind === "gauge") {
    return samples.map((s) => valueIn(s, name) ?? null);
  }

  const out: (number | null)[] = [];
  for (let i = 1; i < samples.length; i++) {
    const a = valueIn(samples[i - 1], name);
    const b = valueIn(samples[i], name);
    out.push(
      rateBetween(
        a === undefined ? undefined : { value: a, atMs: samples[i - 1].sampledAtMs },
        b === undefined ? undefined : { value: b, atMs: samples[i].sampledAtMs },
      ),
    );
  }
  return out;
}

/** The most recent usable point of a series, ignoring trailing gaps. */
export function latestOf(series: readonly (number | null)[]): number | null {
  for (let i = series.length - 1; i >= 0; i--) {
    const v = series[i];
    if (v !== null && Number.isFinite(v)) return v;
  }
  return null;
}

/** Drop the gaps, for a chart that would rather have a shorter continuous line
 *  than a broken one. */
export function compact(series: readonly (number | null)[]): number[] {
  return series.filter((v): v is number => v !== null && Number.isFinite(v));
}

/**
 * Cache hit ratio over the last interval, as a fraction in `[0, 1]`.
 *
 * Computed from the *deltas*, never from the lifetime totals. A server up for
 * six weeks has a lifetime ratio pinned at three nines no matter how badly it
 * is thrashing right now, so the lifetime number is exactly the one that
 * cannot show a problem that started an hour ago.
 *
 * `null` when either counter is missing, when the interval saw no reads at all
 * (an idle server has no hit ratio, and reporting 0 % would read as a crisis),
 * or across a restart.
 */
export function cacheHitRatio(samples: readonly PulseHealth[]): number | null {
  if (samples.length < 2) return null;
  const prev = samples[samples.length - 2];
  const next = samples[samples.length - 1];

  const reqA = valueIn(prev, "cache_read_requests");
  const reqB = valueIn(next, "cache_read_requests");
  const missA = valueIn(prev, "cache_reads");
  const missB = valueIn(next, "cache_reads");
  if (
    reqA === undefined ||
    reqB === undefined ||
    missA === undefined ||
    missB === undefined
  ) {
    return null;
  }
  if (isCounterReset(reqA, reqB) || isCounterReset(missA, missB)) return null;

  const requests = reqB - reqA;
  if (requests <= 0) return null;

  const misses = missB - missA;
  // A server can report more misses than requests across a sample boundary
  // (the two counters are not updated atomically), which would render as a
  // negative hit rate. Clamp rather than surface arithmetic noise as a crisis.
  return Math.min(1, Math.max(0, 1 - misses / requests));
}
