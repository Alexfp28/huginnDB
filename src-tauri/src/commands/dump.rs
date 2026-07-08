//! Whole-database export and the one backend primitive the import flow needs.
//!
//! `export_database` streams a portable `.sql` dump (schema + data) for the
//! target database of a connection. `read_text_file` is intentionally the
//! *only* backend piece import needs: the frontend re-runs the picked file
//! through the existing query batch runner (`splitSql` + `execute_batch` in
//! `src/lib/sqlSplit.ts` / `commands::query::execute_batch`) instead of a
//! second, parallel execution path here (see `SchemaExplorer.tsx`'s
//! "Import .sql…" handler).
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

use crate::commands::schema::list_tables;
use crate::commands::structure::{mysql_structure, pg_structure};
use crate::db::ddl::{build_create, Driver, TableStructure};
use crate::db::dump::{
    build_insert_statements, mysql_auto_increment_resync_stmt, mysql_literal, pg_literal,
    pg_sequence_resync_stmt, sqlite_literal,
};
use crate::db::sql::quote_ident;
use crate::error::{AppError, AppResult};
use crate::state::{AppState, DbPool};
use sqlx::{Column, Row};
use std::io::Write;
use tauri::{AppHandle, State};

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

fn qualified_name(pg_or_sqlite: bool, schema: Option<&str>, table: &str) -> String {
    match schema {
        Some(s) if !s.is_empty() => format!(
            "{}.{}",
            quote_ident(pg_or_sqlite, s),
            quote_ident(pg_or_sqlite, table)
        ),
        _ => quote_ident(pg_or_sqlite, table),
    }
}

/// Export the target database of `connection_id` to a user-chosen `.sql`
/// file. Rejects MongoDB (out of scope — no SQL DDL/dump to speak of).
#[tauri::command]
pub async fn export_database(
    app: AppHandle,
    state: State<'_, AppState>,
    connection_id: String,
) -> AppResult<String> {
    let pool = pool_for(state.inner(), &connection_id)?;
    if matches!(&pool, DbPool::Mongo(_)) {
        return Err(AppError::InvalidInput(
            "database export is not supported for MongoDB".into(),
        ));
    }

    let tables: Vec<_> = list_tables(state, connection_id.clone(), None)
        .await?
        .into_iter()
        .filter(|t| t.kind == "table")
        .collect();

    use tauri_plugin_dialog::DialogExt;
    let suggested = format!("{}.sql", connection_id.replace("::db::", "_"));
    let path = app
        .dialog()
        .file()
        .set_title("Export database")
        .set_file_name(&suggested)
        .add_filter("SQL", &["sql"])
        .blocking_save_file()
        .ok_or_else(|| AppError::Transfer("export cancelled".into()))?;
    let dest = path.to_string();

    let mut w = std::io::BufWriter::new(std::fs::File::create(&dest)?);
    writeln!(
        w,
        "-- HuginnDB export of {connection_id} — {}\n",
        chrono::Utc::now().to_rfc3339()
    )?;

    match pool {
        DbPool::Postgres(p) => export_pg(&mut w, &p, &tables).await?,
        DbPool::Mysql(p) => export_mysql(&mut w, &p, &tables).await?,
        DbPool::Sqlite(p) => export_sqlite(&mut w, &p).await?,
        DbPool::Mongo(_) => unreachable!("rejected above"),
    }
    w.flush()?;
    Ok(dest)
}

/// Reads a text file for the frontend-driven import flow (see module docs).
#[tauri::command]
pub fn read_text_file(file_path: String) -> AppResult<String> {
    Ok(std::fs::read_to_string(&file_path)?)
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
    tables: &[crate::commands::schema::TableInfo],
) -> AppResult<()> {
    let mut cached = Vec::with_capacity(tables.len());
    for t in tables {
        // `build_create` (not `build_ddl`) deliberately skips
        // `validate_structure`'s default-expression allowlist, which exists
        // to gate *user-typed* structure-editor input — catalog-sourced
        // defaults (e.g. Postgres's `'foo'::text` cast-style defaults) are
        // common and would otherwise be rejected outright.
        let structure = pg_structure(pool, Some(t.schema.clone()), t.name.clone()).await?;
        let mut stmts = build_create(Driver::Postgres, &structure)?;
        let create = stmts.remove(0);
        let qt = qualified_name(true, structure.schema.as_deref(), &structure.name);
        cached.push(CachedTable { create, tail: stmts, structure, qt });
    }

    for c in &cached {
        writeln!(w, "{};\n", c.create)?;
    }

    for c in &cached {
        let quoted_cols: Vec<String> = c
            .structure
            .columns
            .iter()
            .map(|col| quote_ident(true, &col.name))
            .collect();
        let auto_idx = c.structure.columns.iter().position(|col| col.auto_increment);

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
    tables: &[crate::commands::schema::TableInfo],
) -> AppResult<()> {
    let mut cached = Vec::with_capacity(tables.len());
    for t in tables {
        let structure = mysql_structure(pool, Some(t.schema.clone()), t.name.clone()).await?;
        let mut stmts = build_create(Driver::Mysql, &structure)?;
        let create = stmts.remove(0);
        let qt = qualified_name(false, None, &structure.name);
        cached.push(CachedTable { create, tail: stmts, structure, qt });
    }

    for c in &cached {
        writeln!(w, "{};\n", c.create)?;
    }

    for c in &cached {
        let quoted_cols: Vec<String> = c
            .structure
            .columns
            .iter()
            .map(|col| quote_ident(false, &col.name))
            .collect();
        let auto_idx = c.structure.columns.iter().position(|col| col.auto_increment);

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

async fn export_sqlite(w: &mut impl Write, pool: &sqlx::SqlitePool) -> AppResult<()> {
    let table_rows = sqlx::query(
        "SELECT name, sql FROM sqlite_master \
         WHERE type = 'table' AND sql IS NOT NULL AND name NOT LIKE 'sqlite_%' \
         ORDER BY name",
    )
    .fetch_all(pool)
    .await?;
    let index_rows = sqlx::query(
        "SELECT sql FROM sqlite_master \
         WHERE type = 'index' AND sql IS NOT NULL AND name NOT LIKE 'sqlite_%' \
         ORDER BY name",
    )
    .fetch_all(pool)
    .await?;

    writeln!(w, "PRAGMA foreign_keys=OFF;\n")?;
    for r in &table_rows {
        let sql: String = r.get("sql");
        writeln!(w, "{sql};\n")?;
    }

    for r in &table_rows {
        let name: String = r.get("name");
        let quoted = quote_ident(true, &name);
        let rows = sqlx::query(&format!("SELECT * FROM {quoted}"))
            .fetch_all(pool)
            .await?;
        if rows.is_empty() {
            continue;
        }
        // No `TableStructure` is built for SQLite (schema is dumped verbatim
        // from `sqlite_master`), so the column list comes straight from the
        // fetched rows' own metadata instead.
        let quoted_cols: Vec<String> = rows[0]
            .columns()
            .iter()
            .map(|c| quote_ident(true, c.name()))
            .collect();
        let literal_rows: Vec<Vec<String>> = rows
            .iter()
            .map(|row| (0..quoted_cols.len()).map(|i| sqlite_literal(row, i)).collect())
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
