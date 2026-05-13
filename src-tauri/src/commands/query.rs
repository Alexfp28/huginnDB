use crate::error::{AppError, AppResult};
use crate::state::{AppState, DbPool};
use serde::Serialize;
use serde_json::{json, Value};
use sqlx::{Column, Row, TypeInfo, ValueRef};
use std::time::Instant;
use tauri::State;

#[derive(Debug, Serialize)]
pub struct QueryResult {
    pub columns: Vec<ColumnMeta>,
    pub rows: Vec<Vec<Value>>,
    pub rows_affected: u64,
    pub elapsed_ms: u64,
    pub total: Option<u64>,
}

#[derive(Debug, Serialize)]
pub struct ColumnMeta {
    pub name: String,
    pub data_type: String,
}

fn pool_for(state: &AppState, id: &str) -> AppResult<DbPool> {
    state
        .connections
        .read()
        .get(id)
        .ok_or_else(|| AppError::NotConnected(id.to_string()))
}

fn pg_value(row: &sqlx::postgres::PgRow, idx: usize) -> Value {
    let raw = match row.try_get_raw(idx) {
        Ok(r) => r,
        Err(_) => return Value::Null,
    };
    if raw.is_null() {
        return Value::Null;
    }
    let ty = raw.type_info();
    let name = ty.name();
    match name {
        "BOOL" => row.try_get::<bool, _>(idx).map(Value::from).unwrap_or(Value::Null),
        "INT2" => row.try_get::<i16, _>(idx).map(|v| json!(v)).unwrap_or(Value::Null),
        "INT4" => row.try_get::<i32, _>(idx).map(|v| json!(v)).unwrap_or(Value::Null),
        "INT8" => row.try_get::<i64, _>(idx).map(|v| json!(v)).unwrap_or(Value::Null),
        "FLOAT4" => row.try_get::<f32, _>(idx).map(|v| json!(v)).unwrap_or(Value::Null),
        "FLOAT8" => row.try_get::<f64, _>(idx).map(|v| json!(v)).unwrap_or(Value::Null),
        "JSON" | "JSONB" => row.try_get::<Value, _>(idx).unwrap_or(Value::Null),
        "TIMESTAMP" => row
            .try_get::<chrono::NaiveDateTime, _>(idx)
            .map(|v| json!(v.to_string()))
            .unwrap_or(Value::Null),
        "TIMESTAMPTZ" => row
            .try_get::<chrono::DateTime<chrono::Utc>, _>(idx)
            .map(|v| json!(v.to_rfc3339()))
            .unwrap_or(Value::Null),
        "DATE" => row
            .try_get::<chrono::NaiveDate, _>(idx)
            .map(|v| json!(v.to_string()))
            .unwrap_or(Value::Null),
        "UUID" => row
            .try_get::<uuid::Uuid, _>(idx)
            .map(|v| json!(v.to_string()))
            .unwrap_or(Value::Null),
        "BYTEA" => row
            .try_get::<Vec<u8>, _>(idx)
            .map(|v| json!(format!("\\x{}", hex(&v))))
            .unwrap_or(Value::Null),
        _ => row
            .try_get::<String, _>(idx)
            .map(Value::String)
            .unwrap_or(Value::Null),
    }
}

fn mysql_value(row: &sqlx::mysql::MySqlRow, idx: usize) -> Value {
    let raw = match row.try_get_raw(idx) {
        Ok(r) => r,
        Err(_) => return Value::Null,
    };
    if raw.is_null() {
        return Value::Null;
    }
    let name = raw.type_info().name().to_string();
    if name.contains("INT") {
        return row
            .try_get::<i64, _>(idx)
            .map(|v| json!(v))
            .unwrap_or(Value::Null);
    }
    if name.contains("FLOAT") || name.contains("DOUBLE") || name.contains("DECIMAL") {
        return row
            .try_get::<f64, _>(idx)
            .map(|v| json!(v))
            .unwrap_or(Value::Null);
    }
    if name.contains("BOOL") || name == "TINYINT(1)" {
        return row
            .try_get::<bool, _>(idx)
            .map(Value::from)
            .unwrap_or(Value::Null);
    }
    if name.contains("JSON") {
        return row.try_get::<Value, _>(idx).unwrap_or(Value::Null);
    }
    if name.contains("BLOB") || name.contains("BINARY") {
        return row
            .try_get::<Vec<u8>, _>(idx)
            .map(|v| json!(hex(&v)))
            .unwrap_or(Value::Null);
    }
    row.try_get::<String, _>(idx)
        .map(Value::String)
        .unwrap_or(Value::Null)
}

fn sqlite_value(row: &sqlx::sqlite::SqliteRow, idx: usize) -> Value {
    let raw = match row.try_get_raw(idx) {
        Ok(r) => r,
        Err(_) => return Value::Null,
    };
    if raw.is_null() {
        return Value::Null;
    }
    if let Ok(v) = row.try_get::<i64, _>(idx) {
        return json!(v);
    }
    if let Ok(v) = row.try_get::<f64, _>(idx) {
        return json!(v);
    }
    if let Ok(v) = row.try_get::<String, _>(idx) {
        return Value::String(v);
    }
    if let Ok(v) = row.try_get::<Vec<u8>, _>(idx) {
        return json!(hex(&v));
    }
    Value::Null
}

fn hex(bytes: &[u8]) -> String {
    let mut s = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        use std::fmt::Write;
        let _ = write!(&mut s, "{:02x}", b);
    }
    s
}

fn is_select(sql: &str) -> bool {
    let trimmed = sql.trim_start().to_lowercase();
    trimmed.starts_with("select")
        || trimmed.starts_with("with")
        || trimmed.starts_with("show")
        || trimmed.starts_with("explain")
        || trimmed.starts_with("pragma")
}

#[tauri::command]
pub async fn execute_query(
    state: State<'_, AppState>,
    connection_id: String,
    sql: String,
) -> AppResult<QueryResult> {
    execute_with_state(&state, &connection_id, &sql).await
}

async fn execute_with_state(
    state: &AppState,
    connection_id: &str,
    sql: &str,
) -> AppResult<QueryResult> {
    let pool = pool_for(state, connection_id)?;
    let start = Instant::now();

    if !is_select(sql) {
        let rows_affected = match &pool {
            DbPool::Postgres(p) => sqlx::query(sql).execute(p).await?.rows_affected(),
            DbPool::Mysql(p) => sqlx::query(sql).execute(p).await?.rows_affected(),
            DbPool::Sqlite(p) => sqlx::query(sql).execute(p).await?.rows_affected(),
        };
        return Ok(QueryResult {
            columns: vec![],
            rows: vec![],
            rows_affected,
            elapsed_ms: start.elapsed().as_millis() as u64,
            total: None,
        });
    }

    let result = match pool {
        DbPool::Postgres(p) => {
            let rows = sqlx::query(sql).fetch_all(&p).await?;
            let columns = rows
                .first()
                .map(|r| {
                    r.columns()
                        .iter()
                        .map(|c| ColumnMeta {
                            name: c.name().to_string(),
                            data_type: c.type_info().name().to_string(),
                        })
                        .collect()
                })
                .unwrap_or_default();
            let data: Vec<Vec<Value>> = rows
                .iter()
                .map(|r| (0..r.columns().len()).map(|i| pg_value(r, i)).collect())
                .collect();
            QueryResult {
                rows_affected: data.len() as u64,
                rows: data,
                columns,
                elapsed_ms: start.elapsed().as_millis() as u64,
                total: None,
            }
        }
        DbPool::Mysql(p) => {
            let rows = sqlx::query(sql).fetch_all(&p).await?;
            let columns = rows
                .first()
                .map(|r| {
                    r.columns()
                        .iter()
                        .map(|c| ColumnMeta {
                            name: c.name().to_string(),
                            data_type: c.type_info().name().to_string(),
                        })
                        .collect()
                })
                .unwrap_or_default();
            let data: Vec<Vec<Value>> = rows
                .iter()
                .map(|r| (0..r.columns().len()).map(|i| mysql_value(r, i)).collect())
                .collect();
            QueryResult {
                rows_affected: data.len() as u64,
                rows: data,
                columns,
                elapsed_ms: start.elapsed().as_millis() as u64,
                total: None,
            }
        }
        DbPool::Sqlite(p) => {
            let rows = sqlx::query(sql).fetch_all(&p).await?;
            let columns = rows
                .first()
                .map(|r| {
                    r.columns()
                        .iter()
                        .map(|c| ColumnMeta {
                            name: c.name().to_string(),
                            data_type: c.type_info().name().to_string(),
                        })
                        .collect()
                })
                .unwrap_or_default();
            let data: Vec<Vec<Value>> = rows
                .iter()
                .map(|r| (0..r.columns().len()).map(|i| sqlite_value(r, i)).collect())
                .collect();
            QueryResult {
                rows_affected: data.len() as u64,
                rows: data,
                columns,
                elapsed_ms: start.elapsed().as_millis() as u64,
                total: None,
            }
        }
    };
    Ok(result)
}

fn quote_ident(driver_pg_or_sqlite: bool, name: &str) -> String {
    if driver_pg_or_sqlite {
        format!("\"{}\"", name.replace('"', "\"\""))
    } else {
        format!("`{}`", name.replace('`', "``"))
    }
}

#[tauri::command]
pub async fn fetch_table_data(
    state: State<'_, AppState>,
    connection_id: String,
    schema: Option<String>,
    table: String,
    limit: i64,
    offset: i64,
    order_by: Option<String>,
    order_desc: Option<bool>,
) -> AppResult<QueryResult> {
    let pool = pool_for(state.inner(), &connection_id)?;
    let is_pg_or_sqlite = matches!(&pool, DbPool::Postgres(_) | DbPool::Sqlite(_));

    let order_clause = match order_by {
        Some(col) => {
            let dir = if order_desc.unwrap_or(false) { "DESC" } else { "ASC" };
            format!(" ORDER BY {} {}", quote_ident(is_pg_or_sqlite, &col), dir)
        }
        None => String::new(),
    };

    let (data_sql, count_sql) = match &pool {
        DbPool::Postgres(_) => {
            let schema = schema.clone().unwrap_or_else(|| "public".into());
            let qt = format!(
                "{}.{}",
                quote_ident(true, &schema),
                quote_ident(true, &table)
            );
            (
                format!("SELECT * FROM {}{} LIMIT {} OFFSET {}", qt, order_clause, limit, offset),
                format!("SELECT COUNT(*) FROM {}", qt),
            )
        }
        DbPool::Mysql(_) => {
            let qt = if let Some(s) = &schema {
                format!("{}.{}", quote_ident(false, s), quote_ident(false, &table))
            } else {
                quote_ident(false, &table)
            };
            (
                format!("SELECT * FROM {}{} LIMIT {} OFFSET {}", qt, order_clause, limit, offset),
                format!("SELECT COUNT(*) FROM {}", qt),
            )
        }
        DbPool::Sqlite(_) => {
            let qt = quote_ident(true, &table);
            (
                format!("SELECT * FROM {}{} LIMIT {} OFFSET {}", qt, order_clause, limit, offset),
                format!("SELECT COUNT(*) FROM {}", qt),
            )
        }
    };

    let mut result = execute_with_state(state.inner(), &connection_id, &data_sql).await?;

    let total: Option<u64> = match &pool {
        DbPool::Postgres(p) => sqlx::query_scalar::<_, i64>(&count_sql)
            .fetch_optional(p)
            .await?
            .map(|v| v as u64),
        DbPool::Mysql(p) => sqlx::query_scalar::<_, i64>(&count_sql)
            .fetch_optional(p)
            .await?
            .map(|v| v as u64),
        DbPool::Sqlite(p) => sqlx::query_scalar::<_, i64>(&count_sql)
            .fetch_optional(p)
            .await?
            .map(|v| v as u64),
    };
    result.total = total;
    Ok(result)
}

#[tauri::command]
pub async fn update_cell(
    state: State<'_, AppState>,
    connection_id: String,
    schema: Option<String>,
    table: String,
    pk_column: String,
    pk_value: Value,
    column: String,
    value: Option<String>,
) -> AppResult<u64> {
    let pool = pool_for(state.inner(), &connection_id)?;
    let is_pg_or_sqlite = matches!(&pool, DbPool::Postgres(_) | DbPool::Sqlite(_));
    let qt = if let Some(s) = schema {
        if is_pg_or_sqlite {
            format!("{}.{}", quote_ident(true, &s), quote_ident(true, &table))
        } else {
            format!("{}.{}", quote_ident(false, &s), quote_ident(false, &table))
        }
    } else {
        quote_ident(is_pg_or_sqlite, &table)
    };
    let col_id = quote_ident(is_pg_or_sqlite, &column);
    let pk_id = quote_ident(is_pg_or_sqlite, &pk_column);
    let pk_str = json_to_string(&pk_value);

    let affected = match pool {
        DbPool::Postgres(p) => {
            let sql = format!("UPDATE {} SET {} = $1 WHERE {} = $2", qt, col_id, pk_id);
            sqlx::query(&sql)
                .bind(&value)
                .bind(&pk_str)
                .execute(&p)
                .await?
                .rows_affected()
        }
        DbPool::Mysql(p) => {
            let sql = format!("UPDATE {} SET {} = ? WHERE {} = ?", qt, col_id, pk_id);
            sqlx::query(&sql)
                .bind(&value)
                .bind(&pk_str)
                .execute(&p)
                .await?
                .rows_affected()
        }
        DbPool::Sqlite(p) => {
            let sql = format!("UPDATE {} SET {} = ?1 WHERE {} = ?2", qt, col_id, pk_id);
            sqlx::query(&sql)
                .bind(&value)
                .bind(&pk_str)
                .execute(&p)
                .await?
                .rows_affected()
        }
    };
    Ok(affected)
}

fn json_to_string(v: &Value) -> Option<String> {
    match v {
        Value::Null => None,
        Value::String(s) => Some(s.clone()),
        other => Some(other.to_string()),
    }
}
