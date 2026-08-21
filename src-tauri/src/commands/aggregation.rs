//! MongoDB aggregation-pipeline and view commands.
//!
//! The Mongo counterpart of [`crate::commands::view`], which rejects MongoDB
//! outright because a Mongo "view" is a stored aggregation pipeline rather than
//! a `SELECT` body there is any DDL to diff. The shape here follows the same
//! read → preview → apply arc, with two differences that come straight from the
//! data model:
//!
//! * **Preview is per stage, not just per pipeline.** A pipeline is read one
//!   stage at a time, so the editor shows each stage's own output — the thing
//!   that makes a 16-stage `$lookup` chain debuggable at all.
//! * **The pipeline is source text, not a parsed structure.** It crosses the IPC
//!   boundary exactly as the user typed it (relaxed JSON, `ObjectId(…)`,
//!   comments) and is parsed in Rust by the grammar the query editor already
//!   uses. The frontend never needs a second parser, and the two surfaces can
//!   never disagree about what a value means.
//!
//! Every command rejects a non-MongoDB connection up front, mirroring how
//! `commands::view` rejects Mongo.

use crate::commands::query::QueryResult;
use crate::db::mongo::aggregation::{self, MongoViewDefinition, PipelineStageInput, StagePreview};
use crate::db::mongo::values::pipeline_to_shell_text;
use crate::error::{AppError, AppResult};
use crate::state::AppState;
use serde::{Deserialize, Serialize};
use tauri::State;

/// Default preview sample size — the same 10 documents Compass shows, chosen
/// so a debounced keystroke costs one bounded round trip per stage.
const DEFAULT_PREVIEW_LIMIT: u32 = 10;

/// Message for the non-MongoDB case of [`AppState::mongo_for`]. Named here
/// rather than templated in the helper because the useful half is the
/// pointer to this feature's SQL equivalent.
const MONGO_ONLY: &str =
    "the aggregation editor is MongoDB-only; SQL views are edited in the view editor";

// ---------------------------------------------------------------------------
// Formatting / mode switching
// ---------------------------------------------------------------------------

/// A pipeline in both of the representations the editor holds: one array
/// literal (text mode) and one source string per stage (stage mode).
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PipelineText {
    pub text: String,
    pub stages: Vec<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FormatPipelineArgs {
    /// The whole pipeline as one array literal…
    #[serde(default)]
    pub text: Option<String>,
    /// …or one source string per stage. Exactly one of the two is set.
    #[serde(default)]
    pub stages: Option<Vec<String>>,
}

/// Normalise a pipeline and return **both** representations of it.
///
/// This is the mode switch: going from the text editor to the stage editor
/// means splitting one array literal into its stages, and going back means
/// joining them — neither of which the frontend can do without re-implementing
/// the relaxed grammar (an array literal cannot be split on commas: a stage
/// body is full of them). Reusing the parser here keeps exactly one
/// implementation of "what is a stage".
///
/// Doubles as the editor's format/prettify action, since the round trip
/// re-renders from BSON.
#[tauri::command]
pub async fn format_mongo_pipeline(args: FormatPipelineArgs) -> AppResult<PipelineText> {
    let stages = match (&args.text, &args.stages) {
        (Some(text), _) => aggregation::parse_pipeline_text(text)?,
        (None, Some(bodies)) => {
            let mut out = Vec::with_capacity(bodies.len());
            for (i, body) in bodies.iter().enumerate() {
                out.push(
                    aggregation::parse_stage(body)
                        .map_err(|e| AppError::InvalidInput(format!("stage {}: {e}", i + 1)))?,
                );
            }
            out
        }
        (None, None) => {
            return Err(AppError::InvalidInput(
                "format_mongo_pipeline: pass either `text` or `stages`".into(),
            ))
        }
    };
    Ok(PipelineText {
        text: pipeline_to_shell_text(&stages),
        stages: stages
            .iter()
            .map(|d| {
                crate::db::mongo::values::bson_to_shell_text(&mongodb::bson::Bson::Document(
                    d.clone(),
                ))
            })
            .collect(),
    })
}

// ---------------------------------------------------------------------------
// Preview
// ---------------------------------------------------------------------------

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RunPipelineArgs {
    pub connection_id: String,
    /// Collection (or view) the pipeline reads from.
    pub source: String,
    /// The pipeline as one array literal. Mutually exclusive with `stages`.
    #[serde(default)]
    pub text: Option<String>,
    /// The pipeline as individual stages, each with its on/off state.
    #[serde(default)]
    pub stages: Option<Vec<PipelineStageInput>>,
    #[serde(default)]
    pub limit: Option<u32>,
}

impl RunPipelineArgs {
    fn parsed(&self) -> AppResult<Vec<mongodb::bson::Document>> {
        match (&self.text, &self.stages) {
            (Some(text), _) => aggregation::parse_pipeline_text(text),
            (None, Some(stages)) => aggregation::parse_enabled(stages),
            (None, None) => Err(AppError::InvalidInput(
                "run_mongo_pipeline: pass either `text` or `stages`".into(),
            )),
        }
    }
}

/// Run the whole pipeline and return a sample of its output — the editor's
/// final preview, in both modes.
#[tauri::command]
pub async fn run_mongo_pipeline(
    app: tauri::AppHandle,
    window: tauri::Window,
    state: State<'_, AppState>,
    args: RunPipelineArgs,
) -> AppResult<QueryResult> {
    crate::commands::connection::ensure_database_view(
        &app,
        state.inner(),
        Some(window.label()),
        &args.connection_id,
    )
    .await;
    let conn = state.mongo_for(&args.connection_id, MONGO_ONLY)?;
    let stages = args.parsed()?;
    aggregation::run_pipeline(
        &conn,
        &args.source,
        stages,
        args.limit.unwrap_or(DEFAULT_PREVIEW_LIMIT),
    )
    .await
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PreviewStagesArgs {
    pub connection_id: String,
    pub source: String,
    pub stages: Vec<PipelineStageInput>,
    #[serde(default)]
    pub limit: Option<u32>,
}

/// Run one bounded preview per stage (each stage sees the pipeline truncated
/// after it). Errors are reported per stage rather than failing the call, so a
/// half-typed stage doesn't blank the whole editor.
#[tauri::command]
pub async fn preview_mongo_stages(
    app: tauri::AppHandle,
    window: tauri::Window,
    state: State<'_, AppState>,
    args: PreviewStagesArgs,
) -> AppResult<Vec<StagePreview>> {
    crate::commands::connection::ensure_database_view(
        &app,
        state.inner(),
        Some(window.label()),
        &args.connection_id,
    )
    .await;
    let conn = state.mongo_for(&args.connection_id, MONGO_ONLY)?;
    aggregation::preview_stages(
        &conn,
        &args.source,
        &args.stages,
        args.limit.unwrap_or(DEFAULT_PREVIEW_LIMIT),
    )
    .await
}

// ---------------------------------------------------------------------------
// Views
// ---------------------------------------------------------------------------

/// Read a view's `viewOn` + pipeline, rendered back as editable source.
#[tauri::command]
pub async fn get_mongo_view(
    app: tauri::AppHandle,
    window: tauri::Window,
    state: State<'_, AppState>,
    connection_id: String,
    view: String,
) -> AppResult<MongoViewDefinition> {
    crate::commands::connection::ensure_database_view(
        &app,
        state.inner(),
        Some(window.label()),
        &connection_id,
    )
    .await;
    let conn = state.mongo_for(&connection_id, MONGO_ONLY)?;
    aggregation::read_view(&conn, &view).await
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveViewArgs {
    pub connection_id: String,
    pub name: String,
    /// The collection or view the pipeline reads from.
    pub view_on: String,
    #[serde(default)]
    pub text: Option<String>,
    #[serde(default)]
    pub stages: Option<Vec<PipelineStageInput>>,
    /// `true` creates the view, `false` redefines an existing one.
    pub create: bool,
}

/// Create a view from the current pipeline, or redefine an existing one.
///
/// Disabled stages are dropped rather than stored: a view has no notion of a
/// switched-off stage, and writing one in would change what the view returns.
#[tauri::command]
pub async fn save_mongo_view(
    app: tauri::AppHandle,
    window: tauri::Window,
    state: State<'_, AppState>,
    args: SaveViewArgs,
) -> AppResult<()> {
    crate::commands::connection::ensure_database_view(
        &app,
        state.inner(),
        Some(window.label()),
        &args.connection_id,
    )
    .await;
    let conn = state.mongo_for(&args.connection_id, MONGO_ONLY)?;
    let stages = RunPipelineArgs {
        connection_id: args.connection_id.clone(),
        source: args.view_on.clone(),
        text: args.text,
        stages: args.stages,
        limit: None,
    }
    .parsed()?;
    aggregation::save_view(&conn, &args.name, &args.view_on, stages, args.create).await
}
