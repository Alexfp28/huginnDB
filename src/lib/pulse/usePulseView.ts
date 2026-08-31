/**
 * Everything a Pulse surface needs about one connection, derived once.
 *
 * Both densities — the dock panel and the expanded window — answer the same
 * questions from the same store, and computing them twice in two components is
 * how the two would eventually disagree about what "queries per second" means.
 * The store reads stay raw (a slice reference, never a fresh array — gotcha
 * #1) and everything derived is memoized here.
 */

import { useMemo } from "react";
import { deriveAlerts, type PulseAlert } from "@/lib/pulse/alerts";
import { cacheHitRatio, latestOf, seriesFor, valueIn } from "@/lib/pulse/rates";
import { NO_SAMPLES, usePulse, type PulseDetail } from "@/stores/session/pulse";
import type { PulseHealth, PulseStorageItem, PulseTopQuery } from "@/types";

export interface PulseView {
  samples: readonly PulseHealth[];
  /** The newest snapshot, or `undefined` before the first one lands. */
  latest: PulseHealth | undefined;
  /** Last live-sample failure, cleared by the next success. */
  error: string | undefined;
  alerts: PulseAlert[];

  /** Per-second rates, oldest first. `null` marks an unmeasurable interval. */
  queriesSeries: (number | null)[];
  connectionsSeries: (number | null)[];
  runningSeries: (number | null)[];

  /** Latest usable value of each series, ignoring trailing gaps. */
  queriesPerSecond: number | null;
  connections: number | null;
  running: number | null;
  connectionsMax: number | undefined;
  /** Hit ratio over the last interval, `null` when the interval was idle. */
  cacheHit: number | null;

  topQueries: PulseDetail<PulseTopQuery> | undefined;
  storage: PulseDetail<PulseStorageItem> | undefined;
  storageTotalBytes: number;
}

export function usePulseView(connectionId: string | null): PulseView {
  const samples = usePulse((s) =>
    connectionId ? (s.samples[connectionId] ?? NO_SAMPLES) : NO_SAMPLES,
  );
  const error = usePulse((s) => (connectionId ? s.errors[connectionId] : undefined));
  const topQueries = usePulse((s) =>
    connectionId ? s.topQueries[connectionId] : undefined,
  );
  const storage = usePulse((s) => (connectionId ? s.storage[connectionId] : undefined));

  const derived = useMemo(() => {
    const latest = samples[samples.length - 1];
    const queriesSeries = seriesFor(samples, "queries");
    const connectionsSeries = seriesFor(samples, "connections_active");
    const runningSeries = seriesFor(samples, "connections_running");
    return {
      latest,
      alerts: deriveAlerts(samples),
      queriesSeries,
      connectionsSeries,
      runningSeries,
      queriesPerSecond: latestOf(queriesSeries),
      connections: latestOf(connectionsSeries),
      running: latestOf(runningSeries),
      connectionsMax: latest ? valueIn(latest, "connections_max") : undefined,
      cacheHit: cacheHitRatio(samples),
    };
  }, [samples]);

  const storageTotalBytes = useMemo(
    () =>
      (storage?.items ?? []).reduce(
        (sum, i) => sum + i.dataBytes + i.indexBytes + i.freeBytes,
        0,
      ),
    [storage],
  );

  return { samples, error, topQueries, storage, storageTotalBytes, ...derived };
}

/** The rejection a driver Pulse cannot read yet answers with. Matched on the
 *  text `AppError::UnsupportedDriver` serialises to, since errors cross the IPC
 *  boundary as plain strings. */
export function isUnsupported(error: string | undefined): boolean {
  return !!error && /unsupported driver/i.test(error);
}
