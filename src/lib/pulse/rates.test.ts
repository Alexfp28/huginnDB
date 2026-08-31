import { describe, expect, it } from "vitest";
import type { PulseHealth, PulseMetricSample } from "@/types";
import {
  cacheHitRatio,
  compact,
  isCounterReset,
  latestOf,
  rateBetween,
  seriesFor,
  seriesFromHistory,
  valueIn,
} from "./rates";

const COUNTER: Pick<PulseMetricSample, "kind" | "unit"> = {
  kind: "counter",
  unit: "count",
};
const GAUGE: Pick<PulseMetricSample, "kind" | "unit"> = {
  kind: "gauge",
  unit: "count",
};

/** A snapshot at `atMs` holding the named readings. Counters unless the name
 *  is listed in `gauges`. */
function snap(
  atMs: number,
  values: Record<string, number>,
  gauges: string[] = [],
): PulseHealth {
  return {
    driver: "mysql",
    serverVersion: "8.0.36",
    uptimeSecs: 1000,
    sampledAtMs: atMs,
    metrics: Object.entries(values).map(([name, value]) => ({
      name,
      value,
      ...(gauges.includes(name) ? GAUGE : COUNTER),
    })),
    notes: [],
  };
}

describe("valueIn", () => {
  it("distinguishes a missing metric from a zero one", () => {
    const s = snap(0, { queries: 0 });
    expect(valueIn(s, "queries")).toBe(0);
    expect(valueIn(s, "slow_queries")).toBeUndefined();
  });
});

describe("rateBetween", () => {
  it("computes a per-second rate", () => {
    const r = rateBetween({ value: 100, atMs: 0 }, { value: 150, atMs: 5000 });
    expect(r).toBe(10);
  });

  it("returns null across a counter reset rather than a negative spike", () => {
    expect(isCounterReset(100, 4)).toBe(true);
    expect(rateBetween({ value: 100, atMs: 0 }, { value: 4, atMs: 5000 })).toBeNull();
  });

  it("returns null when the clock did not move", () => {
    // Two samples stamped identically would divide by zero and yield Infinity,
    // which a chart happily scales its whole axis to.
    expect(rateBetween({ value: 1, atMs: 7 }, { value: 9, atMs: 7 })).toBeNull();
    expect(rateBetween({ value: 1, atMs: 9 }, { value: 9, atMs: 7 })).toBeNull();
  });

  it("returns null when either end is missing the metric", () => {
    expect(rateBetween(undefined, { value: 9, atMs: 5000 })).toBeNull();
    expect(rateBetween({ value: 1, atMs: 0 }, undefined)).toBeNull();
  });
});

describe("seriesFor", () => {
  it("plots a gauge as read, one point per sample", () => {
    const series = seriesFor(
      [
        snap(0, { connections_active: 5 }, ["connections_active"]),
        snap(5000, { connections_active: 9 }, ["connections_active"]),
      ],
      "connections_active",
    );
    expect(series).toEqual([5, 9]);
  });

  it("plots a counter as a rate, one point shorter than the input", () => {
    const series = seriesFor(
      [
        snap(0, { queries: 100 }),
        snap(5000, { queries: 150 }),
        snap(10000, { queries: 250 }),
      ],
      "queries",
    );
    expect(series).toEqual([10, 20]);
  });

  it("breaks the line at a restart instead of drawing through it", () => {
    const series = seriesFor(
      [
        snap(0, { queries: 900 }),
        // The server restarted here: the counter is back near zero.
        snap(5000, { queries: 12 }),
        snap(10000, { queries: 62 }),
      ],
      "queries",
    );
    expect(series).toEqual([null, 10]);
  });

  it("returns nothing for a metric no sample reports", () => {
    expect(seriesFor([snap(0, { queries: 1 })], "lock_waits")).toEqual([]);
    expect(seriesFor([], "queries")).toEqual([]);
  });
});

describe("seriesFromHistory", () => {
  it("plots a gauge as read, one point per reading", () => {
    const series = seriesFromHistory(
      [
        { tsMs: 0, value: 5 },
        { tsMs: 5000, value: 9 },
      ],
      "gauge",
    );
    expect(series).toEqual([5, 9]);
  });

  it("plots a counter as a rate, one point shorter than the input", () => {
    const series = seriesFromHistory(
      [
        { tsMs: 0, value: 100 },
        { tsMs: 5000, value: 150 },
        { tsMs: 10000, value: 250 },
      ],
      "counter",
    );
    expect(series).toEqual([10, 20]);
  });

  it("does not assume even spacing — a downsampled gap still divides by the real elapsed time", () => {
    const series = seriesFromHistory(
      [
        { tsMs: 0, value: 0 },
        // A gap much longer than the other interval, from the retention
        // staircase thinning old history to one point per 5 minutes.
        { tsMs: 300_000, value: 300 },
      ],
      "counter",
    );
    expect(series).toEqual([1]);
  });

  it("breaks the line at a restart instead of drawing through it", () => {
    const series = seriesFromHistory(
      [
        { tsMs: 0, value: 900 },
        { tsMs: 5000, value: 12 },
      ],
      "counter",
    );
    expect(series).toEqual([null]);
  });

  it("returns an empty series for zero or one points", () => {
    expect(seriesFromHistory([], "counter")).toEqual([]);
    expect(seriesFromHistory([{ tsMs: 0, value: 1 }], "counter")).toEqual([]);
    expect(seriesFromHistory([], "gauge")).toEqual([]);
  });
});

describe("latestOf / compact", () => {
  it("skips trailing gaps to find the last real reading", () => {
    expect(latestOf([1, 2, null])).toBe(2);
    expect(latestOf([null, null])).toBeNull();
    expect(latestOf([])).toBeNull();
  });

  it("drops gaps", () => {
    expect(compact([1, null, 3])).toEqual([1, 3]);
  });
});

describe("cacheHitRatio", () => {
  it("uses the interval's deltas, not the lifetime totals", () => {
    // Lifetime looks perfect (1M requests, 1k misses = 99.9 %) while the last
    // interval is a disaster (100 requests, 50 misses = 50 %). The interval is
    // the answer that can show a problem that started an hour ago.
    const ratio = cacheHitRatio([
      snap(0, { cache_read_requests: 1_000_000, cache_reads: 1_000 }),
      snap(5000, { cache_read_requests: 1_000_100, cache_reads: 1_050 }),
    ]);
    expect(ratio).toBeCloseTo(0.5, 6);
  });

  it("is null on an idle interval rather than reporting nought per cent", () => {
    const ratio = cacheHitRatio([
      snap(0, { cache_read_requests: 500, cache_reads: 5 }),
      snap(5000, { cache_read_requests: 500, cache_reads: 5 }),
    ]);
    expect(ratio).toBeNull();
  });

  it("is null across a restart and with fewer than two samples", () => {
    expect(
      cacheHitRatio([
        snap(0, { cache_read_requests: 500, cache_reads: 5 }),
        snap(5000, { cache_read_requests: 12, cache_reads: 0 }),
      ]),
    ).toBeNull();
    expect(cacheHitRatio([snap(0, { cache_read_requests: 1, cache_reads: 0 })])).toBeNull();
  });

  it("clamps the counters drifting apart instead of reporting a negative rate", () => {
    const ratio = cacheHitRatio([
      snap(0, { cache_read_requests: 100, cache_reads: 10 }),
      snap(5000, { cache_read_requests: 110, cache_reads: 40 }),
    ]);
    expect(ratio).toBe(0);
  });

  it("is null when the engine reports neither counter", () => {
    expect(cacheHitRatio([snap(0, { queries: 1 }), snap(5000, { queries: 2 })])).toBeNull();
  });
});
