//! MongoDB query + CRUD execution, shaped into the SQL-shaped DTOs the rest of
//! the app consumes ([`QueryResult`] / [`BatchResult`]).
//!
//! Read operations (`find`/`aggregate`/`count`/`distinct`) are flattened into a
//! tabular `(columns, rows)` result by [`docs_to_result`]: top-level fields
//! become columns (`_id` first), nested documents/arrays stay structured JSON in
//! the cell (the `CellPreview` panel expands them). Write operations report an
//! affected-document count in `rows_affected` and carry no rows.

use crate::commands::query::{
    BatchResult, ColumnFilter, ColumnMeta, FilterOp, QueryResult, RowValue, StmtOutcome,
};
use crate::error::AppResult;
use crate::state::MongoConn;
use mongodb::bson::{doc, Bson, Document};
use serde_json::Value;
use std::time::Instant;

use super::schema::resolve_db;
use super::shell::{self, MongoOp};
use super::values::{bson_to_json, id_to_bson, json_to_bson, string_to_bson};

/// Collect a cursor of documents without pulling in an external `Stream` trait
/// (the `mongodb` cursor exposes `advance` + `deserialize_current` directly).
async fn collect(cursor: &mut mongodb::Cursor<Document>) -> AppResult<Vec<Document>> {
    let mut out = Vec::new();
    while cursor.advance().await? {
        out.push(cursor.deserialize_current()?);
    }
    Ok(out)
}

/// Flatten a set of documents into a tabular result. Columns are the union of
/// top-level field names across all rows, `_id` pinned first, otherwise
/// first-seen order.
fn docs_to_result(docs: Vec<Document>, elapsed_ms: u64) -> QueryResult {
    let mut order: Vec<String> = Vec::new();
    let mut seen: std::collections::HashSet<String> = std::collections::HashSet::new();
    for d in &docs {
        for k in d.keys() {
            if seen.insert(k.clone()) {
                order.push(k.clone());
            }
        }
    }
    order.sort_by_key(|k| if k == "_id" { 0 } else { 1 });

    let columns: Vec<ColumnMeta> = order
        .iter()
        .map(|name| ColumnMeta {
            name: name.clone(),
            // BSON is schemaless; the explorer infers per-field types separately.
            data_type: "bson".to_string(),
        })
        .collect();

    let rows: Vec<Vec<Value>> = docs
        .iter()
        .map(|d| {
            order
                .iter()
                .map(|k| d.get(k).map(bson_to_json).unwrap_or(Value::Null))
                .collect()
        })
        .collect();

    QueryResult {
        rows_affected: rows.len() as u64,
        rows,
        columns,
        elapsed_ms,
        total: None,
    }
}

/// Single scalar result (used by `count`): one column, one row.
fn scalar_result(name: &str, value: Value, elapsed_ms: u64) -> QueryResult {
    QueryResult {
        columns: vec![ColumnMeta {
            name: name.to_string(),
            data_type: "bson".into(),
        }],
        rows: vec![vec![value]],
        rows_affected: 1,
        elapsed_ms,
        total: None,
    }
}

/// Result carrying only an affected-document count (writes).
fn affected_result(count: u64, elapsed_ms: u64) -> QueryResult {
    QueryResult {
        columns: vec![],
        rows: vec![],
        rows_affected: count,
        elapsed_ms,
        total: None,
    }
}

/// Execute one parsed `mongosh` statement and shape it into a [`QueryResult`].
pub async fn execute(conn: &MongoConn, sql: &str) -> AppResult<QueryResult> {
    let start = Instant::now();
    let parsed = shell::parse(sql)?;
    let db = resolve_db(conn)?;
    let coll = db.collection::<Document>(&parsed.collection);
    let ms = || start.elapsed().as_millis() as u64;

    match parsed.op {
        MongoOp::Find {
            filter,
            projection,
            sort,
            limit,
            skip,
            one,
        } => {
            let mut action = coll.find(filter);
            if let Some(p) = projection {
                action = action.projection(p);
            }
            if let Some(s) = sort {
                action = action.sort(s);
            }
            let effective_limit = if one { Some(1) } else { limit };
            if let Some(l) = effective_limit {
                action = action.limit(l);
            }
            if let Some(sk) = skip {
                action = action.skip(sk.max(0) as u64);
            }
            let mut cursor = action.await?;
            let docs = collect(&mut cursor).await?;
            Ok(docs_to_result(docs, ms()))
        }
        MongoOp::Aggregate { pipeline } => {
            let mut cursor = coll.aggregate(pipeline).await?;
            let docs = collect(&mut cursor).await?;
            Ok(docs_to_result(docs, ms()))
        }
        MongoOp::Count { filter } => {
            let n = coll.count_documents(filter).await?;
            Ok(scalar_result("count", Value::from(n), ms()))
        }
        MongoOp::Distinct { field, filter } => {
            let values = coll.distinct(&field, filter).await?;
            let rows: Vec<Vec<Value>> = values.iter().map(|b| vec![bson_to_json(b)]).collect();
            Ok(QueryResult {
                columns: vec![ColumnMeta {
                    name: field,
                    data_type: "bson".into(),
                }],
                rows_affected: rows.len() as u64,
                rows,
                elapsed_ms: ms(),
                total: None,
            })
        }
        MongoOp::InsertOne { doc } => {
            coll.insert_one(doc).await?;
            Ok(affected_result(1, ms()))
        }
        MongoOp::InsertMany { docs } => {
            let n = docs.len() as u64;
            coll.insert_many(docs).await?;
            Ok(affected_result(n, ms()))
        }
        MongoOp::UpdateOne { filter, update } => {
            let r = coll.update_one(filter, update).await?;
            Ok(affected_result(r.modified_count, ms()))
        }
        MongoOp::UpdateMany { filter, update } => {
            let r = coll.update_many(filter, update).await?;
            Ok(affected_result(r.modified_count, ms()))
        }
        MongoOp::ReplaceOne {
            filter,
            replacement,
        } => {
            let r = coll.replace_one(filter, replacement).await?;
            Ok(affected_result(r.modified_count, ms()))
        }
        MongoOp::DeleteOne { filter } => {
            let r = coll.delete_one(filter).await?;
            Ok(affected_result(r.deleted_count, ms()))
        }
        MongoOp::DeleteMany { filter } => {
            let r = coll.delete_many(filter).await?;
            Ok(affected_result(r.deleted_count, ms()))
        }
    }
}

/// Run a batch of `mongosh` statements sequentially (one [`StmtOutcome`] each,
/// stopping at the first failure — mirrors the SQL batch contract).
pub async fn execute_batch(conn: &MongoConn, statements: &[String]) -> AppResult<BatchResult> {
    let mut outcomes = Vec::new();
    let mut last_result = None;
    let mut total_affected = 0u64;

    for (index, raw) in statements.iter().enumerate() {
        let stmt = raw.trim();
        if stmt.is_empty() {
            continue;
        }
        let is_read = shell::parse(stmt).map(|c| c.op.is_read()).unwrap_or(false);
        match execute(conn, stmt).await {
            Ok(result) => {
                total_affected += result.rows_affected;
                outcomes.push(StmtOutcome {
                    index,
                    preview: stmt_preview(stmt),
                    rows_affected: result.rows_affected,
                    is_select: is_read,
                    error: None,
                });
                if is_read {
                    last_result = Some(result);
                }
            }
            Err(e) => {
                outcomes.push(StmtOutcome {
                    index,
                    preview: stmt_preview(stmt),
                    rows_affected: 0,
                    is_select: is_read,
                    error: Some(e.to_string()),
                });
                break;
            }
        }
    }

    Ok(BatchResult {
        statements: outcomes,
        last_result,
        total_affected,
    })
}

fn stmt_preview(s: &str) -> String {
    let one_line = s.split_whitespace().collect::<Vec<_>>().join(" ");
    if one_line.chars().count() > 120 {
        let head: String = one_line.chars().take(117).collect();
        format!("{head}…")
    } else {
        one_line
    }
}

/// Build a Mongo filter document from the grid's column filters + free-text
/// search. `_id` equality/inequality reconstructs the BSON `_id` (ObjectId-aware).
fn build_filter(
    filters: &[ColumnFilter],
    search: Option<&str>,
    search_columns: &[String],
) -> Document {
    let mut clauses: Vec<Document> = Vec::new();

    for f in filters {
        let clause = match f.op {
            FilterOp::IsNull => doc! { &f.column: { "$eq": Bson::Null } },
            FilterOp::IsNotNull => doc! { &f.column: { "$ne": Bson::Null } },
            FilterOp::Eq => {
                let v = field_value(&f.column, &f.value);
                doc! { &f.column: v }
            }
            FilterOp::Ne => {
                let v = field_value(&f.column, &f.value);
                doc! { &f.column: { "$ne": v } }
            }
        };
        clauses.push(clause);
    }

    if let Some(q) = search {
        if !q.is_empty() && !search_columns.is_empty() {
            let escaped = regex_escape(q);
            let ors: Vec<Document> = search_columns
                .iter()
                .map(|c| doc! { c: { "$regex": &escaped, "$options": "i" } })
                .collect();
            clauses.push(doc! { "$or": ors });
        }
    }

    if clauses.is_empty() {
        Document::new()
    } else if clauses.len() == 1 {
        clauses.into_iter().next().unwrap()
    } else {
        doc! { "$and": clauses }
    }
}

/// Convert a filter value to BSON, treating `_id` specially so an ObjectId
/// rendered as a hex string round-trips to a real ObjectId.
fn field_value(column: &str, value: &Value) -> Bson {
    if column == "_id" {
        id_to_bson(value)
    } else {
        json_to_bson(value)
    }
}

/// Escape regex metacharacters so a free-text search is matched literally.
fn regex_escape(input: &str) -> String {
    let mut out = String::with_capacity(input.len());
    for ch in input.chars() {
        if "\\^$.|?*+()[]{}".contains(ch) {
            out.push('\\');
        }
        out.push(ch);
    }
    out
}

/// Paginated collection browse — the MongoDB analogue of `fetch_table_data`.
#[allow(clippy::too_many_arguments)]
pub async fn fetch_collection_data(
    conn: &MongoConn,
    collection: &str,
    limit: i64,
    offset: i64,
    order_by: Option<&str>,
    order_desc: bool,
    filters: &[ColumnFilter],
    search: Option<&str>,
    search_columns: &[String],
) -> AppResult<QueryResult> {
    let start = Instant::now();
    let db = resolve_db(conn)?;
    let coll = db.collection::<Document>(collection);

    let filter = build_filter(filters, search, search_columns);

    let total = coll.count_documents(filter.clone()).await?;

    let mut action = coll
        .find(filter)
        .limit(limit.max(0))
        .skip(offset.max(0) as u64);
    if let Some(col) = order_by {
        let dir = if order_desc { -1 } else { 1 };
        action = action.sort(doc! { col: dir });
    }
    let mut cursor = action.await?;
    let docs = collect(&mut cursor).await?;

    let mut result = docs_to_result(docs, start.elapsed().as_millis() as u64);
    result.total = Some(total);
    Ok(result)
}

/// Update one field of one document addressed by `_id` (`$set`).
pub async fn update_cell(
    conn: &MongoConn,
    collection: &str,
    id_value: &Value,
    field: &str,
    value: Option<&str>,
    type_hint: Option<&str>,
) -> AppResult<u64> {
    let db = resolve_db(conn)?;
    let coll = db.collection::<Document>(collection);
    let id = id_to_bson(id_value);
    let new_value = string_to_bson(value, type_hint);
    let r = coll
        .update_one(doc! { "_id": id }, doc! { "$set": { field: new_value } })
        .await?;
    Ok(r.modified_count)
}

/// Delete documents by their `_id` values (`{_id: {$in: […]}}`).
pub async fn delete_rows(
    conn: &MongoConn,
    collection: &str,
    id_values: &[Value],
) -> AppResult<u64> {
    if id_values.is_empty() {
        return Ok(0);
    }
    let db = resolve_db(conn)?;
    let coll = db.collection::<Document>(collection);
    let ids: Vec<Bson> = id_values.iter().map(id_to_bson).collect();
    let r = coll.delete_many(doc! { "_id": { "$in": ids } }).await?;
    Ok(r.deleted_count)
}

/// Insert one document built from the grid's column/value pairs. Returns the
/// inserted `_id` as JSON (so the grid can locate the new row).
pub async fn insert_row(
    conn: &MongoConn,
    collection: &str,
    values: &[RowValue],
) -> AppResult<Value> {
    let db = resolve_db(conn)?;
    let coll = db.collection::<Document>(collection);

    let mut document = Document::new();
    for rv in values {
        // Skip an empty/blank `_id` so the server generates an ObjectId.
        if rv.column == "_id" && rv.value.as_deref().map(str::trim).unwrap_or("").is_empty() {
            continue;
        }
        let bson = string_to_bson(rv.value.as_deref(), rv.column_type.as_deref());
        document.insert(rv.column.clone(), bson);
    }

    let res = coll.insert_one(document).await?;
    Ok(bson_to_json(&res.inserted_id))
}
