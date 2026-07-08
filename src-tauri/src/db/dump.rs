//! Pure logic for "export database to .sql": per-driver literal encoding and
//! `INSERT` statement assembly. No I/O, no `sqlx` execution — [`crate::commands::dump`]
//! drives the actual queries and file writing.
//!
//! Mirrors [`crate::db::values`]'s per-driver dispatch-by-type-name shape, but
//! emits SQL literal text instead of `serde_json::Value` — the two modules
//! intentionally stay separate rather than sharing a "value" abstraction,
//! since a JSON value and a SQL literal have different escaping/quoting rules
//! per type and forcing them through one representation would obscure both.

use crate::db::ddl::Driver;
use sqlx::{Row, TypeInfo, ValueRef};

/// Escape + quote a text literal for the driver.
///
/// Postgres and SQLite only need `'` doubled (`standard_conforming_strings`
/// is on by default for both). MySQL's default `sql_mode` also treats `\` as
/// an escape character inside string literals, so MySQL literals additionally
/// double backslashes — done *first*, so doubling `'` afterward doesn't touch
/// the backslashes just inserted.
pub fn quote_text_literal(driver: Driver, s: &str) -> String {
    let escaped = if driver == Driver::Mysql {
        s.replace('\\', "\\\\").replace('\'', "''")
    } else {
        s.replace('\'', "''")
    };
    format!("'{escaped}'")
}

/// Lowercase hex encoding of a byte slice (mirrors the private helper of the
/// same shape in `db/values.rs` — small enough to duplicate rather than widen
/// that module's visibility for one shared five-line function).
fn hex(bytes: &[u8]) -> String {
    use std::fmt::Write;
    let mut s = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        let _ = write!(&mut s, "{b:02x}");
    }
    s
}

fn fmt_f64(v: f64) -> String {
    if v.is_finite() {
        v.to_string()
    } else {
        // No portable literal for NaN/Infinity across all three drivers in a
        // plain INSERT; NULL is the closest safe fallback (accepted v1 gap —
        // non-finite floats are vanishingly rare in practice).
        "NULL".to_string()
    }
}

/// One cell → SQL literal text, Postgres.
pub fn pg_literal(row: &sqlx::postgres::PgRow, idx: usize) -> String {
    let raw = match row.try_get_raw(idx) {
        Ok(r) => r,
        Err(_) => return "NULL".into(),
    };
    if raw.is_null() {
        return "NULL".into();
    }
    match raw.type_info().name() {
        "BOOL" => row
            .try_get::<bool, _>(idx)
            .map(|v| if v { "TRUE" } else { "FALSE" }.to_string())
            .unwrap_or_else(|_| "NULL".into()),
        "INT2" => row
            .try_get::<i16, _>(idx)
            .map(|v| v.to_string())
            .unwrap_or_else(|_| "NULL".into()),
        "INT4" => row
            .try_get::<i32, _>(idx)
            .map(|v| v.to_string())
            .unwrap_or_else(|_| "NULL".into()),
        "INT8" => row
            .try_get::<i64, _>(idx)
            .map(|v| v.to_string())
            .unwrap_or_else(|_| "NULL".into()),
        "FLOAT4" => row
            .try_get::<f32, _>(idx)
            .map(|v| fmt_f64(v as f64))
            .unwrap_or_else(|_| "NULL".into()),
        "FLOAT8" => row
            .try_get::<f64, _>(idx)
            .map(fmt_f64)
            .unwrap_or_else(|_| "NULL".into()),
        "NUMERIC" => row
            .try_get::<sqlx::types::BigDecimal, _>(idx)
            .map(|v| v.to_string())
            .unwrap_or_else(|_| "NULL".into()),
        "JSON" | "JSONB" => row
            .try_get::<serde_json::Value, _>(idx)
            .map(|v| quote_text_literal(Driver::Postgres, &v.to_string()))
            .unwrap_or_else(|_| "NULL".into()),
        "TIMESTAMP" => row
            .try_get::<chrono::NaiveDateTime, _>(idx)
            .map(|v| quote_text_literal(Driver::Postgres, &v.to_string()))
            .unwrap_or_else(|_| "NULL".into()),
        "TIMESTAMPTZ" => row
            .try_get::<chrono::DateTime<chrono::Utc>, _>(idx)
            .map(|v| quote_text_literal(Driver::Postgres, &v.to_rfc3339()))
            .unwrap_or_else(|_| "NULL".into()),
        "DATE" => row
            .try_get::<chrono::NaiveDate, _>(idx)
            .map(|v| quote_text_literal(Driver::Postgres, &v.to_string()))
            .unwrap_or_else(|_| "NULL".into()),
        "UUID" => row
            .try_get::<uuid::Uuid, _>(idx)
            .map(|v| quote_text_literal(Driver::Postgres, &v.to_string()))
            .unwrap_or_else(|_| "NULL".into()),
        "BYTEA" => row
            .try_get::<Vec<u8>, _>(idx)
            .map(|v| format!("'\\x{}'", hex(&v)))
            .unwrap_or_else(|_| "NULL".into()),
        // Strings and unknown types (including arrays/MONEY, an accepted v1
        // gap already present in `values::pg_value`) share this fallback.
        _ => row
            .try_get::<String, _>(idx)
            .map(|v| quote_text_literal(Driver::Postgres, &v))
            .unwrap_or_else(|_| "NULL".into()),
    }
}

/// One cell → SQL literal text, MySQL.
pub fn mysql_literal(row: &sqlx::mysql::MySqlRow, idx: usize) -> String {
    let raw = match row.try_get_raw(idx) {
        Ok(r) => r,
        Err(_) => return "NULL".into(),
    };
    if raw.is_null() {
        return "NULL".into();
    }
    let name = raw.type_info().name().to_uppercase();

    // Must be checked before the generic `INT` branch — see gotcha #15's note
    // in `values::mysql_value` ("TINYINT(1)" contains "INT").
    if name == "BOOL" || name == "TINYINT(1)" {
        return row
            .try_get::<bool, _>(idx)
            .map(|v| if v { "1" } else { "0" }.to_string())
            .unwrap_or_else(|_| "NULL".into());
    }
    if name.contains("INT") {
        // Same widen-then-narrow fallback chain as `values::mysql_value`
        // (gotcha #15) — sqlx maps each MySQL integer width to a specific
        // Rust type and refuses a mismatched `try_get`.
        if let Ok(v) = row.try_get::<i64, _>(idx) {
            return v.to_string();
        }
        if let Ok(v) = row.try_get::<i32, _>(idx) {
            return v.to_string();
        }
        if let Ok(v) = row.try_get::<i16, _>(idx) {
            return v.to_string();
        }
        if let Ok(v) = row.try_get::<i8, _>(idx) {
            return v.to_string();
        }
        if let Ok(v) = row.try_get::<u64, _>(idx) {
            return v.to_string();
        }
        if let Ok(v) = row.try_get::<u32, _>(idx) {
            return v.to_string();
        }
        if let Ok(v) = row.try_get::<u16, _>(idx) {
            return v.to_string();
        }
        if let Ok(v) = row.try_get::<u8, _>(idx) {
            return v.to_string();
        }
        return "NULL".into();
    }
    if name.contains("DECIMAL") {
        return row
            .try_get::<sqlx::types::BigDecimal, _>(idx)
            .map(|v| v.to_string())
            .unwrap_or_else(|_| "NULL".into());
    }
    if name.contains("FLOAT") || name.contains("DOUBLE") {
        return row
            .try_get::<f64, _>(idx)
            .map(fmt_f64)
            .unwrap_or_else(|_| "NULL".into());
    }
    if name.contains("JSON") {
        return row
            .try_get::<serde_json::Value, _>(idx)
            .map(|v| quote_text_literal(Driver::Mysql, &v.to_string()))
            .unwrap_or_else(|_| "NULL".into());
    }
    if name.contains("BLOB") || name.contains("BINARY") {
        // Same content-based text/binary disambiguation as gotcha #17's
        // `values::mysql_value` — a real `LONGTEXT` can still be reported
        // under a BLOB-ish type name, so bytes are validated as UTF-8 rather
        // than trusting the type name alone. Valid UTF-8 dumps as a quoted
        // string literal (portable, human-readable); otherwise as a hex blob
        // literal.
        if let Ok(bytes) = row.try_get::<Vec<u8>, _>(idx) {
            return match String::from_utf8(bytes) {
                Ok(s) => quote_text_literal(Driver::Mysql, &s),
                Err(e) => format!("0x{}", hex(e.as_bytes())),
            };
        }
        return "NULL".into();
    }
    if name == "DATETIME" {
        return row
            .try_get::<chrono::NaiveDateTime, _>(idx)
            .map(|v| quote_text_literal(Driver::Mysql, &v.to_string()))
            .unwrap_or_else(|_| "NULL".into());
    }
    if name == "TIMESTAMP" {
        return row
            .try_get::<chrono::DateTime<chrono::Utc>, _>(idx)
            .map(|v| quote_text_literal(Driver::Mysql, &v.to_rfc3339()))
            .unwrap_or_else(|_| "NULL".into());
    }
    if name == "DATE" {
        return row
            .try_get::<chrono::NaiveDate, _>(idx)
            .map(|v| quote_text_literal(Driver::Mysql, &v.to_string()))
            .unwrap_or_else(|_| "NULL".into());
    }
    if name == "TIME" {
        return row
            .try_get::<chrono::NaiveTime, _>(idx)
            .map(|v| quote_text_literal(Driver::Mysql, &v.to_string()))
            .unwrap_or_else(|_| "NULL".into());
    }
    if name == "YEAR" {
        return row
            .try_get::<u16, _>(idx)
            .map(|v| v.to_string())
            .unwrap_or_else(|_| "NULL".into());
    }
    if name.contains("BIT") {
        // A literal INSERT is parsed as a plain number by MySQL's grammar
        // even for a BIT column — unlike a bound parameter (gotcha #15's
        // `CAST(? AS UNSIGNED)` requirement is specific to prepared-statement
        // binding), so the bare decimal value round-trips fine here.
        return row
            .try_get::<u64, _>(idx)
            .map(|v| v.to_string())
            .unwrap_or_else(|_| "NULL".into());
    }
    row.try_get::<String, _>(idx)
        .map(|v| quote_text_literal(Driver::Mysql, &v))
        .unwrap_or_else(|_| "NULL".into())
}

/// One cell → SQL literal text, SQLite. SQLite is dynamically typed, so this
/// tries the supported affinities in the same order as `values::sqlite_value`.
pub fn sqlite_literal(row: &sqlx::sqlite::SqliteRow, idx: usize) -> String {
    let raw = match row.try_get_raw(idx) {
        Ok(r) => r,
        Err(_) => return "NULL".into(),
    };
    if raw.is_null() {
        return "NULL".into();
    }
    if let Ok(v) = row.try_get::<i64, _>(idx) {
        return v.to_string();
    }
    if let Ok(v) = row.try_get::<f64, _>(idx) {
        return fmt_f64(v);
    }
    if let Ok(v) = row.try_get::<String, _>(idx) {
        return quote_text_literal(Driver::Sqlite, &v);
    }
    if let Ok(v) = row.try_get::<Vec<u8>, _>(idx) {
        return format!("X'{}'", hex(&v));
    }
    "NULL".into()
}

/// Assemble one or more multi-row `INSERT INTO ... VALUES (...), (...);`
/// statements from pre-rendered per-cell literals, chunked at `batch_size`
/// rows per statement (mysqldump-style multi-row insert). `quoted_columns`
/// and `rows` must already be caller-rendered — this only assembles
/// punctuation, so it has no driver-specific behaviour of its own.
pub fn build_insert_statements(
    qualified_table: &str,
    quoted_columns: &[String],
    rows: &[Vec<String>],
    batch_size: usize,
) -> Vec<String> {
    if rows.is_empty() {
        return vec![];
    }
    let col_list = quoted_columns.join(", ");
    rows.chunks(batch_size.max(1))
        .map(|chunk| {
            let values = chunk
                .iter()
                .map(|r| format!("({})", r.join(", ")))
                .collect::<Vec<_>>()
                .join(",\n  ");
            format!("INSERT INTO {qualified_table} ({col_list}) VALUES\n  {values}")
        })
        .collect()
}

/// Postgres: resync an identity/serial column's sequence after loading
/// explicit PK values, so the next native insert doesn't collide with a
/// loaded row. `pg_get_serial_sequence`'s arguments are plain string literals
/// holding the *unquoted* table/column names, not `quote_ident`-quoted
/// identifiers — do not "fix" that later.
pub fn pg_sequence_resync_stmt(unquoted_table: &str, unquoted_column: &str, max_value: i64) -> String {
    format!(
        "SELECT setval(pg_get_serial_sequence('{unquoted_table}', '{unquoted_column}'), {max_value}, true)"
    )
}

/// MySQL: resync an `AUTO_INCREMENT` column after loading explicit PK values.
pub fn mysql_auto_increment_resync_stmt(qualified_table: &str, max_value: i64) -> String {
    format!("ALTER TABLE {qualified_table} AUTO_INCREMENT = {}", max_value + 1)
}
