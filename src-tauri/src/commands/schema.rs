//! Schema introspection commands (databases, tables, columns, indexes, server info).
//!
//! Every command takes a `connection_id` so it can resolve the right pool
//! from [`crate::state::AppState`]. Queries are written against the
//! standard `information_schema` views where available, with `pg_*` /
//! `sqlite_master` fallbacks for engine-specific metadata.

use crate::error::{AppError, AppResult};
use crate::state::{AppState, DbPool};
use serde::Serialize;
use sqlx::Row;
use tauri::State;

/// One row in the database/catalog list.
#[derive(Debug, Serialize)]
pub struct DatabaseInfo {
    pub name: String,
}

/// One row in the table/view list.
#[derive(Debug, Serialize)]
pub struct TableInfo {
    pub schema: String,
    pub name: String,
    /// "table" or "view".
    pub kind: String,
    /// Approximate row count sourced from the engine's statistics catalog.
    ///
    /// - **Postgres** — `pg_stat_user_tables.n_live_tup` (updated by autovacuum; may be 0
    ///   for brand-new tables or views).
    /// - **MySQL** — `information_schema.TABLES.TABLE_ROWS` (engine-maintained estimate;
    ///   can differ significantly from `COUNT(*)` on InnoDB).
    /// - **SQLite** — always `None`. Reliable per-table counts require individual
    ///   `COUNT(*)` queries, which become prohibitively expensive on schemas with
    ///   many tables. Use `SELECT COUNT(*) FROM table` manually when an exact count
    ///   is needed.
    #[serde(rename = "row_count")]
    pub row_count: Option<u64>,
}

/// Column metadata as displayed in the schema explorer.
#[derive(Debug, Serialize)]
pub struct ColumnInfo {
    pub name: String,
    pub data_type: String,
    pub nullable: bool,
    pub is_primary_key: bool,
}

/// Index summary including the participating columns.
#[derive(Debug, Serialize)]
pub struct IndexInfo {
    pub name: String,
    pub columns: Vec<String>,
    pub unique: bool,
}

/// Resolve the active pool for `id`, or fail with [`AppError::NotConnected`].
fn pool_for(state: &AppState, id: &str) -> AppResult<DbPool> {
    state
        .connections
        .read()
        .get(id)
        .ok_or_else(|| AppError::NotConnected(id.to_string()))
}

/// List visible databases / schemas / catalogs for the connection.
#[tauri::command]
pub async fn list_databases(
    state: State<'_, AppState>,
    connection_id: String,
) -> AppResult<Vec<DatabaseInfo>> {
    let pool = pool_for(state.inner(), &connection_id)?;
    let names: Vec<String> = match pool {
        DbPool::Postgres(p) => {
            sqlx::query_scalar(
                "SELECT datname FROM pg_database \
                 WHERE datistemplate = false \
                 ORDER BY datname",
            )
            .fetch_all(&p)
            .await?
        }
        DbPool::Mysql(p) => {
            sqlx::query_scalar(
                "SELECT schema_name FROM information_schema.schemata \
                 WHERE schema_name NOT IN ('information_schema', 'performance_schema', \
                                           'mysql', 'sys') \
                 ORDER BY schema_name",
            )
            .fetch_all(&p)
            .await?
        }
        // SQLite is single-file; pretend the file is one schema named "main".
        DbPool::Sqlite(_) => vec!["main".to_string()],
    };
    Ok(names.into_iter().map(|n| DatabaseInfo { name: n }).collect())
}

/// List user-visible tables and views, with approximate row counts where available.
///
/// Row counts are sourced from engine statistics catalogs in a single query to
/// avoid N+1 round-trips. See [`TableInfo::row_count`] for per-driver details.
#[tauri::command]
pub async fn list_tables(
    state: State<'_, AppState>,
    connection_id: String,
    database: Option<String>,
) -> AppResult<Vec<TableInfo>> {
    let pool = pool_for(state.inner(), &connection_id)?;
    let tables = match pool {
        DbPool::Postgres(p) => {
            // LEFT JOIN against pg_stat_user_tables fetches approximate live-row counts
            // for tables in one round-trip. Views never have stat entries, so their
            // n_live_tup will be NULL (→ row_count: None).
            let rows = sqlx::query(
                "SELECT t.table_schema, t.table_name, t.table_type, s.n_live_tup \
                 FROM information_schema.tables t \
                 LEFT JOIN pg_stat_user_tables s \
                   ON s.schemaname = t.table_schema AND s.relname = t.table_name \
                 WHERE t.table_schema NOT IN ('pg_catalog', 'information_schema') \
                 ORDER BY t.table_schema, t.table_name",
            )
            .fetch_all(&p)
            .await?;
            rows.into_iter()
                .map(|r| TableInfo {
                    schema: r.get::<String, _>("table_schema"),
                    name: r.get::<String, _>("table_name"),
                    kind: if r.get::<String, _>("table_type") == "VIEW" {
                        "view".into()
                    } else {
                        "table".into()
                    },
                    row_count: r
                        .get::<Option<i64>, _>("n_live_tup")
                        .map(|v| v.unsigned_abs()),
                })
                .collect()
        }
        DbPool::Mysql(p) => {
            let db = database.unwrap_or_default();
            // TABLE_ROWS is an engine-maintained estimate stored in information_schema;
            // no extra queries needed.
            let rows = sqlx::query(
                "SELECT table_schema, table_name, table_type, table_rows \
                 FROM information_schema.tables \
                 WHERE table_schema = COALESCE(NULLIF(?, ''), DATABASE()) \
                 ORDER BY table_schema, table_name",
            )
            .bind(&db)
            .fetch_all(&p)
            .await?;
            rows.into_iter()
                .map(|r| TableInfo {
                    schema: r.get::<String, _>("table_schema"),
                    name: r.get::<String, _>("table_name"),
                    kind: if r
                        .get::<String, _>("table_type")
                        .to_uppercase()
                        .contains("VIEW")
                    {
                        "view".into()
                    } else {
                        "table".into()
                    },
                    row_count: r.get::<Option<u64>, _>("table_rows"),
                })
                .collect()
        }
        DbPool::Sqlite(p) => {
            let rows = sqlx::query(
                "SELECT name, type FROM sqlite_master \
                 WHERE type IN ('table', 'view') \
                 AND name NOT LIKE 'sqlite_%' \
                 ORDER BY name",
            )
            .fetch_all(&p)
            .await?;
            rows.into_iter()
                .map(|r| TableInfo {
                    schema: "main".into(),
                    name: r.get::<String, _>("name"),
                    kind: r.get::<String, _>("type"),
                    // SQLite has no statistics catalog with per-table row counts.
                    // sqlite_stat1 only exists after ANALYZE and is unreliable for
                    // fresh databases. N individual COUNT(*) queries would block the
                    // UI on large schemas.
                    row_count: None,
                })
                .collect()
        }
    };
    Ok(tables)
}

/// List columns for `schema.table` in catalog order.
///
/// The `is_primary_key` flag is determined by joining against
/// `information_schema.table_constraints` (Postgres), `column_key`
/// (MySQL), or the `pk` field of `PRAGMA table_info` (SQLite).
#[tauri::command]
pub async fn list_columns(
    state: State<'_, AppState>,
    connection_id: String,
    schema: Option<String>,
    table: String,
) -> AppResult<Vec<ColumnInfo>> {
    let pool = pool_for(state.inner(), &connection_id)?;
    let cols = match pool {
        DbPool::Postgres(p) => {
            let schema = schema.unwrap_or_else(|| "public".into());
            let rows = sqlx::query(
                "SELECT c.column_name, c.data_type, c.is_nullable, \
                        EXISTS ( \
                            SELECT 1 FROM information_schema.table_constraints tc \
                            JOIN information_schema.key_column_usage k \
                              ON tc.constraint_name = k.constraint_name \
                             AND tc.table_schema = k.table_schema \
                            WHERE tc.constraint_type = 'PRIMARY KEY' \
                              AND tc.table_schema = c.table_schema \
                              AND tc.table_name = c.table_name \
                              AND k.column_name = c.column_name \
                        ) AS is_pk \
                 FROM information_schema.columns c \
                 WHERE c.table_schema = $1 AND c.table_name = $2 \
                 ORDER BY c.ordinal_position",
            )
            .bind(&schema)
            .bind(&table)
            .fetch_all(&p)
            .await?;
            rows.into_iter()
                .map(|r| ColumnInfo {
                    name: r.get::<String, _>("column_name"),
                    data_type: r.get::<String, _>("data_type"),
                    nullable: r.get::<String, _>("is_nullable") == "YES",
                    is_primary_key: r.get::<bool, _>("is_pk"),
                })
                .collect()
        }
        DbPool::Mysql(p) => {
            let rows = sqlx::query(
                "SELECT column_name, column_type, is_nullable, column_key \
                 FROM information_schema.columns \
                 WHERE table_schema = COALESCE(NULLIF(?, ''), DATABASE()) \
                   AND table_name = ? \
                 ORDER BY ordinal_position",
            )
            .bind(schema.unwrap_or_default())
            .bind(&table)
            .fetch_all(&p)
            .await?;
            rows.into_iter()
                .map(|r| ColumnInfo {
                    name: r.get::<String, _>("column_name"),
                    data_type: r.get::<String, _>("column_type"),
                    nullable: r.get::<String, _>("is_nullable") == "YES",
                    is_primary_key: r.get::<String, _>("column_key") == "PRI",
                })
                .collect()
        }
        DbPool::Sqlite(p) => {
            // PRAGMA does not accept bound parameters; identifiers are
            // quoted defensively even though they come from a trusted
            // catalog lookup.
            let q = format!("PRAGMA table_info(\"{}\")", table.replace('"', "\"\""));
            let rows = sqlx::query(&q).fetch_all(&p).await?;
            rows.into_iter()
                .map(|r| ColumnInfo {
                    name: r.get::<String, _>("name"),
                    data_type: r.get::<String, _>("type"),
                    nullable: r.get::<i64, _>("notnull") == 0,
                    is_primary_key: r.get::<i64, _>("pk") > 0,
                })
                .collect()
        }
    };
    Ok(cols)
}

/// List indexes for `schema.table`, with the columns each one covers.
#[tauri::command]
pub async fn list_indexes(
    state: State<'_, AppState>,
    connection_id: String,
    schema: Option<String>,
    table: String,
) -> AppResult<Vec<IndexInfo>> {
    let pool = pool_for(state.inner(), &connection_id)?;
    let idx = match pool {
        DbPool::Postgres(p) => {
            let schema = schema.unwrap_or_else(|| "public".into());
            let rows = sqlx::query(
                "SELECT i.relname AS index_name, \
                        array_agg(a.attname ORDER BY x.ordinality) AS columns, \
                        ix.indisunique AS is_unique \
                 FROM pg_class t \
                 JOIN pg_namespace n ON n.oid = t.relnamespace \
                 JOIN pg_index ix ON ix.indrelid = t.oid \
                 JOIN pg_class i ON i.oid = ix.indexrelid \
                 JOIN unnest(ix.indkey) WITH ORDINALITY AS x(attnum, ordinality) ON true \
                 JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = x.attnum \
                 WHERE n.nspname = $1 AND t.relname = $2 \
                 GROUP BY i.relname, ix.indisunique",
            )
            .bind(&schema)
            .bind(&table)
            .fetch_all(&p)
            .await?;
            rows.into_iter()
                .map(|r| IndexInfo {
                    name: r.get::<String, _>("index_name"),
                    columns: r.get::<Vec<String>, _>("columns"),
                    unique: r.get::<bool, _>("is_unique"),
                })
                .collect()
        }
        DbPool::Mysql(p) => {
            let rows = sqlx::query(
                "SELECT index_name, column_name, non_unique \
                 FROM information_schema.statistics \
                 WHERE table_schema = COALESCE(NULLIF(?, ''), DATABASE()) \
                   AND table_name = ? \
                 ORDER BY index_name, seq_in_index",
            )
            .bind(schema.unwrap_or_default())
            .bind(&table)
            .fetch_all(&p)
            .await?;
            use std::collections::BTreeMap;
            let mut grouped: BTreeMap<String, (Vec<String>, bool)> = BTreeMap::new();
            for r in rows {
                let name: String = r.get("index_name");
                let col: String = r.get("column_name");
                let non_unique: i64 = r.get("non_unique");
                let entry = grouped
                    .entry(name)
                    .or_insert_with(|| (Vec::new(), non_unique == 0));
                entry.0.push(col);
            }
            grouped
                .into_iter()
                .map(|(name, (cols, unique))| IndexInfo {
                    name,
                    columns: cols,
                    unique,
                })
                .collect()
        }
        DbPool::Sqlite(p) => {
            let q = format!("PRAGMA index_list(\"{}\")", table.replace('"', "\"\""));
            let rows = sqlx::query(&q).fetch_all(&p).await?;
            let mut out = Vec::new();
            for r in rows {
                let name: String = r.get("name");
                let unique: i64 = r.get("unique");
                let q2 = format!("PRAGMA index_info(\"{}\")", name.replace('"', "\"\""));
                let cols_rows = sqlx::query(&q2).fetch_all(&p).await?;
                let cols: Vec<String> = cols_rows.into_iter().map(|c| c.get("name")).collect();
                out.push(IndexInfo {
                    name,
                    columns: cols,
                    unique: unique != 0,
                });
            }
            out
        }
    };
    Ok(idx)
}

/// Return a short version string for the connected server.
///
/// The string is formatted as `"{engine} {version}"` for easy display in
/// the status bar (e.g. `"sqlite 3.45.3"`, `"postgresql 16.2"`, `"mysql 8.0.35"`).
///
/// Drivers:
/// - **Postgres** — `SELECT version()`, first two tokens lowercased.
/// - **MySQL** — `SELECT VERSION()`, stripped to `major.minor.patch` before the
///   distro suffix.
/// - **SQLite** — `SELECT sqlite_version()`.
#[tauri::command]
pub async fn server_version(
    state: State<'_, AppState>,
    connection_id: String,
) -> AppResult<String> {
    let pool = pool_for(state.inner(), &connection_id)?;
    let version = match pool {
        DbPool::Postgres(p) => {
            let raw: String = sqlx::query_scalar("SELECT version()")
                .fetch_one(&p)
                .await?;
            // Full string is like "PostgreSQL 16.2 on x86_64-pc-linux-gnu, ...".
            // Extract and lowercase the first two whitespace-delimited tokens.
            raw.splitn(3, ' ')
                .take(2)
                .collect::<Vec<_>>()
                .join(" ")
                .to_lowercase()
        }
        DbPool::Mysql(p) => {
            let raw: String = sqlx::query_scalar("SELECT VERSION()")
                .fetch_one(&p)
                .await?;
            // Strip the distro/build suffix (everything after the first `-`).
            let ver = raw.split('-').next().unwrap_or(&raw);
            format!("mysql {ver}")
        }
        DbPool::Sqlite(p) => {
            let raw: String = sqlx::query_scalar("SELECT sqlite_version()")
                .fetch_one(&p)
                .await?;
            format!("sqlite {raw}")
        }
    };
    Ok(version)
}
