/**
 * What the numbers mean — the rules that turn a run of Pulse snapshots into
 * the short list the panel shows under "Alerts".
 *
 * These live on this side of the IPC boundary rather than in Rust for two
 * reasons. They are thresholds, which the user will eventually want to edit,
 * and a threshold belongs next to the copy that explains it; and they read the
 * *series*, which is the frontend's to hold while Pulse is on screen (the
 * backend keeps no per-connection state — see `src-tauri/src/pulse/mod.rs`).
 *
 * An alert is a code plus parameters, never a sentence: the panel translates
 * it, the same contract `PulseNote` uses coming the other way.
 *
 * Every rule here answers from the *last interval*, not from the server's
 * lifetime. A box up for six weeks has flattering lifetime averages no matter
 * what it is doing right now, and "right now" is the only question this panel
 * is asked.
 */

import type { PulseHealth } from "@/types";
import { cacheHitRatio, rateBetween, valueIn } from "./rates";

export type PulseAlertLevel = "warning" | "critical";

export interface PulseAlert {
  /** Translated as `pulse.alert.<code>`. */
  code: string;
  level: PulseAlertLevel;
  /** Interpolation values for the message. */
  params?: Record<string, string | number>;
}

/** Connection pressure at or above this fraction of the ceiling is a warning… */
const CONNECTIONS_WARN = 0.7;
/** …and at or above this, a crisis: the next client to arrive is refused. */
const CONNECTIONS_CRITICAL = 0.85;
/** A buffer pool serving fewer than this many of its reads from memory is
 *  going to disk enough for someone to feel it. */
const CACHE_HIT_WARN = 0.95;

/** Rate of a counter over the most recent interval, per second. */
function lastRate(samples: readonly PulseHealth[], name: string): number | null {
  if (samples.length < 2) return null;
  const prev = samples[samples.length - 2];
  const next = samples[samples.length - 1];
  const a = valueIn(prev, name);
  const b = valueIn(next, name);
  return rateBetween(
    a === undefined ? undefined : { value: a, atMs: prev.sampledAtMs },
    b === undefined ? undefined : { value: b, atMs: next.sampledAtMs },
  );
}

function perMinute(perSecond: number): number {
  return Math.round(perSecond * 60);
}

/**
 * Derive the alerts for a connection from its live series, most severe first.
 *
 * The backend's own [`PulseNote`]s are folded in at warning level and last:
 * they say a reading could not be taken, which matters, but never as much as a
 * reading that was taken and is bad.
 */
export function deriveAlerts(samples: readonly PulseHealth[]): PulseAlert[] {
  const alerts: PulseAlert[] = [];
  const latest = samples[samples.length - 1];
  if (!latest) return alerts;

  // ── Connection pressure ────────────────────────────────────────────────
  const active = valueIn(latest, "connections_active");
  const max = valueIn(latest, "connections_max");
  if (active !== undefined && max !== undefined && max > 0) {
    const used = active / max;
    if (used >= CONNECTIONS_WARN) {
      alerts.push({
        code: "connectionsNearMax",
        level: used >= CONNECTIONS_CRITICAL ? "critical" : "warning",
        params: { percent: Math.round(used * 100), active, max },
      });
    }
  }

  // ── Buffer pool ────────────────────────────────────────────────────────
  const hit = cacheHitRatio(samples);
  if (hit !== null && hit < CACHE_HIT_WARN) {
    alerts.push({
      code: "cacheHitLow",
      level: "warning",
      // One decimal: the interesting range is 90–99 %, where a rounded
      // integer hides the difference between "slipping" and "collapsed".
      params: { percent: (hit * 100).toFixed(1) },
    });
  }

  // ── Spill and refusals ─────────────────────────────────────────────────
  // Any of these happening *at all* is worth saying. They are all zero on a
  // healthy server, so a threshold above zero would only ever hide the early
  // warning, which is the one worth having.
  const spill = lastRate(samples, "tmp_disk_tables");
  if (spill !== null && spill > 0) {
    alerts.push({
      code: "tmpDiskTables",
      level: "warning",
      params: { perMinute: perMinute(spill) },
    });
  }

  const slow = lastRate(samples, "slow_queries");
  if (slow !== null && slow > 0) {
    alerts.push({
      code: "slowQueries",
      level: "warning",
      params: { perMinute: perMinute(slow) },
    });
  }

  const aborted = lastRate(samples, "connections_aborted");
  if (aborted !== null && aborted > 0) {
    alerts.push({
      code: "abortedConnects",
      level: "warning",
      params: { perMinute: perMinute(aborted) },
    });
  }

  for (const note of latest.notes) {
    alerts.push({ code: note.code, level: "warning" });
  }

  return alerts;
}
