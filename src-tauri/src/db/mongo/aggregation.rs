//! Aggregation pipelines and MongoDB views.
//!
//! MongoDB has no `CREATE VIEW`: a view *is* a stored aggregation pipeline over
//! a source collection, created with `{create, viewOn, pipeline}` and altered
//! with `{collMod, viewOn, pipeline}`. That is why [`crate::commands::view`]
//! rejects MongoDB outright — the SQL view editor's "diff two SELECT bodies and
//! build DDL" model has nothing to diff. This module is the parallel path:
//! parse → preview → save, with the pipeline as the unit of work.
//!
//! Three things it deliberately does *not* do:
//!
//! * **Invent a grammar.** Stage bodies are read by
//!   [`super::shell::parse_relaxed_value`], the same relaxed-JSON/constructor
//!   parser the query editor already uses, and written back by
//!   [`super::values::bson_to_shell_text`]. One grammar, both directions.
//! * **Let a preview write.** `$out` and `$merge` end a pipeline by *writing* a
//!   collection. Running one as a "preview" — on every keystroke, debounced —
//!   would silently overwrite a collection while the user is still typing, so
//!   [`reject_write_stages`] refuses them before anything reaches the server.
//! * **Trust a stage to be cheap.** Every preview appends `{$limit: n}`, and the
//!   per-stage preview runs the pipeline *prefix* for each stage, so what the UI
//!   shows is bounded work rather than a full materialisation per keystroke.

use crate::commands::query::QueryResult;
use crate::error::{AppError, AppResult};
use crate::state::MongoConn;
use mongodb::bson::{doc, Bson, Document};
use serde::{Deserialize, Serialize};
use std::time::Instant;

use super::query::docs_to_result;
use super::schema::resolve_db;
use super::shell::parse_relaxed_value;
use super::values::{bson_to_shell_text, pipeline_to_shell_text};

/// Upper bound on a preview's sample size, whatever the caller asks for. The
/// editor's default is 10 (Compass's); this only stops a hand-edited request
/// from turning a debounced keystroke into a full table scan.
const MAX_PREVIEW_LIMIT: u32 = 200;

// ---------------------------------------------------------------------------
// DTOs
// ---------------------------------------------------------------------------

/// A MongoDB view as the editor sees it: the source collection plus the
/// pipeline, already rendered as editable source text.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MongoViewDefinition {
    pub name: String,
    /// The collection (or other view) the pipeline reads from — `viewOn`.
    pub view_on: String,
    /// The whole pipeline as one editable array literal, for the text editor.
    pub pipeline: String,
    /// The same pipeline split per stage, for the stage editor. Each entry is
    /// one stage document as source text.
    pub stages: Vec<String>,
}

/// One stage as the editor holds it: its source text plus whether it is
/// currently switched on. A disabled stage is kept in the document so the user
/// can toggle it back, but never reaches the server.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PipelineStageInput {
    pub body: String,
    #[serde(default = "default_true")]
    pub enabled: bool,
}

fn default_true() -> bool {
    true
}

/// Preview output for a single stage, aligned by index to the stages that were
/// sent in — so the UI can render "this stage errored" against the right card
/// without re-deriving the mapping.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StagePreview {
    pub index: usize,
    /// `true` when the stage is disabled: nothing was run for it.
    pub skipped: bool,
    /// Documents this stage emitted (sampled), when the prefix ran.
    pub result: Option<QueryResult>,
    /// Why this stage has no result — a parse error in its own body, or a
    /// server error from running the pipeline up to and including it.
    pub error: Option<String>,
    /// Whether the sample hit the preview limit, i.e. the real output is
    /// "`result.rows.len()` or more" rather than exactly that many.
    pub truncated: bool,
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

/// Parse one stage body into a document.
pub fn parse_stage(body: &str) -> AppResult<Document> {
    let trimmed = body.trim();
    if trimmed.is_empty() {
        return Err(AppError::InvalidInput("the stage is empty".into()));
    }
    match parse_relaxed_value(trimmed)? {
        Bson::Document(d) => Ok(d),
        _ => Err(AppError::InvalidInput(
            "a pipeline stage must be a document, e.g. { $match: { status: \"A\" } }".into(),
        )),
    }
}

/// Parse a whole pipeline written as one array literal (the text editor's
/// mode). Accepts a bare document too — a single-stage pipeline typed without
/// its brackets is a common slip and reads unambiguously.
pub fn parse_pipeline_text(text: &str) -> AppResult<Vec<Document>> {
    let trimmed = text.trim();
    if trimmed.is_empty() {
        return Ok(Vec::new());
    }
    match parse_relaxed_value(trimmed)? {
        Bson::Array(items) => items
            .into_iter()
            .enumerate()
            .map(|(i, item)| match item {
                Bson::Document(d) => Ok(d),
                _ => Err(AppError::InvalidInput(format!(
                    "stage {} is not a document — every pipeline entry must be `{{ $stage: … }}`",
                    i + 1
                ))),
            })
            .collect(),
        Bson::Document(d) => Ok(vec![d]),
        _ => Err(AppError::InvalidInput(
            "a pipeline must be an array of stages, e.g. [ { $match: { … } } ]".into(),
        )),
    }
}

/// Collect the enabled stages of a stage list, parsing each one. A parse error
/// names the stage so the message is actionable in a 20-stage pipeline.
pub fn parse_enabled(stages: &[PipelineStageInput]) -> AppResult<Vec<Document>> {
    let mut out = Vec::new();
    for (i, stage) in stages.iter().enumerate() {
        if !stage.enabled {
            continue;
        }
        let doc = parse_stage(&stage.body)
            .map_err(|e| AppError::InvalidInput(format!("stage {}: {e}", i + 1)))?;
        out.push(doc);
    }
    Ok(out)
}

/// Refuse the pipeline stages that write.
///
/// `$out` and `$merge` are terminal *write* stages: running one replaces or
/// upserts into a real collection. The editor previews on a debounce as the
/// user types, so executing them would destroy data mid-edit — and a view whose
/// pipeline ends in one is rejected by the server anyway. Checked before the
/// pipeline is sent, so the message names the stage instead of surfacing a
/// server error.
pub fn reject_write_stages(stages: &[Document]) -> AppResult<()> {
    for (i, stage) in stages.iter().enumerate() {
        for key in stage.keys() {
            if key == "$out" || key == "$merge" {
                return Err(AppError::InvalidInput(format!(
                    "stage {} uses {key}, which writes to a collection — HuginnDB does not run \
                     write stages from the aggregation editor. Remove it to preview the pipeline, \
                     or run it from the query editor.",
                    i + 1
                )));
            }
        }
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Running
// ---------------------------------------------------------------------------

fn clamp_limit(limit: u32) -> i64 {
    limit.clamp(1, MAX_PREVIEW_LIMIT) as i64
}

/// Run `stages` against `source` and return at most `limit` documents.
pub async fn run_pipeline(
    conn: &MongoConn,
    source: &str,
    stages: Vec<Document>,
    limit: u32,
) -> AppResult<QueryResult> {
    reject_write_stages(&stages)?;
    let db = resolve_db(conn)?;
    let started = Instant::now();
    let mut full = stages;
    full.push(doc! {"$limit": clamp_limit(limit)});

    let mut cursor = db
        .collection::<Document>(source)
        .aggregate(full)
        .await
        .map_err(AppError::from)?;
    let mut docs = Vec::new();
    while cursor.advance().await? {
        docs.push(cursor.deserialize_current()?);
    }
    let truncated = docs.len() as i64 >= clamp_limit(limit);
    Ok(docs_to_result(
        docs,
        started.elapsed().as_millis() as u64,
        truncated,
    ))
}

/// Run one preview per stage: stage *i*'s output is the pipeline truncated
/// after it. This is what makes the stage editor legible — you can see exactly
/// where a `$match` empties the pipeline or a `$lookup` fans it out — and it is
/// why every prefix carries its own `$limit`.
///
/// Errors are per stage rather than fatal: a half-typed stage 3 leaves stages
/// 1–2 previewing normally, and stage 3 shows why it can't run. Stages after a
/// broken one report the same failure (their prefix contains it), which is the
/// honest answer — there is no output to show until it parses.
pub async fn preview_stages(
    conn: &MongoConn,
    source: &str,
    stages: &[PipelineStageInput],
    limit: u32,
) -> AppResult<Vec<StagePreview>> {
    let db = resolve_db(conn)?;
    let coll = db.collection::<Document>(source);
    let sample = clamp_limit(limit);

    // Prefix of *enabled, parsed* stages built up as we walk the list. A
    // disabled stage contributes nothing but still gets an entry, so the
    // frontend's index alignment holds.
    let mut prefix: Vec<Document> = Vec::new();
    let mut failed: Option<String> = None;
    let mut out = Vec::with_capacity(stages.len());

    for (index, stage) in stages.iter().enumerate() {
        if !stage.enabled {
            out.push(StagePreview {
                index,
                skipped: true,
                result: None,
                error: None,
                truncated: false,
            });
            continue;
        }
        if let Some(reason) = &failed {
            out.push(StagePreview {
                index,
                skipped: false,
                result: None,
                error: Some(reason.clone()),
                truncated: false,
            });
            continue;
        }
        let parsed = match parse_stage(&stage.body) {
            Ok(d) => d,
            Err(e) => {
                let message = e.to_string();
                failed = Some(format!("stage {}: {message}", index + 1));
                out.push(StagePreview {
                    index,
                    skipped: false,
                    result: None,
                    error: Some(message),
                    truncated: false,
                });
                continue;
            }
        };
        if let Err(e) = reject_write_stages(std::slice::from_ref(&parsed)) {
            let message = e.to_string();
            failed = Some(message.clone());
            out.push(StagePreview {
                index,
                skipped: false,
                result: None,
                error: Some(message),
                truncated: false,
            });
            continue;
        }
        prefix.push(parsed);

        let mut run = prefix.clone();
        run.push(doc! {"$limit": sample});
        let started = Instant::now();
        match coll.aggregate(run).await {
            Ok(mut cursor) => {
                let mut docs = Vec::new();
                let mut read_error = None;
                loop {
                    match cursor.advance().await {
                        Ok(true) => match cursor.deserialize_current() {
                            Ok(d) => docs.push(d),
                            Err(e) => {
                                read_error = Some(e.to_string());
                                break;
                            }
                        },
                        Ok(false) => break,
                        Err(e) => {
                            read_error = Some(e.to_string());
                            break;
                        }
                    }
                }
                match read_error {
                    Some(message) => {
                        // A cursor failure is this stage's problem, not a reason
                        // to stop previewing later ones — the prefix is still
                        // valid, so let them try.
                        out.push(StagePreview {
                            index,
                            skipped: false,
                            result: None,
                            error: Some(message),
                            truncated: false,
                        });
                    }
                    None => {
                        let truncated = docs.len() as i64 >= sample;
                        out.push(StagePreview {
                            index,
                            skipped: false,
                            result: Some(docs_to_result(
                                docs,
                                started.elapsed().as_millis() as u64,
                                truncated,
                            )),
                            error: None,
                            truncated,
                        });
                    }
                }
            }
            Err(e) => {
                out.push(StagePreview {
                    index,
                    skipped: false,
                    result: None,
                    error: Some(e.to_string()),
                    truncated: false,
                });
            }
        }
    }
    Ok(out)
}

// ---------------------------------------------------------------------------
// Views
// ---------------------------------------------------------------------------

/// What `name` currently is in this database.
///
/// The three states are kept distinct because collapsing any two of them loses
/// something a caller needs. A view and a collection share one namespace in
/// MongoDB, so "exists" is not enough to know whether an operation is safe:
/// [`drop_view`] must refuse a collection outright (dropping one deletes its
/// documents), while a caller deciding between `create` and `collMod` must tell
/// "absent" from "already a view" — and a caller merely *describing* a relation
/// treats both non-view answers as "no view body", not as an error.
pub enum ViewPresence {
    /// Nothing by that name.
    Absent,
    /// A plain collection. Never a view operation's target.
    Collection,
    /// A view, with its stored definition already parsed.
    View(MongoViewDefinition),
}

/// Whether a `listCollections` spec describes a view.
///
/// Pure, and split out for that reason: this predicate is the whole thing
/// standing between [`drop_view`] and a collection's documents, so it is worth
/// being testable without a server. Absent `type` means collection — the field
/// only appeared in MongoDB 3.4, and treating an unknown reply as the
/// destructive case would be the wrong way round.
fn spec_is_view(spec: &Document) -> bool {
    spec.get_str("type").unwrap_or("collection") == "view"
}

/// The `listCollections` spec for `name`, or `None` when nothing by that name
/// exists.
///
/// Goes through the raw command rather than the typed helper: `viewOn` and
/// `pipeline` live in the spec's free-form `options` document, and reading them
/// as BSON keeps this independent of how the driver's `CollectionSpecification`
/// models options across versions.
pub(super) async fn collection_spec(conn: &MongoConn, name: &str) -> AppResult<Option<Document>> {
    let db = resolve_db(conn)?;
    let reply = db
        .run_command(doc! {
            "listCollections": 1,
            "filter": { "name": name },
        })
        .await?;
    Ok(reply
        .get_document("cursor")
        .ok()
        .and_then(|c| c.get_array("firstBatch").ok())
        .and_then(|batch| batch.first())
        .and_then(Bson::as_document)
        .cloned())
}

/// Parse a view's spec into the editable definition.
fn view_from_spec(name: &str, spec: &Document) -> AppResult<MongoViewDefinition> {
    let options = spec.get_document("options").map_err(|_| {
        AppError::InvalidInput(format!("view {name} has no stored definition to edit"))
    })?;
    let view_on = options.get_str("viewOn").unwrap_or_default().to_string();
    let stage_docs: Vec<Document> = options
        .get_array("pipeline")
        .map(|stages| {
            stages
                .iter()
                .filter_map(Bson::as_document)
                .cloned()
                .collect()
        })
        .unwrap_or_default();

    Ok(MongoViewDefinition {
        name: name.to_string(),
        view_on,
        pipeline: pipeline_to_shell_text(&stage_docs),
        stages: stage_docs
            .iter()
            .map(|d| bson_to_shell_text(&Bson::Document(d.clone())))
            .collect(),
    })
}

/// Resolve what `name` is, parsing the definition when it turns out to be a
/// view. One round trip, and the only place the three states are derived.
pub async fn view_presence(conn: &MongoConn, name: &str) -> AppResult<ViewPresence> {
    let Some(spec) = collection_spec(conn, name).await? else {
        return Ok(ViewPresence::Absent);
    };
    if !spec_is_view(&spec) {
        return Ok(ViewPresence::Collection);
    }
    Ok(ViewPresence::View(view_from_spec(name, &spec)?))
}

/// Read a view's stored definition and render its pipeline back as editable
/// source.
///
/// Errors on anything that is not a view, which is what the editor wants: it
/// was opened on a specific view and has nothing to show otherwise. A caller
/// that would rather treat "not a view" as an ordinary answer wants
/// [`view_presence`].
pub async fn read_view(conn: &MongoConn, name: &str) -> AppResult<MongoViewDefinition> {
    match view_presence(conn, name).await? {
        ViewPresence::View(def) => Ok(def),
        ViewPresence::Collection => Err(AppError::InvalidInput(format!(
            "`{name}` is a collection, not a view"
        ))),
        ViewPresence::Absent => Err(AppError::NotFound(format!("view {name}"))),
    }
}

/// Create a new view (`{create, viewOn, pipeline}`) or redefine an existing one
/// (`{collMod, viewOn, pipeline}`).
///
/// Both commands take the same two fields, which is why one function covers
/// them: the only difference is whether the name must already exist. `collMod`
/// replaces the pipeline wholesale — there is no partial update — so the editor
/// always sends the complete pipeline.
pub async fn save_view(
    conn: &MongoConn,
    name: &str,
    view_on: &str,
    stages: Vec<Document>,
    create: bool,
) -> AppResult<()> {
    let name = name.trim();
    if name.is_empty() {
        return Err(AppError::InvalidInput("the view needs a name".into()));
    }
    if name.starts_with("system.") {
        return Err(AppError::InvalidInput(
            "`system.` is reserved for MongoDB's own collections".into(),
        ));
    }
    if view_on.trim().is_empty() {
        return Err(AppError::InvalidInput(
            "a view needs a source collection (viewOn)".into(),
        ));
    }
    // A view whose pipeline writes is rejected by the server too, but with a
    // less specific message than the one this gives.
    reject_write_stages(&stages)?;

    let db = resolve_db(conn)?;
    let key = if create { "create" } else { "collMod" };
    db.run_command(doc! {
        key: name,
        "viewOn": view_on.trim(),
        "pipeline": stages.into_iter().map(Bson::Document).collect::<Vec<_>>(),
    })
    .await?;
    Ok(())
}

/// Drop a view, refusing anything that is not one.
///
/// The call itself is identical to dropping a collection — MongoDB keeps views
/// and collections in one namespace — which is exactly why the check in front
/// of it is not optional. Unguarded, `drop_view("orders")` against a database
/// whose `orders` is a real collection deletes every document in it, reporting
/// success. That was survivable while the only caller was the schema explorer,
/// where the user had clicked a row the tree already knew was a view; it is not
/// survivable once a caller can pass a name it merely guessed, which is what
/// exposing this over the MCP connector means.
///
/// An absent name is an error rather than a silent success, even though
/// MongoDB's own `drop` is idempotent: every SQL driver here builds a bare
/// `DROP VIEW` with no `IF EXISTS`, so erroring is what makes this consistent
/// with the other four rather than a special case — and a caller that mistyped
/// a name learns so instead of being told it worked.
pub async fn drop_view(conn: &MongoConn, name: &str) -> AppResult<()> {
    match view_presence(conn, name).await? {
        ViewPresence::View(_) => {}
        ViewPresence::Collection => {
            return Err(AppError::InvalidInput(format!(
                "`{name}` is a collection, not a view — refusing to drop it. Dropping a \
                 collection deletes every document in it; drop the collection itself if that \
                 is really what you meant."
            )))
        }
        ViewPresence::Absent => return Err(AppError::NotFound(format!("view {name}"))),
    }
    let db = resolve_db(conn)?;
    db.collection::<Document>(name).drop().await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_a_relaxed_pipeline_array() {
        let stages = parse_pipeline_text(
            r#"[
              // keep only the active ones
              { $match: { status: 'A' } },
              { $group: { _id: "$cust", n: { $sum: 1 } } },
            ]"#,
        )
        .unwrap();
        assert_eq!(stages.len(), 2);
        assert!(stages[0].contains_key("$match"));
        assert!(stages[1].contains_key("$group"));
    }

    #[test]
    fn accepts_a_single_stage_without_brackets() {
        let stages = parse_pipeline_text("{ $limit: 5 }").unwrap();
        assert_eq!(stages.len(), 1);
        assert_eq!(stages[0].get_i32("$limit").unwrap(), 5);
    }

    #[test]
    fn empty_pipeline_text_is_an_empty_pipeline() {
        assert!(parse_pipeline_text("   \n  ").unwrap().is_empty());
    }

    #[test]
    fn rejects_a_non_document_stage() {
        let err = parse_pipeline_text("[ 1, 2 ]").unwrap_err().to_string();
        assert!(err.contains("stage 1"), "unexpected message: {err}");
    }

    #[test]
    fn rejects_write_stages_by_name() {
        let stages = parse_pipeline_text(r#"[{ $match: {} }, { $out: "copy" }]"#).unwrap();
        let err = reject_write_stages(&stages).unwrap_err().to_string();
        assert!(err.contains("$out"), "unexpected message: {err}");
        assert!(err.contains("stage 2"), "unexpected message: {err}");

        let merge = parse_pipeline_text(r#"[{ $merge: { into: "x" } }]"#).unwrap();
        assert!(reject_write_stages(&merge).is_err());
    }

    #[test]
    fn disabled_stages_are_left_out_of_the_parsed_pipeline() {
        let stages = vec![
            PipelineStageInput {
                body: "{ $match: { a: 1 } }".into(),
                enabled: true,
            },
            PipelineStageInput {
                body: "{ $limit: 3 }".into(),
                enabled: false,
            },
        ];
        let parsed = parse_enabled(&stages).unwrap();
        assert_eq!(parsed.len(), 1);
        assert!(parsed[0].contains_key("$match"));
    }

    #[test]
    fn a_parse_error_names_the_stage() {
        let stages = vec![
            PipelineStageInput {
                body: "{ $match: {} }".into(),
                enabled: true,
            },
            PipelineStageInput {
                body: "{ $limit: }".into(),
                enabled: true,
            },
        ];
        let err = parse_enabled(&stages).unwrap_err().to_string();
        assert!(err.contains("stage 2"), "unexpected message: {err}");
    }

    /// The round-trip that keeps a saved view from silently changing meaning:
    /// text → BSON → text must be stable, and typed values must survive.
    #[test]
    fn pipeline_source_round_trips_through_bson() {
        let source = r#"[
          { $match: { _id: ObjectId("507f1f77bcf86cd799439011"), n: NumberLong(301353073) } },
          { $addFields: { at: ISODate("2026-08-17T10:00:00Z"), ratio: 1.5, whole: 2.0 } }
        ]"#;
        let stages = parse_pipeline_text(source).unwrap();
        let text = pipeline_to_shell_text(&stages);
        assert!(
            text.contains("ObjectId(\"507f1f77bcf86cd799439011\")"),
            "{text}"
        );
        assert!(text.contains("NumberLong(301353073)"), "{text}");
        assert!(text.contains("ISODate("), "{text}");
        // Re-parsing the rendered source must produce the identical pipeline —
        // this is what stops "open a view, save it unchanged" from rewriting a
        // Long as an Int or an ObjectId as a string.
        let reparsed = parse_pipeline_text(&text).unwrap();
        assert_eq!(stages, reparsed);
    }

    #[test]
    fn dotted_keys_stay_quoted_when_rendered() {
        let stages = parse_pipeline_text(r#"[{ $sort: { "customData.format": -1 } }]"#).unwrap();
        let text = pipeline_to_shell_text(&stages);
        assert!(text.contains("\"customData.format\""), "{text}");
        assert_eq!(parse_pipeline_text(&text).unwrap(), stages);
    }

    // -----------------------------------------------------------------------
    // The guard in front of `drop_view`
    // -----------------------------------------------------------------------

    #[test]
    fn a_view_spec_is_recognised_as_a_view() {
        assert!(spec_is_view(
            &doc! { "name": "active_orders", "type": "view" }
        ));
    }

    #[test]
    fn a_collection_spec_is_not_a_view() {
        // The case that costs data if it goes the other way: `drop_view` on
        // this name would delete every document in the collection.
        assert!(!spec_is_view(
            &doc! { "name": "orders", "type": "collection" }
        ));
    }

    #[test]
    fn a_spec_with_no_type_is_treated_as_a_collection() {
        // `type` only appeared in MongoDB 3.4, and an unknown reply must fall
        // to the *safe* answer, not the destructive one.
        assert!(!spec_is_view(&doc! { "name": "orders" }));
        assert!(!spec_is_view(&doc! { "name": "orders", "type": 1 }));
    }

    #[test]
    fn a_view_spec_parses_into_an_editable_definition() {
        let spec = doc! {
            "name": "active_orders",
            "type": "view",
            "options": {
                "viewOn": "orders",
                "pipeline": [ { "$match": { "status": "A" } } ],
            },
        };
        let def = view_from_spec("active_orders", &spec).unwrap();
        assert_eq!(def.name, "active_orders");
        assert_eq!(def.view_on, "orders");
        assert!(def.pipeline.contains("$match"));
        assert_eq!(def.stages.len(), 1);
    }
}
