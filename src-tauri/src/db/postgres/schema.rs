//! PostgreSQL catalog introspection.
//!
//! Result shapes mirror [`crate::commands::schema`]'s DTOs exactly, the same
//! convention [`crate::db::mssql::schema`] and [`crate::db::mongo::schema`]
//! already follow: the DTOs are the IPC contract and live with the commands
//! that serialise them, while the SQL that fills them lives with its driver.
//!
//! Every function here takes an already-opened `PgPool`. Resolving a connection
//! id to a pool, and dispatching to the right driver, stays in
//! `commands::schema` — this module never sees an `AppState`.

use sqlx::PgPool;

use crate::commands::schema::{ColumnInfo, IndexInfo, PrivilegeInfo, TableInfo, UserInfo};
use crate::commands::schema::{DatabaseInfo, DatabaseSize};
use crate::error::AppResult;
use sqlx::Row;

/// Databases on the server, template databases excluded.
pub async fn list_databases(pool: &PgPool) -> AppResult<Vec<DatabaseInfo>> {
    let names: Vec<String> = sqlx::query_scalar(
        "SELECT datname FROM pg_database \
         WHERE datistemplate = false \
         ORDER BY datname",
    )
    .fetch_all(pool)
    .await?;
    Ok(names
        .into_iter()
        .map(|name| DatabaseInfo { name })
        .collect())
}

/// On-disk size per database.
///
/// **`pg_database_size` is not a catalog read.** It is
/// `calculate_database_size()`, which walks the database's directory calling
/// `stat` on every file, so this is measured in seconds on a large server —
/// the reason the sizes are a deferred command rather than part of
/// [`list_databases`]. It counts everything in the directory, free space
/// included.
///
/// The `CASE` is what makes the failure per-row. `pg_database_size` raises
/// `permission denied` for a database the login cannot `CONNECT` to, and one
/// raise aborts the whole statement — so without the guard, a single
/// inaccessible database on a shared server costs every other database its
/// size. With it, that database alone answers `NULL`.
pub async fn database_sizes(pool: &PgPool) -> AppResult<Vec<DatabaseSize>> {
    let rows = sqlx::query(
        "SELECT datname, \
                CASE WHEN has_database_privilege(datname, 'CONNECT') \
                     THEN pg_database_size(oid) END AS size_bytes \
         FROM pg_database \
         WHERE datistemplate = false \
         ORDER BY datname",
    )
    .fetch_all(pool)
    .await?;
    Ok(rows
        .iter()
        .map(|r| DatabaseSize {
            name: r.get::<String, _>("datname"),
            size_bytes: r
                .get::<Option<i64>, _>("size_bytes")
                .and_then(|n| u64::try_from(n).ok()),
        })
        .collect())
}

/// Engine and version, as `postgresql <version>`.
///
/// `version()` returns something like `PostgreSQL 16.2 on x86_64-pc-linux-gnu,
/// compiled by gcc ...`; the status bar wants the first two tokens.
pub async fn server_version(pool: &PgPool) -> AppResult<String> {
    let raw: String = sqlx::query_scalar("SELECT version()")
        .fetch_one(pool)
        .await?;
    Ok(raw
        .splitn(3, ' ')
        .take(2)
        .collect::<Vec<_>>()
        .join(" ")
        .to_lowercase())
}

/// Tables and views in every non-system schema, with approximate live-row
/// counts and on-disk sizes where Postgres can supply them.
pub async fn list_tables(p: &sqlx::PgPool) -> AppResult<Vec<TableInfo>> {
    Ok({
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
        .fetch_all(p)
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
    })
}

/// A table's columns, with primary-key and single-column foreign-key flags.
pub async fn list_columns(
    p: &sqlx::PgPool,
    schema: Option<String>,
    table: String,
) -> AppResult<Vec<ColumnInfo>> {
    Ok({
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
        .fetch_all(p)
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
    })
}

/// A table's indexes and the columns each covers.
pub async fn list_indexes(
    p: &sqlx::PgPool,
    schema: Option<String>,
    table: String,
) -> AppResult<Vec<IndexInfo>> {
    Ok({
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
        .fetch_all(p)
        .await?;
        rows.into_iter()
            .map(|r| IndexInfo {
                name: r.get::<String, _>("index_name"),
                columns: r.get::<Vec<String>, _>("columns"),
                unique: r.get::<bool, _>("is_unique"),
            })
            .collect()
    })
}

/// Server-side roles, with their membership aggregated in the same round-trip.
pub async fn list_users(p: &sqlx::PgPool) -> AppResult<Vec<UserInfo>> {
    Ok({
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
        .fetch_all(p)
        .await?;
        rows.into_iter()
            .map(|r| UserInfo {
                name: r.get::<String, _>("rolname"),
                is_superuser: r.get::<bool, _>("rolsuper"),
                can_login: r.get::<bool, _>("rolcanlogin"),
                roles: r.get::<Vec<String>, _>("roles"),
            })
            .collect()
    })
}

/// Privileges granted to `user`, from `information_schema.role_table_grants`.
pub async fn list_privileges(p: &sqlx::PgPool, user: String) -> AppResult<Vec<PrivilegeInfo>> {
    Ok({
        let rows = sqlx::query(
            "SELECT privilege_type, table_schema, table_name \
             FROM information_schema.role_table_grants \
             WHERE grantee = $1 \
             ORDER BY table_schema, table_name, privilege_type",
        )
        .bind(&user)
        .fetch_all(p)
        .await?;
        rows.into_iter()
            .map(|r| PrivilegeInfo {
                privilege: r.get::<String, _>("privilege_type"),
                schema: Some(r.get::<String, _>("table_schema")),
                table: Some(r.get::<String, _>("table_name")),
            })
            .collect()
    })
}

// ---------------------------------------------------------------------------
// Views
// ---------------------------------------------------------------------------

/// The body of a view — just the `SELECT`, with no `CREATE VIEW ... AS` wrapper
/// and no trailing semicolon.
///
/// `Ok(None)` when `schema.view` is not a view: a table of that name, or nothing
/// at all. Not an error, because the callers ask this *about* a relation whose
/// kind they may not know yet (`describe_table` over MCP asks for every
/// relation), and "this is a table" is an answer rather than a failure.
///
/// `relkind = 'v'` only, deliberately matching [`list_tables`]: materialised
/// views are absent from `information_schema.tables`, so they never surface as
/// `kind: "view"` and there is nothing for a definition to belong to.
pub async fn view_definition(
    p: &sqlx::PgPool,
    schema: Option<&str>,
    view: &str,
) -> AppResult<Option<String>> {
    let schema = schema.filter(|s| !s.is_empty()).unwrap_or("public");
    let def: Option<String> = sqlx::query_scalar(
        "SELECT pg_get_viewdef(c.oid, true) \
         FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace \
         WHERE n.nspname = $1 AND c.relname = $2 AND c.relkind = 'v'",
    )
    .bind(schema)
    .bind(view)
    .fetch_optional(p)
    .await?;
    Ok(def.map(|q| q.trim().trim_end_matches(';').trim().to_string()))
}
