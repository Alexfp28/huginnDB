//! Agent mode: the tool-call loop.
//!
//! Request → `tool_calls` → [`crate::ai::exec`] → tool results → repeat, until
//! the model answers without asking for anything or a budget stops it.
//!
//! # Why this is last, and gated
//!
//! It is the mode that needs a model most people cannot run. A small model
//! asked to chain tool calls does not degrade — it fabricates, or emits
//! `tool_calls` whose arguments are not JSON, and the assistant *looks* like it
//! is working right up to the point where nothing it claims to have read was
//! ever read. So [`crate::ai::probe`] measures the endpoint first and this
//! refuses to run unless the answer was
//! [`crate::ai::probe::Capability::ToolCapable`]. Assisted mode
//! ([`crate::ai::tasks`]) is what everyone else gets, and it is not a
//! consolation prize: for four common jobs it is *better*, because the context
//! was chosen deliberately rather than discovered.
//!
//! # The Console is the feature, not the logging
//!
//! Every iteration emits: the tools it was offered, each call with its
//! arguments, and each result's **size**. That is the roadmap's own claim and
//! it is worth restating, because it looks like instrumentation and is not — a
//! user who can watch what the assistant did and how much came back will
//! believe the metadata-only guarantee; one who cannot, will not. The result
//! *payload* is deliberately never logged: it is the row data the guarantee is
//! about, and writing it to a panel the user can copy out of would be an odd
//! way to keep it.
//!
//! # Budgets, and what happens at the end of one
//!
//! Four hard caps: iterations, total tool calls, the row and character caps
//! every reply already carries ([`crate::ai::exec`]), and a **turn-wide**
//! character budget across all of them. The last exists because the loop
//! re-sends its whole accumulated history on every iteration, so twelve replies
//! that each fit comfortably still add up to a context nobody can hold — the
//! per-reply cap bounds one read, and this bounds the turn.
//!
//! A loop that hits any of them stops and says so *in the transcript* rather
//! than silently returning half an investigation, because "the model gave up"
//! and "the model was cut off" are different facts and only one of them is
//! worth retrying.
//!
//! # The webview does not write the system prompt here
//!
//! The panel sends a chat prompt that tells the model it has no database
//! access, which is true of plain chat and false here. The loop drops whatever
//! system message arrived and supplies [`SYSTEM_PROMPT`]. That is mostly
//! hygiene — the frontend is ours — but it also means the one instruction that
//! governs what the assistant may do with its tools is not something a page can
//! rewrite.

use crate::ai::exec::{AiCall, AiRuntime};
use crate::ai::provider::{self, Endpoint};
use crate::ai::scope::DataScope;
use crate::ai::stream::{AssistantMessage, ToolCall};
use crate::ai::tools;
use crate::error::AppResult;
use crate::log_bus::{LogEntry, LogKind, LogSink};
use reqwest::Client;
use serde_json::{json, Value};

/// What the loop is allowed to spend.
#[derive(Debug, Clone, Copy)]
pub struct AgentLimits {
    /// Model calls, including the final one that answers.
    ///
    /// Six is enough for "list the tables, describe two of them, answer" with
    /// room to recover from one mistake, and small enough that a model stuck in
    /// a loop costs seconds rather than a coffee break.
    pub max_iterations: usize,
    /// Tool calls across the whole turn, however they are distributed.
    ///
    /// A separate cap from the iterations because one iteration may ask for
    /// six tools at once, and the thing worth bounding is how much of the
    /// database a single question can touch.
    pub max_tool_calls: usize,
    /// Passed through to every tool. See `crate::ai::exec::effective_row_cap`.
    pub max_context_rows: i64,
    /// Characters of tool *results* one turn may accumulate.
    ///
    /// The cap the per-reply one cannot be: every iteration re-sends the whole
    /// history, so a turn's cost is the sum of its replies rather than the size
    /// of its largest. Three replies at the per-reply ceiling is where a
    /// 4096-token window stops having room for the question.
    pub max_result_chars: usize,
}

impl Default for AgentLimits {
    fn default() -> Self {
        Self {
            max_iterations: 6,
            max_tool_calls: 12,
            max_context_rows: crate::ai::exec::DEFAULT_MAX_CONTEXT_ROWS,
            max_result_chars: 3 * crate::ai::exec::MAX_TOOL_RESULT_CHARS,
        }
    }
}

/// The system prompt agent mode runs under.
///
/// Its load-bearing lines are the two that constrain *behaviour* rather than
/// tone: look before answering, and never claim to have read something a tool
/// did not return. The second is the failure this whole feature is built to
/// avoid — a confident answer about a schema nobody looked at is worse than no
/// answer, because the user cannot tell them apart.
pub const SYSTEM_PROMPT: &str = concat!(
    "You are a database assistant embedded in HuginnDB, with read-only tools ",
    "over the user's connection.\n\n",
    "Use the tools to look before you answer. Never state a table name, a ",
    "column, a type or a count that a tool did not return — if you need ",
    "something you have not read, read it. If a tool refuses, say what it ",
    "refused and why rather than working around it.\n\n",
    "You cannot write. When a change is warranted, propose the statement in a ",
    "fenced code block tagged with the dialect and leave it to the user, who ",
    "runs it from their own editor. Never present a statement as executed.\n\n",
    "Be brief. Answer in the language the user writes in."
);

/// What the caller is told as the loop runs.
///
/// Three callbacks rather than one enum so the command can route each to where
/// it belongs — text to the delta stream, calls and results to their own event
/// — without a match in the hot path.
/// `(call id, tool name, result, error)`. The result is the whole payload;
/// deciding how much of it to forward is the caller's — which is the point of
/// handing it over rather than a summary.
pub type ToolResultSink = dyn FnMut(&str, &str, Option<&Value>, Option<&str>) + Send;

pub struct AgentSinks<'a> {
    pub on_text: &'a mut (dyn FnMut(&str) + Send),
    pub on_tool_call: &'a mut (dyn FnMut(&ToolCall) + Send),
    pub on_tool_result: &'a mut ToolResultSink,
}

/// Why the loop stopped.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StopReason {
    /// The model answered without asking for anything else.
    Answered,
    /// [`AgentLimits::max_iterations`] was reached.
    Iterations,
    /// [`AgentLimits::max_tool_calls`] was reached.
    ToolCalls,
    /// [`AgentLimits::max_result_chars`] was reached — the turn had read more
    /// than it could carry into another iteration.
    ResultBudget,
}

impl StopReason {
    /// The sentence appended to the transcript when a budget ended the turn.
    ///
    /// Said out loud because "the model gave up" and "the model was cut off"
    /// are different facts, and only one of them is worth retrying.
    pub fn note(self) -> Option<&'static str> {
        match self {
            Self::Answered => None,
            Self::Iterations => Some(
                "\n\n_Stopped: this turn reached its step limit. Ask a narrower \
                 question, or ask it to continue._",
            ),
            Self::ToolCalls => Some(
                "\n\n_Stopped: this turn reached its limit on how many reads one \
                 question may make._",
            ),
            Self::ResultBudget => Some(
                "\n\n_Stopped: this turn read more than it can carry. Ask about one \
                 table at a time, or lower the row budget in Settings → AI._",
            ),
        }
    }
}

/// One assistant turn that asked for tools, in the shape the wire expects.
///
/// Pure, and split out because getting it wrong is silent: a server handed a
/// tool result with no matching `tool_calls` entry before it either errors or —
/// worse — answers as though the call never happened.
pub fn assistant_turn(message: &AssistantMessage) -> Value {
    json!({
        "role": "assistant",
        "content": message.content,
        "tool_calls": message
            .tool_calls
            .iter()
            .map(|call| json!({
                "id": call.id,
                "type": "function",
                "function": {
                    "name": call.name,
                    // Back to text: the wire carries arguments as a JSON
                    // *string*, and a server handed an object here rejects the
                    // history on the next turn.
                    "arguments": call.arguments.to_string(),
                },
            }))
            .collect::<Vec<_>>(),
    })
}

/// One tool result, in the shape the wire expects.
pub fn tool_result_message(call: &ToolCall, payload: &str) -> Value {
    json!({
        "role": "tool",
        "tool_call_id": call.id,
        "name": call.name,
        "content": payload,
    })
}

/// How many rows a tool reply carried, for the Console line.
///
/// The count and never the payload: that is the row data the metadata-only
/// guarantee is about, and writing it into a panel would be an odd way to keep
/// the promise.
pub fn result_rows(value: &Value) -> Option<u64> {
    value
        .get("rows")
        .and_then(Value::as_array)
        .map(|rows| rows.len() as u64)
        .or_else(|| value.as_array().map(|items| items.len() as u64))
}

/// Run the loop.
///
/// `conversation` is the user/assistant history *without* a system message —
/// see the module docs for why this supplies its own.
#[allow(clippy::too_many_arguments)]
pub async fn run(
    state: &crate::state::AppState,
    sink: &dyn LogSink,
    http: &Client,
    endpoint: &Endpoint,
    connection: &str,
    scope: DataScope,
    conversation: Vec<Value>,
    limits: AgentLimits,
    sinks: &mut AgentSinks<'_>,
) -> AppResult<(AssistantMessage, StopReason)> {
    // The catalogue `scope` advertises. `ai::exec` re-derives the scope per call
    // and refuses independently, so this decides what the model is *offered*
    // rather than what it is allowed — absence is the cheaper guarantee (see
    // `crate::ai::tools::catalogue`), and the refusal is still there behind it.
    let catalogue = tools::catalogue(scope);
    let runtime = AiRuntime {
        endpoint_trust: endpoint_trust_of(scope),
        max_context_rows: limits.max_context_rows,
    };

    let mut messages = Vec::with_capacity(conversation.len() + 4);
    messages.push(json!({ "role": "system", "content": SYSTEM_PROMPT }));
    messages.extend(conversation);

    log(
        sink,
        connection,
        format!(
            "agent turn: {} tools offered ({}), up to {} steps",
            catalogue.len(),
            match scope {
                DataScope::Rows => "rows allowed",
                DataScope::MetadataOnly => "metadata only",
            },
            limits.max_iterations
        ),
        None,
    );

    let mut spent = 0usize;
    let mut carried = 0usize;
    let mut last = AssistantMessage::default();
    for step in 1..=limits.max_iterations {
        let body = provider::chat_body(endpoint, messages.clone(), &catalogue, true);
        let message = provider::stream_chat(http, endpoint, &body, sinks.on_text).await?;

        if message.tool_calls.is_empty() {
            return Ok((message, StopReason::Answered));
        }
        if spent + message.tool_calls.len() > limits.max_tool_calls {
            return Ok((message, StopReason::ToolCalls));
        }
        // The assistant's own turn goes into the history *before* its results,
        // or the tool messages below have nothing to attach to.
        messages.push(assistant_turn(&message));

        for call in &message.tool_calls {
            spent += 1;
            (sinks.on_tool_call)(call);
            log(
                sink,
                connection,
                format!("step {step}: {}({})", call.name, call.arguments),
                None,
            );

            let outcome = crate::ai::exec::execute(
                state,
                sink,
                runtime,
                &AiCall {
                    connection,
                    tool: &call.name,
                    args: &call.arguments,
                },
            )
            .await;

            match outcome {
                Ok(value) => {
                    let rows = result_rows(&value);
                    let payload = value.to_string();
                    carried += payload.len();
                    // The size is logged alongside the row count because size
                    // is what actually ends a turn, and a user reading the
                    // Console to understand why should not have to infer it.
                    log(
                        sink,
                        connection,
                        match rows {
                            Some(n) => format!(
                                "step {step}: {} returned {n} rows, {} chars ({carried} carried)",
                                call.name,
                                payload.len()
                            ),
                            None => format!(
                                "step {step}: {} returned {} chars ({carried} carried)",
                                call.name,
                                payload.len()
                            ),
                        },
                        None,
                    );
                    (sinks.on_tool_result)(&call.id, &call.name, Some(&value), None);
                    messages.push(tool_result_message(call, &payload));
                }
                Err(e) => {
                    // A refusal is *content*, not a failure: the model is told
                    // what it may not do so it can answer around it, which is
                    // the whole point of removing tools rather than erroring.
                    let reason = e.to_string();
                    log(
                        sink,
                        connection,
                        format!("step {step}: {}", call.name),
                        Some(&reason),
                    );
                    (sinks.on_tool_result)(&call.id, &call.name, None, Some(&reason));
                    messages.push(tool_result_message(call, &reason));
                }
            }
        }
        // Checked after the results are in rather than before the next call, so
        // the reads the user already paid for are in the transcript either way:
        // the budget ends the *turn*, it does not discard what it bought.
        if carried >= limits.max_result_chars {
            log(
                sink,
                connection,
                format!("turn stopped: {carried} chars of results carried"),
                None,
            );
            return Ok((message, StopReason::ResultBudget));
        }
        last = message;
    }
    Ok((last, StopReason::Iterations))
}

/// The trust level that produces `scope`.
///
/// `ai::exec` takes an [`AiRuntime`] and derives the scope itself from the
/// endpoint's trust plus the connection's flag. The loop already knows the
/// answer, so this reverses it rather than threading the preference through:
/// `Trusted` yields `Rows` for any connection, `Untrusted` leaves the
/// connection's own opt-in to decide — which, when the scope here is `Rows`,
/// it already has.
fn endpoint_trust_of(scope: DataScope) -> crate::ai::scope::EndpointTrust {
    match scope {
        DataScope::Rows => crate::ai::scope::EndpointTrust::Trusted,
        DataScope::MetadataOnly => crate::ai::scope::EndpointTrust::Untrusted,
    }
}

fn log(sink: &dyn LogSink, connection: &str, message: String, error: Option<&str>) {
    let mut entry = LogEntry::new(LogKind::Ai)
        .connection_id(connection)
        .message(message);
    if let Some(error) = error {
        entry = entry.error(error);
    }
    sink.log(entry);
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ai::stream::ToolCall;

    fn call(id: &str, name: &str, args: Value) -> ToolCall {
        ToolCall {
            id: id.into(),
            name: name.into(),
            arguments: args,
        }
    }

    /// The wire wants `arguments` as a JSON **string**. An object there is
    /// accepted by some servers and rejected by others, and the rejection
    /// arrives on the *next* turn, when the history is replayed.
    #[test]
    fn an_assistant_turn_carries_its_arguments_as_text() {
        let message = AssistantMessage {
            content: "looking".into(),
            tool_calls: vec![call("c1", "describe_table", json!({ "table": "orders" }))],
            finish_reason: Some("tool_calls".into()),
        };
        let turn = assistant_turn(&message);
        assert_eq!(turn["role"], json!("assistant"));
        assert_eq!(turn["content"], json!("looking"));
        let calls = turn["tool_calls"].as_array().unwrap();
        assert_eq!(calls[0]["id"], json!("c1"));
        assert_eq!(calls[0]["type"], json!("function"));
        assert_eq!(calls[0]["function"]["name"], json!("describe_table"));
        let arguments = calls[0]["function"]["arguments"].as_str().unwrap();
        assert_eq!(
            serde_json::from_str::<Value>(arguments).unwrap(),
            json!({ "table": "orders" })
        );
    }

    /// A result with no matching call in the history is how a loop ends up
    /// answering as though the call never happened.
    #[test]
    fn a_tool_result_names_the_call_it_answers() {
        let message = tool_result_message(&call("c1", "list_tables", json!({})), "[\"orders\"]");
        assert_eq!(message["role"], json!("tool"));
        assert_eq!(message["tool_call_id"], json!("c1"));
        assert_eq!(message["name"], json!("list_tables"));
        assert_eq!(message["content"], json!("[\"orders\"]"));
    }

    /// The count reaches the Console; the payload never does.
    #[test]
    fn a_result_reports_its_row_count_in_both_reply_shapes() {
        assert_eq!(result_rows(&json!({ "rows": [[1], [2]] })), Some(2));
        assert_eq!(result_rows(&json!(["orders", "customers"])), Some(2));
        assert_eq!(result_rows(&json!({ "version": "16.2" })), None);
        assert_eq!(result_rows(&json!(null)), None);
    }

    #[test]
    fn a_budget_that_ended_the_turn_says_so_and_a_finished_one_does_not() {
        assert!(StopReason::Answered.note().is_none());
        assert!(StopReason::Iterations
            .note()
            .unwrap()
            .contains("step limit"));
        assert!(StopReason::ToolCalls
            .note()
            .unwrap()
            .contains("how many reads"));
    }

    /// The two failures a user would otherwise confuse: a model that finished
    /// and one that was cut off mid-investigation.
    #[test]
    fn the_stop_reasons_are_distinguishable() {
        let notes = [
            StopReason::Iterations.note(),
            StopReason::ToolCalls.note(),
            StopReason::ResultBudget.note(),
        ];
        let unique: std::collections::HashSet<_> = notes.iter().collect();
        assert_eq!(unique.len(), notes.len(), "two budgets read the same");
    }

    /// The cap a per-reply one cannot be: every iteration re-sends the whole
    /// history, so a turn costs the *sum* of its replies. Three replies at the
    /// per-reply ceiling is where the question stops fitting alongside them.
    #[test]
    fn the_turn_budget_is_a_few_replies_worth_not_one() {
        let limits = AgentLimits::default();
        assert_eq!(
            limits.max_result_chars,
            3 * crate::ai::exec::MAX_TOOL_RESULT_CHARS
        );
        assert!(limits.max_result_chars > crate::ai::exec::MAX_TOOL_RESULT_CHARS);
    }

    /// The prompt's job is to stop the one failure this feature exists to
    /// avoid: a confident answer about a schema nobody looked at.
    #[test]
    fn the_system_prompt_forbids_claiming_unread_facts_and_writes() {
        assert!(SYSTEM_PROMPT.contains("Never state a table name"));
        assert!(SYSTEM_PROMPT.contains("You cannot write"));
        assert!(SYSTEM_PROMPT.contains("Never present a statement as executed"));
    }

    /// The reversal has to round-trip, or the loop would advertise row tools
    /// and then have every call to one refused underneath it.
    #[test]
    fn the_runtime_the_loop_builds_reproduces_its_own_scope() {
        for scope in [DataScope::Rows, DataScope::MetadataOnly] {
            let trust = endpoint_trust_of(scope);
            // `false` is the connection's own flag: under `Trusted` it is
            // ignored, and under `Untrusted` a metadata-only scope is what it
            // must produce.
            assert_eq!(crate::ai::scope::DataScope::resolve(trust, false), scope);
        }
    }

    /// Small enough that a stuck model costs seconds, big enough for "list,
    /// describe two, answer" with room for one mistake.
    #[test]
    fn the_default_budgets_are_the_documented_ones() {
        let limits = AgentLimits::default();
        assert_eq!(limits.max_iterations, 6);
        assert_eq!(limits.max_tool_calls, 12);
        assert_eq!(
            limits.max_context_rows,
            crate::ai::exec::DEFAULT_MAX_CONTEXT_ROWS
        );
    }
}
