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

use crate::ai::probe::{self, ProbeReport};
use crate::ai::provider::{self, Endpoint};
use crate::error::{AppError, AppResult};
use crate::state::AppState;
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use tauri::{AppHandle, Emitter, State};

/// Emitted with `emit_to(window_label, …)` rather than broadcast: two windows
/// can each have the panel open with their own conversation, and a broadcast
/// would render one window's tokens in the other.
pub const AI_DELTA_EVENT: &str = "huginndb://ai-delta";

/// One chunk of a streaming reply.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AiDelta {
    /// The turn this belongs to. The panel may have more than one in flight
    /// across tabs, and a delta with no owner is worse than none.
    pub turn_id: String,
    pub text: String,
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

/// Stream one turn, emitting [`AI_DELTA_EVENT`] as text arrives.
#[tauri::command]
pub async fn ai_send(
    app: AppHandle,
    window: tauri::Window,
    state: State<'_, AppState>,
    turn_id: String,
    messages: Vec<ChatMessage>,
) -> AppResult<AiTurnResult> {
    let body = {
        let prefs = state.prefs.read();
        let endpoint = Endpoint::from_prefs(&prefs.ai)?;
        (
            provider::chat_body(&endpoint, wire_messages(&messages)?, &[], true),
            endpoint,
        )
    };
    let (request, endpoint) = body;
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
        result = provider::stream_chat(&http, &endpoint, &request, &mut on_text) => result,
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
