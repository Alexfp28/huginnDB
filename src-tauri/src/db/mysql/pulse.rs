//! MySQL vital signs for Pulse. See [`crate::pulse`] for the contract these
//! readings are normalised into.

use std::collections::HashMap;

use sqlx::{MySqlPool, Row};

use crate::error::AppResult;
use crate::pulse::{
    truncate, ExplainPlan, IndexUsage, MetricSample, PulseHealth, PulseNote, SessionRow,
    StorageItem, TopQuery,
};

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

/// `STATUS_METRICS`, applied. Split out of [`build_health`] so
/// [`sample`] — the sampler's one-round-trip read — can share the exact same
/// mapping without also pulling in `SHOW GLOBAL VARIABLES`.
fn map_status(status: &HashMap<String, String>) -> Vec<MetricSample> {
    STATUS_METRICS
        .iter()
        .filter_map(|(raw, canonical)| {
            let value = status.get(*raw)?.trim().parse::<f64>().ok()?;
            MetricSample::new(canonical, value)
        })
        .collect()
}

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
    let mut metrics = map_status(status);

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

/// The one-round-trip read `pulse::sampler` ticks every 60s: `SHOW GLOBAL
/// STATUS` only, no `SHOW GLOBAL VARIABLES` — this is exactly the read
/// [`health`]'s own doc comment says the sampler would skip. That drops
/// `connections_max` (it lives in `max_connections`, a variable) from the
/// stored history; the live panel still has it, since it calls [`health`],
/// not this.
pub async fn sample(pool: &MySqlPool) -> AppResult<Vec<MetricSample>> {
    let status = name_value_rows(pool, "SHOW GLOBAL STATUS").await?;
    Ok(map_status(&status))
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

/// Statements the server has spent the most time on.
///
/// Reads `performance_schema`, so it fails outright when that is off — the
/// caller surfaces the note [`build_health`] already raised instead of an
/// error, since "switched off" is a state the user can act on and a stack trace
/// is not. Server-side schemas are excluded: the connector's own catalog reads
/// and the server's internal statements are not what anyone came here to see.
pub async fn top_queries(pool: &MySqlPool, limit: u32) -> AppResult<Vec<TopQuery>> {
    // `SUM_TIMER_WAIT` and friends are picoseconds. Divided in Rust rather
    // than in SQL so the raw counters stay legible in the query itself.
    // `QUERY_SAMPLE_TEXT` exists since 5.7.7 and is a literal, runnable
    // example of the digest — unlike `DIGEST_TEXT`, which is normalised to
    // `?` placeholders and cannot be handed to `EXPLAIN`.
    let rows = sqlx::query(
        "SELECT SCHEMA_NAME, DIGEST_TEXT, QUERY_SAMPLE_TEXT, COUNT_STAR, SUM_TIMER_WAIT, \
                MAX_TIMER_WAIT, SUM_ROWS_EXAMINED, SUM_ROWS_SENT, SUM_NO_INDEX_USED \
         FROM performance_schema.events_statements_summary_by_digest \
         WHERE DIGEST_TEXT IS NOT NULL AND COUNT_STAR > 0 \
           AND (SCHEMA_NAME IS NULL OR SCHEMA_NAME NOT IN \
                ('performance_schema', 'information_schema', 'mysql', 'sys')) \
         ORDER BY SUM_TIMER_WAIT DESC \
         LIMIT ?",
    )
    .bind(limit)
    .fetch_all(pool)
    .await?;

    Ok(rows
        .into_iter()
        .map(|r| {
            let count = num_at(&r, "COUNT_STAR").max(1);
            let total_ps = num_at(&r, "SUM_TIMER_WAIT") as f64;
            TopQuery {
                digest: truncate(&named_text(&r, "DIGEST_TEXT").unwrap_or_default()),
                schema: named_text(&r, "SCHEMA_NAME"),
                count,
                avg_ms: total_ps / count as f64 / 1e9,
                max_ms: num_at(&r, "MAX_TIMER_WAIT") as f64 / 1e9,
                rows_examined: num_at(&r, "SUM_ROWS_EXAMINED"),
                rows_sent: num_at(&r, "SUM_ROWS_SENT"),
                full_scans: num_at(&r, "SUM_NO_INDEX_USED"),
                sample: named_text(&r, "QUERY_SAMPLE_TEXT")
                    .map(|s| s.trim().to_string())
                    .filter(|s| !s.is_empty()),
            }
        })
        .collect())
}

/// Read the plan MySQL would use for one statement, without running it.
///
/// `sql` must already be validated read-only and single —
/// [`crate::commands::pulse::pulse_explain_inner`] is where that is enforced,
/// once, for both engines, rather than here where it would be easy to forget
/// on a second call site.
pub async fn explain(pool: &MySqlPool, sql: &str) -> AppResult<ExplainPlan> {
    let wrapped = format!("EXPLAIN FORMAT=JSON {sql}");
    let text: String = sqlx::query_scalar(&wrapped).fetch_one(pool).await?;
    let raw: serde_json::Value = serde_json::from_str(&text)?;
    Ok(ExplainPlan { raw })
}

/// The connection's biggest relations, largest first.
///
/// `SHOW TABLE STATUS` for the same reason the schema explorer uses it: it does
/// not wait on InnoDB metadata locks, which `information_schema.TABLES` can do
/// indefinitely on a busy server — precisely the server someone is looking at
/// Pulse about. Views report no size (their `Engine` is NULL) and are dropped.
///
/// Sorting and the limit happen here rather than in SQL because `SHOW` accepts
/// neither an `ORDER BY` nor a `LIMIT`. A schema with thousands of tables
/// therefore costs one full result set to rank, which is why this is an
/// on-demand read and not part of any sampling loop.
pub async fn storage(pool: &MySqlPool, limit: usize) -> AppResult<Vec<StorageItem>> {
    let db: Option<String> = sqlx::query_scalar("SELECT DATABASE()")
        .fetch_one(pool)
        .await?;
    // No default database on the connection: MySQL has nothing to enumerate,
    // the same empty answer `schema::list_tables` gives (issue #52).
    let Some(db) = db.filter(|d| !d.is_empty()) else {
        return Ok(vec![]);
    };

    let sql = format!(
        "SHOW TABLE STATUS FROM {}",
        crate::db::sql::Dialect::Mysql.quote_ident(&db)
    );
    let rows = sqlx::query(&sql).fetch_all(pool).await?;

    let mut items: Vec<StorageItem> = rows
        .into_iter()
        .filter(|r| {
            // Engine is NULL for a view, which has no footprint of its own.
            r.try_get::<Option<String>, _>("Engine")
                .ok()
                .flatten()
                .is_some()
        })
        .map(|r| StorageItem {
            name: r.try_get("Name").unwrap_or_default(),
            schema: Some(db.clone()),
            data_bytes: num_at(&r, "Data_length"),
            index_bytes: num_at(&r, "Index_length"),
            free_bytes: num_at(&r, "Data_free"),
        })
        .collect();

    items.sort_unstable_by_key(|i| std::cmp::Reverse(i.total()));
    items.truncate(limit);
    Ok(items)
}

/// Read an unsigned counter column whose width and signedness vary by server.
///
/// Same hazard `schema::list_tables` documents: `Row::get` panics on a type
/// mismatch and different MySQL versions and forks disagree about whether these
/// columns carry the UNSIGNED flag. A panic inside an async Tauri command never
/// rejects the IPC promise — it hangs it — so every read falls through
/// `u64 → i64 → 0` instead.
fn num_at(row: &sqlx::mysql::MySqlRow, col: &str) -> u64 {
    row.try_get::<u64, _>(col)
        .or_else(|_| row.try_get::<i64, _>(col).map(|v| v.unsigned_abs()))
        .or_else(|_| {
            row.try_get::<Option<u64>, _>(col)
                .map(|v| v.unwrap_or_default())
        })
        .unwrap_or(0)
}

/// [`text_at`] by column name, tolerating NULL.
fn named_text(row: &sqlx::mysql::MySqlRow, col: &str) -> Option<String> {
    if let Ok(s) = row.try_get::<Option<String>, _>(col) {
        return s;
    }
    row.try_get::<Option<Vec<u8>>, _>(col)
        .ok()
        .flatten()
        .map(|b| String::from_utf8_lossy(&b).into_owned())
}
/// Sessions the server currently holds open, from `SHOW FULL PROCESSLIST` —
/// the same statement any `mysql` client runs, and unlike
/// `information_schema.PROCESSLIST` never disabled by
/// `performance_schema_show_processlist`/`show_compatibility_56` on a server
/// that has otherwise moved past it.
pub async fn sessions(pool: &MySqlPool) -> AppResult<Vec<SessionRow>> {
    let rows = sqlx::query("SHOW FULL PROCESSLIST").fetch_all(pool).await?;
    let blockers = blocking_chain(pool).await;

    Ok(rows
        .iter()
        .map(|r| {
            let id = num_at(r, "Id").to_string();
            SessionRow {
                blocked_by: blockers.get(&id).cloned(),
                id,
                user: named_text(r, "User"),
                host: named_text(r, "Host"),
                db: named_text(r, "db"),
                command: named_text(r, "Command").unwrap_or_default(),
                state: named_text(r, "State"),
                duration_secs: num_at(r, "Time") as f64,
                query: named_text(r, "Info").map(|q| truncate(&q)),
            }
        })
        .collect())
}

/// Waiting `PROCESSLIST` id → blocking `PROCESSLIST` id, from
/// `performance_schema.data_lock_waits`.
///
/// Best-effort, like every other `performance_schema` read here: a role
/// without the privilege, or the schema switched off, leaves every session's
/// `blocked_by` unset rather than failing the whole sessions read — not
/// *naming* a lock wait is a smaller loss than the session list vanishing
/// because of it. A waiting thread stuck on several locks at once collapses
/// to its first blocker; spotting *a* blockage is this ranking's job, not
/// modelling the full wait graph.
async fn blocking_chain(pool: &MySqlPool) -> HashMap<String, String> {
    let Ok(rows) = sqlx::query(
        "SELECT wt.PROCESSLIST_ID AS waiting_pid, bt.PROCESSLIST_ID AS blocking_pid \
         FROM performance_schema.data_lock_waits dlw \
         JOIN performance_schema.threads wt ON wt.THREAD_ID = dlw.REQUESTING_THREAD_ID \
         JOIN performance_schema.threads bt ON bt.THREAD_ID = dlw.BLOCKING_THREAD_ID",
    )
    .fetch_all(pool)
    .await
    else {
        return HashMap::new();
    };

    let mut out = HashMap::new();
    for row in rows {
        let Some(waiting) = row.try_get::<Option<i64>, _>("waiting_pid").ok().flatten() else {
            continue;
        };
        let Some(blocking) = row.try_get::<Option<i64>, _>("blocking_pid").ok().flatten() else {
            continue;
        };
        out.entry(waiting.to_string())
            .or_insert_with(|| blocking.to_string());
    }
    out
}

/// Per-index usage since the counters were last reset, least-read first — from
/// `sys.schema_index_statistics`, a view over `performance_schema` installed
/// on every server since 5.7.7. One query covers every table in the
/// connection's current database in one round trip; MongoDB has no such
/// server-wide read and pays per collection instead (see
/// `crate::db::mongo::pulse::index_usage`'s doc comment).
///
/// Sorted ascending on purpose: the whole point of this view is spotting the
/// indexes nobody reads, so those belong at the top rather than requiring a
/// scroll past the busy ones to find them.
///
/// Per-index *size* is deliberately not read here: MySQL keeps it in
/// `mysql.innodb_index_stats`, a system table ordinary accounts frequently
/// cannot `SELECT` from, and failing this whole read over one optional column
/// would cost more than the column is worth. `size_bytes` stays `None`.
pub async fn index_usage(pool: &MySqlPool, limit: u32) -> AppResult<Vec<IndexUsage>> {
    let db: Option<String> = sqlx::query_scalar("SELECT DATABASE()")
        .fetch_one(pool)
        .await?;
    // No default database on the connection: nothing to rank, the same empty
    // answer `storage` gives (issue #52).
    let Some(db) = db.filter(|d| !d.is_empty()) else {
        return Ok(vec![]);
    };

    let rows = sqlx::query(
        "SELECT table_schema, table_name, index_name, rows_selected \
         FROM sys.schema_index_statistics \
         WHERE table_schema = ? \
         ORDER BY rows_selected ASC \
         LIMIT ?",
    )
    .bind(&db)
    .bind(limit)
    .fetch_all(pool)
    .await?;

    Ok(rows
        .into_iter()
        .map(|r| IndexUsage {
            schema: named_text(&r, "table_schema"),
            table: named_text(&r, "table_name").unwrap_or_default(),
            index_name: named_text(&r, "index_name").unwrap_or_default(),
            reads: r.try_get::<Option<u64>, _>("rows_selected").ok().flatten(),
            size_bytes: None,
        })
        .collect())
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

    #[test]
    fn storage_total_adds_free_space_in() {
        let item = StorageItem {
            name: "orders".into(),
            schema: Some("shop".into()),
            data_bytes: 100,
            index_bytes: 40,
            free_bytes: 10,
        };
        assert_eq!(item.total(), 150);
    }
}
