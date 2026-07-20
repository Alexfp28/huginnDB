//! Extraction of typed values from `sqlx` rows into `serde_json::Value`.
//!
//! These helpers are the boundary between strongly typed driver values and
//! the dynamic shape the frontend ingests. Each driver gets its own
//! function because the type-info APIs and supported encodings differ:
//!
//! * Postgres reports a stable upper-case OID name (`INT4`, `JSONB`, …).
//! * MySQL reports the full column type string (`varchar(255)`, …) which
//!   we pattern-match on substrings.
//! * SQLite is dynamically typed; we attempt several decodings in order
//!   and fall back to NULL.
//!
//! Unknown types degrade to `Value::Null` rather than failing the whole
//! query, so the user can still inspect the rest of the result set when a
//! single column doesn't decode.

use serde_json::{json, Value};
use sqlx::{Column, Row, TypeInfo, ValueRef};

/// Extract column `idx` from a Postgres row.
pub fn pg_value(row: &sqlx::postgres::PgRow, idx: usize) -> Value {
    let raw = match row.try_get_raw(idx) {
        Ok(r) => r,
        Err(_) => return Value::Null,
    };
    if raw.is_null() {
        return Value::Null;
    }

    match raw.type_info().name() {
        "BOOL" => row
            .try_get::<bool, _>(idx)
            .map(|v| json!(v))
            .unwrap_or(Value::Null),
        "INT2" => row
            .try_get::<i16, _>(idx)
            .map(|v| json!(v))
            .unwrap_or(Value::Null),
        "INT4" => row
            .try_get::<i32, _>(idx)
            .map(|v| json!(v))
            .unwrap_or(Value::Null),
        "INT8" => row
            .try_get::<i64, _>(idx)
            .map(|v| json!(v))
            .unwrap_or(Value::Null),
        "FLOAT4" => row
            .try_get::<f32, _>(idx)
            .map(|v| json!(v))
            .unwrap_or(Value::Null),
        "FLOAT8" => row
            .try_get::<f64, _>(idx)
            .map(|v| json!(v))
            .unwrap_or(Value::Null),
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
        // Strings and unknown types share the same fallback because
        // Postgres serialises most textual types as Rust `String`.
        _ => row
            .try_get::<String, _>(idx)
            .map(Value::String)
            .unwrap_or(Value::Null),
    }
}

/// Extract column `idx` from a MySQL row.
pub fn mysql_value(row: &sqlx::mysql::MySqlRow, idx: usize) -> Value {
    let raw = match row.try_get_raw(idx) {
        Ok(r) => r,
        Err(_) => return Value::Null,
    };
    if raw.is_null() {
        return Value::Null;
    }
    let name = raw.type_info().name().to_uppercase();

    // A MySQL `TINYINT(1)` / `BOOL` / `BOOLEAN` column is reported by sqlx as
    // the type name **`"BOOLEAN"`** — see sqlx's `ColumnType::name`
    // (`ColumnType::Tiny if max_size == Some(1) => "BOOLEAN"`); a plain
    // `TINYINT` stays `"TINYINT"`, and the display width is never part of the
    // name (so it is *not* `"TINYINT(1)"`). The earlier `name == "BOOL" ||
    // name == "TINYINT(1)"` guard therefore never matched, and because
    // `"BOOLEAN"` does not contain the substring `"INT"` the value skipped the
    // integer branch below and fell through to the `String` fallback — which
    // is type-incompatible with a `TINYINT`, so every boolean cell decoded to
    // `Value::Null` and rendered as "NULL" in the grid (issue #68).
    //
    // Route `"BOOLEAN"` through the same signed/unsigned integer decoder as the
    // other integer widths (it is physically a `TINYINT`, and a `TINYINT(1)`
    // can legally hold any small int like 2 or -1, so decoding it as a Rust
    // `bool` would both lose that value and misrepresent it). This yields the
    // stored 0/1 (matching HeidiSQL) instead of NULL.
    if name.contains("INT") || name == "BOOLEAN" {
        // Width/sign fallback. sqlx maps each MySQL integer width to a
        // *specific* Rust type and its `Decode` impl refuses a mismatched
        // target: a `TINYINT` column decodes as `i8`, `TINYINT UNSIGNED` as
        // `u8`, `INT UNSIGNED` as `u32`, `BIGINT UNSIGNED` as `u64`, etc.
        // `try_get::<i64>` therefore returns `Err` for everything that isn't
        // a signed 64-bit-compatible column, and the value collapsed to
        // `Value::Null` — which is why bare `TINYINT`/`SMALLINT` rendered as
        // "NULL" in the grid even though the row held a real number (the same
        // class of bug we fixed for `BIT`, gotcha #11).
        //
        // Try signed widest-first, then unsigned, folding unsigned values
        // through `u64`. Only after every width fails do we surrender to NULL.
        if let Ok(v) = row.try_get::<i64, _>(idx) {
            return json!(v);
        }
        if let Ok(v) = row.try_get::<i32, _>(idx) {
            return json!(v);
        }
        if let Ok(v) = row.try_get::<i16, _>(idx) {
            return json!(v);
        }
        if let Ok(v) = row.try_get::<i8, _>(idx) {
            return json!(v);
        }
        if let Ok(v) = row.try_get::<u64, _>(idx) {
            return json!(v);
        }
        if let Ok(v) = row.try_get::<u32, _>(idx) {
            return json!(v);
        }
        if let Ok(v) = row.try_get::<u16, _>(idx) {
            return json!(v);
        }
        if let Ok(v) = row.try_get::<u8, _>(idx) {
            return json!(v);
        }
        return Value::Null;
    }
    if name.contains("FLOAT") || name.contains("DOUBLE") || name.contains("DECIMAL") {
        return row
            .try_get::<f64, _>(idx)
            .map(|v| json!(v))
            .unwrap_or(Value::Null);
    }
    if name.contains("JSON") {
        return row.try_get::<Value, _>(idx).unwrap_or(Value::Null);
    }
    if name.contains("BLOB") || name.contains("BINARY") {
        // sqlx labels a column `LONGBLOB`/`BLOB` (vs `LONGTEXT`/`TEXT`) purely
        // from the protocol-level `BINARY` column flag, which the MySQL server
        // *sometimes* sets on genuine text columns (depending on charset /
        // collation), so a real `LONGTEXT` lands here and used to render as a
        // hex dump. The flag isn't reachable through sqlx's public API, so we
        // disambiguate by content: if the bytes are valid UTF-8 we treat the
        // value as text (matching HeidiSQL); otherwise we emit hex. See gotcha #17.
        //
        // We MUST read the bytes via `try_get::<Vec<u8>>` and validate UTF-8
        // ourselves rather than `try_get::<String>`. `try_get::<String>` runs
        // sqlx's *type-compatibility* gate first, and `String` is incompatible
        // with a `BINARY`-flagged column — so it returns `Err` *before* ever
        // looking at the bytes, and even a pristine UTF-8 `LONGTEXT` (e.g. a
        // large JSON document) collapsed to a hex dump. `Vec<u8>` is compatible
        // with BLOB, so `String::from_utf8` here decides text-vs-binary by the
        // actual content, which is the behaviour we want.
        if let Ok(bytes) = row.try_get::<Vec<u8>, _>(idx) {
            return match String::from_utf8(bytes) {
                Ok(s) => Value::String(s),
                Err(e) => json!(hex(e.as_bytes())),
            };
        }
        return Value::Null;
    }
    // Temporal types — sqlx doesn't decode them as `String` by default, so
    // without an explicit branch the fallback below would return `Value::Null`
    // and the grid would render the cell empty (HeidiSQL shows the value
    // correctly because it decodes them as strings via the C connector).
    // Order matters: check DATETIME / TIMESTAMP / DATE before the generic
    // TIME branch since they all contain the substring "TIME"/"DATE".
    if name == "DATETIME" {
        return row
            .try_get::<chrono::NaiveDateTime, _>(idx)
            .map(|v| json!(v.to_string()))
            .unwrap_or(Value::Null);
    }
    if name == "TIMESTAMP" {
        // MySQL stores TIMESTAMP in UTC and converts to the session time zone
        // on read. sqlx hands us a `DateTime<Utc>` accordingly.
        return row
            .try_get::<chrono::DateTime<chrono::Utc>, _>(idx)
            .map(|v| json!(v.to_rfc3339()))
            .unwrap_or(Value::Null);
    }
    if name == "DATE" {
        return row
            .try_get::<chrono::NaiveDate, _>(idx)
            .map(|v| json!(v.to_string()))
            .unwrap_or(Value::Null);
    }
    if name == "TIME" {
        return row
            .try_get::<chrono::NaiveTime, _>(idx)
            .map(|v| json!(v.to_string()))
            .unwrap_or(Value::Null);
    }
    if name == "YEAR" {
        return row
            .try_get::<u16, _>(idx)
            .map(|v| json!(v))
            .unwrap_or(Value::Null);
    }
    // BIT(n) — decode as `u64`, NOT `Vec<u8>`. sqlx refuses to decode a byte
    // vector from a `MYSQL_TYPE_BIT` column (its blob type-compatibility check
    // only accepts BLOB / STRING / VARBINARY), so `try_get::<Vec<u8>>` returns
    // `Err` and the cell would collapse to `Value::Null` — the grid then
    // renders "NULL" even though the row holds a real value. The `u64` decoder
    // *does* special-case `ColumnType::Bit` and folds the raw bytes big-endian
    // for us (BIT(1) → 0/1, wider BIT(n) → its numeric value). The frontend
    // turns the number into true/false or 0/1 per the user's grid preference.
    if name.contains("BIT") {
        return row
            .try_get::<u64, _>(idx)
            .map(|n| json!(n))
            .unwrap_or(Value::Null);
    }
    row.try_get::<String, _>(idx)
        .map(Value::String)
        .unwrap_or(Value::Null)
}

/// Extract column `idx` from a SQLite row.
pub fn sqlite_value(row: &sqlx::sqlite::SqliteRow, idx: usize) -> Value {
    let raw = match row.try_get_raw(idx) {
        Ok(r) => r,
        Err(_) => return Value::Null,
    };
    if raw.is_null() {
        return Value::Null;
    }
    // SQLite is dynamically typed; try the supported affinities in order.
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

/// Map the columns of a `sqlx` row into `(name, type_name)` pairs.
pub fn pg_columns(row: &sqlx::postgres::PgRow) -> Vec<(String, String)> {
    row.columns()
        .iter()
        .map(|c| (c.name().to_string(), c.type_info().name().to_string()))
        .collect()
}

/// See [`pg_columns`].
pub fn mysql_columns(row: &sqlx::mysql::MySqlRow) -> Vec<(String, String)> {
    row.columns()
        .iter()
        .map(|c| (c.name().to_string(), c.type_info().name().to_string()))
        .collect()
}

/// See [`pg_columns`].
pub fn sqlite_columns(row: &sqlx::sqlite::SqliteRow) -> Vec<(String, String)> {
    row.columns()
        .iter()
        .map(|c| (c.name().to_string(), c.type_info().name().to_string()))
        .collect()
}

/// Lowercase hex encoding of a byte slice.
fn hex(bytes: &[u8]) -> String {
    use std::fmt::Write;
    let mut s = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        let _ = write!(&mut s, "{b:02x}");
    }
    s
}
