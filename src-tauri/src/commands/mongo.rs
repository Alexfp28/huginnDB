//! MongoDB per-collection data import/export (#65) — the Mongo counterpart of
//! the SQL whole-database `.sql` dump in [`crate::commands::dump`] (which
//! rejects Mongo outright).
//!
//! Format: **canonical MongoDB Extended JSON**, so `ObjectId`/`Date`/`Long`/
//! `Decimal128`/… survive a round-trip with their types intact, unlike the
//! display-lossy [`crate::db::mongo::values::bson_to_json`] the grid uses.
//! Export serializes each document via `bson`'s own `into_canonical_extjson`;
//! import parses each entry with `bson`'s own `Bson::try_from::<serde_json::
//! Value>` (which understands both canonical and relaxed Extended JSON) and
//! `insert_many`s the batch. Both are unlocked by the `serde_json-1` feature on
//! the `bson` crate (see `Cargo.toml`), so fidelity matches MongoDB's spec for
//! every BSON type — not just the common tags the grid's own converter handles.

use crate::db::mongo::schema::resolve_db;
use crate::error::{AppError, AppResult};
use crate::state::{AppState, DbPool};
use mongodb::bson::{doc, Bson, Document};
use serde_json::Value;
use std::convert::TryFrom;
use std::io::Write;
use tauri::{AppHandle, State};

fn pool_for(state: &AppState, id: &str) -> AppResult<DbPool> {
    state
        .connections
        .read()
        .get(id)
        .ok_or_else(|| AppError::NotConnected(id.to_string()))
}

fn mongo_conn(pool: &DbPool) -> AppResult<&crate::state::MongoConn> {
    match pool {
        DbPool::Mongo(conn) => Ok(conn),
        _ => Err(AppError::InvalidInput(
            "collection import/export is only supported for MongoDB; use \"Export database\" for the SQL drivers".into(),
        )),
    }
}

/// Export every document of `collection` to a user-chosen `.json` file as a
/// canonical Extended JSON array. Streams straight from the cursor to the file
/// so a large collection isn't fully buffered in memory. Returns the written
/// path; rejects if the user cancels the save dialog.
#[tauri::command]
pub async fn export_collection(
    app: AppHandle,
    state: State<'_, AppState>,
    connection_id: String,
    collection: String,
) -> AppResult<String> {
    let pool = pool_for(state.inner(), &connection_id)?;
    let conn = mongo_conn(&pool)?;
    let db = resolve_db(conn)?;

    use tauri_plugin_dialog::DialogExt;
    let suggested = format!("{collection}.json");
    let path = app
        .dialog()
        .file()
        .set_title("Export collection")
        .set_file_name(&suggested)
        .add_filter("JSON", &["json"])
        .blocking_save_file()
        .ok_or_else(|| AppError::Transfer("export cancelled".into()))?;
    let dest = path.to_string();

    let coll = db.collection::<Document>(&collection);
    let mut cursor = coll.find(doc! {}).await?;
    let mut w = std::io::BufWriter::new(std::fs::File::create(&dest)?);
    write!(w, "[")?;
    let mut first = true;
    while cursor.advance().await? {
        let document = cursor.deserialize_current()?;
        let ext = Bson::Document(document).into_canonical_extjson();
        if !first {
            write!(w, ",")?;
        }
        first = false;
        write!(w, "\n  ")?;
        serde_json::to_writer(&mut w, &ext)?;
    }
    write!(w, "\n]\n")?;
    w.flush()?;
    Ok(dest)
}

/// Import documents from a JSON file into `collection` and return how many were
/// inserted. Accepts a canonical/relaxed Extended JSON **array**, a single
/// **object**, or newline-delimited JSON (mongoexport's default `--type=json`
/// shape). Server-generated `_id`s are kept as written when present.
#[tauri::command]
pub async fn import_collection(
    state: State<'_, AppState>,
    connection_id: String,
    collection: String,
    file_path: String,
) -> AppResult<u64> {
    let pool = pool_for(state.inner(), &connection_id)?;
    let conn = mongo_conn(&pool)?;
    let db = resolve_db(conn)?;

    let text = std::fs::read_to_string(&file_path)?;
    let docs = parse_documents(&text)?;
    if docs.is_empty() {
        return Ok(0);
    }
    let coll = db.collection::<Document>(&collection);
    let res = coll.insert_many(docs).await?;
    Ok(res.inserted_ids.len() as u64)
}

/// Parse the import file into BSON documents. Tries whole-file JSON first (an
/// array of objects, or a single object), then falls back to newline-delimited
/// JSON so a mongoexport dump loads without a format flag.
fn parse_documents(text: &str) -> AppResult<Vec<Document>> {
    match serde_json::from_str::<Value>(text) {
        Ok(Value::Array(arr)) => arr.into_iter().map(value_to_document).collect(),
        Ok(v @ Value::Object(_)) => Ok(vec![value_to_document(v)?]),
        Ok(_) => Err(AppError::Transfer(
            "expected a JSON object or an array of objects".into(),
        )),
        Err(_) => {
            // Not a single JSON value — treat as JSONL (one document per line).
            let mut out = Vec::new();
            for (i, line) in text.lines().enumerate() {
                let line = line.trim();
                if line.is_empty() {
                    continue;
                }
                let value: Value = serde_json::from_str(line)
                    .map_err(|e| AppError::Transfer(format!("line {}: {e}", i + 1)))?;
                out.push(value_to_document(value)?);
            }
            Ok(out)
        }
    }
}

fn value_to_document(value: Value) -> AppResult<Document> {
    // `bson`'s own Extended JSON parser: understands canonical (`$oid`,
    // `$numberLong`, `$date: {$numberLong}`, …) and relaxed forms, and every
    // BSON type — so a document exported by `into_canonical_extjson` round-trips
    // exactly.
    match Bson::try_from(value).map_err(|e| AppError::Transfer(e.to_string()))? {
        Bson::Document(d) => Ok(d),
        _ => Err(AppError::Transfer(
            "each entry must be a JSON object (a document)".into(),
        )),
    }
}
