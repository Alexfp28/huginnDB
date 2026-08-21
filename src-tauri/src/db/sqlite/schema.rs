//! SQLite catalog introspection. See [`crate::db::postgres::schema`] for the
//! module's contract.

use sqlx::SqlitePool;

use crate::commands::schema::DatabaseInfo;
use crate::commands::schema::{ColumnInfo, IndexInfo, TableInfo};
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
