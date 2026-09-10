//! The AI panel's command surface.
//!
//! Six commands, and the boundary they draw matters more than any of them
//! individually: **the webview asks for a turn and receives text; it never
//! learns the API key and never holds a socket.** Everything network-facing is
//! behind [`crate::ai::provider`] (see [`crate::ai`]'s egress invariant), and
//! everything secret is behind [`crate::ai::secrets`].
//!
//! # What `ai_send` is, in this phase
//!
//! One streamed turn with **no tools declared**. That is deliberate and
//! temporary: assisted mode's deterministic context builders are phase 5 of
//! `docs/AI_ROADMAP.md` and the agent loop is phase 6, and declaring tools
//! before the loop exists would have the model emit calls nothing executes —
//! which reads to a user as an assistant that ignores its own conclusions.
//! What lands here is what phase 4's panel needs to exist: a conversation that
//! streams.
//!
//! The messages come from the frontend, typed as role + content, so the webview
//! cannot inject a `tool` role or fabricate `tool_calls`. It *can* put anything
//! in a `user` message, row data included — and that is correct rather than a
//! hole in the coupling rule: a user pasting a grid selection into a chat is
//! consenting to send it. The rule in [`crate::ai::scope`] governs what the
//! *assistant* may read on its own initiative, which is a different question.

use crate::ai::agent;
use crate::ai::probe::{self, ProbeReport};
use crate::ai::provider::{self, Endpoint};
use crate::ai::scope::DataScope;
use crate::ai::tasks::{self, TaskInput};
use crate::error::{AppError, AppResult};
use crate::prefs::AiMode;
use crate::state::AppState;
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use tauri::{AppHandle, Emitter, State};

/// Emitted with `emit_to(window_label, …)` rather than broadcast: two windows
/// can each have the panel open with their own conversation, and a broadcast
/// would render one window's tokens in the other.
pub const AI_DELTA_EVENT: &str = "huginndb://ai-delta";

/// A tool call the agent loop made, or its result. Same window scoping as
/// [`AI_DELTA_EVENT`], and same reason.
pub const AI_TOOL_EVENT: &str = "huginndb://ai-tool";

/// One chunk of a streaming reply.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AiDelta {
    /// The turn this belongs to. The panel may have more than one in flight
    /// across tabs, and a delta with no owner is worse than none.
    pub turn_id: String,
    pub text: String,
}

/// One step of the agent loop, on its way to the panel's tool card.
///
/// The call and its result are two events rather than one, because they are
/// separated by however long the database took — a card that could not render
/// until the result arrived would leave a slow query looking like a hung
/// assistant, which is exactly when someone wants to see what it is doing.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AiToolEvent {
    pub turn_id: String,
    /// The id the model gave the call, and what pairs the two events up.
    pub id: String,
    pub name: String,
    /// Present on the call, absent on the result.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub args: Option<serde_json::Value>,
    /// Present on a successful result.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub result: Option<serde_json::Value>,
    /// Present on a refusal or a failure.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

/// One message in the conversation the frontend is sending.
///
/// Typed rather than an opaque `serde_json::Value`, which narrows what the
/// webview can express to exactly what a chat needs — see the module docs.
#[derive(Debug, Clone, Deserialize)]
pub struct ChatMessage {
    /// `"system"`, `"user"` or `"assistant"`. Anything else is refused.
    pub role: String,
    pub content: String,
}

/// What a finished turn reports back.
///
/// `content` is the whole assembled reply even though the panel already
/// received it as deltas: a cancelled or dropped event leaves the panel's copy
/// incomplete, and reconciling against this is cheaper than making the event
/// stream reliable.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AiTurnResult {
    pub content: String,
    pub finish_reason: Option<String>,
}

/// Roles the frontend may send.
const ROLES: [&str; 3] = ["system", "user", "assistant"];

/// Validate and convert the conversation into wire shape.
///
/// Pure, and the only thing standing between the webview and the request body.
fn wire_messages(messages: &[ChatMessage]) -> AppResult<Vec<serde_json::Value>> {
    if messages.is_empty() {
        return Err(AppError::InvalidInput(
            "a turn needs at least one message".into(),
        ));
    }
    messages
        .iter()
        .map(|message| {
            if !ROLES.contains(&message.role.as_str()) {
                return Err(AppError::InvalidInput(format!(
                    "{:?} is not a message role the panel may send ({})",
                    message.role,
                    ROLES.join(", ")
                )));
            }
            Ok(serde_json::json!({
                "role": message.role,
                "content": message.content,
            }))
        })
        .collect()
}

/// Measure what the configured endpoint can do. See [`crate::ai::probe`].
///
/// Cached across calls, because the probe costs a real completion. `refresh`
/// forces a new one — the settings panel's "test again" button, and the only
/// way to re-check an endpoint that was down a minute ago.
#[tauri::command]
pub async fn ai_probe(state: State<'_, AppState>, refresh: bool) -> AppResult<ProbeReport> {
    let endpoint = {
        let prefs = state.prefs.read();
        Endpoint::from_prefs(&prefs.ai)?
    };
    if !refresh {
        if let Some(report) = probe::cached(state.inner(), &endpoint) {
            return Ok(report);
        }
    }
    let http = provider::client(endpoint.timeout)?;
    let report = probe::probe(&http, &endpoint).await;
    probe::store(state.inner(), &report);
    Ok(report)
}

/// The model ids the configured endpoint serves.
///
/// Deliberately **not** [`ai_probe`]: a dropdown needs a list, not a capability
/// verdict, and the probe costs a real completion against the user's model. The
/// panel opens this every time it mounts, so it has to be one cheap `GET` —
/// which is also why an endpoint that does not implement `/models` (normal for
/// `llama-server` and several gateways) is an empty list here and a caller's
/// problem to degrade from, not an error worth a notification.
#[tauri::command]
pub async fn ai_models(state: State<'_, AppState>) -> AppResult<Vec<String>> {
    let endpoint = {
        let prefs = state.prefs.read();
        Endpoint::from_prefs(&prefs.ai)?
    };
    let http = provider::client(endpoint.timeout)?;
    Ok(provider::list_models(&http, &endpoint)
        .await
        .unwrap_or_default())
}

/// Stream one turn, emitting [`AI_DELTA_EVENT`] as text arrives.
///
/// `connection_id` is the conversation's connection when the panel has one.
/// Agent mode needs it, because its tools address a database; plain chat
/// ignores it, and a turn with no connection can only ever be plain chat.
#[tauri::command]
pub async fn ai_send(
    app: AppHandle,
    window: tauri::Window,
    state: State<'_, AppState>,
    turn_id: String,
    messages: Vec<ChatMessage>,
    connection_id: Option<String>,
) -> AppResult<AiTurnResult> {
    let (endpoint, mode, trust, max_rows) = {
        let prefs = state.prefs.read();
        (
            Endpoint::from_prefs(&prefs.ai)?,
            prefs.ai.mode,
            prefs.ai.endpoint_trust,
            prefs.ai.max_context_rows,
        )
    };
    let wire = wire_messages(&messages)?;

    // Agent mode is a *measurement* away, not a preference away: the
    // preference says what the user wants and the probe says whether this model
    // can deliver it. A loop over a model that answers in prose is not a
    // degraded feature, it is one that fabricates.
    if mode == AiMode::Agent {
        if let Some(connection) = connection_id
            .as_deref()
            .map(str::trim)
            .filter(|c| !c.is_empty())
        {
            return run_agent(
                &app, &window, state, &endpoint, trust, max_rows, turn_id, connection, wire,
            )
            .await;
        }
    }

    let request = provider::chat_body(&endpoint, wire, &[], true);
    stream_turn(&app, &window, state, &endpoint, turn_id, &request).await
}

/// The agent loop, wrapped in the same cancellation the plain turn has.
///
/// Cancelling drops this whole future, which drops whichever `stream_chat` is
/// in flight and closes its socket — the same mechanism, one level up, so a
/// stop pressed between two tool calls ends the turn rather than letting the
/// next one start.
#[allow(clippy::too_many_arguments)]
async fn run_agent(
    app: &AppHandle,
    window: &tauri::Window,
    state: State<'_, AppState>,
    endpoint: &Endpoint,
    trust: crate::ai::scope::EndpointTrust,
    max_rows: i64,
    turn_id: String,
    connection: &str,
    conversation: Vec<serde_json::Value>,
) -> AppResult<AiTurnResult> {
    let report = probe::cached(state.inner(), endpoint);
    let capability = match report {
        Some(report) => report.capability,
        // Nothing measured yet. Measuring costs one small completion, which is
        // cheaper than letting the loop run and produce a fabricated answer.
        None => {
            let http = provider::client(endpoint.timeout)?;
            let fresh = probe::probe(&http, endpoint).await;
            probe::store(state.inner(), &fresh);
            fresh.capability
        }
    };
    if capability != probe::Capability::ToolCapable {
        return Err(AppError::Inference(
            "this model does not emit reliable tool calls, so agent mode cannot run on it.              Switch to assisted mode in Settings → AI, or pick a tool-capable model."
                .into(),
        ));
    }

    let rows_allowed = {
        let profiles = state.profiles.read();
        let id = crate::ai::exec::resolve_connection(connection, &profiles)?;
        profiles
            .iter()
            .find(|p| p.id == id)
            .is_some_and(|p| p.ai_rows_allowed)
    };
    let scope = DataScope::resolve(trust, rows_allowed);
    let http = provider::client(endpoint.timeout)?;
    let sink = crate::log_bus::TauriSink::new(app, window.label());

    let cancel = Arc::new(tokio::sync::Notify::new());
    state
        .ai_turns
        .write()
        .insert(turn_id.clone(), cancel.clone());

    // Each sink owns its captures rather than borrowing them. `AgentSinks`
    // holds `&mut dyn FnMut(&…)` behind a higher-ranked lifetime, and a closure
    // borrowing a local from this frame cannot satisfy it — cloning three cheap
    // handles is the fix, not a lifetime parameter threaded through the loop.
    let label = window.label().to_string();
    let mut on_text = {
        let (app, label, turn_id) = (app.clone(), label.clone(), turn_id.clone());
        move |text: &str| {
            let _ = app.emit_to(
                label.as_str(),
                AI_DELTA_EVENT,
                AiDelta {
                    turn_id: turn_id.clone(),
                    text: text.to_string(),
                },
            );
        }
    };
    let mut on_tool_call = {
        let (app, label, turn_id) = (app.clone(), label.clone(), turn_id.clone());
        move |call: &crate::ai::stream::ToolCall| {
            let _ = app.emit_to(
                label.as_str(),
                AI_TOOL_EVENT,
                AiToolEvent {
                    turn_id: turn_id.clone(),
                    id: call.id.clone(),
                    name: call.name.clone(),
                    args: Some(call.arguments.clone()),
                    result: None,
                    error: None,
                },
            );
        }
    };
    let mut on_tool_result = {
        let (app, label, turn_id) = (app.clone(), label.clone(), turn_id.clone());
        move |id: &str, name: &str, result: Option<&serde_json::Value>, error: Option<&str>| {
            let _ = app.emit_to(
                label.as_str(),
                AI_TOOL_EVENT,
                AiToolEvent {
                    turn_id: turn_id.clone(),
                    id: id.to_string(),
                    name: name.to_string(),
                    args: None,
                    result: result.cloned(),
                    error: error.map(str::to_string),
                },
            );
        }
    };
    let mut sinks = agent::AgentSinks {
        on_text: &mut on_text,
        on_tool_call: &mut on_tool_call,
        on_tool_result: &mut on_tool_result,
    };

    let limits = agent::AgentLimits {
        max_context_rows: max_rows,
        ..agent::AgentLimits::default()
    };
    let outcome = tokio::select! {
        result = agent::run(
            state.inner(),
            &sink,
            &http,
            endpoint,
            connection,
            scope,
            conversation,
            limits,
            &mut sinks,
        ) => result,
        _ = cancel.notified() => Err(AppError::Inference("the turn was cancelled".into())),
    };
    state.ai_turns.write().remove(&turn_id);

    let (message, stop) = outcome?;
    Ok(AiTurnResult {
        // The budget note is appended to the answer rather than raised as an
        // error: the investigation up to the cap is worth reading, and losing
        // it to report the cap would be the wrong trade.
        content: match stop.note() {
            Some(note) => format!("{}{note}", message.content),
            None => message.content,
        },
        finish_reason: message.finish_reason,
    })
}

/// Stream one completion and report it, with cancellation registered.
///
/// Shared by [`ai_send`] and [`ai_task`] because the two differ only in who
/// wrote the messages — the panel, or `ai::tasks`. Duplicating this would mean
/// two places that have to remember to register the turn before the first byte,
/// and the one that forgot would have an unstoppable turn.
async fn stream_turn(
    app: &AppHandle,
    window: &tauri::Window,
    state: State<'_, AppState>,
    endpoint: &Endpoint,
    turn_id: String,
    request: &serde_json::Value,
) -> AppResult<AiTurnResult> {
    let http = provider::client(endpoint.timeout)?;

    // Registered before the first byte, so a stop pressed during the model's
    // think time — which on a local 7B is most of the wait — has something to
    // notify.
    let cancel = Arc::new(tokio::sync::Notify::new());
    state
        .ai_turns
        .write()
        .insert(turn_id.clone(), cancel.clone());

    let label = window.label().to_string();
    let mut on_text = |text: &str| {
        let _ = app.emit_to(
            label.as_str(),
            AI_DELTA_EVENT,
            AiDelta {
                turn_id: turn_id.clone(),
                text: text.to_string(),
            },
        );
    };

    let outcome = tokio::select! {
        result = provider::stream_chat(&http, endpoint, request, &mut on_text) => result,
        // Dropping the streaming future is what closes the socket. The text
        // already emitted stays on screen — the panel keeps what it rendered,
        // which is the honest outcome of stopping halfway.
        _ = cancel.notified() => Err(AppError::Inference("the turn was cancelled".into())),
    };
    state.ai_turns.write().remove(&turn_id);

    let message = outcome?;
    Ok(AiTurnResult {
        content: message.content,
        finish_reason: message.finish_reason,
    })
}

/// Run one assisted task: gather its context in Rust, then stream one answer.
///
/// The difference from [`ai_send`] is where the prompt comes from. A chat turn
/// carries whatever the user typed; a task carries a context `crate::ai::tasks`
/// assembled by reading the database itself — which is what makes assisted mode
/// work on a model far too small to be trusted with a tool loop, and what makes
/// the panel able to answer about a schema at all before phase 6 lands.
///
/// Still one model call and no iteration. The `DataScope` is resolved here from
/// the endpoint's declared trust and the connection's own opt-in, so the one
/// task that reads rows is gated exactly as a tool call would be.
#[tauri::command]
pub async fn ai_task(
    app: AppHandle,
    window: tauri::Window,
    state: State<'_, AppState>,
    turn_id: String,
    input: TaskInput,
) -> AppResult<AiTurnResult> {
    let (endpoint, trust, max_rows) = {
        let prefs = state.prefs.read();
        (
            Endpoint::from_prefs(&prefs.ai)?,
            prefs.ai.endpoint_trust,
            prefs.ai.max_context_rows,
        )
    };
    let rows_allowed = {
        let profiles = state.profiles.read();
        let id = crate::ai::exec::resolve_connection(&input.connection, &profiles)?;
        profiles
            .iter()
            .find(|p| p.id == id)
            .is_some_and(|p| p.ai_rows_allowed)
    };
    let scope = DataScope::resolve(trust, rows_allowed);

    // A `TauriSink` so every read a task makes lands in the Console beside the
    // user's own statements. That is the same trust argument the roadmap makes
    // for agent mode: an assistant whose reads are visible is one a user can
    // believe about what it did and did not look at.
    let sink = crate::log_bus::TauriSink::new(&app, window.label());
    let context = tasks::gather(
        state.inner(),
        &sink,
        &input,
        scope,
        crate::ai::exec::effective_row_cap(max_rows),
    )
    .await?;
    let request = provider::chat_body(&endpoint, tasks::build_prompt(&input, &context), &[], true);
    stream_turn(&app, &window, state, &endpoint, turn_id, &request).await
}

/// Abort an in-flight turn.
///
/// Returns whether there was one, so the panel can tell "stopped" from "it had
/// already finished" instead of leaving a stop button that appears to do
/// nothing.
#[tauri::command]
pub fn ai_cancel(state: State<'_, AppState>, turn_id: String) -> AppResult<bool> {
    let Some(cancel) = state.ai_turns.read().get(&turn_id).cloned() else {
        return Ok(false);
    };
    cancel.notify_waiters();
    Ok(true)
}

/// Store a BYOK key for the configured endpoint, in the OS keychain.
///
/// Keyed by the endpoint's origin, so this is not a global "the API key" — see
/// [`crate::ai::secrets`]. Deliberately does not require `enabled`: a user
/// setting the feature up pastes the key before switching it on.
#[tauri::command]
pub fn ai_set_key(state: State<'_, AppState>, key: String) -> AppResult<()> {
    if key.trim().is_empty() {
        return Err(AppError::InvalidInput(
            "an empty API key cannot be stored — use ai_clear_key to remove one".into(),
        ));
    }
    let base_url = configured_base_url(state.inner())?;
    crate::ai::secrets::set_key(&base_url, &key)
}

/// Whether a key is stored for the configured endpoint.
///
/// **The only thing the frontend is ever told about it.** There is no command
/// that returns the key, which is the same posture connection passwords have.
#[tauri::command]
pub fn ai_has_key(state: State<'_, AppState>) -> AppResult<bool> {
    crate::ai::secrets::has_key(&configured_base_url(state.inner())?)
}

/// Forget the key for the configured endpoint. Succeeds when there was none.
#[tauri::command]
pub fn ai_clear_key(state: State<'_, AppState>) -> AppResult<()> {
    crate::ai::secrets::clear_key(&configured_base_url(state.inner())?)
}

/// The endpoint URL the three key commands operate on.
///
/// Goes through [`Endpoint::new`] rather than parsing the preference directly,
/// so a key cannot be filed under an origin the rest of the code would refuse
/// to call. The model is irrelevant here, hence the placeholder — a key belongs
/// to a host, not to a model.
fn configured_base_url(state: &AppState) -> AppResult<reqwest::Url> {
    let base_url = state.prefs.read().ai.base_url.clone();
    Ok(Endpoint::new(&base_url, "unused", None, 120)?.base_url)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn message(role: &str, content: &str) -> ChatMessage {
        ChatMessage {
            role: role.into(),
            content: content.into(),
        }
    }

    #[test]
    fn a_conversation_converts_to_the_openai_message_shape() {
        let wire = wire_messages(&[
            message("system", "You are a database assistant."),
            message("user", "which tables are there?"),
            message("assistant", "Let me look."),
        ])
        .unwrap();
        assert_eq!(wire.len(), 3);
        assert_eq!(wire[0]["role"], serde_json::json!("system"));
        assert_eq!(
            wire[1]["content"],
            serde_json::json!("which tables are there?")
        );
    }

    /// The narrowing this type exists for: the webview must not be able to
    /// forge a `tool` message, which in a later phase is how a model is told
    /// what a tool returned. Fabricating one would let the page put words in
    /// the database's mouth.
    #[test]
    fn a_role_the_panel_may_not_send_is_refused() {
        for role in ["tool", "function", "developer", "", "USER"] {
            let err = wire_messages(&[message(role, "x")])
                .expect_err("only the three chat roles are allowed")
                .to_string();
            assert!(err.contains("not a message role"), "{role:?}: {err}");
            assert!(err.contains("system, user, assistant"), "{role:?}: {err}");
        }
    }

    #[test]
    fn an_empty_conversation_is_refused() {
        let err = wire_messages(&[])
            .expect_err("there is nothing to answer")
            .to_string();
        assert!(err.contains("at least one message"), "{err}");
    }

    /// Content is passed through untouched, including row data a user pasted
    /// in. See the module docs: that is consent, not a leak.
    #[test]
    fn message_content_is_not_inspected_or_trimmed() {
        let wire = wire_messages(&[message("user", "  id=7, email=a@b.c  ")]).unwrap();
        assert_eq!(
            wire[0]["content"],
            serde_json::json!("  id=7, email=a@b.c  ")
        );
    }

    /// The event payload is a contract with `types.ts`, and a delta with no
    /// turn id cannot be routed to the conversation that asked for it.
    #[test]
    fn a_delta_serialises_with_its_turn_id_in_camel_case() {
        let payload = serde_json::to_value(AiDelta {
            turn_id: "t1".into(),
            text: "hola".into(),
        })
        .unwrap();
        assert_eq!(
            payload,
            serde_json::json!({ "turnId": "t1", "text": "hola" })
        );
    }

    #[test]
    fn a_turn_result_serialises_in_camel_case() {
        let payload = serde_json::to_value(AiTurnResult {
            content: "done".into(),
            finish_reason: Some("stop".into()),
        })
        .unwrap();
        assert_eq!(
            payload,
            serde_json::json!({ "content": "done", "finishReason": "stop" })
        );
    }
}
