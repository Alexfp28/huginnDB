//! Whole-database export and the one backend primitive the import flow needs.
//!
//! `export_databases` streams a portable, combined `.sql` dump (schema +
//! data) for one or more already-resolved database connections — the
//! connection-level and per-database "Export database…" dialogs both funnel
//! into it (see `ExportDatabaseDialog.tsx`). `read_text_file` is
//! intentionally the *only* backend piece import needs: the frontend
//! re-runs the picked file through the existing query batch runner
//! (`splitSql` + `execute_batch` in `src/lib/sqlSplit.ts` /
//! `commands::query::execute_batch`) instead of a second, parallel
//! execution path here (see `ImportSqlDialog.tsx`).
//!
//! Export writes in three global phases for Postgres/MySQL — bare
//! `CREATE TABLE`, then all data, then `ALTER TABLE ADD CONSTRAINT` (FK) +
//! `CREATE INDEX` — so a whole-database dump doesn't need a table-dependency
//! topological sort, and doesn't need elevated privileges (e.g. Postgres's
//! superuser-only `session_replication_role`) to load out of FK order.
//! SQLite instead dumps its catalog verbatim (higher fidelity than
//! reconstructing via `TableStructure` — it captures `CHECK` constraints
//! etc.) bracketed by `PRAGMA foreign_keys=OFF/ON`, since SQLite inlines FKs
//! into `CREATE TABLE` text that isn't worth re-parsing to split.

use crate::commands::query::{build_filter_clause_at, ColumnFilter};
use crate::commands::schema::{list_tables_inner, TableInfo};
use crate::commands::structure::{mysql_structure, pg_structure};
use crate::db::ddl::{build_create, TableStructure};
use crate::db::dump::{
    build_insert_statements, mysql_auto_increment_resync_stmt, mysql_literal, pg_literal,
    pg_sequence_resync_stmt, sqlite_literal,
};
use crate::db::sql::Dialect;
use crate::error::{AppError, AppResult};
use crate::state::{AppState, DbPool};
use serde::Deserialize;
use sqlx::{Column, Row};
use std::io::Write;
use tauri::{AppHandle, State};

/// How a table's existing data is treated relative to the rows being
/// exported. `TruncateInsert` prefixes each table's `INSERT` block with a
/// `DELETE FROM` so re-running the dump against a target that already has
/// conflicting rows replaces them instead of erroring on the primary key —
/// the "vaciar tabla e insertar" mode from the connection-level export
/// dialog. Plain `DELETE FROM` (not `TRUNCATE`) so the same code path works
/// unchanged across Postgres/MySQL/SQLite.
#[derive(Debug, Clone, Copy, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum DataMode {
    Insert,
    TruncateInsert,
}

fn pool_for(state: &AppState, id: &str) -> AppResult<DbPool> {
    state
        .connections
        .read()
        .get(id)
        .ok_or_else(|| AppError::NotConnected(id.to_string()))
}

/// Rows per multi-row `INSERT ... VALUES (...), (...);` statement
/// (mysqldump-style batching).
const BATCH_SIZE: usize = 500;

/// One database (or, for a multi-DB connection, one already-resolved
/// `<parent>::db::<name>` child) to include in an [`export_databases`] run.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportTarget {
    /// Already resolved by the frontend — for a single-DB profile this is
    /// the profile id itself; for a multi-DB connection it's that
    /// database's synthetic child id (`openTrackedDatabaseView`), so this
    /// command never has to resolve or open pools itself.
    pub connection_id: String,
    /// Only used for the `-- Database: <name>` header comment separating
    /// targets in the combined output.
    pub database_name: String,
    /// `None` exports every table in this database; `Some` restricts it to
    /// the named subset (the export dialog's per-database table checkboxes).
    #[serde(default)]
    pub tables: Option<Vec<String>>,
}

/// Export one or more databases — each optionally scoped to a subset of its
/// tables — into a SINGLE combined `.sql` file at `dest_path`. Replaces the
/// old `export_database` (always the connection's one implicit database, via
/// a Rust-side save dialog): the connection-level and per-database "Export
/// database…" menu actions both funnel into this command now, with one
/// target for a single-DB profile or per-database menu, several for a
/// multi-DB connection's "pick which databases" dialog. The frontend already
/// owns the save-path UI (a text field + native picker, mirroring HeidiSQL),
/// so — unlike `export_table`/`export_table_rows` — this command takes
/// `dest_path` directly instead of opening its own dialog. Rejects MongoDB.
#[tauri::command]
pub async fn export_databases(
    state: State<'_, AppState>,
    targets: Vec<ExportTarget>,
    data_mode: DataMode,
    dest_path: String,
) -> AppResult<String> {
    if targets.is_empty() {
        return Err(AppError::InvalidInput(
            "export_databases: no databases selected".into(),
        ));
    }

    let mut w = std::io::BufWriter::new(std::fs::File::create(&dest_path)?);
    writeln!(
        w,
        "-- HuginnDB export — {}\n",
        chrono::Utc::now().to_rfc3339()
    )?;

    for target in &targets {
        let pool = pool_for(state.inner(), &target.connection_id)?;
        if matches!(&pool, DbPool::Mongo(_)) {
            return Err(AppError::InvalidInput(format!(
                "database export is not supported for MongoDB (database: {})",
                target.database_name
            )));
        }

        let mut tables: Vec<TableInfo> = list_tables_inner(state.inner(), &target.connection_id)
            .await?
            .into_iter()
            .filter(|t| t.kind == "table")
            .collect();
        if let Some(names) = &target.tables {
            tables.retain(|t| names.contains(&t.name));
        }

        writeln!(w, "-- Database: {}\n", target.database_name)?;
        match pool {
            DbPool::Postgres(p) => export_pg(&mut w, &p, &tables, data_mode).await?,
            DbPool::Mysql(p) => export_mysql(&mut w, &p, &tables, data_mode).await?,
            DbPool::Sqlite(p) => {
                let table_filter = target.tables.as_deref();
                export_sqlite(&mut w, &p, table_filter, data_mode).await?
            }
            // SQL Server export needs its own literal encoder (`0x…` binaries,
            // `N'…'` unicode strings) plus `SET IDENTITY_INSERT` bracketing
            // instead of the sequence/auto-increment resync the others do —
            // deferred, so refuse rather than emit a dump that won't load.
            DbPool::MsSql(_) => {
                return Err(AppError::UnsupportedDriver(
                    "database export is not supported for SQL Server yet".into(),
                ))
            }
            DbPool::Mongo(_) => unreachable!("rejected above"),
        }
    }
    w.flush()?;
    Ok(dest_path)
}

/// Reads a text file for the frontend-driven import flow (see module docs).
#[tauri::command]
pub fn read_text_file(file_path: String) -> AppResult<String> {
    Ok(std::fs::read_to_string(&file_path)?)
}

/// Export a single table (schema + data) to a user-chosen `.sql` file — the
/// same DDL+data format [`export_databases`] produces, scoped to one table.
/// Always plain `INSERT` ([`DataMode::Insert`]) — this is the DataGrid
/// toolbar's "Export the full table", not the connection-level dialog, so it
/// has no data-mode control of its own. Rejects MongoDB; collections use
/// [`crate::commands::mongo::export_collection`] instead.
#[tauri::command]
pub async fn export_table(
    app: AppHandle,
    state: State<'_, AppState>,
    connection_id: String,
    schema: Option<String>,
    table: String,
) -> AppResult<String> {
    let pool = pool_for(state.inner(), &connection_id)?;
    if matches!(&pool, DbPool::Mongo(_)) {
        return Err(AppError::InvalidInput(
            "table export is not supported for MongoDB; use \"Export collection\" instead".into(),
        ));
    }

    let tables: Vec<_> = list_tables_inner(state.inner(), &connection_id)
        .await?
        .into_iter()
        .filter(|t| {
            t.kind == "table"
                && t.name == table
                && schema.as_deref().map_or(true, |s| t.schema == s)
        })
        .collect();
    if tables.is_empty() {
        return Err(AppError::InvalidInput(format!("table not found: {table}")));
    }

    use tauri_plugin_dialog::DialogExt;
    let suggested = format!("{table}.sql");
    let path = app
        .dialog()
        .file()
        .set_title("Export table")
        .set_file_name(&suggested)
        .add_filter("SQL", &["sql"])
        .blocking_save_file()
        .ok_or_else(|| AppError::Transfer("export cancelled".into()))?;
    let dest = path.to_string();

    let mut w = std::io::BufWriter::new(std::fs::File::create(&dest)?);
    writeln!(
        w,
        "-- HuginnDB export of {connection_id}.{table} — {}\n",
        chrono::Utc::now().to_rfc3339()
    )?;

    match pool {
        DbPool::MsSql(_) => {
            return Err(AppError::UnsupportedDriver(
                "table export is not supported for SQL Server yet".into(),
            ))
        }
        DbPool::Postgres(p) => export_pg(&mut w, &p, &tables, DataMode::Insert).await?,
        DbPool::Mysql(p) => export_mysql(&mut w, &p, &tables, DataMode::Insert).await?,
        DbPool::Sqlite(p) => {
            export_sqlite(
                &mut w,
                &p,
                Some(std::slice::from_ref(&table)),
                DataMode::Insert,
            )
            .await?
        }
        DbPool::Mongo(_) => unreachable!("rejected above"),
    }
    w.flush()?;
    Ok(dest)
}

/// Export the rows of `schema.table` matching `filters`/`search` as `INSERT`
/// statements, without any DDL — the filtered-data counterpart of
/// [`export_table`], driven by the same [`ColumnFilter`] shape the DataGrid's
/// advanced filter already builds. No pagination limit: every matching row
/// is written, not just the current page. Rejects MongoDB.
#[allow(clippy::too_many_arguments)]
#[tauri::command]
pub async fn export_table_rows(
    app: AppHandle,
    state: State<'_, AppState>,
    connection_id: String,
    schema: Option<String>,
    table: String,
    filters: Vec<ColumnFilter>,
    search: Option<String>,
    search_columns: Option<Vec<String>>,
) -> AppResult<String> {
    let pool = pool_for(state.inner(), &connection_id)?;
    if matches!(&pool, DbPool::Mongo(_)) {
        return Err(AppError::InvalidInput(
            "row export is not supported for MongoDB here; use \"Export collection\" instead"
                .into(),
        ));
    }
    if matches!(&pool, DbPool::MsSql(_)) {
        return Err(AppError::UnsupportedDriver(
            "row export is not supported for SQL Server yet".into(),
        ));
    }
    let dialect = Dialect::try_of(&pool)?;
    let search_columns = search_columns.unwrap_or_default();
    let search_ref = search.as_deref().filter(|s| !s.is_empty());
    let (where_clause, binds, _) =
        build_filter_clause_at(1, dialect, &filters, search_ref, &search_columns);
    let qt = dialect.qualify(schema.as_deref(), &table);
    let select_sql = format!("SELECT * FROM {qt}{where_clause}");

    use tauri_plugin_dialog::DialogExt;
    let suggested = format!("{table}_rows.sql");
    let path = app
        .dialog()
        .file()
        .set_title("Export query results")
        .set_file_name(&suggested)
        .add_filter("SQL", &["sql"])
        .blocking_save_file()
        .ok_or_else(|| AppError::Transfer("export cancelled".into()))?;
    let dest = path.to_string();

    let mut w = std::io::BufWriter::new(std::fs::File::create(&dest)?);
    writeln!(
        w,
        "-- HuginnDB filtered export of {connection_id}.{table} — {}\n",
        chrono::Utc::now().to_rfc3339()
    )?;

    // No `TableStructure` is available here (this is a plain filtered
    // `SELECT *`, not a table dump), so the quoted column list comes from the
    // fetched rows' own metadata — the same technique `export_sqlite` already
    // uses for its per-row dump.
    match &pool {
        DbPool::MsSql(_) => unreachable!("sql server rejected above"),
        DbPool::Postgres(p) => {
            let mut q = sqlx::query(&select_sql);
            for b in &binds {
                q = q.bind(b);
            }
            let rows = q.fetch_all(p).await?;
            if !rows.is_empty() {
                let quoted_cols: Vec<String> = rows[0]
                    .columns()
                    .iter()
                    .map(|c| Dialect::Postgres.quote_ident(c.name()))
                    .collect();
                let literal_rows: Vec<Vec<String>> = rows
                    .iter()
                    .map(|row| (0..quoted_cols.len()).map(|i| pg_literal(row, i)).collect())
                    .collect();
                for stmt in build_insert_statements(&qt, &quoted_cols, &literal_rows, BATCH_SIZE) {
                    writeln!(w, "{stmt};\n")?;
                }
            }
        }
        DbPool::Mysql(p) => {
            let mut q = sqlx::query(&select_sql);
            for b in &binds {
                q = q.bind(b);
            }
            let rows = q.fetch_all(p).await?;
            if !rows.is_empty() {
                let quoted_cols: Vec<String> = rows[0]
                    .columns()
                    .iter()
                    .map(|c| Dialect::Mysql.quote_ident(c.name()))
                    .collect();
                let literal_rows: Vec<Vec<String>> = rows
                    .iter()
                    .map(|row| {
                        (0..quoted_cols.len())
                            .map(|i| mysql_literal(row, i))
                            .collect()
                    })
                    .collect();
                for stmt in build_insert_statements(&qt, &quoted_cols, &literal_rows, BATCH_SIZE) {
                    writeln!(w, "{stmt};\n")?;
                }
            }
        }
        DbPool::Sqlite(p) => {
            let mut q = sqlx::query(&select_sql);
            for b in &binds {
                q = q.bind(b);
            }
            let rows = q.fetch_all(p).await?;
            if !rows.is_empty() {
                let quoted_cols: Vec<String> = rows[0]
                    .columns()
                    .iter()
                    .map(|c| Dialect::Sqlite.quote_ident(c.name()))
                    .collect();
                let literal_rows: Vec<Vec<String>> = rows
                    .iter()
                    .map(|row| {
                        (0..quoted_cols.len())
                            .map(|i| sqlite_literal(row, i))
                            .collect()
                    })
                    .collect();
                for stmt in build_insert_statements(&qt, &quoted_cols, &literal_rows, BATCH_SIZE) {
                    writeln!(w, "{stmt};\n")?;
                }
            }
        }
        DbPool::Mongo(_) => unreachable!("rejected above"),
    }
    w.flush()?;
    Ok(dest)
}

// ---------------------------------------------------------------------------
// Postgres
// ---------------------------------------------------------------------------

struct CachedTable {
    create: String,
    tail: Vec<String>,
    structure: TableStructure,
    qt: String,
}

async fn export_pg(
    w: &mut impl Write,
    pool: &sqlx::PgPool,
    tables: &[TableInfo],
    data_mode: DataMode,
) -> AppResult<()> {
    let mut cached = Vec::with_capacity(tables.len());
    for t in tables {
        // `build_create` (not `build_ddl`) deliberately skips
        // `validate_structure`'s default-expression allowlist, which exists
        // to gate *user-typed* structure-editor input — catalog-sourced
        // defaults (e.g. Postgres's `'foo'::text` cast-style defaults) are
        // common and would otherwise be rejected outright.
        let structure = pg_structure(pool, Some(t.schema.clone()), t.name.clone()).await?;
        let mut stmts = build_create(Dialect::Postgres, &structure)?;
        let create = stmts.remove(0);
        let qt = Dialect::Postgres.qualify(structure.schema.as_deref(), &structure.name);
        cached.push(CachedTable {
            create,
            tail: stmts,
            structure,
            qt,
        });
    }

    for c in &cached {
        writeln!(w, "{};\n", c.create)?;
    }

    for c in &cached {
        let quoted_cols: Vec<String> = c
            .structure
            .columns
            .iter()
            .map(|col| Dialect::Postgres.quote_ident(&col.name))
            .collect();
        let auto_idx = c
            .structure
            .columns
            .iter()
            .position(|col| col.auto_increment);

        let rows = sqlx::query(&format!("SELECT * FROM {}", c.qt))
            .fetch_all(pool)
            .await?;
        let mut max_val: Option<i64> = None;
        let literal_rows: Vec<Vec<String>> = rows
            .iter()
            .map(|row| {
                if let Some(i) = auto_idx {
                    if let Ok(v) = row.try_get::<i64, _>(i) {
                        max_val = Some(max_val.map_or(v, |m| m.max(v)));
                    }
                }
                (0..quoted_cols.len()).map(|i| pg_literal(row, i)).collect()
            })
            .collect();

        if data_mode == DataMode::TruncateInsert {
            writeln!(w, "DELETE FROM {};\n", c.qt)?;
        }
        for stmt in build_insert_statements(&c.qt, &quoted_cols, &literal_rows, BATCH_SIZE) {
            writeln!(w, "{stmt};\n")?;
        }
        if let (Some(i), Some(max_val)) = (auto_idx, max_val) {
            let unquoted_table = match &c.structure.schema {
                Some(s) if !s.is_empty() => format!("{s}.{}", c.structure.name),
                _ => c.structure.name.clone(),
            };
            let col_name = &c.structure.columns[i].name;
            writeln!(
                w,
                "{};\n",
                pg_sequence_resync_stmt(&unquoted_table, col_name, max_val)
            )?;
        }
    }

    for c in &cached {
        for stmt in &c.tail {
            writeln!(w, "{stmt};\n")?;
        }
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// MySQL
// ---------------------------------------------------------------------------

async fn export_mysql(
    w: &mut impl Write,
    pool: &sqlx::MySqlPool,
    tables: &[TableInfo],
    data_mode: DataMode,
) -> AppResult<()> {
    let mut cached = Vec::with_capacity(tables.len());
    for t in tables {
        let structure = mysql_structure(pool, Some(t.schema.clone()), t.name.clone()).await?;
        let mut stmts = build_create(Dialect::Mysql, &structure)?;
        let create = stmts.remove(0);
        let qt = Dialect::Mysql.qualify(None, &structure.name);
        cached.push(CachedTable {
            create,
            tail: stmts,
            structure,
            qt,
        });
    }

    for c in &cached {
        writeln!(w, "{};\n", c.create)?;
    }

    for c in &cached {
        let quoted_cols: Vec<String> = c
            .structure
            .columns
            .iter()
            .map(|col| Dialect::Mysql.quote_ident(&col.name))
            .collect();
        let auto_idx = c
            .structure
            .columns
            .iter()
            .position(|col| col.auto_increment);

        let rows = sqlx::query(&format!("SELECT * FROM {}", c.qt))
            .fetch_all(pool)
            .await?;
        let mut max_val: Option<i64> = None;
        let literal_rows: Vec<Vec<String>> = rows
            .iter()
            .map(|row| {
                if let Some(i) = auto_idx {
                    if let Ok(v) = row.try_get::<i64, _>(i) {
                        max_val = Some(max_val.map_or(v, |m| m.max(v)));
                    }
                }
                (0..quoted_cols.len())
                    .map(|i| mysql_literal(row, i))
                    .collect()
            })
            .collect();

        if data_mode == DataMode::TruncateInsert {
            writeln!(w, "DELETE FROM {};\n", c.qt)?;
        }
        for stmt in build_insert_statements(&c.qt, &quoted_cols, &literal_rows, BATCH_SIZE) {
            writeln!(w, "{stmt};\n")?;
        }
        if let Some(max_val) = max_val {
            writeln!(w, "{};\n", mysql_auto_increment_resync_stmt(&c.qt, max_val))?;
        }
    }

    for c in &cached {
        for stmt in &c.tail {
            writeln!(w, "{stmt};\n")?;
        }
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// SQLite
// ---------------------------------------------------------------------------

/// `table_filter` scopes the dump to the named tables (used by
/// [`export_table`] with one name, [`export_databases`] with the export
/// dialog's per-database checkbox subset); `None` dumps every table.
async fn export_sqlite(
    w: &mut impl Write,
    pool: &sqlx::SqlitePool,
    table_filter: Option<&[String]>,
    data_mode: DataMode,
) -> AppResult<()> {
    // `sqlx::query` takes a runtime `&str` (not the compile-time-checked
    // `query!` macro), so the `IN (?, ?, …)` placeholder list can be built to
    // match the filter's length rather than hard-coding an arity.
    let placeholders = |n: usize| (0..n).map(|_| "?").collect::<Vec<_>>().join(", ");

    let table_sql = match table_filter {
        Some(names) => format!(
            "SELECT name, sql FROM sqlite_master \
             WHERE type = 'table' AND sql IS NOT NULL AND name NOT LIKE 'sqlite_%' \
             AND name IN ({}) ORDER BY name",
            placeholders(names.len())
        ),
        None => "SELECT name, sql FROM sqlite_master \
             WHERE type = 'table' AND sql IS NOT NULL AND name NOT LIKE 'sqlite_%' \
             ORDER BY name"
            .to_string(),
    };
    let mut tq = sqlx::query(&table_sql);
    if let Some(names) = table_filter {
        for n in names {
            tq = tq.bind(n);
        }
    }
    let table_rows = tq.fetch_all(pool).await?;

    let index_sql = match table_filter {
        Some(names) => format!(
            "SELECT sql FROM sqlite_master \
             WHERE type = 'index' AND sql IS NOT NULL AND name NOT LIKE 'sqlite_%' \
             AND tbl_name IN ({}) ORDER BY name",
            placeholders(names.len())
        ),
        None => "SELECT sql FROM sqlite_master \
             WHERE type = 'index' AND sql IS NOT NULL AND name NOT LIKE 'sqlite_%' \
             ORDER BY name"
            .to_string(),
    };
    let mut iq = sqlx::query(&index_sql);
    if let Some(names) = table_filter {
        for n in names {
            iq = iq.bind(n);
        }
    }
    let index_rows = iq.fetch_all(pool).await?;

    writeln!(w, "PRAGMA foreign_keys=OFF;\n")?;
    for r in &table_rows {
        let sql: String = r.get("sql");
        writeln!(w, "{sql};\n")?;
    }

    for r in &table_rows {
        let name: String = r.get("name");
        let quoted = Dialect::Sqlite.quote_ident(&name);
        let rows = sqlx::query(&format!("SELECT * FROM {quoted}"))
            .fetch_all(pool)
            .await?;
        if data_mode == DataMode::TruncateInsert {
            writeln!(w, "DELETE FROM {quoted};\n")?;
        }
        if rows.is_empty() {
            continue;
        }
        // No `TableStructure` is built for SQLite (schema is dumped verbatim
        // from `sqlite_master`), so the column list comes straight from the
        // fetched rows' own metadata instead.
        let quoted_cols: Vec<String> = rows[0]
            .columns()
            .iter()
            .map(|c| Dialect::Sqlite.quote_ident(c.name()))
            .collect();
        let literal_rows: Vec<Vec<String>> = rows
            .iter()
            .map(|row| {
                (0..quoted_cols.len())
                    .map(|i| sqlite_literal(row, i))
                    .collect()
            })
            .collect();
        for stmt in build_insert_statements(&quoted, &quoted_cols, &literal_rows, BATCH_SIZE) {
            writeln!(w, "{stmt};\n")?;
        }
    }

    for r in &index_rows {
        let sql: String = r.get("sql");
        writeln!(w, "{sql};\n")?;
    }
    writeln!(w, "PRAGMA foreign_keys=ON;\n")?;
    Ok(())
}
