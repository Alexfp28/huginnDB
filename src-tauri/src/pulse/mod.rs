//! HuginnDB Pulse — server-health telemetry.
//!
//! Pulse reads the counters the engine already keeps and hands them to the UI
//! (a side panel and its expanded window) and, later, to the MCP connector.
//! This module owns the two things that must be shared across every engine:
//! the **canonical metric catalogue** and the DTOs that cross the IPC boundary.
//!
//! # Why canonical names, and why the raw value
//!
//! Each engine spells the same idea differently — MySQL's `Threads_connected`
//! is MongoDB's `connections.current` — so a snapshot is normalised to a fixed
//! vocabulary here. The panel then renders one set of tiles for every driver,
//! and an MCP client can ask for `connections_active` without knowing which
//! engine is answering. An engine that has no equivalent for a metric simply
//! omits it; a missing metric and a zero are different answers, and collapsing
//! them would invent a reading.
//!
//! What is emphatically **not** normalised is the value: a [`MetricKind::Counter`]
//! is reported exactly as the server reports it, monotonically increasing since
//! its last restart. Deriving a per-second rate needs two samples and the
//! interval between them, which only the caller holding the series has; doing it
//! here would mean either guessing the interval or keeping per-connection state
//! in a module that has no business owning any. It also makes a server restart
//! detectable — a counter that goes *down* is a restart, not a negative rate —
//! which a pre-derived rate throws away.
//!
//! # No display copy
//!
//! Nothing here is user-facing text. A degradation is a [`PulseNote`] carrying a
//! machine-readable `code` the frontend translates, for the same reason the
//! backend never writes an environment's default name (gotcha #27): copy chosen
//! in Rust would freeze one language into the user's screen.

use serde::Serialize;

/// Whether a reading accumulates since server start or describes the instant.
///
/// The distinction is the whole reason the catalogue exists: a consumer must
/// difference a `Counter` against the previous sample and must not difference a
/// `Gauge`. Getting it backwards yields a chart that is either flat or absurd.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum MetricKind {
    /// Monotonic since the server last restarted. Rate = Δvalue / Δt.
    Counter,
    /// An instantaneous reading. Plotted as-is.
    Gauge,
}

/// What the number counts, so a consumer can format it without a lookup table
/// of its own. Kept here rather than on the frontend because the MCP connector
/// serves the same metrics to a client that has no frontend at all.
///
/// Only the units the catalogue actually uses are listed — a duration unit will
/// arrive with the first metric measured in one, rather than sitting here
/// unconstructed waiting for it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum MetricUnit {
    Count,
    Bytes,
}

/// One entry in the catalogue.
#[derive(Debug, Clone, Copy)]
pub struct MetricSpec {
    pub name: &'static str,
    pub kind: MetricKind,
    pub unit: MetricUnit,
}

const fn counter(name: &'static str, unit: MetricUnit) -> MetricSpec {
    MetricSpec {
        name,
        kind: MetricKind::Counter,
        unit,
    }
}

const fn gauge(name: &'static str, unit: MetricUnit) -> MetricSpec {
    MetricSpec {
        name,
        kind: MetricKind::Gauge,
        unit,
    }
}

/// The canonical metric vocabulary.
///
/// Adding an entry is cheap; renaming one is not — the names are the MCP tool's
/// public argument values and, once the history store lands, the key rows are
/// written under. Treat them as a contract.
pub const METRICS: &[MetricSpec] = &[
    // Throughput. `queries` is every statement the server answered; the four
    // below break it down and deliberately do not have to sum to it (a server
    // answers plenty that is none of the four).
    counter("queries", MetricUnit::Count),
    counter("select_ops", MetricUnit::Count),
    counter("insert_ops", MetricUnit::Count),
    counter("update_ops", MetricUnit::Count),
    counter("delete_ops", MetricUnit::Count),
    counter("slow_queries", MetricUnit::Count),
    // Connection pressure. `connections_max` is the server's configured
    // ceiling, which is a gauge even though it almost never moves — it can be
    // changed at runtime, and a panel that cached it would keep showing the old
    // limit after someone raised it mid-incident.
    gauge("connections_active", MetricUnit::Count),
    gauge("connections_running", MetricUnit::Count),
    gauge("connections_max", MetricUnit::Count),
    counter("connections_aborted", MetricUnit::Count),
    // Memory and spill. `cache_reads` counts the reads that had to go to disk,
    // so the hit ratio is `1 - Δcache_reads / Δcache_read_requests` — a ratio
    // over the *interval*, not over the server's lifetime, which is what makes
    // it able to show a problem that started an hour ago.
    counter("cache_read_requests", MetricUnit::Count),
    counter("cache_reads", MetricUnit::Count),
    counter("tmp_disk_tables", MetricUnit::Count),
    counter("lock_waits", MetricUnit::Count),
    // Network.
    counter("bytes_sent", MetricUnit::Bytes),
    counter("bytes_received", MetricUnit::Bytes),
];

/// Look a spec up by canonical name.
pub fn spec(name: &str) -> Option<&'static MetricSpec> {
    METRICS.iter().find(|m| m.name == name)
}

/// One reading in a snapshot.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MetricSample {
    pub name: &'static str,
    pub value: f64,
    pub kind: MetricKind,
    pub unit: MetricUnit,
}

impl MetricSample {
    /// Build a sample for a catalogued metric. Returns `None` for a name that
    /// is not in [`METRICS`], which is what keeps a typo in a driver's mapping
    /// table from inventing a metric nobody can render or query.
    pub fn new(name: &str, value: f64) -> Option<Self> {
        spec(name).map(|s| MetricSample {
            name: s.name,
            value,
            kind: s.kind,
            unit: s.unit,
        })
    }
}

/// Something the user needs to know about the snapshot itself — a capability
/// the server does not grant, a feature switched off — as a code the frontend
/// translates. Never a sentence.
///
/// There is deliberately no severity field. Every note describes a *reading
/// Pulse could not take*, which is one thing and reads as a caution; the
/// alerts with real severity (a connection ceiling being approached, a
/// blocking transaction) are derived from the metrics by whoever holds the
/// series, and carry their own. A severity arrives here the day a note needs
/// one that is not "caution".
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PulseNote {
    pub code: &'static str,
}

impl PulseNote {
    pub fn warning(code: &'static str) -> Self {
        PulseNote { code }
    }
}

/// A single read of a server's vital signs.
///
/// `sampledAtMs` is stamped by the backend, not the frontend: the frontend's
/// clock is the same one either way, but the interval between two samples is
/// what every rate is divided by, and taking both ends of it from the same
/// place keeps a slow IPC round trip out of the arithmetic.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PulseHealth {
    /// `"mysql"` / `"mongodb"`. The frontend already knows the driver from the
    /// profile; this is here so an MCP client, which does not, still can tell.
    pub driver: &'static str,
    pub server_version: String,
    /// Seconds since the server last restarted, when it reports one.
    pub uptime_secs: Option<u64>,
    pub sampled_at_ms: u64,
    pub metrics: Vec<MetricSample>,
    pub notes: Vec<PulseNote>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn catalogue_names_are_unique() {
        // The names key both the MCP argument surface and (later) the history
        // rows, so a duplicate would make one of the two unreachable.
        let mut seen: Vec<&str> = METRICS.iter().map(|m| m.name).collect();
        seen.sort_unstable();
        let before = seen.len();
        seen.dedup();
        assert_eq!(before, seen.len(), "duplicate metric name in METRICS");
    }

    #[test]
    fn sample_rejects_an_uncatalogued_name() {
        assert!(MetricSample::new("queries", 1.0).is_some());
        assert!(MetricSample::new("Questions", 1.0).is_none());
    }

    #[test]
    fn sample_carries_the_catalogue_kind_and_unit() {
        let s = MetricSample::new("bytes_sent", 42.0).expect("catalogued");
        assert_eq!(s.kind, MetricKind::Counter);
        assert_eq!(s.unit, MetricUnit::Bytes);

        let g = MetricSample::new("connections_active", 7.0).expect("catalogued");
        assert_eq!(g.kind, MetricKind::Gauge);
        assert_eq!(g.unit, MetricUnit::Count);
    }
}
