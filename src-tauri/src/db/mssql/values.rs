//! SQL Server row → `serde_json::Value` decoding.
//!
//! The counterpart of [`crate::db::values`]'s `pg_value` / `mysql_value` /
//! `sqlite_value`, but structurally simpler: `tiberius` hands back a typed
//! [`ColumnData`] per cell, so this matches on the *value* rather than
//! second-guessing a type *name* the way the `sqlx` decoders have to. That
//! removes the whole class of bugs documented in gotchas #11, #15 and #17.
//!
//! Two deliberate representation choices:
//!
//! * **`bit` decodes to the number 0/1, not a JSON boolean.** SQL Server's
//!   `bit` is its boolean type, and the grid already has a BIT display
//!   preference plus a dedicated 0/1 editor (`BitInput`) driven off the
//!   reported type name. Emitting `0`/`1` keeps that path working and matches
//!   the MySQL `TINYINT(1)` precedent (gotcha #15), where forcing a Rust `bool`
//!   would have thrown information away.
//! * **`decimal`/`numeric`/`money` decode to a *string*.** They are arbitrary
//!   precision on the server; routing them through an `f64` would silently
//!   round. Same reasoning as the other drivers' handling of `NUMERIC`.
//!
//! Anything that cannot be decoded degrades to `Value::Null` rather than
//! failing the whole query — again matching [`crate::db::values`].

use serde_json::Value;
use tiberius::{ColumnData, ColumnType, Row};

/// Decode cell `idx` of `row` into JSON.
pub fn mssql_value(row: &Row, idx: usize) -> Value {
    let Some((_, data)) = row.cells().nth(idx) else {
        return Value::Null;
    };
    match data {
        ColumnData::Bit(v) => v.map(|b| Value::from(u8::from(b))).unwrap_or(Value::Null),
        ColumnData::U8(v) => v.map(Value::from).unwrap_or(Value::Null),
        ColumnData::I16(v) => v.map(Value::from).unwrap_or(Value::Null),
        ColumnData::I32(v) => v.map(Value::from).unwrap_or(Value::Null),
        ColumnData::I64(v) => v.map(Value::from).unwrap_or(Value::Null),
        ColumnData::F32(v) => v.and_then(finite_f32).unwrap_or(Value::Null),
        ColumnData::F64(v) => v.and_then(finite_f64).unwrap_or(Value::Null),
        ColumnData::String(v) => v
            .as_ref()
            .map(|s| Value::from(s.as_ref()))
            .unwrap_or(Value::Null),
        ColumnData::Guid(v) => v.map(|g| Value::from(g.to_string())).unwrap_or(Value::Null),
        // Hex, `0x`-prefixed — the literal form T-SQL itself accepts, so a
        // copied cell can be pasted straight back into a query.
        ColumnData::Binary(v) => v
            .as_ref()
            .map(|b| Value::from(format!("0x{}", hex(b))))
            .unwrap_or(Value::Null),
        ColumnData::Numeric(v) => v.map(|n| Value::from(n.to_string())).unwrap_or(Value::Null),
        ColumnData::Xml(v) => v
            .as_ref()
            .map(|x| Value::from(x.as_ref().to_string()))
            .unwrap_or(Value::Null),
        // The temporal variants carry raw TDS day/tick counts, so they go
        // through `try_get`'s `FromSql` impls (the `chrono` feature) instead of
        // being reinterpreted here.
        ColumnData::DateTime(_) | ColumnData::SmallDateTime(_) | ColumnData::DateTime2(_) => row
            .try_get::<chrono::NaiveDateTime, _>(idx)
            .ok()
            .flatten()
            .map(|v| Value::from(v.to_string()))
            .unwrap_or(Value::Null),
        ColumnData::Date(_) => row
            .try_get::<chrono::NaiveDate, _>(idx)
            .ok()
            .flatten()
            .map(|v| Value::from(v.to_string()))
            .unwrap_or(Value::Null),
        ColumnData::Time(_) => row
            .try_get::<chrono::NaiveTime, _>(idx)
            .ok()
            .flatten()
            .map(|v| Value::from(v.to_string()))
            .unwrap_or(Value::Null),
        ColumnData::DateTimeOffset(_) => row
            .try_get::<chrono::DateTime<chrono::Utc>, _>(idx)
            .ok()
            .flatten()
            .map(|v| Value::from(v.to_rfc3339()))
            .unwrap_or(Value::Null),
    }
}

/// Column name + T-SQL type name pairs, in result-set order.
///
/// The type name feeds `ColumnMeta.data_type`, which the grid uses for
/// right-aligning numerics and for picking the BIT editor — so it has to read
/// like a type the user would recognise from the structure view, not like a
/// protocol token.
pub fn mssql_columns(row: &Row) -> Vec<(String, String)> {
    row.columns()
        .iter()
        .map(|c| (c.name().to_string(), type_name(c.column_type()).to_string()))
        .collect()
}

/// Map a TDS column type onto the T-SQL type name it corresponds to.
///
/// The protocol distinguishes fixed-length from nullable-variable-length forms
/// of the same logical type (`Int4` vs `Intn`, `Datetime` vs `Datetimen`, …);
/// both map to the same user-facing name, since a nullable `int` is still an
/// `int`. Where the protocol genuinely cannot tell two types apart the wider
/// one is reported.
fn type_name(ct: ColumnType) -> &'static str {
    match ct {
        ColumnType::Null => "null",
        ColumnType::Bit | ColumnType::Bitn => "bit",
        ColumnType::Int1 => "tinyint",
        ColumnType::Int2 => "smallint",
        ColumnType::Int4 => "int",
        ColumnType::Int8 => "bigint",
        // The nullable integer form carries its width in the value, not the
        // type token; `int` is the overwhelmingly common case.
        ColumnType::Intn => "int",
        ColumnType::Float4 => "real",
        ColumnType::Float8 | ColumnType::Floatn => "float",
        ColumnType::Money | ColumnType::Money4 => "money",
        ColumnType::Decimaln => "decimal",
        ColumnType::Numericn => "numeric",
        ColumnType::Datetime | ColumnType::Datetimen => "datetime",
        ColumnType::Datetime4 => "smalldatetime",
        ColumnType::Datetime2 => "datetime2",
        ColumnType::DatetimeOffsetn => "datetimeoffset",
        ColumnType::Daten => "date",
        ColumnType::Timen => "time",
        ColumnType::Guid => "uniqueidentifier",
        ColumnType::BigChar => "char",
        ColumnType::BigVarChar => "varchar",
        ColumnType::NChar => "nchar",
        ColumnType::NVarchar => "nvarchar",
        ColumnType::Text => "text",
        ColumnType::NText => "ntext",
        ColumnType::BigBinary => "binary",
        ColumnType::BigVarBin => "varbinary",
        ColumnType::Image => "image",
        ColumnType::Xml => "xml",
        ColumnType::Udt => "udt",
        ColumnType::SSVariant => "sql_variant",
    }
}

/// First column of `row` as an `i64` — the `COUNT(*)` / `SELECT 1` shape.
///
/// Accepts every integer width TDS might use for a count (`COUNT(*)` is `int`,
/// `COUNT_BIG` and the partition-stats views are `bigint`) so callers don't
/// have to care which one the server picked.
pub fn first_i64(row: &Row) -> Option<i64> {
    match row.cells().next().map(|(_, d)| d)? {
        ColumnData::U8(v) => v.map(i64::from),
        ColumnData::I16(v) => v.map(i64::from),
        ColumnData::I32(v) => v.map(i64::from),
        ColumnData::I64(v) => *v,
        ColumnData::Numeric(v) => v.and_then(|n| n.to_string().parse::<i64>().ok()),
        _ => None,
    }
}

/// First column of `row` as a string, for the single-value catalog queries.
pub fn first_string(row: &Row) -> Option<String> {
    match row.cells().next().map(|(_, d)| d)? {
        ColumnData::String(v) => v.as_ref().map(|s| s.to_string()),
        _ => None,
    }
}

fn finite_f32(v: f32) -> Option<Value> {
    serde_json::Number::from_f64(f64::from(v)).map(Value::Number)
}

fn finite_f64(v: f64) -> Option<Value> {
    serde_json::Number::from_f64(v).map(Value::Number)
}

/// Lowercase hex encoding (mirrors the private helper of the same shape in
/// [`crate::db::values`] and [`crate::db::dump`]).
fn hex(bytes: &[u8]) -> String {
    use std::fmt::Write;
    let mut s = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        let _ = write!(&mut s, "{b:02x}");
    }
    s
}

#[cfg(test)]
mod tests {
    use super::type_name;
    use tiberius::ColumnType;

    #[test]
    fn maps_protocol_types_to_tsql_names() {
        // The nullable and fixed forms of one logical type must not surface as
        // two different names — a nullable `int` is still an `int`.
        assert_eq!(type_name(ColumnType::Int4), "int");
        assert_eq!(type_name(ColumnType::Intn), "int");
        assert_eq!(type_name(ColumnType::Bit), "bit");
        assert_eq!(type_name(ColumnType::Bitn), "bit");
        // `bit` must keep reporting as exactly "bit": the grid's BIT detection
        // is anchored (`/^bit\b/i`), so anything else silently loses the 0/1
        // editor.
        assert_eq!(type_name(ColumnType::Bitn), "bit");
        assert_eq!(type_name(ColumnType::Guid), "uniqueidentifier");
        assert_eq!(type_name(ColumnType::NVarchar), "nvarchar");
    }
}
