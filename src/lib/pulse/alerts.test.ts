import { describe, expect, it } from "vitest";
import type { PulseHealth, PulseMetricSample } from "@/types";
import { deriveAlerts } from "./alerts";

const COUNTER: Pick<PulseMetricSample, "kind" | "unit"> = {
  kind: "counter",
  unit: "count",
};
const GAUGES = ["connections_active", "connections_max", "connections_running"];

function snap(
  atMs: number,
  values: Record<string, number>,
  notes: string[] = [],
): PulseHealth {
  return {
    driver: "mysql",
    serverVersion: "8.0.36",
    uptimeSecs: 1000,
    sampledAtMs: atMs,
    metrics: Object.entries(values).map(([name, value]) => ({
      name,
      value,
      ...COUNTER,
      ...(GAUGES.includes(name) ? { kind: "gauge" as const } : {}),
    })),
    notes: notes.map((code) => ({ code })),
  };
}

const codes = (samples: PulseHealth[]) => deriveAlerts(samples).map((a) => a.code);

describe("connection pressure", () => {
  it("stays quiet below the warning threshold", () => {
    const s = snap(0, { connections_active: 60, connections_max: 300 });
    expect(codes([s])).toEqual([]);
  });

  it("warns past 70 % and escalates past 85 %", () => {
    const warn = deriveAlerts([
      snap(0, { connections_active: 220, connections_max: 300 }),
    ]);
    expect(warn[0]).toMatchObject({
      code: "connectionsNearMax",
      level: "warning",
      params: { percent: 73, active: 220, max: 300 },
    });

    const crit = deriveAlerts([
      snap(0, { connections_active: 280, connections_max: 300 }),
    ]);
    expect(crit[0]).toMatchObject({ code: "connectionsNearMax", level: "critical" });
  });

  it("says nothing when the server did not report a ceiling", () => {
    // Better silent than dividing by a limit we had to invent.
    expect(codes([snap(0, { connections_active: 280 })])).toEqual([]);
  });
});

describe("buffer pool", () => {
  it("warns on a bad interval even when the lifetime ratio is excellent", () => {
    const alerts = deriveAlerts([
      snap(0, { cache_read_requests: 1_000_000, cache_reads: 1_000 }),
      snap(5000, { cache_read_requests: 1_000_100, cache_reads: 1_050 }),
    ]);
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({ code: "cacheHitLow", level: "warning" });
    expect(alerts[0].params?.percent).toBe("50.0");
  });

  it("stays quiet on a healthy interval", () => {
    expect(
      codes([
        snap(0, { cache_read_requests: 100_000, cache_reads: 10 }),
        snap(5000, { cache_read_requests: 110_000, cache_reads: 12 }),
      ]),
    ).toEqual([]);
  });
});

describe("spill and refusals", () => {
  it("reports any non-zero rate, converted to per minute", () => {
    const alerts = deriveAlerts([
      snap(0, { tmp_disk_tables: 100, slow_queries: 10, connections_aborted: 2 }),
      snap(60_000, {
        tmp_disk_tables: 190,
        slow_queries: 13,
        connections_aborted: 3,
      }),
    ]);
    expect(alerts.map((a) => [a.code, a.params?.perMinute])).toEqual([
      ["tmpDiskTables", 90],
      ["slowQueries", 3],
      ["abortedConnects", 1],
    ]);
  });

  it("stays quiet when the counters did not move", () => {
    expect(
      codes([
        snap(0, { tmp_disk_tables: 100, slow_queries: 10 }),
        snap(5000, { tmp_disk_tables: 100, slow_queries: 10 }),
      ]),
    ).toEqual([]);
  });

  it("needs two samples before it can say anything about a counter", () => {
    expect(codes([snap(0, { tmp_disk_tables: 9_999 })])).toEqual([]);
  });
});

describe("backend notes", () => {
  it("folds them in last, behind any real reading", () => {
    const alerts = deriveAlerts([
      snap(0, { connections_active: 290, connections_max: 300 }, [
        "performanceSchemaOff",
      ]),
    ]);
    expect(alerts.map((a) => a.code)).toEqual([
      "connectionsNearMax",
      "performanceSchemaOff",
    ]);
    expect(alerts[1].level).toBe("warning");
  });
});

describe("empty input", () => {
  it("derives nothing from no samples", () => {
    expect(deriveAlerts([])).toEqual([]);
  });
});
