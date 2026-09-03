//! SQLite catalog introspection. See [`crate::db::postgres::schema`] for the
//! module's contract.

use sqlx::SqlitePool;

use crate::commands::schema::{ColumnInfo, IndexInfo, TableInfo};
use crate::commands::schema::{DatabaseInfo, DatabaseSize};
use crate::db::sql::Dialect;
use crate::error::AppResult;
use sqlx::Row;

/// The single database a SQLite connection has.
///
/// A SQLite connection *is* one file, so there is nothing to query: the tree
/// still wants one node, and `main` is the name SQLite itself uses for the
/// primary schema (`PRAGMA database_list`). Kept as a function rather than a
/// constant at the call site so the dispatch in `commands::schema` reads the
/// same for all five drivers.
pub fn list_databases() -> Vec<DatabaseInfo> {
    vec![DatabaseInfo {
        name: "main".to_string(),
    }]
}

/// Bytes occupied by `pages` pages of `page_size` bytes each.
///
/// Pure and `checked_mul`-guarded so a nonsensical pragma pair (a negative
/// page count from a corrupt header, or a product past `u64`) yields `None` —
/// "the engine would not say" — rather than a wrapped number presented as a
/// size. Split out from [`database_sizes`] because it is the only part of that
/// function a test can reach without a database.
pub(crate) fn pages_to_bytes(pages: i64, page_size: i64) -> Option<u64> {
    let pages = u64::try_from(pages).ok()?;
    let page_size = u64::try_from(page_size).ok()?;
    pages.checked_mul(page_size)
}

/// Size of the SQLite file behind this connection.
///
/// `page_count * page_size` is the number the OS file browser shows, which
/// makes it the most directly meaningful of the five drivers' answers. It
/// includes pages on the freelist (space the file holds but no longer uses)
/// and excludes the `-wal` and `-shm` sidecars, which can be substantial
/// between checkpoints.
///
/// Separate from [`list_databases`], which is sync and needs no pool, because
/// this one is neither — two functions rather than one contorted signature.
pub async fn database_sizes(pool: &SqlitePool) -> AppResult<Vec<DatabaseSize>> {
    let pages: i64 = sqlx::query_scalar("PRAGMA page_count")
        .fetch_one(pool)
        .await?;
    let page_size: i64 = sqlx::query_scalar("PRAGMA page_size")
        .fetch_one(pool)
        .await?;
    Ok(vec![DatabaseSize {
        name: "main".to_string(),
        size_bytes: pages_to_bytes(pages, page_size),
    }])
}

/// Engine and version, as `sqlite <version>`.
pub async fn server_version(pool: &SqlitePool) -> AppResult<String> {
    let raw: String = sqlx::query_scalar("SELECT sqlite_version()")
        .fetch_one(pool)
        .await?;
    Ok(format!("sqlite {raw}"))
}

/// Tables and views from `sqlite_master`.
pub async fn list_tables(p: &sqlx::SqlitePool) -> AppResult<Vec<TableInfo>> {
    Ok({
        let rows = sqlx::query(
            "SELECT name, type FROM sqlite_master \
             WHERE type IN ('table', 'view') \
             AND name NOT LIKE 'sqlite_%' \
             ORDER BY name",
        )
        .fetch_all(p)
        .await?;
        // Per-table size comes from the optional `dbstat` virtual table.
        // It is a compile-time feature of SQLite and may be absent on some
        // builds; the first probe failure flips `dbstat_available` to false
        // so we don't spam errors for every remaining table.
        let mut dbstat_available = true;
        let mut out = Vec::with_capacity(rows.len());
        for r in rows {
            let name: String = r.get("name");
            let kind: String = r.get("type");
            let size_bytes = if dbstat_available && kind == "table" {
                match sqlx::query_scalar::<_, Option<i64>>(
                    "SELECT SUM(pgsize) FROM dbstat WHERE name = ?",
                )
                .bind(&name)
                .fetch_one(p)
                .await
                {
                    Ok(v) => v.map(|n| n.unsigned_abs()),
                    Err(_) => {
                        dbstat_available = false;
                        None
                    }
                }
            } else {
                None
            };
            out.push(TableInfo {
                schema: "main".into(),
                name,
                kind,
                // SQLite has no statistics catalog with per-table row counts.
                // sqlite_stat1 only exists after ANALYZE and is unreliable for
                // fresh databases. N individual COUNT(*) queries would block the
                // UI on large schemas.
                row_count: None,
                size_bytes,
            });
        }
        out
    })
}

/// A table's columns, from `PRAGMA table_info` plus `PRAGMA foreign_key_list`.
///
/// `_schema` is accepted and ignored: SQLite has no schema layer (the file is
/// the database), but taking it keeps the dispatch in `commands::schema`
/// identical across all five drivers.
pub async fn list_columns(
    p: &sqlx::SqlitePool,
    _schema: Option<String>,
    table: String,
) -> AppResult<Vec<ColumnInfo>> {
    Ok({
        // PRAGMA does not accept bound parameters; identifiers are
        // quoted defensively even though they come from a trusted
        // catalog lookup.
        let q = format!("PRAGMA table_info({})", Dialect::Sqlite.quote_ident(&table));
        let rows = sqlx::query(&q).fetch_all(p).await?;
        // foreign_key_list yields one row per column of each constraint.
        // Group by `id` to filter composite FKs.
        let fk_q = format!(
            "PRAGMA foreign_key_list({})",
            Dialect::Sqlite.quote_ident(&table)
        );
        let fk_rows = sqlx::query(&fk_q).fetch_all(p).await?;
        use std::collections::HashMap;
        // (id) -> Vec<(from, target_table, target_col_opt)>
        let mut groups: HashMap<i64, Vec<(String, String, Option<String>)>> = HashMap::new();
        for r in fk_rows {
            let id: i64 = r.get("id");
            let from: String = r.get("from");
            let target_table: String = r.get("table");
            let to: Option<String> = r.try_get("to").ok().flatten();
            groups.entry(id).or_default().push((from, target_table, to));
        }
        let mut fk_map: HashMap<String, (String, Option<String>)> = HashMap::new();
        for parts in groups.into_values() {
            if parts.len() == 1 {
                let (from, target_table, to) = parts.into_iter().next().unwrap();
                fk_map.insert(from, (target_table, to));
            }
        }
        // Resolve any FK with NULL `to` (implicit PK) by inspecting the
        // target table once each.
        use std::collections::HashSet;
        let needs_pk_resolution: HashSet<String> = fk_map
            .values()
            .filter(|(_, to)| to.is_none())
            .map(|(t, _)| t.clone())
            .collect();
        let mut pk_cache: HashMap<String, Option<String>> = HashMap::new();
        for target in needs_pk_resolution {
            let q2 = format!(
                "PRAGMA table_info({})",
                Dialect::Sqlite.quote_ident(&target)
            );
            let pk = match sqlx::query(&q2).fetch_all(p).await {
                Ok(target_rows) => target_rows
                    .into_iter()
                    .find(|r| r.get::<i64, _>("pk") > 0)
                    .map(|r| r.get::<String, _>("name")),
                Err(_) => None,
            };
            pk_cache.insert(target, pk);
        }
        rows.into_iter()
            .map(|r| {
                let name: String = r.get("name");
                let (ref_table, ref_column) = match fk_map.get(&name) {
                    Some((t, Some(c))) => (Some(t.clone()), Some(c.clone())),
                    Some((t, None)) => (Some(t.clone()), pk_cache.get(t).cloned().unwrap_or(None)),
                    None => (None, None),
                };
                ColumnInfo {
                    name,
                    data_type: r.get::<String, _>("type"),
                    nullable: r.get::<i64, _>("notnull") == 0,
                    is_primary_key: r.get::<i64, _>("pk") > 0,
                    referenced_schema: None,
                    referenced_table: ref_table,
                    referenced_column: ref_column,
                }
            })
            .collect()
    })
}

/// A table's indexes, from `PRAGMA index_list` + `PRAGMA index_info`.
///
/// `_schema` is accepted and ignored — see [`list_columns`].
pub async fn list_indexes(
    p: &sqlx::SqlitePool,
    _schema: Option<String>,
    table: String,
) -> AppResult<Vec<IndexInfo>> {
    Ok({
        let q = format!("PRAGMA index_list({})", Dialect::Sqlite.quote_ident(&table));
        let rows = sqlx::query(&q).fetch_all(p).await?;
        let mut out = Vec::new();
        for r in rows {
            let name: String = r.get("name");
            let unique: i64 = r.get("unique");
            let q2 = format!("PRAGMA index_info({})", Dialect::Sqlite.quote_ident(&name));
            let cols_rows = sqlx::query(&q2).fetch_all(p).await?;
            let cols: Vec<String> = cols_rows.into_iter().map(|c| c.get("name")).collect();
            out.push(IndexInfo {
                name,
                columns: cols,
                unique: unique != 0,
            });
        }
        out
    })
}

// ---------------------------------------------------------------------------
// Views
// ---------------------------------------------------------------------------

/// The body of a view — just the `SELECT`. See
/// [`crate::db::postgres::schema::view_definition`] for why a missing view is
/// `Ok(None)` rather than an error.
///
/// `sqlite_master.sql` holds the *whole* `CREATE VIEW ... AS ...` statement, so
/// the header is stripped by [`crate::db::view_ddl::strip_view_header`] to keep
/// the returned body meaning the same thing it does on the other drivers.
/// `_schema` is accepted and ignored: SQLite has exactly one schema (`main`).
pub async fn view_definition(
    p: &sqlx::SqlitePool,
    _schema: Option<&str>,
    view: &str,
) -> AppResult<Option<String>> {
    let create_sql: Option<Option<String>> =
        sqlx::query_scalar("SELECT sql FROM sqlite_master WHERE type = 'view' AND name = ?")
            .bind(view)
            .fetch_optional(p)
            .await?;
    Ok(create_sql
        .flatten()
        .map(|sql| crate::db::view_ddl::strip_view_header(&sql)))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pages_to_bytes_multiplies_the_pragma_pair() {
        // SQLite's own default page size, and the number the OS file browser
        // shows for such a file.
        assert_eq!(pages_to_bytes(2_560, 4_096), Some(10_485_760));
        assert_eq!(pages_to_bytes(0, 4_096), Some(0));
    }

    #[test]
    fn pages_to_bytes_refuses_nonsense_rather_than_wrapping() {
        // A corrupt header can hand back a negative page count, and a wrapped
        // product presented as a size is worse than no badge at all — the
        // best-effort contract says `None` means "would not say", and a
        // silently truncated number cannot say that.
        assert_eq!(pages_to_bytes(-1, 4_096), None);
        assert_eq!(pages_to_bytes(4_096, -1), None);
        assert_eq!(pages_to_bytes(i64::MAX, i64::MAX), None);
    }
}
