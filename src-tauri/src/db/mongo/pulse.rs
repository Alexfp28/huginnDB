//! MongoDB vital signs for Pulse. See [`crate::pulse`] for the contract these
//! readings are normalised into.

use mongodb::bson::{doc, Bson, Document};

use crate::error::AppResult;
use crate::pulse::{MetricSample, PulseHealth, PulseNote, StorageItem};
use crate::state::MongoConn;

/// Read a nested numeric field by path, coercing whatever BSON number the
/// server chose.
///
/// `serverStatus` is not consistent about width: the same counter comes back as
/// `Int32` on a quiet server and `Int64` once it grows, and WiredTiger's own
/// block reports `Double` for several. A typed `get_i64` therefore silently
/// misses readings on exactly the servers worth measuring, which is the kind of
/// bug that looks like "that metric is not supported here".
fn num(doc: &Document, path: &[&str]) -> Option<f64> {
    let (last, parents) = path.split_last()?;
    let mut current = doc;
    for key in parents {
        current = current.get_document(key).ok()?;
    }
    match current.get(*last)? {
        Bson::Int32(v) => Some(*v as f64),
        Bson::Int64(v) => Some(*v as f64),
        Bson::Double(v) => Some(*v),
        _ => None,
    }
}

/// Sum of every `opcounters` entry — the closest MongoDB has to "statements
/// this server answered".
///
/// Summed rather than reading one field because there is no single counter:
/// `query` alone would omit every `getmore` a cursor-heavy workload is made of,
/// and `command` alone would omit the CRUD. Absent entries contribute nothing,
/// so an older server missing one still reports a usable total.
fn opcounter_total(status: &Document) -> Option<f64> {
    let ops = status.get_document("opcounters").ok()?;
    let total: f64 = ["query", "insert", "update", "delete", "getmore", "command"]
        .iter()
        .filter_map(|k| num(ops, &[k]))
        .sum();
    Some(total)
}

/// Build a snapshot from a `serverStatus` reply.
///
/// Pure, so the whole mapping is testable against a captured reply — which
/// matters here more than for MySQL, because a wrong path in a nested document
/// does not fail, it just makes the metric quietly absent.
pub fn build_health(status: &Document, profiling_level: Option<i32>) -> PulseHealth {
    let mut metrics = Vec::new();
    let mut push = |name: &str, value: Option<f64>| {
        if let Some(v) = value {
            metrics.extend(MetricSample::new(name, v));
        }
    };

    push("queries", opcounter_total(status));
    push("select_ops", num(status, &["opcounters", "query"]));
    push("insert_ops", num(status, &["opcounters", "insert"]));
    push("update_ops", num(status, &["opcounters", "update"]));
    push("delete_ops", num(status, &["opcounters", "delete"]));

    let current = num(status, &["connections", "current"]);
    push("connections_active", current);
    // MongoDB reports headroom, not a ceiling, so the ceiling is the sum.
    // Reporting `available` as the max would make a busy server look idle.
    if let (Some(cur), Some(avail)) = (current, num(status, &["connections", "available"])) {
        push("connections_max", Some(cur + avail));
    }

    // The nearest thing to MySQL's `Threads_running`: clients holding or
    // waiting on the global lock right now. Not identical — it counts internal
    // clients too — but it moves for the same reason and is the only
    // instantaneous concurrency figure `serverStatus` offers.
    push(
        "connections_running",
        num(status, &["globalLock", "activeClients", "total"]),
    );

    // WiredTiger's cache accounting mirrors a buffer pool's: requests against
    // the cache, and the subset that had to be read in from disk. Same shape as
    // the MySQL pair, so the hit ratio is derived identically downstream.
    push(
        "cache_read_requests",
        num(
            status,
            &["wiredTiger", "cache", "pages requested from the cache"],
        ),
    );
    push(
        "cache_reads",
        num(status, &["wiredTiger", "cache", "pages read into cache"]),
    );

    push("bytes_sent", num(status, &["network", "bytesOut"]));
    push("bytes_received", num(status, &["network", "bytesIn"]));

    let mut notes = Vec::new();
    // Level 0 is off. `None` means the level could not be read at all (a role
    // without the privilege), which is not the same claim — stay quiet rather
    // than telling the user to switch on something that may already be on.
    if profiling_level == Some(0) {
        notes.push(PulseNote::warning("profilerOff"));
    }

    PulseHealth {
        driver: "mongodb",
        server_version: status
            .get_str("version")
            .unwrap_or_default()
            .split('-')
            .next()
            .unwrap_or_default()
            .to_string(),
        uptime_secs: num(status, &["uptime"]).map(|v| v.max(0.0) as u64),
        sampled_at_ms: crate::state::now_millis(),
        metrics,
        notes,
    }
}

/// Read the server's vital signs.
///
/// `serverStatus` is an `admin` command and is one round trip. The profiling
/// level is a second, best-effort one: a role without it simply leaves the
/// note unraised, and the sampler will skip this call entirely the same way
/// MySQL's variables read is skipped.
pub async fn health(conn: &MongoConn) -> AppResult<PulseHealth> {
    let admin = conn.client.database("admin");
    let status = admin.run_command(doc! {"serverStatus": 1}).await?;

    // Profiling is per database, so it is read against the connection's own
    // target rather than `admin`; a cluster-level connection with no database
    // selected has nothing to ask about and skips it.
    let level = match crate::db::mongo::schema::resolve_db(conn) {
        Ok(db) => db
            .run_command(doc! {"profile": -1})
            .await
            .ok()
            .and_then(|d| d.get_i32("was").ok()),
        Err(_) => None,
    };

    Ok(build_health(&status, level))
}

/// Per-collection footprint from one `$collStats` aggregation.
///
/// One round trip for every collection at once, the same call
/// [`crate::db::mongo::schema`] already makes for the explorer's sizes — the
/// N+1 of a `collStats` per collection is what that avoided and this must not
/// reintroduce. Views have no storage stats and drop out on their own.
///
/// `freeStorageSize` lands in `free_bytes`, which lines up exactly with what
/// MySQL's `Data_free` means: allocated but unused, and reclaimable by a
/// rebuild. Servers before 4.4 do not report it and simply read as zero.
pub async fn storage(conn: &MongoConn, limit: usize) -> AppResult<Vec<StorageItem>> {
    let db = crate::db::mongo::schema::resolve_db(conn)?;
    let db_name = db.name().to_string();
    let prefix = format!("{db_name}.");

    let mut cursor = db
        .aggregate(vec![doc! {"$collStats": {"storageStats": {}}}])
        .await?;

    let mut items: Vec<StorageItem> = Vec::new();
    while matches!(cursor.advance().await, Ok(true)) {
        let Ok(stat) = cursor.deserialize_current() else {
            continue;
        };
        let Some(name) = stat
            .get_str("ns")
            .ok()
            .and_then(|ns| ns.strip_prefix(&prefix))
        else {
            continue;
        };
        let Ok(s) = stat.get_document("storageStats") else {
            continue;
        };
        let take = |key: &str| num(s, &[key]).unwrap_or(0.0).max(0.0) as u64;
        items.push(StorageItem {
            name: name.to_string(),
            schema: Some(db_name.clone()),
            data_bytes: take("storageSize"),
            index_bytes: take("totalIndexSize"),
            free_bytes: take("freeStorageSize"),
        });
    }

    items.sort_unstable_by_key(|i| std::cmp::Reverse(i.total()));
    items.truncate(limit);
    Ok(items)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn value_of(h: &PulseHealth, name: &str) -> Option<f64> {
        h.metrics.iter().find(|m| m.name == name).map(|m| m.value)
    }

    fn status() -> Document {
        doc! {
            "version": "7.0.9",
            "uptime": 1_036_800.0,
            "opcounters": {
                "query": 500_i64, "insert": 120_i32, "update": 90_i64,
                "delete": 30_i64, "getmore": 180_i64, "command": 20_i64,
            },
            "connections": { "current": 214_i32, "available": 286_i32 },
            "globalLock": { "activeClients": { "total": 7_i32 } },
            "wiredTiger": { "cache": {
                "pages requested from the cache": 1_000_000_i64,
                "pages read into cache": 4_200_i64,
            }},
            "network": { "bytesIn": 9_000_i64, "bytesOut": 12_000.0 },
        }
    }

    #[test]
    fn maps_server_status_onto_canonical_names() {
        let h = build_health(&status(), Some(1));
        assert_eq!(h.driver, "mongodb");
        assert_eq!(h.server_version, "7.0.9");
        assert_eq!(h.uptime_secs, Some(1_036_800));
        assert_eq!(value_of(&h, "select_ops"), Some(500.0));
        assert_eq!(value_of(&h, "connections_active"), Some(214.0));
        assert_eq!(value_of(&h, "connections_running"), Some(7.0));
        assert_eq!(value_of(&h, "cache_reads"), Some(4_200.0));
    }

    #[test]
    fn totals_every_opcounter_rather_than_reading_one() {
        // 500 + 120 + 90 + 30 + 180 + 20. Reading `query` alone would omit the
        // getmores a cursor-heavy workload is mostly made of.
        assert_eq!(
            value_of(&build_health(&status(), None), "queries"),
            Some(940.0)
        );
    }

    #[test]
    fn reports_the_ceiling_not_the_headroom() {
        // 214 in use + 286 free = 500. Reporting `available` would make a
        // server at 43 % look almost idle.
        assert_eq!(
            value_of(&build_health(&status(), None), "connections_max"),
            Some(500.0),
        );
    }

    #[test]
    fn accepts_whichever_bson_number_width_the_server_chose() {
        // Int32, Int64 and Double all appear in a real reply, sometimes for the
        // same field on different servers.
        let h = build_health(&status(), None);
        assert_eq!(value_of(&h, "insert_ops"), Some(120.0)); // Int32
        assert_eq!(value_of(&h, "update_ops"), Some(90.0)); // Int64
        assert_eq!(value_of(&h, "bytes_sent"), Some(12_000.0)); // Double
    }

    #[test]
    fn omits_a_metric_the_reply_does_not_carry() {
        let h = build_health(&doc! {"version": "7.0.9"}, None);
        assert_eq!(value_of(&h, "connections_active"), None);
        assert_eq!(value_of(&h, "cache_reads"), None);
        // MongoDB has no equivalent of these at all, so they are absent rather
        // than zero — a zero would render as a healthy reading.
        assert_eq!(value_of(&h, "slow_queries"), None);
        assert_eq!(value_of(&h, "tmp_disk_tables"), None);
    }

    #[test]
    fn warns_only_when_the_profiler_is_known_to_be_off() {
        assert_eq!(build_health(&status(), Some(0)).notes.len(), 1);
        assert_eq!(
            build_health(&status(), Some(0)).notes[0].code,
            "profilerOff"
        );
        assert!(build_health(&status(), Some(1)).notes.is_empty());
        // Unreadable level: stay quiet rather than telling someone to switch on
        // something that may already be on.
        assert!(build_health(&status(), None).notes.is_empty());
    }
}
