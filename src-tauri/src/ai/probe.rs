//! Ask an endpoint what it can actually do, before offering the user a mode it
//! cannot deliver.
//!
//! # Why this exists at all
//!
//! Small models fail at chained tool calls, and they fail *silently*: asked to
//! call a tool, a 3B answers "I will now call `list_tables`" in prose, or emits
//! `tool_calls` whose arguments are not JSON. Agent mode over such a model is
//! not a degraded feature, it is a broken one — and the user has no way to tell
//! the difference from the inside, because the assistant looks like it is
//! working right up to the point where nothing it claims to have read was ever
//! read.
//!
//! So the panel gates agent mode on a measurement rather than on hope, and the
//! settings UI can say *"this model does not emit reliable tool calls —
//! assisted mode is available, agent mode is not"*. That sentence is the whole
//! point of this file.
//!
//! # Two probes, one of them non-fatal
//!
//! `GET /models` is a courtesy: it names what the endpoint serves, which lets
//! the settings panel offer a list instead of a text field. **It must never be
//! fatal.** llama.cpp's `llama-server`, several proxies and more than one
//! self-hosted gateway do not implement it, and treating a 404 there as "your
//! endpoint is broken" would reject working deployments — including the exact
//! one this feature is designed around.
//!
//! The tool-call smoke test is the real measurement: one completion, one
//! trivial tool, `tool_choice: "auto"`. What comes back is classified by
//! [`classify`].
//!
//! # Where the tests are
//!
//! [`report`] is a pure combinator over the two results, so the whole
//! degradation table — `/models` 404s, the chat call dies, the model answers in
//! prose, the model emits unparseable arguments — is pinned without a server.
//! [`probe`] is the two awaits that feed it.

use crate::ai::provider::{self, Endpoint};
use crate::ai::stream::{self, AssistantMessage};
use crate::error::AppResult;
use crate::state::AppState;
use reqwest::Client;
use serde::Serialize;
use serde_json::{json, Value};

/// The name of the tool the smoke test offers.
///
/// Prefixed so it cannot collide with a real catalogue entry, and so a model
/// that later hallucinates it in a genuine conversation is obviously wrong.
pub const PROBE_TOOL: &str = "huginndb_probe";

/// What an endpoint can do, as measured.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum Capability {
    /// The chat route did not answer usably. Carries the reason verbatim —
    /// this is what the settings panel shows, and a paraphrase would lose the
    /// one detail that identifies the misconfiguration.
    Unreachable { reason: String },
    /// It completes, but does not emit usable tool calls. Assisted mode only.
    ChatOnly,
    /// It emits well-formed tool calls. Agent mode is available.
    ToolCapable,
}

/// The probe's answer, plus what it learned on the way.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProbeReport {
    /// [`Endpoint::fingerprint`] at the time of the probe. A configuration
    /// change makes the cached answer stale, and this is how [`cached`] knows.
    pub key: String,
    pub capability: Capability,
    /// Model ids `/models` reported. Empty when it did not answer, which is
    /// not an error — see this module's docs.
    pub models: Vec<String>,
    /// One or two sentences for the settings panel to show verbatim.
    pub note: String,
}

/// The body the smoke test sends.
///
/// The prompt is blunt on purpose. A hedged instruction ("you may use the tool
/// if helpful") measures the model's judgment rather than its protocol
/// support, which is not the question — and it is how a tool-capable model gets
/// misreported as chat-only.
pub fn probe_body(endpoint: &Endpoint) -> Value {
    json!({
        "model": endpoint.model,
        "stream": false,
        "messages": [
            {
                "role": "system",
                "content": "You are being tested for tool-calling support. Reply only by \
                            calling the provided function."
            },
            {
                "role": "user",
                "content": "Call the huginndb_probe function with answer set to \"ok\". Do not \
                            write any prose."
            }
        ],
        "tools": [{
            "type": "function",
            "function": {
                "name": PROBE_TOOL,
                "description": "Answer the connectivity probe.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "answer": { "type": "string", "description": "Always \"ok\"." }
                    },
                    "required": ["answer"],
                    "additionalProperties": false
                }
            }
        }],
        "tool_choice": "auto"
    })
}

/// Classify a completion that came back.
///
/// **Any** well-formed tool call counts, not only one named [`PROBE_TOOL`].
/// What is being measured is whether the server emits parseable `tool_calls` at
/// all; which tool a model chooses is its judgment, and a model that calls
/// something else has still demonstrated the one thing agent mode needs. The
/// failures this catches are the two real ones: prose instead of a call, and a
/// call whose arguments are not JSON (which never reaches here — see
/// [`report`]).
pub fn classify(message: &AssistantMessage) -> Capability {
    match message.tool_calls.iter().any(|call| !call.name.is_empty()) {
        true => Capability::ToolCapable,
        false => Capability::ChatOnly,
    }
}

/// Combine the two probe results into a report.
///
/// Pure, so the degradation table is a unit test rather than a manual
/// afternoon with four servers.
pub fn report(key: String, models: AppResult<Vec<String>>, chat: AppResult<Value>) -> ProbeReport {
    let (models, models_note) = match models {
        Ok(models) => (models, None),
        // Not fatal, and said out loud so a user comparing two endpoints knows
        // why one offers a model list and the other does not.
        Err(e) => (
            Vec::new(),
            Some(format!(
                "The endpoint does not list its models ({e}), which is normal for llama-server \
                 and some gateways — type the model id by hand."
            )),
        ),
    };

    let (capability, note) = match chat {
        Err(e) => (
            Capability::Unreachable {
                reason: e.to_string(),
            },
            format!("Could not complete a request: {e}"),
        ),
        Ok(payload) => match stream::parse_message(&payload) {
            Ok(message) => match classify(&message) {
                Capability::ToolCapable => (
                    Capability::ToolCapable,
                    "This model emits well-formed tool calls. Agent mode is available.".into(),
                ),
                other => (
                    other,
                    "This model answered in prose instead of calling the test function, so it \
                     will not drive a tool loop reliably. Assisted mode is available; agent mode \
                     is not."
                        .into(),
                ),
            },
            // The most informative outcome of all, and the reason
            // `provider::complete_raw` exists: the model *tried* to call the
            // tool and produced arguments that are not JSON. That is chat-only
            // with evidence, not an unreachable endpoint.
            Err(e) => (
                Capability::ChatOnly,
                format!(
                    "This model emitted a tool call that could not be parsed ({e}), so agent \
                     mode is not available. Assisted mode is."
                ),
            ),
        },
    };

    ProbeReport {
        key,
        capability,
        models,
        note: match models_note {
            Some(extra) => format!("{note} {extra}"),
            None => note,
        },
    }
}

/// Probe `endpoint`. Never fails — an unreachable endpoint is a *result*.
pub async fn probe(http: &Client, endpoint: &Endpoint) -> ProbeReport {
    let models = provider::list_models(http, endpoint).await;
    let chat = provider::complete_raw(http, endpoint, &probe_body(endpoint)).await;
    report(endpoint.fingerprint(), models, chat)
}

/// The cached report for `endpoint`, if the cache is about this exact
/// configuration.
///
/// Keyed on [`Endpoint::fingerprint`] rather than merely present-or-absent: a
/// user who edits the base URL or switches model must not be shown the previous
/// endpoint's verdict, and "agent mode is available" is precisely the claim
/// that must not survive a configuration change.
pub fn cached(state: &AppState, endpoint: &Endpoint) -> Option<ProbeReport> {
    let key = endpoint.fingerprint();
    state
        .ai_probe
        .read()
        .clone()
        .filter(|report| report.key == key)
}

/// Cache `report`, replacing whatever was there.
pub fn store(state: &AppState, report: &ProbeReport) {
    *state.ai_probe.write() = Some(report.clone());
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ai::stream::ToolCall;
    use crate::error::AppError;

    fn message(tool_calls: Vec<ToolCall>) -> AssistantMessage {
        AssistantMessage {
            content: String::new(),
            tool_calls,
            finish_reason: None,
        }
    }

    fn call(name: &str) -> ToolCall {
        ToolCall {
            id: "c1".into(),
            name: name.into(),
            arguments: json!({ "answer": "ok" }),
        }
    }

    fn chat_reply(body: Value) -> AppResult<Value> {
        Ok(json!({ "choices": [{ "message": body, "finish_reason": "stop" }] }))
    }

    #[test]
    fn a_well_formed_tool_call_is_tool_capable() {
        assert_eq!(
            classify(&message(vec![call(PROBE_TOOL)])),
            Capability::ToolCapable
        );
        // Any tool, not just the probe's: the protocol is what is measured.
        assert_eq!(
            classify(&message(vec![call("list_tables")])),
            Capability::ToolCapable
        );
    }

    #[test]
    fn prose_instead_of_a_call_is_chat_only() {
        assert_eq!(classify(&message(vec![])), Capability::ChatOnly);
    }

    /// The whole reason `/models` is probed separately: the deployment this
    /// feature is designed around does not implement it.
    #[test]
    fn a_models_route_that_404s_is_not_fatal() {
        let report = report(
            "k".into(),
            Err(AppError::Inference("the endpoint returned 404".into())),
            chat_reply(json!({
                "tool_calls": [{
                    "id": "c1",
                    "function": { "name": PROBE_TOOL, "arguments": "{\"answer\":\"ok\"}" }
                }]
            })),
        );
        assert_eq!(report.capability, Capability::ToolCapable);
        assert!(report.models.is_empty());
        // And the user is told why the model list is empty, rather than left
        // with a field that mysteriously offers nothing.
        assert!(
            report.note.contains("does not list its models"),
            "{}",
            report.note
        );
        assert!(report.note.contains("by hand"), "{}", report.note);
    }

    #[test]
    fn a_models_route_that_answers_reports_what_it_serves() {
        let report = report(
            "k".into(),
            Ok(vec!["qwen2.5-coder:7b".into(), "llama3.1:8b".into()]),
            chat_reply(json!({ "content": "I would call the function." })),
        );
        assert_eq!(report.models.len(), 2);
        assert_eq!(report.capability, Capability::ChatOnly);
        assert!(!report.note.contains("does not list its models"));
    }

    #[test]
    fn a_chat_route_that_fails_is_unreachable_with_the_reason_verbatim() {
        let report = report(
            "k".into(),
            Ok(vec![]),
            Err(AppError::Inference(
                "the endpoint rejected the credentials (401 Unauthorized)".into(),
            )),
        );
        match &report.capability {
            Capability::Unreachable { reason } => {
                assert!(reason.contains("401"), "{reason}");
                assert!(reason.contains("credentials"), "{reason}");
            }
            other => panic!("expected Unreachable, got {other:?}"),
        }
    }

    /// The outcome `provider::complete_raw` was split out for. A model that
    /// emits broken argument JSON is the clearest possible chat-only signal,
    /// and folding the parse into the transport would have reported this
    /// endpoint — which answered fine — as unreachable.
    #[test]
    fn unparseable_tool_arguments_are_chat_only_not_unreachable() {
        let report = report(
            "k".into(),
            Ok(vec![]),
            chat_reply(json!({
                "tool_calls": [{
                    "id": "c1",
                    "function": { "name": PROBE_TOOL, "arguments": "{answer: ok" }
                }]
            })),
        );
        assert_eq!(report.capability, Capability::ChatOnly);
        assert!(
            report.note.contains("could not be parsed"),
            "{}",
            report.note
        );
        assert!(
            report.note.contains("Assisted mode is"),
            "the user must be told what still works: {}",
            report.note
        );
    }

    /// Agent mode's availability must not outlive the configuration it was
    /// measured against.
    #[test]
    fn a_report_is_only_valid_for_the_configuration_it_measured() {
        let report = report(
            "http://a/v1|model-a".into(),
            Ok(vec![]),
            chat_reply(json!({})),
        );
        assert_eq!(report.key, "http://a/v1|model-a");
        assert_ne!(report.key, "http://a/v1|model-b");
    }

    #[test]
    fn the_probe_body_offers_exactly_one_tool_and_lets_the_model_choose() {
        let endpoint = Endpoint {
            base_url: reqwest::Url::parse("http://localhost:11434/v1").unwrap(),
            model: "llama3.1:8b".into(),
            api_key: None,
            timeout: provider::DEFAULT_TIMEOUT,
        };
        let body = probe_body(&endpoint);
        assert_eq!(body["model"], json!("llama3.1:8b"));
        assert_eq!(body["stream"], json!(false));
        assert_eq!(body["tool_choice"], json!("auto"));
        let tools = body["tools"].as_array().unwrap();
        assert_eq!(tools.len(), 1);
        assert_eq!(tools[0]["function"]["name"], json!(PROBE_TOOL));
        // `tool_choice: "required"` would measure nothing: a server that forces
        // a call can produce one from a model that would never emit one on its
        // own, which is the false positive that makes agent mode look
        // available and then fail on the first real turn.
        assert_ne!(body["tool_choice"], json!("required"));
    }

    /// The capability crosses IPC to the settings panel, so its JSON shape is
    /// part of the contract phase 3 mirrors in `types.ts`.
    #[test]
    fn the_capability_serialises_with_a_discriminating_kind() {
        assert_eq!(
            serde_json::to_value(Capability::ToolCapable).unwrap(),
            json!({ "kind": "toolCapable" })
        );
        assert_eq!(
            serde_json::to_value(Capability::ChatOnly).unwrap(),
            json!({ "kind": "chatOnly" })
        );
        assert_eq!(
            serde_json::to_value(Capability::Unreachable {
                reason: "connection refused".into()
            })
            .unwrap(),
            json!({ "kind": "unreachable", "reason": "connection refused" })
        );
    }
}
