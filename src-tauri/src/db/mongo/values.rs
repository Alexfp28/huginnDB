//! BSON ⇄ JSON conversion for the MongoDB driver.
//!
//! MongoDB documents carry BSON types that JSON has no representation for
//! (`ObjectId`, `Date`, `Decimal128`, `Long`, `Binary`, …). The rest of the
//! app speaks `serde_json::Value` end-to-end (see [`crate::commands::query::QueryResult`]),
//! so every value crossing the boundary goes through here.
//!
//! Two directions, two different goals:
//!
//! * [`bson_to_json`] — **display**. Renders the *relaxed*, human-readable form
//!   (an `ObjectId` becomes its 24-char hex string, a `Date` becomes an ISO
//!   string, a `Decimal128`/`Long` becomes a number or string). This is what the
//!   grid and the JSON viewer show. Nested documents/arrays stay structured
//!   (`Value::Object`/`Value::Array`) exactly like the existing SQL JSON columns,
//!   so the `CellPreview` panel can pretty-print them.
//! * [`json_to_bson`] — **round-trip**. Reconstructs proper BSON from JSON,
//!   honouring MongoDB Extended JSON tags (`{"$oid": …}`, `{"$date": …}`,
//!   `{"$numberLong": …}`, `{"$numberDecimal": …}`) that the shell parser emits
//!   for constructors like `ObjectId(...)` / `ISODate(...)`.
//!
//! Tradeoff (mirrors gotcha #17's content-over-type philosophy): because display
//! is lossy for type, the edit path leans on a `column_type` hint
//! ([`string_to_bson`]) the same way `update_cell`'s MySQL `BIT` `CAST` does
//! (gotcha #15). An `_id` that is a genuine 24-hex-char *string* is the one
//! ambiguous case on write — see [`id_to_bson`].

use mongodb::bson::{spec::BinarySubtype, Binary, Bson, Decimal128, Document};
use serde_json::{Map, Number, Value};
use std::str::FromStr;

/// Convert a BSON value to its readable JSON form for display in the grid /
/// JSON viewer. Lossy by design: types that JSON lacks are rendered as the
/// string a user expects to read, not as Extended JSON.
pub fn bson_to_json(b: &Bson) -> Value {
    match b {
        Bson::Double(f) => Number::from_f64(*f)
            .map(Value::Number)
            .unwrap_or(Value::Null),
        Bson::String(s) => Value::String(s.clone()),
        Bson::Boolean(v) => Value::Bool(*v),
        Bson::Null | Bson::Undefined => Value::Null,
        Bson::Int32(i) => Value::Number((*i).into()),
        Bson::Int64(i) => Value::Number((*i).into()),
        Bson::ObjectId(oid) => Value::String(oid.to_hex()),
        Bson::DateTime(dt) => Value::String(
            dt.try_to_rfc3339_string()
                .unwrap_or_else(|_| dt.timestamp_millis().to_string()),
        ),
        Bson::Decimal128(d) => Value::String(d.to_string()),
        Bson::Array(a) => Value::Array(a.iter().map(bson_to_json).collect()),
        Bson::Document(d) => document_to_json(d),
        Bson::Binary(bin) => Value::String(format!(
            "Binary({:?}, {} bytes)",
            bin.subtype,
            bin.bytes.len()
        )),
        Bson::RegularExpression(re) => Value::String(format!("/{}/{}", re.pattern, re.options)),
        Bson::JavaScriptCode(c) => Value::String(c.clone()),
        Bson::JavaScriptCodeWithScope(c) => Value::String(c.code.clone()),
        Bson::Timestamp(ts) => Value::String(format!("Timestamp({}, {})", ts.time, ts.increment)),
        Bson::Symbol(s) => Value::String(s.clone()),
        Bson::MaxKey => Value::String("MaxKey".into()),
        Bson::MinKey => Value::String("MinKey".into()),
        Bson::DbPointer(_) => Value::String("DbPointer".into()),
    }
}

/// Convert a whole document to a JSON object, preserving key order.
pub fn document_to_json(d: &Document) -> Value {
    let mut map = Map::with_capacity(d.len());
    for (k, v) in d {
        map.insert(k.clone(), bson_to_json(v));
    }
    Value::Object(map)
}

/// Reconstruct BSON from JSON, honouring MongoDB Extended JSON tags. Used for
/// query arguments produced by the shell parser and for whole-document writes
/// (`insertOne`, `replaceOne`).
pub fn json_to_bson(v: &Value) -> Bson {
    match v {
        Value::Null => Bson::Null,
        Value::Bool(b) => Bson::Boolean(*b),
        Value::Number(n) => number_to_bson(n),
        Value::String(s) => Bson::String(s.clone()),
        Value::Array(a) => Bson::Array(a.iter().map(json_to_bson).collect()),
        Value::Object(map) => object_to_bson(map),
    }
}

/// Map a JSON number to the narrowest BSON numeric type that holds it: integral
/// values that fit become `Int32`/`Int64`, everything else `Double`.
fn number_to_bson(n: &Number) -> Bson {
    if let Some(i) = n.as_i64() {
        if let Ok(i32v) = i32::try_from(i) {
            Bson::Int32(i32v)
        } else {
            Bson::Int64(i)
        }
    } else {
        Bson::Double(n.as_f64().unwrap_or(0.0))
    }
}

/// Convert a JSON object to BSON, intercepting Extended JSON tags first.
fn object_to_bson(map: &Map<String, Value>) -> Bson {
    // Extended JSON: single-key wrappers the shell parser emits for BSON
    // constructors. Anything that doesn't match falls through to a plain doc.
    if map.len() == 1 {
        let (key, val) = map.iter().next().unwrap();
        match key.as_str() {
            "$oid" => {
                if let Some(s) = val.as_str() {
                    if let Ok(oid) = mongodb::bson::oid::ObjectId::from_str(s) {
                        return Bson::ObjectId(oid);
                    }
                }
            }
            "$date" => return ext_date_to_bson(val),
            "$numberLong" => {
                if let Some(i) = val.as_str().and_then(|s| s.parse::<i64>().ok()) {
                    return Bson::Int64(i);
                }
                if let Some(i) = val.as_i64() {
                    return Bson::Int64(i);
                }
            }
            "$numberInt" => {
                if let Some(i) = val.as_str().and_then(|s| s.parse::<i32>().ok()) {
                    return Bson::Int32(i);
                }
            }
            "$numberDouble" => {
                if let Some(f) = val.as_str().and_then(|s| s.parse::<f64>().ok()) {
                    return Bson::Double(f);
                }
            }
            "$numberDecimal" => {
                if let Some(d) = val.as_str().and_then(|s| Decimal128::from_str(s).ok()) {
                    return Bson::Decimal128(d);
                }
            }
            _ => {}
        }
    }
    let mut doc = Document::new();
    for (k, v) in map {
        doc.insert(k.clone(), json_to_bson(v));
    }
    Bson::Document(doc)
}

/// Decode the value side of an `{"$date": …}` Extended JSON wrapper. Accepts
/// either an RFC3339 string or epoch-millis (number or `{"$numberLong": …}`).
fn ext_date_to_bson(val: &Value) -> Bson {
    use mongodb::bson::DateTime;
    match val {
        Value::String(s) => DateTime::parse_rfc3339_str(s)
            .map(Bson::DateTime)
            .unwrap_or(Bson::Null),
        Value::Number(n) => n
            .as_i64()
            .map(|ms| Bson::DateTime(DateTime::from_millis(ms)))
            .unwrap_or(Bson::Null),
        Value::Object(m) => m
            .get("$numberLong")
            .and_then(|v| v.as_str())
            .and_then(|s| s.parse::<i64>().ok())
            .map(|ms| Bson::DateTime(DateTime::from_millis(ms)))
            .unwrap_or(Bson::Null),
        _ => Bson::Null,
    }
}

/// Coerce the text a cell editor produced into BSON, using the field's inferred
/// BSON type name (from [`super::schema::infer_columns`]) as a hint. This is the
/// write-side analogue of the lossy [`bson_to_json`] display: a `Date` or `Long`
/// field must not silently degrade to a string just because the editor only
/// emits text. `None` value → `Bson::Null`.
pub fn string_to_bson(value: Option<&str>, type_hint: Option<&str>) -> Bson {
    let Some(s) = value else {
        return Bson::Null;
    };
    let hint = type_hint.unwrap_or("").to_ascii_lowercase();
    match hint.as_str() {
        "objectid" => mongodb::bson::oid::ObjectId::from_str(s.trim())
            .map(Bson::ObjectId)
            .unwrap_or_else(|_| Bson::String(s.to_string())),
        "int" | "int32" | "integer" => s
            .trim()
            .parse::<i32>()
            .map(Bson::Int32)
            .unwrap_or_else(|_| Bson::String(s.to_string())),
        "long" | "int64" => s
            .trim()
            .parse::<i64>()
            .map(Bson::Int64)
            .unwrap_or_else(|_| Bson::String(s.to_string())),
        "double" | "number" => s
            .trim()
            .parse::<f64>()
            .map(Bson::Double)
            .unwrap_or_else(|_| Bson::String(s.to_string())),
        "decimal128" | "decimal" => Decimal128::from_str(s.trim())
            .map(Bson::Decimal128)
            .unwrap_or_else(|_| Bson::String(s.to_string())),
        "bool" | "boolean" => match s.trim().to_ascii_lowercase().as_str() {
            "true" | "1" => Bson::Boolean(true),
            "false" | "0" => Bson::Boolean(false),
            _ => Bson::String(s.to_string()),
        },
        "date" | "datetime" => mongodb::bson::DateTime::parse_rfc3339_str(s.trim())
            .map(Bson::DateTime)
            .unwrap_or_else(|_| Bson::String(s.to_string())),
        "null" => Bson::Null,
        // "document" / "array" / unknown: try to parse the text as JSON so the
        // user can paste a nested value; fall back to a plain string.
        "document" | "object" | "array" => serde_json::from_str::<Value>(s)
            .map(|v| json_to_bson(&v))
            .unwrap_or_else(|_| Bson::String(s.to_string())),
        _ => Bson::String(s.to_string()),
    }
}

/// Reconstruct a primary-key (`_id`) value as BSON from its JSON display form.
///
/// `_id` is overwhelmingly an `ObjectId`, which [`bson_to_json`] rendered as a
/// 24-char hex string, so a string that parses as an `ObjectId` is treated as
/// one. Otherwise the value round-trips through [`json_to_bson`] (numeric /
/// string / compound `_id`). The one ambiguous case — a genuine `_id` that is a
/// 24-hex-character *string* — is documented in the module header and deferred
/// to the roadmap (typed `_id` round-trip).
pub fn id_to_bson(value: &Value) -> Bson {
    if let Value::String(s) = value {
        if s.len() == 24 && s.bytes().all(|b| b.is_ascii_hexdigit()) {
            if let Ok(oid) = mongodb::bson::oid::ObjectId::from_str(s) {
                return Bson::ObjectId(oid);
            }
        }
    }
    json_to_bson(value)
}

/// Short, lowercase BSON type name used by the schema explorer's column list
/// (the MongoDB analogue of a SQL `data_type`).
pub fn bson_type_name(b: &Bson) -> &'static str {
    match b {
        Bson::Double(_) => "double",
        Bson::String(_) => "string",
        Bson::Document(_) => "document",
        Bson::Array(_) => "array",
        Bson::Binary(_) => "binary",
        Bson::ObjectId(_) => "objectId",
        Bson::Boolean(_) => "bool",
        Bson::DateTime(_) => "date",
        Bson::Null | Bson::Undefined => "null",
        Bson::RegularExpression(_) => "regex",
        Bson::JavaScriptCode(_) | Bson::JavaScriptCodeWithScope(_) => "javascript",
        Bson::Int32(_) => "int",
        Bson::Int64(_) => "long",
        Bson::Timestamp(_) => "timestamp",
        Bson::Decimal128(_) => "decimal128",
        Bson::Symbol(_) => "symbol",
        Bson::MaxKey => "maxKey",
        Bson::MinKey => "minKey",
        Bson::DbPointer(_) => "dbPointer",
    }
}

/// Construct a BSON binary value (used only in round-trip tests for now).
#[allow(dead_code)]
pub(crate) fn binary(bytes: Vec<u8>) -> Bson {
    Bson::Binary(Binary {
        subtype: BinarySubtype::Generic,
        bytes,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use mongodb::bson::oid::ObjectId;

    #[test]
    fn objectid_renders_as_hex_and_round_trips() {
        let oid = ObjectId::from_str("507f1f77bcf86cd799439011").unwrap();
        let json = bson_to_json(&Bson::ObjectId(oid));
        assert_eq!(json, Value::String("507f1f77bcf86cd799439011".into()));
        // id_to_bson recognises the hex string as an ObjectId again.
        assert_eq!(id_to_bson(&json), Bson::ObjectId(oid));
    }

    #[test]
    fn numbers_pick_narrowest_type() {
        assert_eq!(json_to_bson(&serde_json::json!(5)), Bson::Int32(5));
        assert_eq!(
            json_to_bson(&serde_json::json!(5_000_000_000i64)),
            Bson::Int64(5_000_000_000)
        );
        assert!(matches!(
            json_to_bson(&serde_json::json!(1.5)),
            Bson::Double(_)
        ));
    }

    #[test]
    fn extended_json_oid_tag_becomes_objectid() {
        let v = serde_json::json!({"$oid": "507f1f77bcf86cd799439011"});
        assert!(matches!(json_to_bson(&v), Bson::ObjectId(_)));
    }

    #[test]
    fn string_to_bson_honours_type_hint() {
        assert_eq!(string_to_bson(Some("42"), Some("int")), Bson::Int32(42));
        assert_eq!(string_to_bson(Some("42"), Some("long")), Bson::Int64(42));
        assert_eq!(
            string_to_bson(Some("42"), Some("string")),
            Bson::String("42".into())
        );
        assert_eq!(string_to_bson(None, Some("int")), Bson::Null);
    }

    #[test]
    fn nested_documents_stay_structured() {
        let mut inner = Document::new();
        inner.insert("a", Bson::Int32(1));
        let json = bson_to_json(&Bson::Document(inner));
        assert_eq!(json, serde_json::json!({"a": 1}));
    }
}
