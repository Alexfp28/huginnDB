//! MySQL vital signs for Pulse. See [`crate::pulse`] for the contract these
//! readings are normalised into.

use std::collections::HashMap;

use sqlx::{MySqlPool, Row};

use crate::error::AppResult;
use crate::pulse::{MetricSample, PulseHealth, PulseNote};

/// `SHOW GLOBAL STATUS` name → canonical metric name.
///
/// Only the rows Pulse actually plots are mapped; the statement returns north
/// of 400 on MySQL 8 and carrying the rest across the IPC boundary every five
/// seconds would be pure waste.
///
/// Two entries deserve a note. `Questions` rather than `Queries`: the latter
/// counts statements executed *inside* stored programs too, so on a
/// procedure-heavy server it reports work the client never asked for, which is
/// the opposite of what a "queries per second" tile should read. And
/// `Innodb_buffer_pool_reads` is the count of reads that *missed* the pool and
/// went to disk — the hit ratio is derived from the pair, not read directly,
/// because MySQL has no such counter.
const STATUS_METRICS: &[(&str, &str)] = &[
    ("Questions", "queries"),
    ("Com_select", "select_ops"),
    ("Com_insert", "insert_ops"),
    ("Com_update", "update_ops"),
    ("Com_delete", "delete_ops"),
    ("Slow_queries", "slow_queries"),
    ("Threads_connected", "connections_active"),
    ("Threads_running", "connections_running"),
    ("Aborted_connects", "connections_aborted"),
    ("Innodb_buffer_pool_read_requests", "cache_read_requests"),
    ("Innodb_buffer_pool_reads", "cache_reads"),
    ("Created_tmp_disk_tables", "tmp_disk_tables"),
    ("Table_locks_waited", "lock_waits"),
    ("Bytes_sent", "bytes_sent"),
    ("Bytes_received", "bytes_received"),
];

/// The `SHOW GLOBAL VARIABLES` rows worth reading, and why each one is here.
/// Kept to a handful and filtered server-side: the unfiltered statement returns
/// ~600 rows.
const VARIABLES: &[&str] = &[
    // The denominator of the connection-pressure tile.
    "max_connections",
    // Whether the Consultas view will have anything to show. Read here, on the
    // cheap statement everybody runs, so the panel can warn about it long
    // before the user opens that view and finds it empty.
    "performance_schema",
    "version",
];

/// Parse the two `Variable_name`/`Value` result sets into a snapshot.
///
/// Pure, so the mapping table above is testable without a server — which
/// matters more than usual here, because a wrong mapping does not fail, it
/// silently plots the wrong counter.
pub fn build_health(
    status: &HashMap<String, String>,
    variables: &HashMap<String, String>,
    sampled_at_ms: u64,
) -> PulseHealth {
    let mut metrics: Vec<MetricSample> = STATUS_METRICS
        .iter()
        .filter_map(|(raw, canonical)| {
            let value = status.get(*raw)?.trim().parse::<f64>().ok()?;
            MetricSample::new(canonical, value)
        })
        .collect();

    if let Some(max) = variables
        .get("max_connections")
        .and_then(|v| v.trim().parse::<f64>().ok())
    {
        metrics.extend(MetricSample::new("connections_max", max));
    }

    let mut notes = Vec::new();
    // `performance_schema` is a boolean variable MySQL renders as ON/OFF.
    // Absent means an ancient server that never had it, which for our purposes
    // is the same answer.
    let perf_on = variables
        .get("performance_schema")
        .is_some_and(|v| v.eq_ignore_ascii_case("on"));
    if !perf_on {
        notes.push(PulseNote::warning("performanceSchemaOff"));
    }

    PulseHealth {
        driver: "mysql",
        // `VERSION()` and the `version` variable agree, and reading the
        // variable saves a round trip. The distro suffix is dropped for the
        // same reason `schema::server_version` drops it: nobody needs
        // `-0ubuntu0.22.04.1` in a header.
        server_version: variables
            .get("version")
            .map(|v| v.split('-').next().unwrap_or(v).to_string())
            .unwrap_or_default(),
        uptime_secs: status
            .get("Uptime")
            .and_then(|v| v.trim().parse::<u64>().ok()),
        sampled_at_ms,
        metrics,
        notes,
    }
}

/// Read the server's vital signs.
///
/// Two round trips, and that is deliberate: the variables are a separate,
/// almost-static read that the 60-second history sampler will skip entirely —
/// it only needs `SHOW GLOBAL STATUS`. Keeping them in separate statements is
/// what makes that possible later without restructuring this.
pub async fn health(pool: &MySqlPool) -> AppResult<PulseHealth> {
    let status = name_value_rows(pool, "SHOW GLOBAL STATUS").await?;

    let list = VARIABLES
        .iter()
        .map(|v| format!("'{v}'"))
        .collect::<Vec<_>>()
        .join(", ");
    // The names are compile-time constants from `VARIABLES`, never user input,
    // so the interpolation cannot carry anything a bind parameter would have
    // protected against — and `SHOW` does not accept bind parameters anyway.
    let variables = name_value_rows(
        pool,
        &format!("SHOW GLOBAL VARIABLES WHERE Variable_name IN ({list})"),
    )
    .await?;

    Ok(build_health(
        &status,
        &variables,
        crate::state::now_millis(),
    ))
}

/// Collect a `Variable_name` / `Value` result set into a map.
///
/// Both columns are read as `String` first and as raw bytes only if that
/// fails. sqlx runs a type-compatibility gate before decoding, and MySQL
/// reports these columns' charset inconsistently across versions and
/// collations — the same protocol quirk behind gotcha #17. Unlike that case
/// the fallback loses nothing: these values are always ASCII, so whichever
/// path decodes them yields identical text.
async fn name_value_rows(pool: &MySqlPool, sql: &str) -> AppResult<HashMap<String, String>> {
    let rows = sqlx::query(sql).fetch_all(pool).await?;
    let mut out = HashMap::with_capacity(rows.len());
    for row in rows {
        let (Some(name), Some(value)) = (text_at(&row, 0), text_at(&row, 1)) else {
            continue;
        };
        out.insert(name, value);
    }
    Ok(out)
}

fn text_at(row: &sqlx::mysql::MySqlRow, idx: usize) -> Option<String> {
    if let Ok(s) = row.try_get::<String, _>(idx) {
        return Some(s);
    }
    row.try_get::<Vec<u8>, _>(idx)
        .ok()
        .map(|b| String::from_utf8_lossy(&b).into_owned())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::pulse::MetricKind;

    fn map(pairs: &[(&str, &str)]) -> HashMap<String, String> {
        pairs
            .iter()
            .map(|(k, v)| (k.to_string(), v.to_string()))
            .collect()
    }

    fn value_of(h: &PulseHealth, name: &str) -> Option<f64> {
        h.metrics.iter().find(|m| m.name == name).map(|m| m.value)
    }

    #[test]
    fn maps_status_rows_onto_canonical_names() {
        let h = build_health(
            &map(&[
                ("Questions", "1284"),
                ("Com_select", "900"),
                ("Threads_connected", "87"),
                ("Innodb_buffer_pool_reads", "12"),
                ("Uptime", "3541"),
            ]),
            &map(&[("max_connections", "300")]),
            1_700_000_000_000,
        );

        assert_eq!(value_of(&h, "queries"), Some(1284.0));
        assert_eq!(value_of(&h, "select_ops"), Some(900.0));
        assert_eq!(value_of(&h, "connections_active"), Some(87.0));
        assert_eq!(value_of(&h, "cache_reads"), Some(12.0));
        assert_eq!(value_of(&h, "connections_max"), Some(300.0));
        assert_eq!(h.uptime_secs, Some(3541));
        assert_eq!(h.driver, "mysql");
    }

    #[test]
    fn omits_a_metric_the_server_did_not_report() {
        // A missing counter must be absent, not zero: zero is a reading, and
        // charting one the server never gave us is a lie the user cannot spot.
        let h = build_health(&map(&[("Questions", "10")]), &map(&[]), 0);
        assert_eq!(value_of(&h, "queries"), Some(10.0));
        assert_eq!(value_of(&h, "slow_queries"), None);
        assert_eq!(value_of(&h, "connections_max"), None);
    }

    #[test]
    fn skips_a_row_whose_value_is_not_a_number() {
        // `SHOW GLOBAL STATUS` is not all numbers — `Rsa_public_key` is a PEM
        // blob, `Ssl_cipher_list` a comma list. None of those are mapped, but a
        // future mapping typo landing on one must drop the row, not panic.
        let h = build_health(&map(&[("Questions", "not a number")]), &map(&[]), 0);
        assert_eq!(value_of(&h, "queries"), None);
    }

    #[test]
    fn counters_and_gauges_keep_their_catalogue_kind() {
        let h = build_health(
            &map(&[("Questions", "1"), ("Threads_connected", "2")]),
            &map(&[]),
            0,
        );
        let kind = |n: &str| h.metrics.iter().find(|m| m.name == n).map(|m| m.kind);
        assert_eq!(kind("queries"), Some(MetricKind::Counter));
        assert_eq!(kind("connections_active"), Some(MetricKind::Gauge));
    }

    #[test]
    fn warns_when_performance_schema_is_off() {
        let off = build_health(&map(&[]), &map(&[("performance_schema", "OFF")]), 0);
        assert_eq!(off.notes.len(), 1);
        assert_eq!(off.notes[0].code, "performanceSchemaOff");

        let on = build_health(&map(&[]), &map(&[("performance_schema", "ON")]), 0);
        assert!(on.notes.is_empty());

        // Absent reads as off — an ancient server without the schema at all
        // leaves the Consultas view just as empty as one that disabled it.
        let missing = build_health(&map(&[]), &map(&[]), 0);
        assert_eq!(missing.notes.len(), 1);
    }

    #[test]
    fn strips_the_distro_suffix_from_the_version() {
        let h = build_health(
            &map(&[]),
            &map(&[("version", "8.0.36-0ubuntu0.22.04.1")]),
            0,
        );
        assert_eq!(h.server_version, "8.0.36");
    }
}
