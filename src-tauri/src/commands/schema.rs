//! Schema introspection commands (databases, tables, columns, indexes, server info).
//!
//! Every command takes a `connection_id` so it can resolve the right pool
//! from [`crate::state::AppState`]. Queries are written against the
//! standard `information_schema` views where available, with `pg_*` /
//! `sqlite_master` fallbacks for engine-specific metadata.

use crate::db::sql::quote_ident;
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
    // Omit when absent (`None`) rather than emitting JSON `null`. The frontend
    // types this as `row_count?: number` and guards on `undefined`; serializing
    // `null` slipped past that guard and crashed `formatCount`/`formatBytes`.
    #[serde(rename = "row_count", skip_serializing_if = "Option::is_none")]
    pub row_count: Option<u64>,
    /// Approximate on-disk size in bytes (data + indexes) sourced from the engine.
    ///
    /// - **Postgres** — `pg_total_relation_size(...)`, only for ordinary tables
    ///   (`pg_class.relkind = 'r'`); views and foreign tables yield `None`.
    /// - **MySQL** — `DATA_LENGTH + INDEX_LENGTH` from `information_schema.TABLES`.
    ///   `None` for views.
    /// - **SQLite** — best-effort via the optional `dbstat` virtual table. If the
    ///   build does not include `dbstat`, the first probe fails and every entry
    ///   in this list falls back to `None` for the rest of the call.
    #[serde(rename = "size_bytes", skip_serializing_if = "Option::is_none")]
    pub size_bytes: Option<u64>,
}

/// Column metadata as displayed in the schema explorer.
///
/// `referenced_*` fields are populated for **single-column** FOREIGN KEY
/// constraints only. Composite FKs are intentionally ignored in this
/// iteration — the UI degrades to a plain text input for them.
#[derive(Debug, Serialize)]
pub struct ColumnInfo {
    pub name: String,
    pub data_type: String,
    pub nullable: bool,
    pub is_primary_key: bool,
    pub referenced_schema: Option<String>,
    pub referenced_table: Option<String>,
    pub referenced_column: Option<String>,
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
    Ok(names
        .into_iter()
        .map(|n| DatabaseInfo { name: n })
        .collect())
}

/// List user-visible tables and views, with approximate row counts where available.
///
/// Row counts are sourced from engine statistics catalogs in a single query to
/// avoid N+1 round-trips. See [`TableInfo::row_count`] for per-driver details.
#[tauri::command]
pub async fn list_tables(
    state: State<'_, AppState>,
    connection_id: String,
    _database: Option<String>,
) -> AppResult<Vec<TableInfo>> {
    let pool = pool_for(state.inner(), &connection_id)?;
    let tables = match pool {
        DbPool::Postgres(p) => {
            // LEFT JOIN against pg_stat_user_tables fetches approximate live-row counts
            // for tables in one round-trip. Views never have stat entries, so their
            // n_live_tup will be NULL (→ row_count: None).
            //
            // pg_total_relation_size only makes sense for ordinary tables; calling it
            // on a view raises an error, so we gate the call on relkind = 'r' via a
            // LEFT JOIN against pg_class. Anything else yields NULL.
            let rows = sqlx::query(
                "SELECT t.table_schema, t.table_name, t.table_type, s.n_live_tup, \
                        CASE WHEN c.relkind = 'r' \
                             THEN pg_total_relation_size(c.oid) \
                             ELSE NULL END AS size_bytes \
                 FROM information_schema.tables t \
                 LEFT JOIN pg_stat_user_tables s \
                   ON s.schemaname = t.table_schema AND s.relname = t.table_name \
                 LEFT JOIN pg_namespace n ON n.nspname = t.table_schema \
                 LEFT JOIN pg_class c ON c.relnamespace = n.oid AND c.relname = t.table_name \
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
                    size_bytes: r
                        .get::<Option<i64>, _>("size_bytes")
                        .map(|v| v.unsigned_abs()),
                })
                .collect()
        }
        DbPool::Mysql(p) => {
            // Resolve the current database from the connection (set via the
            // URL when the pool was opened). If the profile has no database
            // set, DATABASE() is NULL and we return an empty list — the user
            // needs to specify a database in the connection profile.
            let db_name: Option<String> = sqlx::query_scalar("SELECT DATABASE()")
                .fetch_one(&p)
                .await?;

            let db = match db_name {
                Some(d) if !d.is_empty() => d,
                // No default database; nothing to enumerate.
                _ => return Ok(vec![]),
            };

            // SHOW TABLE STATUS is significantly faster than querying
            // information_schema.TABLES and, critically, does not block on
            // InnoDB metadata locks the way information_schema can. On busy
            // servers a DDL statement or long-running transaction can cause
            // information_schema.TABLES to wait indefinitely, leaving the
            // schema explorer stuck in a loading state forever.
            //
            // Engine is NULL for views in SHOW TABLE STATUS output; that is
            // how we distinguish views from base tables without needing the
            // table_type column from information_schema.
            //
            // The database name is quoted with backtick-escaping. It comes
            // from DATABASE() (server-side catalog), not user input, so the
            // quoting is a safety measure rather than a SQL-injection guard.
            let q = format!("SHOW TABLE STATUS FROM `{}`", db.replace('`', "``"));
            let rows = sqlx::query(&q).fetch_all(&p).await?;

            // try_get is used throughout instead of get. sqlx's get() panics
            // when the Rust type does not match the column's type-flag reported
            // by the server (e.g. UNSIGNED vs signed BIGINT). Different MySQL
            // versions and forks disagree on whether SHOW TABLE STATUS columns
            // carry the UNSIGNED flag. try_get returns Err instead of panicking;
            // a panic in an async Tauri command causes the IPC promise to hang
            // rather than reject, which is why the schema explorer appeared
            // stuck. The fallback chain u64 → i64 → 0 handles all variants.
            let try_u64 = |r: &sqlx::mysql::MySqlRow, col: &str| -> u64 {
                r.try_get::<u64, _>(col)
                    .or_else(|_| r.try_get::<i64, _>(col).map(|v| v.unsigned_abs()))
                    .unwrap_or(0)
            };

            rows.into_iter()
                .map(|r| {
                    let name: String = r.try_get("Name").unwrap_or_default();
                    // Engine is NULL for views; all base tables have a non-NULL engine.
                    let is_view = r
                        .try_get::<Option<String>, _>("Engine")
                        .ok()
                        .flatten()
                        .is_none();
                    let data_len = try_u64(&r, "Data_length");
                    let idx_len = try_u64(&r, "Index_length");
                    TableInfo {
                        schema: db.clone(),
                        name,
                        kind: if is_view {
                            "view".into()
                        } else {
                            "table".into()
                        },
                        row_count: r
                            .try_get::<u64, _>("Rows")
                            .or_else(|_| r.try_get::<i64, _>("Rows").map(|v| v.unsigned_abs()))
                            .ok(),
                        size_bytes: if is_view {
                            None
                        } else {
                            Some(data_len + idx_len)
                        },
                    }
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
                    .fetch_one(&p)
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
        }
    };
    Ok(tables)
}

/// List columns for `schema.table` in catalog order.
///
/// The `is_primary_key` flag is determined by joining against
/// `information_schema.table_constraints` (Postgres), `column_key`
/// (MySQL), or the `pk` field of `PRAGMA table_info` (SQLite).
///
/// Single-column foreign-key references are surfaced via
/// `referenced_schema` / `referenced_table` / `referenced_column`.
/// Composite FKs are deliberately filtered out to keep the FK-dropdown
/// UI simple — they fall back to a plain text input.
#[tauri::command]
pub async fn list_columns(
    state: State<'_, AppState>,
    connection_id: String,
    schema: Option<String>,
    table: String,
) -> AppResult<Vec<ColumnInfo>> {
    list_columns_inner(state.inner(), &connection_id, schema, table).await
}

/// Borrowed-state variant of [`list_columns`] so other command handlers can
/// reuse the catalog lookup without re-entering the Tauri State guard.
pub async fn list_columns_inner(
    state: &AppState,
    connection_id: &str,
    schema: Option<String>,
    table: String,
) -> AppResult<Vec<ColumnInfo>> {
    let pool = pool_for(state, connection_id)?;
    let cols = match pool {
        DbPool::Postgres(p) => {
            let schema = schema.unwrap_or_else(|| "public".into());
            // The LATERAL subquery walks `pg_constraint` for foreign keys whose
            // conrelid matches the column's table and whose single-element
            // conkey points at this column. We restrict to length-1 conkey to
            // ignore composite FKs.
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
                        ) AS is_pk, \
                        fk.ref_schema, fk.ref_table, fk.ref_column \
                 FROM information_schema.columns c \
                 LEFT JOIN LATERAL ( \
                     SELECT n2.nspname AS ref_schema, \
                            cl2.relname AS ref_table, \
                            att2.attname AS ref_column \
                     FROM pg_constraint con \
                     JOIN pg_class cl  ON cl.oid  = con.conrelid \
                     JOIN pg_namespace n  ON n.oid  = cl.relnamespace \
                     JOIN pg_class cl2 ON cl2.oid = con.confrelid \
                     JOIN pg_namespace n2 ON n2.oid = cl2.relnamespace \
                     JOIN pg_attribute att  ON att.attrelid  = cl.oid  AND att.attnum  = con.conkey[1] \
                     JOIN pg_attribute att2 ON att2.attrelid = cl2.oid AND att2.attnum = con.confkey[1] \
                     WHERE con.contype = 'f' \
                       AND array_length(con.conkey, 1) = 1 \
                       AND n.nspname  = c.table_schema \
                       AND cl.relname = c.table_name \
                       AND att.attname = c.column_name \
                     LIMIT 1 \
                 ) fk ON TRUE \
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
                    referenced_schema: r.get::<Option<String>, _>("ref_schema"),
                    referenced_table: r.get::<Option<String>, _>("ref_table"),
                    referenced_column: r.get::<Option<String>, _>("ref_column"),
                })
                .collect()
        }
        DbPool::Mysql(p) => {
            let schema_arg = schema.unwrap_or_default();
            let rows = sqlx::query(
                "SELECT column_name, column_type, is_nullable, column_key \
                 FROM information_schema.columns \
                 WHERE table_schema = COALESCE(NULLIF(?, ''), DATABASE()) \
                   AND table_name = ? \
                 ORDER BY ordinal_position",
            )
            .bind(&schema_arg)
            .bind(&table)
            .fetch_all(&p)
            .await?;
            // Separate query for FK metadata. Filtered to single-column FKs
            // via a constraint-name lookup with COUNT(*) = 1.
            let fk_rows = sqlx::query(
                "SELECT k.column_name, \
                        k.referenced_table_schema AS ref_schema, \
                        k.referenced_table_name   AS ref_table, \
                        k.referenced_column_name  AS ref_column \
                 FROM information_schema.key_column_usage k \
                 WHERE k.table_schema = COALESCE(NULLIF(?, ''), DATABASE()) \
                   AND k.table_name = ? \
                   AND k.referenced_table_name IS NOT NULL \
                   AND k.ordinal_position = 1 \
                   AND k.constraint_name IN ( \
                       SELECT constraint_name FROM information_schema.key_column_usage \
                       WHERE table_schema = k.table_schema \
                         AND table_name = k.table_name \
                         AND referenced_table_name IS NOT NULL \
                       GROUP BY constraint_name HAVING COUNT(*) = 1 \
                   )",
            )
            .bind(&schema_arg)
            .bind(&table)
            .fetch_all(&p)
            .await?;
            use std::collections::HashMap;
            let mut fk_map: HashMap<String, (Option<String>, Option<String>, Option<String>)> =
                HashMap::new();
            for r in fk_rows {
                fk_map.insert(
                    r.get::<String, _>("column_name"),
                    (
                        r.get::<Option<String>, _>("ref_schema"),
                        r.get::<Option<String>, _>("ref_table"),
                        r.get::<Option<String>, _>("ref_column"),
                    ),
                );
            }
            rows.into_iter()
                .map(|r| {
                    let name: String = r.get("column_name");
                    let (ref_schema, ref_table, ref_column) =
                        fk_map.get(&name).cloned().unwrap_or((None, None, None));
                    ColumnInfo {
                        name,
                        data_type: r.get::<String, _>("column_type"),
                        nullable: r.get::<String, _>("is_nullable") == "YES",
                        is_primary_key: r.get::<String, _>("column_key") == "PRI",
                        referenced_schema: ref_schema,
                        referenced_table: ref_table,
                        referenced_column: ref_column,
                    }
                })
                .collect()
        }
        DbPool::Sqlite(p) => {
            // PRAGMA does not accept bound parameters; identifiers are
            // quoted defensively even though they come from a trusted
            // catalog lookup.
            let q = format!("PRAGMA table_info(\"{}\")", table.replace('"', "\"\""));
            let rows = sqlx::query(&q).fetch_all(&p).await?;
            // foreign_key_list yields one row per column of each constraint.
            // Group by `id` to filter composite FKs.
            let fk_q = format!(
                "PRAGMA foreign_key_list(\"{}\")",
                table.replace('"', "\"\"")
            );
            let fk_rows = sqlx::query(&fk_q).fetch_all(&p).await?;
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
                .filter_map(|(t, to)| to.is_none().then(|| t.clone()))
                .collect();
            let mut pk_cache: HashMap<String, Option<String>> = HashMap::new();
            for target in needs_pk_resolution {
                let q2 = format!("PRAGMA table_info(\"{}\")", target.replace('"', "\"\""));
                let pk = match sqlx::query(&q2).fetch_all(&p).await {
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
                        Some((t, None)) => {
                            (Some(t.clone()), pk_cache.get(t).cloned().unwrap_or(None))
                        }
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

/// Drop a table. `schema` is optional — when omitted the driver applies
/// its default (Postgres → `public`; MySQL → current `DATABASE()`; SQLite
/// has no schema concept).
///
/// All identifiers are sourced from the schema explorer, which itself comes
/// from a catalog query, so the [`quote_ident`] usage matches the rule in
/// `SECURITY.md` — never applied to free-form user input.
#[tauri::command]
pub async fn drop_table(
    state: State<'_, AppState>,
    connection_id: String,
    schema: Option<String>,
    table: String,
) -> AppResult<()> {
    let pool = pool_for(state.inner(), &connection_id)?;
    let qt = match (&pool, schema) {
        (DbPool::Postgres(_), Some(s)) => {
            format!("{}.{}", quote_ident(true, &s), quote_ident(true, &table))
        }
        (DbPool::Postgres(_), None) => format!(
            "{}.{}",
            quote_ident(true, "public"),
            quote_ident(true, &table)
        ),
        (DbPool::Mysql(_), Some(s)) => {
            format!("{}.{}", quote_ident(false, &s), quote_ident(false, &table))
        }
        (DbPool::Mysql(_), None) => quote_ident(false, &table),
        (DbPool::Sqlite(_), _) => quote_ident(true, &table),
    };
    let sql = format!("DROP TABLE {qt}");
    match pool {
        DbPool::Postgres(p) => {
            sqlx::query(&sql).execute(&p).await?;
        }
        DbPool::Mysql(p) => {
            sqlx::query(&sql).execute(&p).await?;
        }
        DbPool::Sqlite(p) => {
            sqlx::query(&sql).execute(&p).await?;
        }
    }
    Ok(())
}

/// Rename a table. Same identifier-source guarantees as [`drop_table`].
///
/// MySQL uses `RENAME TABLE old TO new`; Postgres and SQLite both accept
/// `ALTER TABLE old RENAME TO new`. The new name is sent as a quoted
/// identifier (never bound) because SQL does not allow binding for DDL
/// identifiers — but the caller's UI restricts the value to safe characters
/// before it reaches the command (see `SchemaExplorer` rename dialog).
#[tauri::command]
pub async fn rename_table(
    state: State<'_, AppState>,
    connection_id: String,
    schema: Option<String>,
    table: String,
    new_name: String,
) -> AppResult<()> {
    if new_name.trim().is_empty() {
        return Err(AppError::InvalidInput(
            "rename_table: new_name must not be empty".into(),
        ));
    }
    let pool = pool_for(state.inner(), &connection_id)?;
    let pg_or_sqlite = matches!(&pool, DbPool::Postgres(_) | DbPool::Sqlite(_));
    let new_ident = quote_ident(pg_or_sqlite, new_name.trim());
    let sql = match &pool {
        DbPool::Postgres(_) => {
            let s = schema.unwrap_or_else(|| "public".into());
            format!(
                "ALTER TABLE {}.{} RENAME TO {}",
                quote_ident(true, &s),
                quote_ident(true, &table),
                new_ident,
            )
        }
        DbPool::Mysql(_) => match schema {
            Some(s) => format!(
                "RENAME TABLE {}.{} TO {}.{}",
                quote_ident(false, &s),
                quote_ident(false, &table),
                quote_ident(false, &s),
                new_ident,
            ),
            None => format!(
                "RENAME TABLE {} TO {}",
                quote_ident(false, &table),
                new_ident,
            ),
        },
        DbPool::Sqlite(_) => format!(
            "ALTER TABLE {} RENAME TO {}",
            quote_ident(true, &table),
            new_ident,
        ),
    };
    match pool {
        DbPool::Postgres(p) => {
            sqlx::query(&sql).execute(&p).await?;
        }
        DbPool::Mysql(p) => {
            sqlx::query(&sql).execute(&p).await?;
        }
        DbPool::Sqlite(p) => {
            sqlx::query(&sql).execute(&p).await?;
        }
    }
    Ok(())
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
            let raw: String = sqlx::query_scalar("SELECT version()").fetch_one(&p).await?;
            // Full string is like "PostgreSQL 16.2 on x86_64-pc-linux-gnu, ...".
            // Extract and lowercase the first two whitespace-delimited tokens.
            raw.splitn(3, ' ')
                .take(2)
                .collect::<Vec<_>>()
                .join(" ")
                .to_lowercase()
        }
        DbPool::Mysql(p) => {
            let raw: String = sqlx::query_scalar("SELECT VERSION()").fetch_one(&p).await?;
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
