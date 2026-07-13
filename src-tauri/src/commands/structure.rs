//! Table-structure editor commands: read a table's full structure, and
//! preview / apply DDL changes built by [`crate::db::ddl`].
//!
//! Introspection here is a superset of [`crate::commands::schema::list_columns`]
//! — it additionally returns column defaults, auto-increment flags, composite
//! foreign keys and indexes, everything the visual editor needs to round-trip a
//! table. The lean `list_columns` shape stays untouched for the explorer tree.

use crate::db::ddl::{
    build_ddl, sqlite_rebuild_required, ColumnDef, Driver, ForeignKeyDef, IndexDef, TableStructure,
};
use crate::error::{AppError, AppResult};
use crate::state::{AppState, DbPool};
use serde::{Deserialize, Serialize};
use sqlx::Row;
use std::collections::BTreeMap;
use tauri::State;

fn pool_for(state: &AppState, id: &str) -> AppResult<DbPool> {
    state
        .connections
        .read()
        .get(id)
        .ok_or_else(|| AppError::NotConnected(id.to_string()))
}

fn driver_of(pool: &DbPool) -> Driver {
    match pool {
        DbPool::Postgres(_) => Driver::Postgres,
        DbPool::Mysql(_) => Driver::Mysql,
        DbPool::Sqlite(_) => Driver::Sqlite,
        // MongoDB has no SQL DDL driver; structure *editing* is not supported,
        // and the callers below guard against it before reaching `driver_of`.
        DbPool::Mongo(_) => unreachable!("mongo structure changes are rejected before driver_of"),
    }
}

// ---------------------------------------------------------------------------
// Introspection
// ---------------------------------------------------------------------------

/// Read the full editable structure of `schema.table`.
#[tauri::command]
pub async fn get_table_structure(
    state: State<'_, AppState>,
    connection_id: String,
    schema: Option<String>,
    table: String,
) -> AppResult<TableStructure> {
    get_table_structure_inner(state.inner(), &connection_id, schema, table).await
}

/// Borrowed-state core of [`get_table_structure`], reused by the headless MCP
/// `describe_table` tool.
pub async fn get_table_structure_inner(
    state: &AppState,
    connection_id: &str,
    schema: Option<String>,
    table: String,
) -> AppResult<TableStructure> {
    let pool = pool_for(state, connection_id)?;
    match pool {
        DbPool::Postgres(p) => pg_structure(&p, schema, table).await,
        DbPool::Mysql(p) => mysql_structure(&p, schema, table).await,
        DbPool::Sqlite(p) => sqlite_structure(&p, table).await,
        // Read-only structure for MongoDB: inferred fields + real indexes.
        DbPool::Mongo(conn) => crate::db::mongo::schema::table_structure(&conn, &table).await,
    }
}

pub(crate) async fn pg_structure(
    p: &sqlx::PgPool,
    schema: Option<String>,
    table: String,
) -> AppResult<TableStructure> {
    let schema = schema.unwrap_or_else(|| "public".into());
    let col_rows = sqlx::query(
        "SELECT c.column_name, c.is_nullable, c.column_default, \
                COALESCE(c.is_identity, 'NO') AS is_identity, \
                CASE WHEN c.character_maximum_length IS NOT NULL \
                     THEN c.data_type || '(' || c.character_maximum_length || ')' \
                     WHEN c.numeric_precision IS NOT NULL AND c.data_type IN ('numeric','decimal') \
                     THEN c.data_type || '(' || c.numeric_precision || ',' || COALESCE(c.numeric_scale,0) || ')' \
                     ELSE c.data_type END AS full_type, \
                EXISTS ( \
                    SELECT 1 FROM information_schema.table_constraints tc \
                    JOIN information_schema.key_column_usage k \
                      ON tc.constraint_name = k.constraint_name AND tc.table_schema = k.table_schema \
                    WHERE tc.constraint_type = 'PRIMARY KEY' \
                      AND tc.table_schema = c.table_schema AND tc.table_name = c.table_name \
                      AND k.column_name = c.column_name \
                ) AS is_pk \
         FROM information_schema.columns c \
         WHERE c.table_schema = $1 AND c.table_name = $2 \
         ORDER BY c.ordinal_position",
    )
    .bind(&schema)
    .bind(&table)
    .fetch_all(p)
    .await?;

    let columns = col_rows
        .into_iter()
        .map(|r| {
            let default: Option<String> = r.get("column_default");
            let is_identity = r.get::<String, _>("is_identity") == "YES";
            let auto = is_identity
                || default
                    .as_deref()
                    .map(|d| d.starts_with("nextval("))
                    .unwrap_or(false);
            // Hide serial/identity machinery from the default field — it's
            // represented by the auto_increment flag instead.
            let clean_default = match &default {
                Some(d) if d.starts_with("nextval(") => None,
                other => other.clone(),
            };
            let name: String = r.get("column_name");
            ColumnDef {
                original_name: Some(name.clone()),
                name,
                data_type: r.get::<String, _>("full_type"),
                nullable: r.get::<String, _>("is_nullable") == "YES",
                default: clean_default,
                is_primary_key: r.get::<bool, _>("is_pk"),
                auto_increment: auto,
            }
        })
        .collect();

    // Indexes (exclude the implicit PK index name pattern is engine-specific;
    // we keep them all — the editor shows them and the diff is name-based).
    let idx_rows = sqlx::query(
        "SELECT i.relname AS index_name, \
                array_agg(a.attname ORDER BY x.ordinality) AS columns, \
                ix.indisunique AS is_unique, ix.indisprimary AS is_primary \
         FROM pg_class t \
         JOIN pg_namespace n ON n.oid = t.relnamespace \
         JOIN pg_index ix ON ix.indrelid = t.oid \
         JOIN pg_class i ON i.oid = ix.indexrelid \
         JOIN unnest(ix.indkey) WITH ORDINALITY AS x(attnum, ordinality) ON true \
         JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = x.attnum \
         WHERE n.nspname = $1 AND t.relname = $2 \
         GROUP BY i.relname, ix.indisunique, ix.indisprimary",
    )
    .bind(&schema)
    .bind(&table)
    .fetch_all(p)
    .await?;
    let indexes = idx_rows
        .into_iter()
        .filter(|r| !r.get::<bool, _>("is_primary"))
        .map(|r| IndexDef {
            name: Some(r.get::<String, _>("index_name")),
            columns: r.get::<Vec<String>, _>("columns"),
            unique: r.get::<bool, _>("is_unique"),
        })
        .collect();

    // Composite-capable FK introspection.
    let fk_rows = sqlx::query(
        "SELECT con.conname AS name, \
                n2.nspname AS ref_schema, cl2.relname AS ref_table, \
                ARRAY( SELECT att.attname FROM unnest(con.conkey) WITH ORDINALITY AS k(attnum, ord) \
                       JOIN pg_attribute att ON att.attrelid = con.conrelid AND att.attnum = k.attnum \
                       ORDER BY k.ord ) AS cols, \
                ARRAY( SELECT att.attname FROM unnest(con.confkey) WITH ORDINALITY AS k(attnum, ord) \
                       JOIN pg_attribute att ON att.attrelid = con.confrelid AND att.attnum = k.attnum \
                       ORDER BY k.ord ) AS ref_cols, \
                con.confdeltype AS del, con.confupdtype AS upd \
         FROM pg_constraint con \
         JOIN pg_class cl ON cl.oid = con.conrelid \
         JOIN pg_namespace n ON n.oid = cl.relnamespace \
         JOIN pg_class cl2 ON cl2.oid = con.confrelid \
         JOIN pg_namespace n2 ON n2.oid = cl2.relnamespace \
         WHERE con.contype = 'f' AND n.nspname = $1 AND cl.relname = $2",
    )
    .bind(&schema)
    .bind(&table)
    .fetch_all(p)
    .await?;
    let foreign_keys = fk_rows
        .into_iter()
        .map(|r| ForeignKeyDef {
            name: Some(r.get::<String, _>("name")),
            columns: r.get::<Vec<String>, _>("cols"),
            ref_schema: r.get::<Option<String>, _>("ref_schema"),
            ref_table: r.get::<String, _>("ref_table"),
            ref_columns: r.get::<Vec<String>, _>("ref_cols"),
            on_delete: pg_action(r.get::<String, _>("del")),
            on_update: pg_action(r.get::<String, _>("upd")),
        })
        .collect();

    Ok(TableStructure {
        schema: Some(schema),
        name: table,
        columns,
        indexes,
        foreign_keys,
    })
}

fn pg_action(code: String) -> Option<String> {
    match code.as_str() {
        "a" => None, // NO ACTION (default) — omit
        "r" => Some("RESTRICT".into()),
        "c" => Some("CASCADE".into()),
        "n" => Some("SET NULL".into()),
        "d" => Some("SET DEFAULT".into()),
        _ => None,
    }
}

pub(crate) async fn mysql_structure(
    p: &sqlx::MySqlPool,
    schema: Option<String>,
    table: String,
) -> AppResult<TableStructure> {
    let schema_arg = schema.unwrap_or_default();
    let col_rows = sqlx::query(
        "SELECT column_name, column_type, is_nullable, column_default, column_key, extra \
         FROM information_schema.columns \
         WHERE table_schema = COALESCE(NULLIF(?, ''), DATABASE()) AND table_name = ? \
         ORDER BY ordinal_position",
    )
    .bind(&schema_arg)
    .bind(&table)
    .fetch_all(p)
    .await?;
    let columns = col_rows
        .into_iter()
        .map(|r| {
            let extra: String = r.get::<Option<String>, _>("extra").unwrap_or_default();
            let name: String = r.get("column_name");
            ColumnDef {
                original_name: Some(name.clone()),
                name,
                data_type: r.get::<String, _>("column_type"),
                nullable: r.get::<String, _>("is_nullable") == "YES",
                default: r.get::<Option<String>, _>("column_default"),
                is_primary_key: r.get::<String, _>("column_key") == "PRI",
                auto_increment: extra.to_lowercase().contains("auto_increment"),
            }
        })
        .collect();

    // Indexes (skip PRIMARY).
    let idx_rows = sqlx::query(
        "SELECT index_name, column_name, non_unique \
         FROM information_schema.statistics \
         WHERE table_schema = COALESCE(NULLIF(?, ''), DATABASE()) AND table_name = ? \
         ORDER BY index_name, seq_in_index",
    )
    .bind(&schema_arg)
    .bind(&table)
    .fetch_all(p)
    .await?;
    let mut grouped: BTreeMap<String, (Vec<String>, bool)> = BTreeMap::new();
    for r in idx_rows {
        let name: String = r.get("index_name");
        if name == "PRIMARY" {
            continue;
        }
        let col: String = r.get("column_name");
        let non_unique: i64 = r.get("non_unique");
        let e = grouped
            .entry(name)
            .or_insert_with(|| (Vec::new(), non_unique == 0));
        e.0.push(col);
    }
    let indexes = grouped
        .into_iter()
        .map(|(name, (cols, unique))| IndexDef {
            name: Some(name),
            columns: cols,
            unique,
        })
        .collect();

    // FKs (composite-capable), grouped by constraint name.
    let fk_rows = sqlx::query(
        "SELECT k.constraint_name, k.column_name, \
                k.referenced_table_schema AS ref_schema, \
                k.referenced_table_name AS ref_table, \
                k.referenced_column_name AS ref_column, \
                rc.delete_rule, rc.update_rule \
         FROM information_schema.key_column_usage k \
         JOIN information_schema.referential_constraints rc \
           ON rc.constraint_name = k.constraint_name \
          AND rc.constraint_schema = k.table_schema \
         WHERE k.table_schema = COALESCE(NULLIF(?, ''), DATABASE()) \
           AND k.table_name = ? AND k.referenced_table_name IS NOT NULL \
         ORDER BY k.constraint_name, k.ordinal_position",
    )
    .bind(&schema_arg)
    .bind(&table)
    .fetch_all(p)
    .await?;
    let mut fk_groups: BTreeMap<String, ForeignKeyDef> = BTreeMap::new();
    for r in fk_rows {
        let cname: String = r.get("constraint_name");
        let entry = fk_groups
            .entry(cname.clone())
            .or_insert_with(|| ForeignKeyDef {
                name: Some(cname),
                columns: vec![],
                ref_schema: r.get::<Option<String>, _>("ref_schema"),
                ref_table: r.get::<String, _>("ref_table"),
                ref_columns: vec![],
                on_delete: rule_to_action(r.get::<Option<String>, _>("delete_rule")),
                on_update: rule_to_action(r.get::<Option<String>, _>("update_rule")),
            });
        entry.columns.push(r.get::<String, _>("column_name"));
        if let Some(rc) = r.get::<Option<String>, _>("ref_column") {
            entry.ref_columns.push(rc);
        }
    }

    Ok(TableStructure {
        schema: if schema_arg.is_empty() {
            None
        } else {
            Some(schema_arg)
        },
        name: table,
        columns,
        indexes,
        foreign_keys: fk_groups.into_values().collect(),
    })
}

fn rule_to_action(rule: Option<String>) -> Option<String> {
    match rule.as_deref() {
        Some("NO ACTION") | None => None,
        Some(other) => Some(other.to_string()),
    }
}

async fn sqlite_structure(p: &sqlx::SqlitePool, table: String) -> AppResult<TableStructure> {
    let q = format!("PRAGMA table_info(\"{}\")", table.replace('"', "\"\""));
    let rows = sqlx::query(&q).fetch_all(p).await?;
    // Detect AUTOINCREMENT from the stored CREATE statement (PRAGMA doesn't
    // expose it).
    let create_sql: Option<String> =
        sqlx::query("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?")
            .bind(&table)
            .fetch_optional(p)
            .await?
            .and_then(|r| r.get::<Option<String>, _>("sql"));
    let has_autoincrement = create_sql
        .as_deref()
        .map(|s| s.to_uppercase().contains("AUTOINCREMENT"))
        .unwrap_or(false);

    let columns: Vec<ColumnDef> = rows
        .into_iter()
        .map(|r| {
            let name: String = r.get("name");
            let is_pk = r.get::<i64, _>("pk") > 0;
            let ty: String = r.get("type");
            // INTEGER PRIMARY KEY is SQLite's rowid alias; mark auto when the
            // table declared AUTOINCREMENT.
            let auto = is_pk && has_autoincrement && ty.to_uppercase().contains("INT");
            let default: Option<String> =
                r.try_get::<Option<String>, _>("dflt_value").ok().flatten();
            ColumnDef {
                original_name: Some(name.clone()),
                name,
                data_type: ty,
                nullable: r.get::<i64, _>("notnull") == 0,
                default,
                is_primary_key: is_pk,
                auto_increment: auto,
            }
        })
        .collect();

    // Indexes (skip auto-created PK/unique-from-constraint where origin != 'c').
    let il = format!("PRAGMA index_list(\"{}\")", table.replace('"', "\"\""));
    let idx_rows = sqlx::query(&il).fetch_all(p).await?;
    let mut indexes = Vec::new();
    for r in idx_rows {
        let origin: String = r.try_get("origin").unwrap_or_else(|_| "c".into());
        if origin != "c" {
            continue; // skip indexes auto-made for PK / UNIQUE constraints
        }
        let name: String = r.get("name");
        let unique: i64 = r.get("unique");
        let ii = format!("PRAGMA index_info(\"{}\")", name.replace('"', "\"\""));
        let cols_rows = sqlx::query(&ii).fetch_all(p).await?;
        let cols: Vec<String> = cols_rows.into_iter().map(|c| c.get("name")).collect();
        indexes.push(IndexDef {
            name: Some(name),
            columns: cols,
            unique: unique != 0,
        });
    }

    // FKs (composite-capable), grouped by id.
    let fl = format!(
        "PRAGMA foreign_key_list(\"{}\")",
        table.replace('"', "\"\"")
    );
    let fk_rows = sqlx::query(&fl).fetch_all(p).await?;
    let mut fk_groups: BTreeMap<i64, ForeignKeyDef> = BTreeMap::new();
    for r in fk_rows {
        let id: i64 = r.get("id");
        let from: String = r.get("from");
        let to: Option<String> = r.try_get("to").ok().flatten();
        let target: String = r.get("table");
        let on_delete: Option<String> = r.try_get("on_delete").ok();
        let on_update: Option<String> = r.try_get("on_update").ok();
        let entry = fk_groups.entry(id).or_insert_with(|| ForeignKeyDef {
            name: None,
            columns: vec![],
            ref_schema: None,
            ref_table: target,
            ref_columns: vec![],
            on_delete: rule_to_action(on_delete),
            on_update: rule_to_action(on_update),
        });
        entry.columns.push(from);
        if let Some(t) = to {
            entry.ref_columns.push(t);
        }
    }

    Ok(TableStructure {
        schema: None,
        name: table,
        columns,
        indexes,
        foreign_keys: fk_groups.into_values().collect(),
    })
}

// ---------------------------------------------------------------------------
// Preview / apply
// ---------------------------------------------------------------------------

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StructurePreview {
    /// The ordered DDL statements that would run.
    pub statements: Vec<String>,
    /// True when applying this on SQLite rebuilds the table (drop + recreate),
    /// which the UI flags as a destructive confirmation.
    pub rebuild: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StructureChangeArgs {
    pub connection_id: String,
    #[serde(default)]
    pub original: Option<TableStructure>,
    pub desired: TableStructure,
}

#[tauri::command]
pub async fn preview_structure_change(
    state: State<'_, AppState>,
    args: StructureChangeArgs,
) -> AppResult<StructurePreview> {
    let pool = pool_for(state.inner(), &args.connection_id)?;
    if matches!(&pool, DbPool::Mongo(_)) {
        return Err(AppError::InvalidInput(
            "structure editing is not supported on MongoDB in this version".into(),
        ));
    }
    let driver = driver_of(&pool);
    let statements = build_ddl(driver, args.original.as_ref(), &args.desired)?;
    let rebuild =
        driver == Driver::Sqlite && sqlite_rebuild_required(args.original.as_ref(), &args.desired);
    Ok(StructurePreview {
        statements,
        rebuild,
    })
}

#[tauri::command]
pub async fn apply_structure_change(
    state: State<'_, AppState>,
    args: StructureChangeArgs,
) -> AppResult<()> {
    let pool = pool_for(state.inner(), &args.connection_id)?;
    if matches!(&pool, DbPool::Mongo(_)) {
        return Err(AppError::InvalidInput(
            "structure editing is not supported on MongoDB in this version".into(),
        ));
    }
    let driver = driver_of(&pool);
    let statements = build_ddl(driver, args.original.as_ref(), &args.desired)?;

    match &pool {
        DbPool::Postgres(p) => {
            // PG DDL is transactional — wrap the lot.
            let mut tx = p.begin().await?;
            for stmt in &statements {
                sqlx::query(stmt).execute(&mut *tx).await?;
            }
            tx.commit().await?;
        }
        DbPool::Mysql(p) => {
            // MySQL DDL is non-transactional (implicit commits). Run in order;
            // a mid-sequence failure may leave partial changes — surfaced to
            // the user by the error and the editor re-reading the structure.
            for stmt in &statements {
                sqlx::query(stmt).execute(p).await?;
            }
        }
        DbPool::Sqlite(p) => {
            // The SQLite rebuild emits its own BEGIN/COMMIT semantics via the
            // statement list, and PRAGMA foreign_keys must run outside a
            // transaction — so we execute each statement directly rather than
            // wrapping in our own tx.
            for stmt in &statements {
                sqlx::query(stmt).execute(p).await?;
            }
        }
        DbPool::Mongo(_) => unreachable!("mongo rejected above"),
    }
    Ok(())
}
