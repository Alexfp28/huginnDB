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

/// One server-side user/role, as surfaced by the "Security" panel.
///
/// Field meaning is necessarily driver-specific:
/// - **Postgres** — one row per `pg_roles` entry. `name` is the role name.
/// - **MySQL** — one row per `mysql.user` account. `name` is `"user@host"`
///   (MySQL accounts are scoped by host, so the pair is the real identity —
///   the same user name can exist multiple times with different hosts).
/// - **SQLite** — always empty; the engine has no user/permission concept.
/// - **MongoDB** — one row per user document in the resolved database
///   (`db.runCommand({usersInfo: 1})`). `name` is the bare username.
#[derive(Debug, Serialize)]
pub struct UserInfo {
    pub name: String,
    /// True for a superuser/admin-equivalent account. `false` where the
    /// engine has no such concept or it couldn't be determined.
    pub is_superuser: bool,
    /// True unless the account is explicitly locked/disabled. Defaults to
    /// `true` for engines that don't expose this.
    pub can_login: bool,
    /// Group/role memberships. Postgres: role names this role is a member
    /// of. MySQL: granted roles (MySQL 8 roles, if any). MongoDB:
    /// `"role@db"` strings. Always empty for SQLite.
    pub roles: Vec<String>,
}

/// One granted privilege, as surfaced when the user expands a row in the
/// "Security" panel.
///
/// `schema` / `table` are `None` for a server- or database-wide grant (e.g.
/// Postgres/MySQL `GRANT ... ON *.*`, or a MongoDB privilege whose resource
/// has no collection). Both are `Some` for a grant scoped to one
/// table/collection.
#[derive(Debug, Serialize)]
pub struct PrivilegeInfo {
    pub privilege: String,
    pub schema: Option<String>,
    pub table: Option<String>,
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
    list_databases_inner(state.inner(), &connection_id).await
}

/// Borrowed-state core of [`list_databases`], reused by the headless MCP
/// `list_databases` tool.
pub async fn list_databases_inner(
    state: &AppState,
    connection_id: &str,
) -> AppResult<Vec<DatabaseInfo>> {
    let pool = pool_for(state, connection_id)?;
    if let DbPool::Mongo(conn) = &pool {
        return crate::db::mongo::schema::list_databases(conn).await;
    }
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
        DbPool::Mongo(_) => unreachable!("mongo dispatched above"),
    };
    Ok(names
        .into_iter()
        .map(|n| DatabaseInfo { name: n })
        .collect())
}

/// Create a new database/catalog on the server behind `connection_id`.
///
/// Postgres and MySQL only — this is a server-level DDL statement, so it
/// runs regardless of which database the pool happens to be connected to.
/// SQLite has no such concept (the file *is* the database) and MongoDB
/// creates databases implicitly on first write with no `CREATE DATABASE`
/// wire command, so both are rejected here; the frontend hides the entry
/// point for them entirely (see the multi-DB explorer toolbar), this is
/// just defense in depth against a stale/hand-crafted call.
///
/// `name` goes through the same [`crate::db::ddl::validate_ident`] allowlist
/// used by the structure editor (gotcha #16) — `CREATE DATABASE` cannot bind
/// the name as a parameter, so validating before quoting is the only
/// injection defense available.
#[tauri::command]
pub async fn create_database(
    state: State<'_, AppState>,
    connection_id: String,
    name: String,
) -> AppResult<()> {
    crate::db::ddl::validate_ident("database", &name)?;
    let pool = pool_for(state.inner(), &connection_id)?;
    match pool {
        DbPool::Postgres(p) => {
            let sql = format!("CREATE DATABASE {}", quote_ident(true, &name));
            sqlx::query(&sql).execute(&p).await?;
        }
        DbPool::Mysql(p) => {
            let sql = format!("CREATE DATABASE {}", quote_ident(false, &name));
            sqlx::query(&sql).execute(&p).await?;
        }
        DbPool::Sqlite(_) => {
            return Err(AppError::InvalidInput(
                "SQLite has no separate databases — each file is one database".into(),
            ));
        }
        DbPool::Mongo(_) => {
            return Err(AppError::InvalidInput(
                "MongoDB creates databases implicitly on first write".into(),
            ));
        }
    }
    Ok(())
}

/// Drop a database/catalog on the server behind `connection_id`.
///
/// The mirror of [`create_database`]: Postgres and MySQL only, server-level
/// DDL, `name` validated through the same `validate_ident` allowlist because
/// `DROP DATABASE` can't bind its identifier as a parameter.
///
/// `connection_id` is the *parent* connection. Before issuing the drop we
/// close any synthetic per-database pool this session opened while browsing
/// the target (`<connection_id>::db::<name>`, see `open_database_view`):
/// Postgres refuses to drop a database that still has sessions attached, and
/// our own child pool is the most likely holder. `Pool::close().await` waits
/// for those connections to actually go away rather than relying on the lazy
/// drop of the `ActivePool`. Dropping the database the parent pool itself is
/// connected to still fails server-side (as it must) and that error surfaces
/// to the caller unchanged.
#[tauri::command]
pub async fn drop_database(
    state: State<'_, AppState>,
    connection_id: String,
    name: String,
) -> AppResult<()> {
    crate::db::ddl::validate_ident("database", &name)?;
    // Remove + close our child pool first. The write guard is released at the
    // end of this statement, so the subsequent `.close().await` never holds
    // the lock across an await point.
    let child_id = crate::commands::connection::database_view_id(&connection_id, &name);
    let removed = state.connections.write().remove(&child_id);
    if let Some(active) = removed {
        match &active.pool {
            DbPool::Postgres(p) => p.close().await,
            DbPool::Mysql(p) => p.close().await,
            _ => {}
        }
    }
    let pool = pool_for(state.inner(), &connection_id)?;
    match pool {
        DbPool::Postgres(p) => {
            let sql = format!("DROP DATABASE {}", quote_ident(true, &name));
            sqlx::query(&sql).execute(&p).await?;
        }
        DbPool::Mysql(p) => {
            let sql = format!("DROP DATABASE {}", quote_ident(false, &name));
            sqlx::query(&sql).execute(&p).await?;
        }
        DbPool::Sqlite(_) => {
            return Err(AppError::InvalidInput(
                "SQLite has no separate databases — delete the file instead".into(),
            ));
        }
        DbPool::Mongo(_) => {
            return Err(AppError::InvalidInput(
                "Dropping a MongoDB database isn't supported here".into(),
            ));
        }
    }
    Ok(())
}

/// Create a MongoDB collection on the database `connection_id` is scoped to (#61).
///
/// MongoDB creates a collection implicitly on first write, so there was no way
/// to materialize an empty collection from the UI — this issues an explicit
/// `create` command (via the driver's `create_collection`) so it shows up in
/// the explorer before any document is inserted, matching MongoDB Compass.
///
/// MongoDB-only by design: the SQL drivers have their table-creation path
/// through the structure editor (`preview_structure_change`/`apply_structure_change`,
/// gotcha #16), so a non-Mongo pool is rejected here rather than silently doing
/// nothing. `connection_id` may be a synthetic `<parent>::db::<db>` view id —
/// `resolve_db` reads the database the Mongo pool is bound to either way.
///
/// `name` is validated (non-empty, no `system.` prefix which MongoDB reserves
/// for internal namespaces) before the wire command. This isn't a
/// SQL-injection surface — the name is a `create` command argument, never
/// string-interpolated into a query — but rejecting reserved/empty names up
/// front gives a clean error instead of a cryptic server-side one.
#[tauri::command]
pub async fn create_collection(
    state: State<'_, AppState>,
    connection_id: String,
    name: String,
) -> AppResult<()> {
    let trimmed = name.trim();
    if trimmed.is_empty() {
        return Err(AppError::InvalidInput(
            "collection name cannot be empty".into(),
        ));
    }
    if trimmed.starts_with("system.") {
        return Err(AppError::InvalidInput(
            "collection names starting with 'system.' are reserved by MongoDB".into(),
        ));
    }
    let pool = pool_for(state.inner(), &connection_id)?;
    match &pool {
        DbPool::Mongo(conn) => {
            let db = crate::db::mongo::schema::resolve_db(conn)?;
            db.create_collection(trimmed).await?;
            Ok(())
        }
        _ => Err(AppError::InvalidInput(
            "creating a collection is only supported for MongoDB; use the structure editor to create a table".into(),
        )),
    }
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
    list_tables_inner(state.inner(), &connection_id).await
}

/// Borrowed-state core of [`list_tables`], reused by the headless MCP
/// `list_tables` tool. The `_database` argument the command accepts is unused
/// (the pool is already bound to one database), so the inner form drops it.
pub async fn list_tables_inner(state: &AppState, connection_id: &str) -> AppResult<Vec<TableInfo>> {
    let pool = pool_for(state, connection_id)?;
    if let DbPool::Mongo(conn) = &pool {
        return crate::db::mongo::schema::list_collections(conn).await;
    }
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
        DbPool::Mongo(_) => unreachable!("mongo dispatched above"),
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
    if let DbPool::Mongo(conn) = &pool {
        return crate::db::mongo::schema::infer_columns(conn, &table).await;
    }
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
        DbPool::Mongo(_) => unreachable!("mongo dispatched above"),
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
    list_indexes_inner(state.inner(), &connection_id, schema, table).await
}

/// Borrowed-state core of [`list_indexes`], reused by the headless MCP
/// `list_indexes` tool.
pub async fn list_indexes_inner(
    state: &AppState,
    connection_id: &str,
    schema: Option<String>,
    table: String,
) -> AppResult<Vec<IndexInfo>> {
    let pool = pool_for(state, connection_id)?;
    if let DbPool::Mongo(conn) = &pool {
        return crate::db::mongo::schema::list_indexes(conn, &table).await;
    }
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
        DbPool::Mongo(_) => unreachable!("mongo dispatched above"),
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
    if let DbPool::Mongo(conn) = &pool {
        let db = crate::db::mongo::schema::resolve_db(conn)?;
        db.collection::<mongodb::bson::Document>(&table)
            .drop()
            .await?;
        return Ok(());
    }
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
        (DbPool::Mongo(_), _) => unreachable!("mongo dispatched above"),
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
        DbPool::Mongo(_) => unreachable!("mongo dispatched above"),
    }
    Ok(())
}

/// Empty a table — remove every row while keeping the table itself (#69).
///
/// Postgres/MySQL use `TRUNCATE TABLE` (fast, non-logged); SQLite has no
/// `TRUNCATE`, so a plain `DELETE FROM` clears it. MongoDB deletes every
/// document (`delete_many({})`) rather than dropping the collection. Same
/// catalog-sourced identifier guarantees as [`drop_table`] — `schema`/`table`
/// come from the schema explorer, never free-form input, so [`quote_ident`]
/// is used per the `SECURITY.md` rule.
#[tauri::command]
pub async fn empty_table(
    state: State<'_, AppState>,
    connection_id: String,
    schema: Option<String>,
    table: String,
) -> AppResult<()> {
    let pool = pool_for(state.inner(), &connection_id)?;
    if let DbPool::Mongo(conn) = &pool {
        let db = crate::db::mongo::schema::resolve_db(conn)?;
        db.collection::<mongodb::bson::Document>(&table)
            .delete_many(mongodb::bson::Document::new())
            .await?;
        return Ok(());
    }
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
        (DbPool::Mongo(_), _) => unreachable!("mongo dispatched above"),
    };
    // SQLite has no TRUNCATE; DELETE FROM with no WHERE clears the table.
    let sql = match &pool {
        DbPool::Sqlite(_) => format!("DELETE FROM {qt}"),
        _ => format!("TRUNCATE TABLE {qt}"),
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
        DbPool::Mongo(_) => unreachable!("mongo dispatched above"),
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
    if matches!(&pool, DbPool::Mongo(_)) {
        return Err(AppError::InvalidInput(
            "renaming collections is not supported in this version".into(),
        ));
    }
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
        DbPool::Mongo(_) => unreachable!("mongo rejected above"),
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
        DbPool::Mongo(_) => unreachable!("mongo rejected above"),
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
    server_version_inner(state.inner(), &connection_id).await
}

/// Borrowed-state core of [`server_version`], reused by the headless MCP
/// `server_version` tool.
pub async fn server_version_inner(state: &AppState, connection_id: &str) -> AppResult<String> {
    let pool = pool_for(state, connection_id)?;
    if let DbPool::Mongo(conn) = &pool {
        let info = conn
            .client
            .database("admin")
            .run_command(mongodb::bson::doc! {"buildInfo": 1})
            .await?;
        let ver = info.get_str("version").unwrap_or("?");
        return Ok(format!("mongodb {ver}"));
    }
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
        DbPool::Mongo(_) => unreachable!("mongo dispatched above"),
    };
    Ok(version)
}

/// List server-side users/roles visible to the connection.
///
/// Always returns a (possibly empty) list rather than an error for engines
/// with reduced visibility — e.g. a MySQL account without `SELECT` on
/// `mysql.user` falls back to reporting just itself via `CURRENT_USER()`
/// instead of failing the whole panel.
#[tauri::command]
pub async fn list_users(
    state: State<'_, AppState>,
    connection_id: String,
) -> AppResult<Vec<UserInfo>> {
    list_users_inner(state.inner(), &connection_id).await
}

/// Borrowed-state core of [`list_users`], reused by the headless MCP
/// `list_users` tool.
pub async fn list_users_inner(state: &AppState, connection_id: &str) -> AppResult<Vec<UserInfo>> {
    let pool = pool_for(state, connection_id)?;
    if let DbPool::Mongo(conn) = &pool {
        return crate::db::mongo::schema::list_users(conn).await;
    }
    let users = match pool {
        DbPool::Postgres(p) => {
            // One row per role, roles-of-membership aggregated in the same
            // round-trip via pg_auth_members so we don't N+1 per role.
            let rows = sqlx::query(
                "SELECT r.rolname, r.rolsuper, r.rolcanlogin, \
                        COALESCE(array_agg(g.rolname) FILTER (WHERE g.rolname IS NOT NULL), '{}') AS roles \
                 FROM pg_roles r \
                 LEFT JOIN pg_auth_members m ON m.member = r.oid \
                 LEFT JOIN pg_roles g ON g.oid = m.roleid \
                 GROUP BY r.rolname, r.rolsuper, r.rolcanlogin \
                 ORDER BY r.rolname",
            )
            .fetch_all(&p)
            .await?;
            rows.into_iter()
                .map(|r| UserInfo {
                    name: r.get::<String, _>("rolname"),
                    is_superuser: r.get::<bool, _>("rolsuper"),
                    can_login: r.get::<bool, _>("rolcanlogin"),
                    roles: r.get::<Vec<String>, _>("roles"),
                })
                .collect()
        }
        DbPool::Mysql(p) => {
            // mysql.user requires a global SELECT privilege the connected
            // account may not have; fall back to reporting just the current
            // user (via CURRENT_USER(), always readable) rather than
            // failing the whole panel.
            let rows_res = sqlx::query(
                "SELECT User, Host, Super_priv, account_locked FROM mysql.user \
                 ORDER BY User, Host",
            )
            .fetch_all(&p)
            .await;
            match rows_res {
                Ok(rows) => {
                    // MySQL 8 roles: mysql.role_edges lists (from_user/host)
                    // granted TO (to_user/host). Best-effort — absent on
                    // MySQL 5.7 / MariaDB, where the query simply errors and
                    // we leave every `roles` list empty.
                    let mut role_map: std::collections::HashMap<(String, String), Vec<String>> =
                        std::collections::HashMap::new();
                    if let Ok(edges) =
                        sqlx::query("SELECT TO_USER, TO_HOST, FROM_USER FROM mysql.role_edges")
                            .fetch_all(&p)
                            .await
                    {
                        for e in edges {
                            let key =
                                (e.get::<String, _>("TO_USER"), e.get::<String, _>("TO_HOST"));
                            role_map
                                .entry(key)
                                .or_default()
                                .push(e.get::<String, _>("FROM_USER"));
                        }
                    }
                    rows.into_iter()
                        .map(|r| {
                            let user: String = r.get("User");
                            let host: String = r.get("Host");
                            let can_login = r
                                .try_get::<String, _>("account_locked")
                                .map(|v| v != "Y")
                                .unwrap_or(true);
                            let roles = role_map
                                .get(&(user.clone(), host.clone()))
                                .cloned()
                                .unwrap_or_default();
                            UserInfo {
                                name: format!("{user}@{host}"),
                                is_superuser: r.get::<String, _>("Super_priv") == "Y",
                                can_login,
                                roles,
                            }
                        })
                        .collect()
                }
                Err(_) => {
                    let current: String = sqlx::query_scalar("SELECT CURRENT_USER()")
                        .fetch_one(&p)
                        .await?;
                    vec![UserInfo {
                        name: current,
                        is_superuser: false,
                        can_login: true,
                        roles: vec![],
                    }]
                }
            }
        }
        // SQLite has no user/permission model.
        DbPool::Sqlite(_) => vec![],
        DbPool::Mongo(_) => unreachable!("mongo dispatched above"),
    };
    Ok(users)
}

/// List the privileges granted to `user` (as returned by [`list_users`]).
#[tauri::command]
pub async fn list_privileges(
    state: State<'_, AppState>,
    connection_id: String,
    user: String,
) -> AppResult<Vec<PrivilegeInfo>> {
    list_privileges_inner(state.inner(), &connection_id, user).await
}

/// Borrowed-state core of [`list_privileges`], reused by the headless MCP
/// `list_privileges` tool.
pub async fn list_privileges_inner(
    state: &AppState,
    connection_id: &str,
    user: String,
) -> AppResult<Vec<PrivilegeInfo>> {
    let pool = pool_for(state, connection_id)?;
    if let DbPool::Mongo(conn) = &pool {
        return crate::db::mongo::schema::list_privileges(conn, &user).await;
    }
    let privs = match pool {
        DbPool::Postgres(p) => {
            let rows = sqlx::query(
                "SELECT privilege_type, table_schema, table_name \
                 FROM information_schema.role_table_grants \
                 WHERE grantee = $1 \
                 ORDER BY table_schema, table_name, privilege_type",
            )
            .bind(&user)
            .fetch_all(&p)
            .await?;
            rows.into_iter()
                .map(|r| PrivilegeInfo {
                    privilege: r.get::<String, _>("privilege_type"),
                    schema: Some(r.get::<String, _>("table_schema")),
                    table: Some(r.get::<String, _>("table_name")),
                })
                .collect()
        }
        DbPool::Mysql(p) => {
            // `user` is "user@host" as produced by list_users. SHOW GRANTS
            // requires the literal pair, quoted as MySQL string literals —
            // not identifiers, so quote_ident does not apply here. The
            // source is always a catalog lookup (mysql.user), never
            // free-form input, but quotes are still escaped defensively.
            let (name, host) = user.rsplit_once('@').unwrap_or((user.as_str(), "%"));
            let q = format!(
                "SHOW GRANTS FOR '{}'@'{}'",
                name.replace('\'', "''"),
                host.replace('\'', "''"),
            );
            let rows = sqlx::query(&q).fetch_all(&p).await?;
            let mut out = Vec::new();
            for r in rows {
                // SHOW GRANTS returns one text column whose name is
                // "Grants for <user>@<host>" — read positionally instead.
                let line: String = r.try_get(0).unwrap_or_default();
                out.extend(parse_mysql_grant(&line));
            }
            out
        }
        DbPool::Sqlite(_) => vec![],
        DbPool::Mongo(_) => unreachable!("mongo dispatched above"),
    };
    Ok(privs)
}

/// Parse one `SHOW GRANTS FOR ...` line into individual [`PrivilegeInfo`]
/// rows.
///
/// Handles the common shapes: `GRANT <privs> ON <db>.<table> TO ...`,
/// `... ON *.*`, `... ON \`db\`.*`, and the `GRANT PROXY ON ...` special
/// case (whose "target" is a user, not a schema/table). Anything that
/// doesn't match the expected `GRANT ... ON ... TO ...` shape is skipped
/// rather than mis-parsed.
fn parse_mysql_grant(line: &str) -> Vec<PrivilegeInfo> {
    let Some(rest) = line.strip_prefix("GRANT ") else {
        return vec![];
    };
    let Some(on_idx) = rest.find(" ON ") else {
        return vec![];
    };
    let privileges_part = &rest[..on_idx];
    let after_on = &rest[on_idx + 4..];
    let Some(to_idx) = after_on.rfind(" TO ") else {
        return vec![];
    };
    let target_part = after_on[..to_idx].trim();

    let (schema, table) = if privileges_part.trim() == "PROXY" {
        (None, None)
    } else {
        let cleaned = target_part.replace('`', "");
        match cleaned.split_once('.') {
            Some((db, tbl)) => (
                (db != "*").then(|| db.to_string()),
                (tbl != "*").then(|| tbl.to_string()),
            ),
            None => (None, None),
        }
    };

    split_mysql_privilege_list(privileges_part)
        .into_iter()
        .map(|privilege| PrivilegeInfo {
            privilege,
            schema: schema.clone(),
            table: table.clone(),
        })
        .collect()
}

/// Split a comma-separated privilege list, ignoring commas inside a
/// column-list suffix like `SELECT (col1, col2)`.
fn split_mysql_privilege_list(s: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut depth = 0i32;
    let mut cur = String::new();
    for ch in s.chars() {
        match ch {
            '(' => {
                depth += 1;
                cur.push(ch);
            }
            ')' => {
                depth -= 1;
                cur.push(ch);
            }
            ',' if depth == 0 => {
                let trimmed = cur.trim();
                if !trimmed.is_empty() {
                    out.push(trimmed.to_string());
                }
                cur.clear();
            }
            _ => cur.push(ch),
        }
    }
    let trimmed = cur.trim();
    if !trimmed.is_empty() {
        out.push(trimmed.to_string());
    }
    out
}
