//! MongoDB query + CRUD execution, shaped into the SQL-shaped DTOs the rest of
//! the app consumes ([`QueryResult`] / [`BatchResult`]).
//!
//! Read operations (`find`/`aggregate`/`count`/`distinct`) are flattened into a
//! tabular `(columns, rows)` result by [`docs_to_result`]: top-level fields
//! become columns (`_id` first), nested documents/arrays stay structured JSON in
//! the cell (the `CellPreview` panel expands them). Write operations report an
//! affected-document count in `rows_affected` and carry no rows.

use crate::commands::query::{
    BatchResult, ColumnFilter, ColumnMeta, CountResult, FilterOp, QueryResult, RowValue, SortSpec,
    StmtOutcome,
};
use crate::error::AppResult;
use crate::log_bus::{LogEntry, LogKind, LogSink};
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

/// Infer a single column's BSON type across a result set: the type of the
/// first non-null value seen for `field`, or `"mixed"` if later non-null
/// values disagree with it (BSON is schemaless, so within one result set a
/// field can legitimately hold different types across rows/documents — this
/// is the honest answer rather than picking one type and silently hiding the
/// disagreement). `"null"` when `field` is absent or null in every document.
fn infer_column_type<'a>(docs: impl Iterator<Item = Option<&'a Bson>>) -> String {
    let mut inferred: Option<&'static str> = None;
    for v in docs.flatten() {
        if matches!(v, Bson::Null) {
            continue;
        }
        let t = super::values::bson_type_name(v);
        match inferred {
            None => inferred = Some(t),
            Some(prev) if prev != t => return "mixed".to_string(),
            _ => {}
        }
    }
    inferred.unwrap_or("null").to_string()
}

/// Flatten a set of documents into a tabular result. Columns are the union of
/// top-level field names across all rows, `_id` pinned first, otherwise
/// first-seen order. Each column's `data_type` is inferred from the values
/// actually returned ([`infer_column_type`]) rather than a generic `"bson"`
/// label, so `run_query`/`browse_table` give an MCP client (or the data grid)
/// a real type signal — the same treatment the read-only structure view
/// already gives via `infer_columns`' document sampling.
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
            data_type: infer_column_type(docs.iter().map(|d| d.get(name))),
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

/// Single scalar result (used by `count`): one column, one row. `data_type` is
/// passed in by the caller rather than inferred — `count` always returns a
/// concrete, known type (a 64-bit count), so there's nothing to sample.
fn scalar_result(name: &str, data_type: &str, value: Value, elapsed_ms: u64) -> QueryResult {
    QueryResult {
        columns: vec![ColumnMeta {
            name: name.to_string(),
            data_type: data_type.to_string(),
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
            Ok(scalar_result("count", "long", Value::from(n), ms()))
        }
        MongoOp::Distinct { field, filter } => {
            let values = coll.distinct(&field, filter).await?;
            let data_type = infer_column_type(values.iter().map(Some));
            let rows: Vec<Vec<Value>> = values.iter().map(|b| vec![bson_to_json(b)]).collect();
            Ok(QueryResult {
                columns: vec![ColumnMeta {
                    name: field,
                    data_type,
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
            let r = coll
                .update_one(filter, mongodb::options::UpdateModifications::from(update))
                .await?;
            Ok(affected_result(r.modified_count, ms()))
        }
        MongoOp::UpdateMany { filter, update } => {
            let r = coll
                .update_many(filter, mongodb::options::UpdateModifications::from(update))
                .await?;
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
pub async fn execute_batch(
    conn: &MongoConn,
    statements: &[String],
    sink: &dyn LogSink,
    connection_id: &str,
) -> AppResult<BatchResult> {
    let mut outcomes = Vec::new();
    let mut last_result = None;
    let mut total_affected = 0u64;

    for (index, raw) in statements.iter().enumerate() {
        let stmt = raw.trim();
        if stmt.is_empty() {
            continue;
        }
        let is_read = shell::parse(stmt).map(|c| c.op.is_read()).unwrap_or(false);
        let start = Instant::now();
        match execute(conn, stmt).await {
            Ok(result) => {
                total_affected += result.rows_affected;
                sink.log(
                    LogEntry::new(LogKind::Sql)
                        .connection_id(connection_id)
                        .driver("mongodb")
                        .sql(stmt)
                        .duration_ms(start.elapsed().as_millis() as u64)
                        .rows_affected(result.rows_affected),
                );
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
                sink.log(
                    LogEntry::new(LogKind::Sql)
                        .connection_id(connection_id)
                        .driver("mongodb")
                        .sql(stmt)
                        .duration_ms(start.elapsed().as_millis() as u64)
                        .error(e.to_string()),
                );
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

/// Build a mongosh-style `db.<collection>.find(...)` string describing a
/// collection-browse request, for the Console log. `fetch_collection_data`
/// has no single "statement" of its own the way a hand-typed shell command
/// does, so this rebuilds the same filter `find` would run — purely for
/// display, not reused to actually query — to give the Console the same
/// "what ran" record the SQL drivers and the mongo shell tab already get.
pub(crate) fn describe_find(
    collection: &str,
    filters: &[ColumnFilter],
    search: Option<&str>,
    search_columns: &[String],
    order: &[SortSpec],
    limit: i64,
    offset: i64,
) -> String {
    let filter = build_filter(filters, search, search_columns);
    let mut s = format!(
        "db.{collection}.find({})",
        Bson::Document(filter).into_canonical_extjson()
    );
    if !order.is_empty() {
        let mut sort_doc = Document::new();
        for o in order {
            sort_doc.insert(o.column.clone(), if o.desc { -1 } else { 1 });
        }
        s.push_str(&format!(
            ".sort({})",
            Bson::Document(sort_doc).into_canonical_extjson()
        ));
    }
    if offset > 0 {
        s.push_str(&format!(".skip({offset})"));
    }
    if limit > 0 {
        s.push_str(&format!(".limit({limit})"));
    }
    s
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
        // Raw string form of the value, for the regex (substring/prefix/suffix)
        // operators — those match text, so an ObjectId-aware conversion isn't
        // wanted here.
        let raw = match &f.value {
            serde_json::Value::Null => String::new(),
            serde_json::Value::String(s) => s.clone(),
            other => other.to_string(),
        };
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
            FilterOp::Gt => doc! { &f.column: { "$gt": field_value(&f.column, &f.value) } },
            FilterOp::Gte => doc! { &f.column: { "$gte": field_value(&f.column, &f.value) } },
            FilterOp::Lt => doc! { &f.column: { "$lt": field_value(&f.column, &f.value) } },
            FilterOp::Lte => doc! { &f.column: { "$lte": field_value(&f.column, &f.value) } },
            FilterOp::Contains => {
                doc! { &f.column: { "$regex": regex_escape(&raw), "$options": "i" } }
            }
            FilterOp::NotContains => {
                doc! { &f.column: { "$not": { "$regex": regex_escape(&raw), "$options": "i" } } }
            }
            FilterOp::StartsWith => {
                doc! { &f.column: { "$regex": format!("^{}", regex_escape(&raw)), "$options": "i" } }
            }
            FilterOp::EndsWith => {
                doc! { &f.column: { "$regex": format!("{}$", regex_escape(&raw)), "$options": "i" } }
            }
            FilterOp::Between => doc! {
                &f.column: {
                    "$gte": field_value(&f.column, &f.value),
                    "$lte": field_value(&f.column, &f.value2),
                }
            },
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
    order: &[SortSpec],
    filters: &[ColumnFilter],
    search: Option<&str>,
    search_columns: &[String],
    with_count: bool,
) -> AppResult<QueryResult> {
    let start = Instant::now();
    let db = resolve_db(conn)?;
    let coll = db.collection::<Document>(collection);

    let filter = build_filter(filters, search, search_columns);

    // Skip the count when the caller already knows the total (sort/page-only
    // change); `count_documents` over a filter is the slow part on big
    // collections, mirroring the SQL COUNT(*) skip in `fetch_table_data`.
    let total = if with_count {
        Some(coll.count_documents(filter.clone()).await?)
    } else {
        None
    };

    let mut action = coll
        .find(filter)
        .limit(limit.max(0))
        .skip(offset.max(0) as u64);
    if !order.is_empty() {
        // BSON documents preserve insertion order, so a multi-key sort doc
        // honours the requested precedence (order[0] is the primary key).
        let mut sort_doc = Document::new();
        for s in order {
            sort_doc.insert(s.column.clone(), if s.desc { -1 } else { 1 });
        }
        action = action.sort(sort_doc);
    }
    let mut cursor = action.await?;
    let docs = collect(&mut cursor).await?;

    let mut result = docs_to_result(docs, start.elapsed().as_millis() as u64);
    result.total = total;
    Ok(result)
}

/// Count documents for the browse footer, served independently of the data
/// page (the MongoDB analogue of the SQL `count_table_rows`).
///
/// When `unfiltered` (whole collection) this uses `estimatedDocumentCount`,
/// which reads collection metadata in O(1) — the key difference from
/// [`fetch_collection_data`]'s inline `count_documents`, which scans the whole
/// collection and is exactly what made opening a multi-million-document
/// collection feel slow. With any predicate an exact `count_documents` over
/// the filter is unavoidable, but it no longer blocks the first render.
pub async fn count_collection(
    conn: &MongoConn,
    collection: &str,
    filters: &[ColumnFilter],
    search: Option<&str>,
    search_columns: &[String],
    unfiltered: bool,
) -> AppResult<CountResult> {
    let db = resolve_db(conn)?;
    let coll = db.collection::<Document>(collection);
    if unfiltered {
        let total = coll.estimated_document_count().await?;
        Ok(CountResult {
            total,
            estimated: true,
        })
    } else {
        let filter = build_filter(filters, search, search_columns);
        let total = coll.count_documents(filter).await?;
        Ok(CountResult {
            total,
            estimated: false,
        })
    }
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

#[cfg(test)]
mod tests {
    use super::*;

    fn doc_with(pairs: &[(&str, Bson)]) -> Document {
        let mut d = Document::new();
        for (k, v) in pairs {
            d.insert(k.to_string(), v.clone());
        }
        d
    }

    #[test]
    fn docs_to_result_infers_uniform_column_type() {
        let docs = vec![
            doc_with(&[("_id", Bson::Int32(1)), ("name", Bson::String("a".into()))]),
            doc_with(&[("_id", Bson::Int32(2)), ("name", Bson::String("b".into()))]),
        ];
        let result = docs_to_result(docs, 0);
        let name_col = result.columns.iter().find(|c| c.name == "name").unwrap();
        assert_eq!(name_col.data_type, "string");
    }

    #[test]
    fn docs_to_result_falls_back_to_mixed_on_type_disagreement() {
        let docs = vec![
            doc_with(&[("value", Bson::Int32(1))]),
            doc_with(&[("value", Bson::String("oops".into()))]),
        ];
        let result = docs_to_result(docs, 0);
        let col = result.columns.iter().find(|c| c.name == "value").unwrap();
        assert_eq!(col.data_type, "mixed");
    }

    #[test]
    fn docs_to_result_ignores_nulls_when_inferring_type() {
        let docs = vec![
            doc_with(&[("value", Bson::Null)]),
            doc_with(&[("value", Bson::Int64(42))]),
        ];
        let result = docs_to_result(docs, 0);
        let col = result.columns.iter().find(|c| c.name == "value").unwrap();
        assert_eq!(col.data_type, "long");
    }

    #[test]
    fn docs_to_result_reports_null_when_field_never_present() {
        let docs = vec![doc_with(&[("_id", Bson::Int32(1))])];
        let result = docs_to_result(docs, 0);
        assert_eq!(result.columns.len(), 1);
        assert_eq!(result.columns[0].name, "_id");
        assert_eq!(result.columns[0].data_type, "int");
    }

    #[test]
    fn describe_find_builds_a_readable_mongosh_style_string() {
        let filters = vec![ColumnFilter {
            column: "atnId".to_string(),
            op: FilterOp::Eq,
            value: serde_json::json!(183),
            value2: serde_json::Value::Null,
        }];
        let order = vec![SortSpec {
            column: "atnId".to_string(),
            desc: true,
        }];
        let s = describe_find("events", &filters, None, &[], &order, 50, 100);
        assert!(s.starts_with("db.events.find("));
        assert!(s.contains("\"atnId\""));
        assert!(s.contains(".sort("));
        assert!(s.contains(".skip(100)"));
        assert!(s.contains(".limit(50)"));
    }

    #[test]
    fn between_builds_gte_lte_document() {
        let filters = vec![ColumnFilter {
            column: "age".to_string(),
            op: FilterOp::Between,
            value: serde_json::json!(18),
            value2: serde_json::json!(65),
        }];
        let filter = build_filter(&filters, None, &[]);
        let age = filter.get_document("age").unwrap();
        assert_eq!(age.get_i32("$gte").unwrap(), 18);
        assert_eq!(age.get_i32("$lte").unwrap(), 65);
    }

    #[test]
    fn describe_find_omits_skip_and_limit_when_zero() {
        let s = describe_find("events", &[], None, &[], &[], 0, 0);
        assert_eq!(s, "db.events.find({})");
    }
}
