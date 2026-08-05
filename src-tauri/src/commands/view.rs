//! View editor commands: read a view's definition, and preview / apply the
//! `CREATE VIEW` / `CREATE OR REPLACE VIEW` / rename / drop DDL built by
//! [`crate::db::view_ddl`]. Mirrors [`crate::commands::structure`]'s
//! introspect → preview → apply shape, but for views instead of tables.
//!
//! MongoDB has no `CREATE VIEW` equivalent (its "views" are read-only
//! aggregation-pipeline collections, edited via `collMod`/`createView` — a
//! fundamentally different model), so every command here rejects it up
//! front, matching [`crate::commands::structure`]'s existing Mongo guard.

use crate::db::sql::Dialect;
use crate::db::view_ddl::{build_view_ddl, ViewDefinition};
use crate::error::{AppError, AppResult};
use crate::state::{AppState, DbPool};
use serde::{Deserialize, Serialize};
use sqlx::Row;
use tauri::State;

fn pool_for(state: &AppState, id: &str) -> AppResult<DbPool> {
    state
        .connections
        .read()
        .get(id)
        .ok_or_else(|| AppError::NotConnected(id.to_string()))
}

// ---------------------------------------------------------------------------
// Introspection
// ---------------------------------------------------------------------------

/// SQLite's `sqlite_master.sql` for a view is the *whole* `CREATE VIEW name
/// AS SELECT ...` statement (unlike Postgres/MySQL, which expose just the
/// body). Strip the header so `ViewDefinition.query` is always "just the
/// SELECT" across drivers.
///
/// No SQL parser here (and no new `regex` dependency — CLAUDE.md asks that
/// new crates be discussed first, and this doesn't warrant one): SQLite's own
/// grammar for this statement is `CREATE [TEMP[ORARY]] VIEW [IF NOT EXISTS]
/// name [(col, ...)] AS select-stmt`, so the column list is the only thing
/// that can contain a nested "AS"-like substring, and column lists are bare
/// names with no expressions. Tracking paren depth and taking the first
/// whole-word "AS" at depth 0 is therefore exact for any statement SQLite
/// itself would have produced. Falls back to the raw text if no such "AS" is
/// found — better to hand back something editable than to block outright.
fn strip_sqlite_view_header(create_sql: &str) -> String {
    let upper = create_sql.to_ascii_uppercase();
    let chars: Vec<(usize, char)> = upper.char_indices().collect();
    let n = chars.len();
    let mut depth = 0i32;
    let mut idx = 0usize;
    let is_word = |c: char| c.is_ascii_alphanumeric() || c == '_';
    while idx < n {
        let c = chars[idx].1;
        if c == '(' {
            depth += 1;
        } else if c == ')' {
            depth -= 1;
        } else if depth == 0 && c == 'A' && idx + 1 < n && chars[idx + 1].1 == 'S' {
            let prev_ok = idx == 0 || !is_word(chars[idx - 1].1);
            let next_ok = idx + 2 >= n || !is_word(chars[idx + 2].1);
            if prev_ok && next_ok {
                let body_start = if idx + 2 < n {
                    chars[idx + 2].0
                } else {
                    upper.len()
                };
                return create_sql[body_start..].trim().to_string();
            }
        }
        idx += 1;
    }
    create_sql.trim().to_string()
}

#[tauri::command]
pub async fn get_view_definition(
    state: State<'_, AppState>,
    connection_id: String,
    schema: Option<String>,
    view: String,
) -> AppResult<ViewDefinition> {
    let pool = pool_for(state.inner(), &connection_id)?;
    Dialect::try_of(&pool)?;
    match pool {
        DbPool::Postgres(p) => {
            let schema = schema.unwrap_or_else(|| "public".into());
            let row = sqlx::query(
                "SELECT pg_get_viewdef(c.oid, true) AS def \
                 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace \
                 WHERE n.nspname = $1 AND c.relname = $2 AND c.relkind = 'v'",
            )
            .bind(&schema)
            .bind(&view)
            .fetch_optional(&p)
            .await?
            .ok_or_else(|| AppError::NotFound(format!("view {schema}.{view}")))?;
            let query: String = row.get("def");
            Ok(ViewDefinition {
                schema: Some(schema),
                name: view,
                query: query.trim().trim_end_matches(';').trim().to_string(),
            })
        }
        DbPool::Mysql(p) => {
            let schema_arg = schema.clone().unwrap_or_default();
            let row = sqlx::query(
                "SELECT VIEW_DEFINITION FROM information_schema.views \
                 WHERE TABLE_SCHEMA = COALESCE(NULLIF(?, ''), DATABASE()) AND TABLE_NAME = ?",
            )
            .bind(&schema_arg)
            .bind(&view)
            .fetch_optional(&p)
            .await?
            .ok_or_else(|| AppError::NotFound(format!("view {view}")))?;
            let query: String = row.get("VIEW_DEFINITION");
            Ok(ViewDefinition {
                schema,
                name: view,
                query: query.trim().to_string(),
            })
        }
        DbPool::Sqlite(p) => {
            let row = sqlx::query("SELECT sql FROM sqlite_master WHERE type = 'view' AND name = ?")
                .bind(&view)
                .fetch_optional(&p)
                .await?
                .ok_or_else(|| AppError::NotFound(format!("view {view}")))?;
            let create_sql: String = row.get("sql");
            Ok(ViewDefinition {
                schema: None,
                name: view,
                query: strip_sqlite_view_header(&create_sql),
            })
        }
        DbPool::Mongo(_) => unreachable!("mongo rejected by Dialect::try_of above"),
    }
}

// ---------------------------------------------------------------------------
// Preview / apply
// ---------------------------------------------------------------------------

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ViewPreview {
    pub statements: Vec<String>,
    pub drop_and_recreate: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ViewChangeArgs {
    pub connection_id: String,
    #[serde(default)]
    pub original: Option<ViewDefinition>,
    pub desired: ViewDefinition,
}

#[tauri::command]
pub async fn preview_view_change(
    state: State<'_, AppState>,
    args: ViewChangeArgs,
) -> AppResult<ViewPreview> {
    let pool = pool_for(state.inner(), &args.connection_id)?;
    let dialect = Dialect::try_of(&pool)?;
    let (statements, drop_and_recreate) =
        build_view_ddl(dialect, args.original.as_ref(), &args.desired)?;
    Ok(ViewPreview {
        statements,
        drop_and_recreate,
    })
}

#[tauri::command]
pub async fn apply_view_change(state: State<'_, AppState>, args: ViewChangeArgs) -> AppResult<()> {
    let pool = pool_for(state.inner(), &args.connection_id)?;
    let dialect = Dialect::try_of(&pool)?;
    let (statements, _) = build_view_ddl(dialect, args.original.as_ref(), &args.desired)?;

    match &pool {
        DbPool::Postgres(p) => {
            // View DDL is transactional on Postgres — wrap the (at most two)
            // statements so a mid-sequence failure can't leave a renamed view
            // with its old body, or vice versa.
            let mut tx = p.begin().await?;
            for stmt in &statements {
                sqlx::query(stmt).execute(&mut *tx).await?;
            }
            tx.commit().await?;
        }
        DbPool::Mysql(p) => {
            for stmt in &statements {
                sqlx::query(stmt).execute(p).await?;
            }
        }
        DbPool::Sqlite(p) => {
            for stmt in &statements {
                sqlx::query(stmt).execute(p).await?;
            }
        }
        DbPool::Mongo(_) => unreachable!("mongo rejected above"),
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Rename / drop
// ---------------------------------------------------------------------------

/// Rename a view. Postgres uses `ALTER VIEW ... RENAME TO`; MySQL treats
/// views and tables as the same namespace so `RENAME TABLE` works; SQLite
/// likewise accepts `ALTER TABLE ... RENAME TO` for a view.
#[tauri::command]
pub async fn rename_view(
    state: State<'_, AppState>,
    connection_id: String,
    schema: Option<String>,
    view: String,
    new_name: String,
) -> AppResult<()> {
    if new_name.trim().is_empty() {
        return Err(AppError::InvalidInput(
            "rename_view: new_name must not be empty".into(),
        ));
    }
    let pool = pool_for(state.inner(), &connection_id)?;
    let dialect = Dialect::try_of(&pool)?;
    let new_ident = dialect.quote_ident(new_name.trim());
    let sql = match dialect {
        Dialect::Postgres => format!(
            "ALTER VIEW {} RENAME TO {}",
            dialect.qualify_defaulted(schema.as_deref(), &view),
            new_ident
        ),
        Dialect::Mysql => match schema.as_deref() {
            Some(s) => format!(
                "RENAME TABLE {} TO {}.{}",
                dialect.qualify(Some(s), &view),
                dialect.quote_ident(s),
                new_ident
            ),
            None => format!(
                "RENAME TABLE {} TO {}",
                dialect.quote_ident(&view),
                new_ident
            ),
        },
        Dialect::Sqlite => format!(
            "ALTER TABLE {} RENAME TO {}",
            dialect.quote_ident(&view),
            new_ident
        ),
        // T-SQL renames through `EXEC sp_rename`, which also takes the new name
        // as a bare string rather than an identifier — part of the deferred
        // SQL Server view-editor work.
        Dialect::MsSql => {
            return Err(AppError::UnsupportedDriver(
                "renaming a view is not supported on SQL Server yet".into(),
            ))
        }
    };
    match &pool {
        DbPool::Postgres(p) => {
            sqlx::query(&sql).execute(p).await?;
        }
        DbPool::Mysql(p) => {
            sqlx::query(&sql).execute(p).await?;
        }
        DbPool::Sqlite(p) => {
            sqlx::query(&sql).execute(p).await?;
        }
        DbPool::Mongo(_) => unreachable!("mongo rejected by Dialect::try_of above"),
    }
    Ok(())
}

#[tauri::command]
pub async fn drop_view(
    state: State<'_, AppState>,
    connection_id: String,
    schema: Option<String>,
    view: String,
) -> AppResult<()> {
    let pool = pool_for(state.inner(), &connection_id)?;
    let dialect = Dialect::try_of(&pool)?;
    let qt = dialect.qualify_defaulted(schema.as_deref(), &view);
    let sql = format!("DROP VIEW {qt}");
    match &pool {
        DbPool::Postgres(p) => {
            sqlx::query(&sql).execute(p).await?;
        }
        DbPool::Mysql(p) => {
            sqlx::query(&sql).execute(p).await?;
        }
        DbPool::Sqlite(p) => {
            sqlx::query(&sql).execute(p).await?;
        }
        DbPool::Mongo(_) => unreachable!("mongo rejected by Dialect::try_of above"),
    }
    Ok(())
}
