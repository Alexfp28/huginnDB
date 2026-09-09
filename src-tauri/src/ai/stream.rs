//! Turning a server-sent-events body into one assistant message.
//!
//! Split out of [`crate::ai::provider`] deliberately: this file contains no
//! HTTP and no I/O at all, and it holds what the roadmap's own risk table names
//! as the single most likely source of "the AI is broken" reports — the
//! reassembly of `tool_calls` fragments. Keeping it pure is what lets the whole
//! problem be pinned with captured bytes instead of a live server.
//!
//! # Two layers, and why they are separate
//!
//! 1. [`SseDecoder`] turns a byte stream into complete `data:` payloads. It
//!    buffers **bytes**, not text, which is the whole answer to a frame that
//!    splits a multi-byte UTF-8 sequence down the middle: a `\n` can never
//!    appear inside a UTF-8 continuation byte, so a line boundary is always a
//!    safe place to decode, and a partial sequence simply stays in the buffer
//!    until the rest of it arrives.
//! 2. [`MessageAssembler`] folds those payloads into one message. Text is
//!    trivial; tool calls are not, because their `arguments` arrive as JSON
//!    *fragments* spread across frames, and servers disagree about the rest of
//!    the envelope. See [`MessageAssembler::push_chunk`].
//!
//! # What "servers disagree" means concretely
//!
//! The OpenAI wire format says each `tool_calls` delta carries an `index`
//! naming the slot it belongs to, with `id` and `function.name` sent once and
//! `function.arguments` streamed in pieces. Real servers vary: some omit
//! `index` entirely, some repeat `id`/`name` on every frame, and llama.cpp and
//! Ollama fragment at different boundaries. A naive implementation that
//! concatenates everything it sees works against one and corrupts the other —
//! it either duplicates the name or fuses two separate calls into one. The
//! merge rules below handle all three shapes, and the tests use fragments in
//! each of them.

use crate::error::{AppError, AppResult};
use serde_json::{json, Value};

/// The sentinel payload an OpenAI-compatible stream ends with.
///
/// Interpreted by the caller, not by [`SseDecoder`]: the decoder implements
/// SSE, and `[DONE]` is a convention of the chat API layered on top of it.
pub const DONE: &str = "[DONE]";

/// Incremental server-sent-events reader.
///
/// Feed it whatever bytes arrived; it returns the payloads that completed. Hold
/// one per response and call [`Self::finish`] at the end.
#[derive(Debug, Default)]
pub struct SseDecoder {
    /// Bytes of a line that has not been terminated yet.
    partial: Vec<u8>,
    /// `data:` lines of the event currently being read. SSE joins several with
    /// newlines, and while the chat API sends one per event, a server that
    /// pretty-prints its JSON sends several — a decoder that assumed one would
    /// hand the parser a fragment of an object.
    data: Vec<String>,
}

impl SseDecoder {
    /// Feed raw bytes. Returns any payloads that completed, in order.
    pub fn push(&mut self, chunk: &[u8]) -> Vec<String> {
        self.partial.extend_from_slice(chunk);
        let mut out = Vec::new();
        while let Some(index) = self.partial.iter().position(|byte| *byte == b'\n') {
            let line: Vec<u8> = self.partial.drain(..=index).collect();
            let line = &line[..line.len() - 1];
            let line = line.strip_suffix(b"\r").unwrap_or(line);
            self.line(line, &mut out);
        }
        out
    }

    /// Flush a final event the server left unterminated.
    ///
    /// Not paranoia: a stream that ends `data: [DONE]` with no trailing blank
    /// line is common, and without this the sentinel — or worse, a last content
    /// delta — is silently dropped.
    pub fn finish(&mut self) -> Vec<String> {
        let mut out = Vec::new();
        if !self.partial.is_empty() {
            let line: Vec<u8> = std::mem::take(&mut self.partial);
            let line = line.strip_suffix(b"\r").unwrap_or(&line);
            self.line(line, &mut out);
        }
        self.flush(&mut out);
        out
    }

    fn line(&mut self, line: &[u8], out: &mut Vec<String>) {
        // A blank line ends the event.
        if line.is_empty() {
            self.flush(out);
            return;
        }
        // A line starting with a colon is a comment. Endpoints behind a proxy
        // use these as keepalives, so they arrive routinely and must not be
        // mistaken for data.
        if line.starts_with(b":") {
            return;
        }
        // Lossy rather than strict: the line is complete, so invalid UTF-8 here
        // means the server sent something malformed, and losing one character
        // is a better outcome than aborting a stream that is otherwise fine.
        let line = String::from_utf8_lossy(line);
        let Some((field, value)) = line.split_once(':') else {
            // A field with no colon has an empty value per the SSE spec.
            // Nothing we read has a meaningful empty value.
            return;
        };
        // Exactly one leading space is part of the framing, not the data.
        let value = value.strip_prefix(' ').unwrap_or(value);
        if field == "data" {
            self.data.push(value.to_string());
        }
        // `event:`, `id:` and `retry:` are meaningless here and dropped.
    }

    fn flush(&mut self, out: &mut Vec<String>) {
        if self.data.is_empty() {
            return;
        }
        out.push(std::mem::take(&mut self.data).join("\n"));
    }
}

/// One tool call as it is being assembled, with `arguments` still raw text.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ToolCallDraft {
    pub id: String,
    pub name: String,
    /// JSON source, concatenated from however many fragments the server sent.
    /// **Never parsed per fragment** — half an object is not valid JSON, and a
    /// parser run on each piece is the bug this field's type exists to prevent.
    pub arguments: String,
}

/// A finished tool call: name resolved, arguments parsed.
#[derive(Debug, Clone, PartialEq)]
pub struct ToolCall {
    /// The id the server assigned, echoed back with the result so the model can
    /// match them up. Empty when the server sent none.
    pub id: String,
    pub name: String,
    pub arguments: Value,
}

/// A finished assistant turn.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct AssistantMessage {
    pub content: String,
    pub tool_calls: Vec<ToolCall>,
    /// `"stop"`, `"tool_calls"`, `"length"`, … as the server reported it.
    /// `None` when it reported nothing, which some servers do.
    pub finish_reason: Option<String>,
}

/// Folds stream deltas into one message.
#[derive(Debug, Default)]
pub struct MessageAssembler {
    content: String,
    calls: Vec<ToolCallDraft>,
    finish_reason: Option<String>,
}

impl MessageAssembler {
    /// Fold one decoded `data:` payload into the message.
    ///
    /// Returns the text this chunk added, so the caller can forward it to the
    /// UI without re-diffing the whole buffer.
    ///
    /// # The tool-call merge rules
    ///
    /// * **`index` decides the slot when present.** It is the only signal that
    ///   distinguishes "more arguments for the call we are already building"
    ///   from "a second call". The vector grows to fit, because a server may
    ///   open index 1 before finishing index 0.
    /// * **Without an `index`**, a delta carrying an `id` or a `name` starts a
    ///   new call and anything else continues the last one. That is the shape
    ///   servers which omit `index` actually emit: identity first, then
    ///   argument fragments.
    /// * **`id` and `name` are set when empty, ignored when repeated, and
    ///   appended otherwise.** Three branches because all three happen:
    ///   sent-once (OpenAI), re-sent on every frame (several proxies), and
    ///   genuinely fragmented. Blind appending corrupts the second case; blind
    ///   set-if-empty corrupts the third.
    /// * **`arguments` are always appended verbatim.**
    pub fn push_chunk(&mut self, chunk: &Value) -> AppResult<Option<String>> {
        // Some servers stream a failure as a frame rather than as an HTTP
        // status — a context-length refusal usually arrives this way, after a
        // 200 and several good frames.
        if let Some(error) = chunk.get("error") {
            let message = error
                .get("message")
                .and_then(Value::as_str)
                .unwrap_or("the endpoint reported an error mid-stream");
            return Err(AppError::Inference(message.to_string()));
        }

        let Some(choice) = chunk.get("choices").and_then(|c| c.get(0)) else {
            // A frame with no choices is legitimate: several servers open with
            // a role-only or usage-only frame.
            return Ok(None);
        };
        if let Some(reason) = choice.get("finish_reason").and_then(Value::as_str) {
            self.finish_reason = Some(reason.to_string());
        }
        // `delta` while streaming, `message` if a caller feeds a non-streamed
        // choice through the same path.
        let delta = choice
            .get("delta")
            .or_else(|| choice.get("message"))
            .unwrap_or(&Value::Null);

        if let Some(calls) = delta.get("tool_calls").and_then(Value::as_array) {
            for call in calls {
                self.merge_tool_call(call);
            }
        }

        let text = delta.get("content").and_then(Value::as_str).unwrap_or("");
        if text.is_empty() {
            return Ok(None);
        }
        self.content.push_str(text);
        Ok(Some(text.to_string()))
    }

    fn merge_tool_call(&mut self, call: &Value) {
        let function = call.get("function").unwrap_or(&Value::Null);
        let id = call.get("id").and_then(Value::as_str).unwrap_or_default();
        let name = function
            .get("name")
            .and_then(Value::as_str)
            .unwrap_or_default();
        let arguments = function
            .get("arguments")
            .and_then(Value::as_str)
            .unwrap_or_default();

        let slot = match call.get("index").and_then(Value::as_u64) {
            Some(index) => {
                let index = index as usize;
                if self.calls.len() <= index {
                    self.calls.resize(index + 1, ToolCallDraft::default());
                }
                index
            }
            // No index: identity means a new call, anything else continues the
            // one in progress.
            None => {
                let starts_new = !id.is_empty() || !name.is_empty();
                if self.calls.is_empty() || starts_new {
                    self.calls.push(ToolCallDraft::default());
                }
                self.calls.len() - 1
            }
        };

        let draft = &mut self.calls[slot];
        merge_field(&mut draft.id, id);
        merge_field(&mut draft.name, name);
        draft.arguments.push_str(arguments);
    }

    /// Parse what was assembled.
    pub fn finish(self) -> AppResult<AssistantMessage> {
        let mut tool_calls = Vec::with_capacity(self.calls.len());
        for draft in self.calls {
            // A slot left empty by an out-of-order `index` (the server opened
            // 1 before 0 and never filled 0) is dropped rather than reported as
            // a nameless call.
            if draft.name.is_empty() && draft.arguments.trim().is_empty() {
                continue;
            }
            tool_calls.push(ToolCall {
                arguments: parse_arguments(&draft.name, &draft.arguments)?,
                id: draft.id,
                name: draft.name,
            });
        }
        Ok(AssistantMessage {
            content: self.content,
            tool_calls,
            finish_reason: self.finish_reason,
        })
    }
}

/// Set when empty, ignore when repeated, append otherwise. See
/// [`MessageAssembler::push_chunk`] for why all three cases are real.
fn merge_field(existing: &mut String, incoming: &str) {
    if incoming.is_empty() || existing.as_str() == incoming {
        return;
    }
    existing.push_str(incoming);
}

/// Parse a tool call's assembled arguments.
///
/// An empty string means "no arguments", which is what a server sends for a
/// tool that takes none — `serde_json` would call that a syntax error, and the
/// model would be told its perfectly good call was malformed.
fn parse_arguments(name: &str, raw: &str) -> AppResult<Value> {
    let raw = raw.trim();
    if raw.is_empty() {
        return Ok(json!({}));
    }
    serde_json::from_str(raw).map_err(|e| {
        // The raw text is in the message on purpose: this is the failure that
        // means "the model's JSON was truncated or the reassembly is wrong",
        // and telling the two apart without seeing the bytes is impossible.
        AppError::Inference(format!(
            "could not parse the arguments {name} was called with ({e}): {}",
            truncate(raw, 400)
        ))
    })
}

fn truncate(text: &str, max: usize) -> String {
    match text.char_indices().nth(max) {
        None => text.to_string(),
        Some((cut, _)) => format!("{}…", &text[..cut]),
    }
}

/// Parse a **non-streamed** `choices[0].message` into the same type.
///
/// Used by [`crate::ai::probe`], whose smoke test does not stream. Routed
/// through [`MessageAssembler`] rather than duplicating the field walk, so the
/// two shapes cannot disagree about what a tool call is.
pub fn parse_message(response: &Value) -> AppResult<AssistantMessage> {
    let mut assembler = MessageAssembler::default();
    assembler.push_chunk(response)?;
    assembler.finish()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn collect(decoder: &mut SseDecoder, chunks: &[&[u8]]) -> Vec<String> {
        let mut out = Vec::new();
        for chunk in chunks {
            out.extend(decoder.push(chunk));
        }
        out.extend(decoder.finish());
        out
    }

    #[test]
    fn a_plain_stream_decodes_frame_by_frame() {
        let mut decoder = SseDecoder::default();
        let payloads = collect(
            &mut decoder,
            &[b"data: {\"a\":1}\n\ndata: {\"a\":2}\n\ndata: [DONE]\n\n"],
        );
        assert_eq!(payloads, vec!["{\"a\":1}", "{\"a\":2}", DONE]);
    }

    /// The failure this decoder buffers bytes to avoid. `€` is three bytes; a
    /// chunk boundary inside it must not produce a replacement character, and a
    /// decoder that called `from_utf8` per chunk would.
    #[test]
    fn a_frame_split_mid_utf8_sequence_survives() {
        let payload = "data: {\"content\":\"20 €\"}\n\n".as_bytes().to_vec();
        // Split three bytes from the end of the euro sign's encoding.
        let cut = payload.len() - 6;
        let mut decoder = SseDecoder::default();
        let payloads = collect(&mut decoder, &[&payload[..cut], &payload[cut..]]);
        assert_eq!(payloads, vec!["{\"content\":\"20 €\"}"]);
    }

    /// One byte at a time — the pathological case, and the one that catches a
    /// decoder holding state in the wrong place.
    #[test]
    fn a_stream_delivered_one_byte_at_a_time_decodes_identically() {
        let payload = "data: {\"content\":\"héllo\"}\n\ndata: [DONE]\n\n".as_bytes();
        let mut decoder = SseDecoder::default();
        let mut out = Vec::new();
        for byte in payload {
            out.extend(decoder.push(&[*byte]));
        }
        out.extend(decoder.finish());
        assert_eq!(out, vec!["{\"content\":\"héllo\"}", DONE]);
    }

    #[test]
    fn comments_keepalives_and_other_fields_are_ignored() {
        let mut decoder = SseDecoder::default();
        let payloads = collect(
            &mut decoder,
            &[b": ping\n\nevent: message\nid: 7\ndata: {\"a\":1}\n\n:\n\n"],
        );
        assert_eq!(payloads, vec!["{\"a\":1}"]);
    }

    #[test]
    fn crlf_framing_decodes_the_same_as_lf() {
        let mut decoder = SseDecoder::default();
        let payloads = collect(
            &mut decoder,
            &[b"data: {\"a\":1}\r\n\r\ndata: [DONE]\r\n\r\n"],
        );
        assert_eq!(payloads, vec!["{\"a\":1}", DONE]);
    }

    /// A pretty-printing server sends one event as several `data:` lines, which
    /// SSE says to join with newlines. Handing the JSON parser one of them
    /// alone would fail on every frame.
    #[test]
    fn several_data_lines_join_into_one_payload() {
        let mut decoder = SseDecoder::default();
        let payloads = collect(&mut decoder, &[b"data: {\ndata:   \"a\": 1\ndata: }\n\n"]);
        assert_eq!(payloads, vec!["{\n  \"a\": 1\n}"]);
        assert!(serde_json::from_str::<Value>(&payloads[0]).is_ok());
    }

    /// No trailing blank line. Without `finish` the sentinel is lost, and with
    /// a content delta in that position so is the end of the answer.
    #[test]
    fn a_stream_that_ends_without_a_blank_line_still_yields_its_last_event() {
        let mut decoder = SseDecoder::default();
        let payloads = collect(&mut decoder, &[b"data: {\"a\":1}\n\ndata: [DONE]"]);
        assert_eq!(payloads, vec!["{\"a\":1}", DONE]);
    }

    fn assemble(frames: &[Value]) -> AssistantMessage {
        let mut assembler = MessageAssembler::default();
        for frame in frames {
            assembler.push_chunk(frame).expect("frame must fold");
        }
        assembler.finish().expect("message must finish")
    }

    #[test]
    fn text_deltas_concatenate_and_are_reported_as_they_arrive() {
        let mut assembler = MessageAssembler::default();
        let seen: Vec<Option<String>> = ["The ", "table ", "is ", "empty."]
            .iter()
            .map(|piece| {
                assembler
                    .push_chunk(&json!({ "choices": [{ "delta": { "content": piece } }] }))
                    .unwrap()
            })
            .collect();
        assert_eq!(
            seen,
            ["The ", "table ", "is ", "empty."]
                .iter()
                .map(|p| Some(p.to_string()))
                .collect::<Vec<_>>()
        );
        assert_eq!(assembler.finish().unwrap().content, "The table is empty.");
    }

    /// The OpenAI shape: `index` on every delta, identity once, arguments in
    /// pieces. Three fragments, because two is not enough to catch an
    /// off-by-one in the concatenation.
    #[test]
    fn openai_shaped_arguments_reassemble_across_three_frames() {
        let message = assemble(&[
            json!({ "choices": [{ "delta": { "tool_calls": [{
                "index": 0,
                "id": "call_1",
                "type": "function",
                "function": { "name": "describe_table", "arguments": "" }
            }] } }] }),
            json!({ "choices": [{ "delta": { "tool_calls": [{
                "index": 0, "function": { "arguments": "{\"tab" }
            }] } }] }),
            json!({ "choices": [{ "delta": { "tool_calls": [{
                "index": 0, "function": { "arguments": "le\": \"or" }
            }] } }] }),
            json!({ "choices": [{ "delta": { "tool_calls": [{
                "index": 0, "function": { "arguments": "ders\"}" }
            }] } }], "finish_reason": null }),
            json!({ "choices": [{ "delta": {}, "finish_reason": "tool_calls" }] }),
        ]);
        assert_eq!(message.tool_calls.len(), 1);
        assert_eq!(message.tool_calls[0].id, "call_1");
        assert_eq!(message.tool_calls[0].name, "describe_table");
        assert_eq!(
            message.tool_calls[0].arguments,
            json!({ "table": "orders" })
        );
        assert_eq!(message.finish_reason.as_deref(), Some("tool_calls"));
    }

    /// The shape servers that omit `index` emit. A naive implementation reads
    /// this as one call whose name is `list_tablesserver_version`.
    #[test]
    fn two_calls_without_an_index_do_not_fuse_into_one() {
        let message = assemble(&[
            json!({ "choices": [{ "delta": { "tool_calls": [{
                "function": { "name": "list_tables", "arguments": "" }
            }] } }] }),
            json!({ "choices": [{ "delta": { "tool_calls": [{
                "function": { "arguments": "{}" }
            }] } }] }),
            json!({ "choices": [{ "delta": { "tool_calls": [{
                "function": { "name": "server_version", "arguments": "{}" }
            }] } }] }),
        ]);
        assert_eq!(message.tool_calls.len(), 2);
        assert_eq!(message.tool_calls[0].name, "list_tables");
        assert_eq!(message.tool_calls[1].name, "server_version");
    }

    /// A proxy that re-sends `id` and `name` on every frame. Blind
    /// concatenation gives `describe_tabledescribe_table`, and the tool lookup
    /// then fails with "unknown tool" on a call that was perfectly well formed.
    #[test]
    fn a_repeated_id_and_name_are_not_concatenated_with_themselves() {
        let message = assemble(&[
            json!({ "choices": [{ "delta": { "tool_calls": [{
                "index": 0, "id": "c1",
                "function": { "name": "describe_table", "arguments": "{\"table\":" }
            }] } }] }),
            json!({ "choices": [{ "delta": { "tool_calls": [{
                "index": 0, "id": "c1",
                "function": { "name": "describe_table", "arguments": "\"users\"}" }
            }] } }] }),
        ]);
        assert_eq!(message.tool_calls.len(), 1);
        assert_eq!(message.tool_calls[0].id, "c1");
        assert_eq!(message.tool_calls[0].name, "describe_table");
        assert_eq!(message.tool_calls[0].arguments, json!({ "table": "users" }));
    }

    /// And the third case: a server that genuinely splits the name. Rarer, but
    /// the reason the rule is not simply set-if-empty.
    #[test]
    fn a_genuinely_fragmented_name_is_appended() {
        let message = assemble(&[
            json!({ "choices": [{ "delta": { "tool_calls": [{
                "index": 0, "function": { "name": "describe_" }
            }] } }] }),
            json!({ "choices": [{ "delta": { "tool_calls": [{
                "index": 0, "function": { "name": "table", "arguments": "{\"table\":\"t\"}" }
            }] } }] }),
        ]);
        assert_eq!(message.tool_calls[0].name, "describe_table");
    }

    /// A server may open a later slot first. The vector has to grow, and the
    /// hole must not become a nameless call.
    #[test]
    fn out_of_order_indexes_land_in_their_own_slots() {
        let message = assemble(&[
            json!({ "choices": [{ "delta": { "tool_calls": [{
                "index": 1, "function": { "name": "list_indexes", "arguments": "{\"table\":\"t\"}" }
            }] } }] }),
            json!({ "choices": [{ "delta": { "tool_calls": [{
                "index": 0, "function": { "name": "list_tables", "arguments": "{}" }
            }] } }] }),
        ]);
        assert_eq!(message.tool_calls.len(), 2);
        assert_eq!(message.tool_calls[0].name, "list_tables");
        assert_eq!(message.tool_calls[1].name, "list_indexes");

        // The hole case: index 1 filled, index 0 never.
        let message = assemble(&[json!({ "choices": [{ "delta": { "tool_calls": [{
            "index": 1, "function": { "name": "list_tables", "arguments": "{}" }
        }] } }] })]);
        assert_eq!(message.tool_calls.len(), 1);
        assert_eq!(message.tool_calls[0].name, "list_tables");
    }

    /// A tool that takes no arguments. `serde_json` calls an empty string a
    /// syntax error, which would report a good call as malformed.
    #[test]
    fn a_call_with_no_arguments_gets_an_empty_object() {
        let message = assemble(&[json!({ "choices": [{ "delta": { "tool_calls": [{
            "index": 0, "function": { "name": "list_tables", "arguments": "" }
        }] } }] })]);
        assert_eq!(message.tool_calls[0].arguments, json!({}));
    }

    /// Truncated JSON must name the tool and show the bytes: without them
    /// "invalid JSON" cannot be told apart from a reassembly bug, which is the
    /// question anyone debugging this actually has.
    #[test]
    fn truncated_arguments_fail_with_the_raw_text_in_the_message() {
        let mut assembler = MessageAssembler::default();
        assembler
            .push_chunk(&json!({ "choices": [{ "delta": { "tool_calls": [{
                "index": 0, "function": { "name": "run_query", "arguments": "{\"sql\": \"SEL" }
            }] } }] }))
            .unwrap();
        let err = assembler
            .finish()
            .expect_err("half an object is not valid JSON")
            .to_string();
        assert!(err.contains("run_query"), "{err}");
        assert!(err.contains("SEL"), "{err}");
    }

    #[test]
    fn a_frame_carrying_an_error_stops_the_stream() {
        let mut assembler = MessageAssembler::default();
        let err = assembler
            .push_chunk(&json!({ "error": { "message": "context length exceeded" } }))
            .expect_err("an error frame must not be folded in as content")
            .to_string();
        assert!(err.contains("context length exceeded"), "{err}");
    }

    #[test]
    fn role_only_and_usage_only_frames_are_harmless() {
        let message = assemble(&[
            json!({ "choices": [{ "delta": { "role": "assistant" } }] }),
            json!({ "usage": { "total_tokens": 12 } }),
            json!({ "choices": [] }),
            json!({ "choices": [{ "delta": { "content": "hi" } }] }),
        ]);
        assert_eq!(message.content, "hi");
        assert!(message.tool_calls.is_empty());
    }

    /// The non-streamed shape goes through the same field walk, so the two
    /// cannot disagree about what a tool call is.
    #[test]
    fn a_non_streamed_message_parses_through_the_same_path() {
        let message = parse_message(&json!({
            "choices": [{
                "message": {
                    "role": "assistant",
                    "content": "checking",
                    "tool_calls": [{
                        "id": "c1",
                        "type": "function",
                        "function": { "name": "list_tables", "arguments": "{}" }
                    }]
                },
                "finish_reason": "tool_calls"
            }]
        }))
        .unwrap();
        assert_eq!(message.content, "checking");
        assert_eq!(message.tool_calls.len(), 1);
        assert_eq!(message.tool_calls[0].name, "list_tables");
        assert_eq!(message.finish_reason.as_deref(), Some("tool_calls"));
    }
}
