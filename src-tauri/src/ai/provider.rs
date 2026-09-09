//! The one place HuginnDB talks to an inference endpoint.
//!
//! # The egress invariant, made structural
//!
//! [`crate::ai`] states it; this file is where it is true. Every request goes
//! through [`request`], which resolves the URL from
//! [`Endpoint::base_url`] and then checks it against [`allows`] before a socket
//! is opened. There is no other function in the crate that can reach an
//! inference endpoint, which is what makes "what leaves this machine" a
//! question with one answer instead of a search.
//!
//! Three details do the actual work:
//!
//! * **Redirects are refused.** `reqwest`'s default policy follows up to ten,
//!   and an allowlist that validates the URL it *constructs* is worthless if a
//!   `302` can then point the client at any host on the internet. With
//!   [`redirect::Policy::none`] a redirect arrives as a 3xx response and is
//!   reported as an error, which is the honest outcome: an OpenAI-compatible
//!   endpoint has no business redirecting a completion.
//! * **Plain `http` stays allowed**, unlike `tauri-plugin-opener`'s https-only
//!   capability for external URLs. The deployment this feature is designed
//!   around is `http://localhost:11434/v1` or `http://ai-internal:11434/v1` on
//!   a LAN; an https-only rule would break the primary case. `file://` and
//!   every other scheme are blocked.
//! * **No total request timeout.** A read timeout instead — see [`client`].
//!
//! # No new dependency
//!
//! Roadmap decision D8, and it turned out to be cheaper than the plan assumed.
//! `reqwest` is already a direct dependency with `rustls-tls` + `json` (added
//! for `commands::feedback`), and the streaming body is read with
//! `Response::chunk`, which is **not** behind the `stream` feature — so this
//! phase adds neither a Cargo feature nor `futures-util`, whose `StreamExt` a
//! `bytes_stream()` would have needed. SSE is parsed by hand in
//! [`crate::ai::stream`].

use crate::ai::stream::{AssistantMessage, MessageAssembler, SseDecoder, DONE};
use crate::ai::tools::ToolSpec;
use crate::error::{AppError, AppResult};
use crate::prefs::AiReasoningEffort;
use reqwest::{redirect, Client, Method, RequestBuilder, Url};
use serde_json::{json, Value};
use std::time::Duration;

/// How long a socket may go without delivering a byte before it is declared
/// dead. Overridden by `AiPrefs::request_timeout_secs` in phase 3.
pub const DEFAULT_TIMEOUT: Duration = Duration::from_secs(120);

/// Where the model is, and how to reach it.
#[derive(Debug, Clone)]
pub struct Endpoint {
    /// The OpenAI-compatible base, e.g. `http://localhost:11434/v1`. Every
    /// other URL this module builds is derived from it, and it is the sole
    /// input to [`allows`].
    pub base_url: Url,
    /// The model id to ask for.
    pub model: String,
    /// A BYOK bearer token, or `None` for an endpoint that wants none (which
    /// is every local server). Read from the keychain by
    /// [`crate::ai::secrets`] and never held anywhere the webview can see.
    pub api_key: Option<String>,
    /// Read-timeout budget. See [`client`].
    pub timeout: Duration,
    /// What to send as `reasoning_effort`, or [`AiReasoningEffort::Auto`] to
    /// omit the field. See that type for why omitting is the default.
    pub reasoning_effort: AiReasoningEffort,
}

impl Endpoint {
    /// Validate a user-typed configuration into an endpoint.
    ///
    /// The one place a base URL is parsed, and therefore the right place to
    /// refuse a scheme [`allows`] would reject anyway: a `file://` or `data:`
    /// base can never be *stored* in an `Endpoint`, so the allowlist is not
    /// merely checking every call — it is checking a value that was already
    /// constrained on the way in. Rejecting it here also means the user finds
    /// out in Settings → AI rather than on their first message.
    ///
    /// Pure: no keychain, no prefs, no I/O. [`Self::from_prefs`] is the
    /// wrapper that has those.
    pub fn new(
        base_url: &str,
        model: &str,
        api_key: Option<String>,
        timeout_secs: u64,
    ) -> AppResult<Self> {
        let base_url = base_url.trim();
        if base_url.is_empty() {
            return Err(AppError::Inference(
                "no inference endpoint is configured — set one in Settings → AI (for a local \
                 Ollama that is http://localhost:11434/v1)"
                    .into(),
            ));
        }
        let parsed = Url::parse(base_url)
            .map_err(|e| AppError::Inference(format!("{base_url:?} is not a valid URL: {e}")))?;
        if !matches!(parsed.scheme(), "http" | "https") {
            return Err(AppError::Inference(format!(
                "the endpoint must be an http or https URL, not {:?}",
                parsed.scheme()
            )));
        }
        if parsed.host_str().unwrap_or_default().is_empty() {
            return Err(AppError::Inference(format!(
                "{base_url:?} has no host — an endpoint needs one, e.g. \
                 http://localhost:11434/v1"
            )));
        }
        let model = model.trim();
        if model.is_empty() {
            return Err(AppError::Inference(
                "no model is selected — pick one in Settings → AI".into(),
            ));
        }
        Ok(Self {
            base_url: parsed,
            model: model.to_string(),
            api_key: api_key
                .map(|key| key.trim().to_string())
                .filter(|key| !key.is_empty()),
            // Floored so a `0` cannot make every request fail instantly, and
            // capped so a typo cannot hang a turn for a day.
            timeout: Duration::from_secs(timeout_secs.clamp(5, 3600)),
            // Omitted unless a caller sets it: `from_prefs` is what carries
            // the user's choice, and a bare `new` must stay safe against a
            // server that validates the field.
            reasoning_effort: AiReasoningEffort::Auto,
        })
    }

    /// Build the endpoint the user's preferences describe, with the BYOK key
    /// from the keychain.
    ///
    /// Refuses when the panel is switched off, so no command has to remember
    /// to check: `enabled` is the master switch, and a command surface where
    /// one entry point forgot it is exactly how a disabled feature makes a
    /// network call.
    pub fn from_prefs(prefs: &crate::prefs::AiPrefs) -> AppResult<Self> {
        if !prefs.enabled {
            return Err(AppError::Inference(
                "the AI panel is switched off — turn it on in Settings → AI".into(),
            ));
        }
        // The key is looked up by origin, so it has to be parsed first. `new`
        // does that anyway, and doing it twice is cheaper than duplicating the
        // validation.
        let endpoint = Self::new(
            &prefs.base_url,
            &prefs.model,
            None,
            prefs.request_timeout_secs,
        )?;
        let api_key = crate::ai::secrets::key(&endpoint.base_url)?;
        Ok(Self {
            api_key,
            reasoning_effort: prefs.reasoning_effort,
            ..endpoint
        })
    }

    /// A stable label for this configuration, for cache lines and log lines.
    ///
    /// Deliberately excludes the API key: this string ends up in the Console
    /// and in [`crate::ai::probe`]'s cache key, and a secret that reaches
    /// either has effectively been written to a log.
    pub fn fingerprint(&self) -> String {
        format!("{}|{}", self.base_url, self.model)
    }
}

/// Whether `target` is the endpoint the user configured.
///
/// Scheme, host and port must all match `base`, and the scheme must be `http`
/// or `https`. Scheme equality rather than merely "one of the two" so a
/// configured `https` endpoint can never be talked to over plain `http` — a
/// downgrade is exactly the kind of thing an allowlist exists to refuse, and
/// nothing legitimate needs it.
///
/// Paths are not compared: the endpoint's own path prefix (`/v1`, or none) is
/// where the base URL already puts it, and every URL this module builds is
/// joined onto it.
pub fn allows(base: &Url, target: &Url) -> bool {
    matches!(target.scheme(), "http" | "https")
        && target.scheme() == base.scheme()
        && target.host_str() == base.host_str()
        && target.port_or_known_default() == base.port_or_known_default()
}

/// Build the HTTP client.
///
/// `read_timeout` and `connect_timeout`, and deliberately **not**
/// `Client::timeout`: that one bounds the whole request *including reading the
/// body*, so on a streamed completion it would abort a model that is answering
/// correctly but slowly — the exact case a local 7B on a CPU is in. A read
/// timeout asks the right question instead ("has anything arrived recently?"),
/// which fails fast on a dead socket and never on a slow one.
pub fn client(timeout: Duration) -> AppResult<Client> {
    Client::builder()
        .redirect(redirect::Policy::none())
        .connect_timeout(timeout)
        .read_timeout(timeout)
        .build()
        .map_err(AppError::from)
}

/// Resolve `path` against the endpoint's base and start a request to it.
///
/// **The only function in the crate that may address an inference endpoint.**
/// Every caller here goes through it, so the allowlist check and the bearer
/// header each exist exactly once.
fn request(
    http: &Client,
    endpoint: &Endpoint,
    method: Method,
    path: &str,
) -> AppResult<RequestBuilder> {
    let url = joined(&endpoint.base_url, path)?;
    if !allows(&endpoint.base_url, &url) {
        // Unreachable while `joined` derives from `base_url`, and checked
        // anyway: the invariant is worth more than the branch, and a future
        // caller passing an absolute URL is exactly what this stops.
        return Err(AppError::Inference(format!(
            "refusing to call {url}: it is not the configured inference endpoint"
        )));
    }
    let mut builder = http.request(method, url);
    if let Some(key) = endpoint.api_key.as_deref().map(str::trim) {
        if !key.is_empty() {
            builder = builder.bearer_auth(key);
        }
    }
    Ok(builder)
}

/// Join `path` onto `base`, treating `base` as a directory.
///
/// The trailing-slash trap: `Url::join` replaces the last path *segment*, so
/// joining `chat/completions` onto `http://host:11434/v1` yields
/// `http://host:11434/chat/completions` — silently dropping the `/v1` every
/// OpenAI-compatible server mounts its API under, and producing a 404 that
/// looks like a broken server rather than a broken URL. Users type the base
/// without a trailing slash every time, so this normalises rather than
/// complains.
fn joined(base: &Url, path: &str) -> AppResult<Url> {
    let mut base = base.clone();
    if !base.path().ends_with('/') {
        let with_slash = format!("{}/", base.path());
        base.set_path(&with_slash);
    }
    base.join(path)
        .map_err(|e| AppError::Inference(format!("{base} is not a usable base URL: {e}")))
}

/// The `tools` array an OpenAI-compatible endpoint expects.
pub fn tool_declarations(tools: &[&'static ToolSpec]) -> Vec<Value> {
    tools
        .iter()
        .map(|spec| {
            json!({
                "type": "function",
                "function": {
                    "name": spec.name,
                    "description": spec.description,
                    "parameters": (spec.schema)(),
                }
            })
        })
        .collect()
}

/// Build a `/chat/completions` body.
///
/// `tools` and `tool_choice` are **omitted** when there are none rather than
/// sent empty: several servers reject `"tools": []` outright, and one of them
/// is llama.cpp's, so an empty array would break assisted mode on the
/// deployment this feature is built around.
pub fn chat_body(
    endpoint: &Endpoint,
    messages: Vec<Value>,
    tools: &[&'static ToolSpec],
    stream: bool,
) -> Value {
    let mut body = json!({
        "model": endpoint.model,
        "messages": messages,
        "stream": stream,
    });
    let object = body.as_object_mut().expect("built as an object above");
    if !tools.is_empty() {
        object.insert("tools".into(), Value::Array(tool_declarations(tools)));
        object.insert("tool_choice".into(), Value::String("auto".into()));
    }
    // Only when the user asked for one. Omitting is not laziness: OpenAI
    // validates this field and rejects the request on a non-reasoning model,
    // so a build that always sent a value would break BYOK against half their
    // catalogue — see `AiReasoningEffort::Auto`.
    if let Some(effort) = endpoint.reasoning_effort.wire() {
        object.insert("reasoning_effort".into(), Value::String(effort.into()));
    }
    body
}

/// Stream one completion, forwarding text to `on_text` as it arrives.
///
/// Returns the assembled message once the stream ends. Cancellation is phase
/// 6's: dropping this future drops the response and closes the socket, which is
/// the mechanism it will use.
pub async fn stream_chat(
    http: &Client,
    endpoint: &Endpoint,
    body: &Value,
    on_text: &mut (dyn FnMut(&str) + Send),
) -> AppResult<AssistantMessage> {
    let response = request(http, endpoint, Method::POST, "chat/completions")?
        .json(body)
        .send()
        .await?;
    let mut response = check_status(response).await?;

    let mut decoder = SseDecoder::default();
    let mut assembler = MessageAssembler::default();
    let mut saw_done = false;
    while let Some(chunk) = response.chunk().await? {
        for payload in decoder.push(&chunk) {
            if fold(&mut assembler, &payload, on_text)? {
                saw_done = true;
            }
        }
        if saw_done {
            break;
        }
    }
    if !saw_done {
        // A stream cut short leaves whatever arrived usable, which matters:
        // half an answer plus its text is more use than an error, and a
        // truncated *tool call* is caught by the argument parse in `finish`.
        for payload in decoder.finish() {
            fold(&mut assembler, &payload, on_text)?;
        }
    }
    assembler.finish()
}

/// Fold one payload in. Returns whether it was the `[DONE]` sentinel.
fn fold(
    assembler: &mut MessageAssembler,
    payload: &str,
    on_text: &mut (dyn FnMut(&str) + Send),
) -> AppResult<bool> {
    let payload = payload.trim();
    if payload.is_empty() {
        return Ok(false);
    }
    if payload == DONE {
        return Ok(true);
    }
    let chunk: Value = serde_json::from_str(payload).map_err(|e| {
        AppError::Inference(format!("the endpoint sent a frame that is not JSON ({e})"))
    })?;
    if let Some(text) = assembler.push_chunk(&chunk)? {
        on_text(&text);
    }
    Ok(false)
}

/// One non-streamed completion, returned unparsed.
///
/// Split from [`complete`] for [`crate::ai::probe`]'s sake, and the split is
/// load-bearing rather than tidiness: a reply whose `tool_calls` do not parse is
/// the *strongest* evidence a model is chat-only, and it is the outcome the
/// probe exists to detect. Folded into one function, that reply would come back
/// as the same [`AppError::Inference`] a dead socket does, and the panel would
/// report an endpoint that answered perfectly well as unreachable.
pub async fn complete_raw(http: &Client, endpoint: &Endpoint, body: &Value) -> AppResult<Value> {
    let response = request(http, endpoint, Method::POST, "chat/completions")?
        .json(body)
        .send()
        .await?;
    let payload: Value = check_status(response).await?.json().await?;
    if let Some(error) = payload.get("error") {
        return Err(AppError::Inference(error_message(error)));
    }
    Ok(payload)
}

/// One non-streamed completion.
pub async fn complete(
    http: &Client,
    endpoint: &Endpoint,
    body: &Value,
) -> AppResult<AssistantMessage> {
    crate::ai::stream::parse_message(&complete_raw(http, endpoint, body).await?)
}

/// The model ids `/models` reports.
///
/// `Ok(vec![])` when the endpoint does not implement it — see
/// [`crate::ai::probe`] for why that must not be fatal.
pub async fn list_models(http: &Client, endpoint: &Endpoint) -> AppResult<Vec<String>> {
    let response = request(http, endpoint, Method::GET, "models")?
        .send()
        .await?;
    let payload: Value = check_status(response).await?.json().await?;
    Ok(payload
        .get("data")
        .and_then(Value::as_array)
        .map(|models| {
            models
                .iter()
                .filter_map(|model| model.get("id").and_then(Value::as_str))
                .map(str::to_string)
                .collect()
        })
        .unwrap_or_default())
}

/// Turn a non-2xx into an [`AppError::Inference`] carrying whatever the server
/// said.
///
/// `reqwest` raises no error for an HTTP status, so without this a 401 would
/// arrive at the SSE decoder as a body that is not SSE and be reported as "the
/// endpoint sent a frame that is not JSON" — which is true, useless, and sends
/// the user looking in the wrong place. A 3xx lands here too, since redirects
/// are refused by policy.
async fn check_status(response: reqwest::Response) -> AppResult<reqwest::Response> {
    let status = response.status();
    if status.is_success() {
        return Ok(response);
    }
    let body = response.text().await.unwrap_or_default();
    let detail = serde_json::from_str::<Value>(&body)
        .ok()
        .and_then(|payload| {
            payload.get("error").map(error_message).or_else(|| {
                payload
                    .get("message")
                    .and_then(Value::as_str)
                    .map(str::to_string)
            })
        })
        .unwrap_or_else(|| body.trim().chars().take(300).collect());

    Err(AppError::Inference(match status.as_u16() {
        401 | 403 => format!(
            "the endpoint rejected the credentials ({status}). Check the API key in \
             Settings → AI. {detail}"
        ),
        404 => format!(
            "the endpoint has no such route ({status}). The base URL usually needs to end in \
             /v1. {detail}"
        ),
        // Redirects cannot be followed by design; say so rather than reporting
        // an unexplained 3xx.
        300..=399 => format!(
            "the endpoint answered with a redirect ({status}), which is refused: an inference \
             endpoint must be reached directly. {detail}"
        ),
        _ => format!("the endpoint returned {status}. {detail}"),
    }))
}

/// Read a message out of an OpenAI-shaped `error` object, which is sometimes a
/// string and sometimes an object with a `message`.
fn error_message(error: &Value) -> String {
    error
        .get("message")
        .and_then(Value::as_str)
        .or_else(|| error.as_str())
        .unwrap_or("the endpoint reported an error with no message")
        .to_string()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ai::scope::DataScope;

    fn url(text: &str) -> Url {
        Url::parse(text).expect("test URL must parse")
    }

    fn endpoint(base: &str) -> Endpoint {
        Endpoint {
            base_url: url(base),
            model: "qwen2.5-coder:7b".into(),
            api_key: None,
            timeout: DEFAULT_TIMEOUT,
            reasoning_effort: AiReasoningEffort::Auto,
        }
    }

    /// The allowlist, as a table. Every row that is allowed is a URL this
    /// module can actually build; every row that is not is something a bug or a
    /// redirect could otherwise reach.
    #[test]
    fn only_the_configured_endpoint_is_reachable() {
        let base = url("http://ai-internal:11434/v1");
        let allowed = [
            "http://ai-internal:11434/v1/chat/completions",
            "http://ai-internal:11434/v1/models",
            // A different path on the same host and port is still the same
            // endpoint — the path is not the boundary.
            "http://ai-internal:11434/other",
        ];
        for target in allowed {
            assert!(allows(&base, &url(target)), "{target} must be allowed");
        }
        let refused = [
            // Another host, which is what a redirect would do.
            "http://evil.example.com:11434/v1/chat/completions",
            // Same host, another port.
            "http://ai-internal:8080/v1/chat/completions",
            // Same host and port, scheme upgraded — still not what was
            // configured.
            "https://ai-internal:11434/v1/chat/completions",
            // Not a network scheme at all.
            "file:///etc/passwd",
            "data:text/plain,hello",
        ];
        for target in refused {
            assert!(!allows(&base, &url(target)), "{target} must be refused");
        }
    }

    /// The primary deployment. An https-only rule would break both of these,
    /// which is why the check names the two schemes rather than one.
    #[test]
    fn plain_http_to_loopback_and_to_a_lan_host_is_allowed() {
        for base in ["http://localhost:11434/v1", "http://127.0.0.1:8080/v1"] {
            let base = url(base);
            let target = joined(&base, "chat/completions").unwrap();
            assert!(allows(&base, &target), "{base} must reach its own API");
        }
    }

    /// An https endpoint must not be silently downgraded.
    #[test]
    fn an_https_endpoint_refuses_plain_http_to_the_same_host() {
        let base = url("https://openrouter.ai/api/v1");
        assert!(!allows(
            &base,
            &url("http://openrouter.ai/api/v1/chat/completions")
        ));
        assert!(allows(
            &base,
            &url("https://openrouter.ai/api/v1/chat/completions")
        ));
    }

    /// The trailing-slash trap. Without the normalisation the `/v1` is dropped
    /// and every call 404s.
    #[test]
    fn joining_keeps_the_endpoints_path_prefix() {
        for base in ["http://host:11434/v1", "http://host:11434/v1/"] {
            let target = joined(&url(base), "chat/completions").unwrap();
            assert_eq!(target.as_str(), "http://host:11434/v1/chat/completions");
        }
        // A base with no path at all still works.
        let bare = joined(&url("http://host:11434"), "models").unwrap();
        assert_eq!(bare.as_str(), "http://host:11434/models");
        // And a deeper prefix, which Azure and OpenRouter both use.
        let nested = joined(&url("https://openrouter.ai/api/v1"), "models").unwrap();
        assert_eq!(nested.as_str(), "https://openrouter.ai/api/v1/models");
    }

    #[test]
    fn a_body_without_tools_omits_the_tools_keys() {
        let body = chat_body(
            &endpoint("http://localhost:11434/v1"),
            vec![json!({ "role": "user", "content": "hi" })],
            &[],
            true,
        );
        assert_eq!(body["stream"], json!(true));
        assert_eq!(body["model"], json!("qwen2.5-coder:7b"));
        // Not `"tools": []` — llama.cpp rejects that outright.
        assert!(body.get("tools").is_none(), "{body}");
        assert!(body.get("tool_choice").is_none(), "{body}");
    }

    #[test]
    fn a_body_with_tools_declares_them_in_the_openai_shape() {
        let tools = crate::ai::tools::catalogue(DataScope::MetadataOnly);
        let body = chat_body(
            &endpoint("http://localhost:11434/v1"),
            vec![json!({ "role": "user", "content": "what tables are there?" })],
            &tools,
            false,
        );
        let declared = body["tools"].as_array().expect("tools must be an array");
        assert_eq!(declared.len(), tools.len());
        assert_eq!(body["tool_choice"], json!("auto"));
        for (declaration, spec) in declared.iter().zip(&tools) {
            assert_eq!(declaration["type"], json!("function"));
            assert_eq!(declaration["function"]["name"], json!(spec.name));
            assert_eq!(
                declaration["function"]["parameters"]["type"],
                json!("object"),
                "{} must declare an object schema",
                spec.name
            );
            assert!(
                declaration["function"]["description"]
                    .as_str()
                    .is_some_and(|d| !d.is_empty()),
                "{} must describe itself to the model",
                spec.name
            );
        }
    }

    /// Omission is the safe default, and it is a compatibility requirement
    /// rather than a preference: OpenAI validates this field and rejects the
    /// whole request on a non-reasoning model.
    #[test]
    fn no_reasoning_effort_is_sent_unless_the_user_asked_for_one() {
        let endpoint = endpoint("http://localhost:11434/v1");
        assert_eq!(endpoint.reasoning_effort, AiReasoningEffort::Auto);
        let body = chat_body(&endpoint, vec![], &[], true);
        assert!(body.get("reasoning_effort").is_none(), "{body}");
    }

    #[test]
    fn a_chosen_reasoning_effort_reaches_the_wire() {
        for (choice, wire) in [
            (AiReasoningEffort::None, "none"),
            (AiReasoningEffort::Low, "low"),
            (AiReasoningEffort::Medium, "medium"),
            (AiReasoningEffort::High, "high"),
            (AiReasoningEffort::Max, "max"),
        ] {
            let mut endpoint = endpoint("http://localhost:11434/v1");
            endpoint.reasoning_effort = choice;
            let body = chat_body(&endpoint, vec![], &[], true);
            assert_eq!(body["reasoning_effort"], json!(wire), "{choice:?}");
        }
    }

    /// A metadata-only conversation must not even *declare* the row tools, or
    /// the model spends its turns asking for them. This is the coupling rule
    /// arriving at the wire.
    #[test]
    fn a_metadata_only_body_declares_no_row_tool() {
        let body = chat_body(
            &endpoint("http://localhost:11434/v1"),
            vec![],
            &crate::ai::tools::catalogue(DataScope::MetadataOnly),
            false,
        );
        let declared = body["tools"].to_string();
        assert!(
            !declared.contains(crate::ai::tools::BROWSE_TABLE),
            "{declared}"
        );
        assert!(
            !declared.contains(crate::ai::tools::RUN_QUERY),
            "{declared}"
        );
        assert!(
            declared.contains(crate::ai::tools::LIST_TABLES),
            "{declared}"
        );
    }

    /// Validation, as a table. Every row is something a user can type into
    /// the settings field, and the messages are what they read next.
    #[test]
    fn an_endpoint_is_validated_once_on_the_way_in() {
        // A `file://` base can never be *stored*, so the allowlist is guarding
        // an already-constrained value rather than doing this job alone.
        for (base, needle) in [
            ("", "no inference endpoint"),
            ("   ", "no inference endpoint"),
            ("file:///etc/passwd", "http or https"),
            ("data:text/plain,x", "http or https"),
            ("ftp://host/v1", "http or https"),
            ("not a url", "not a valid URL"),
            ("http://", "not a valid URL"),
        ] {
            let err = Endpoint::new(base, "m", None, 120)
                .expect_err("{base} must be refused")
                .to_string();
            assert!(err.contains(needle), "{base:?} → {err}");
        }

        let err = Endpoint::new("http://localhost:11434/v1", "  ", None, 120)
            .expect_err("a model is required")
            .to_string();
        assert!(err.contains("no model is selected"), "{err}");

        let ok = Endpoint::new("  http://localhost:11434/v1  ", " llama3.1:8b ", None, 120)
            .expect("a valid configuration");
        assert_eq!(ok.base_url.as_str(), "http://localhost:11434/v1");
        assert_eq!(ok.model, "llama3.1:8b");
        assert_eq!(ok.api_key, None);
    }

    /// A `0` must not make every request fail instantly, and a typo must not
    /// hang a turn for a day.
    #[test]
    fn the_timeout_is_clamped_at_both_ends() {
        let with = |secs| {
            Endpoint::new("http://localhost:11434/v1", "m", None, secs)
                .unwrap()
                .timeout
        };
        assert_eq!(with(0), Duration::from_secs(5));
        assert_eq!(with(120), Duration::from_secs(120));
        assert_eq!(with(u64::MAX), Duration::from_secs(3600));
    }

    /// An empty key is not a key: some gateways reject `Authorization: Bearer`
    /// with nothing after it, which is a worse failure than sending no header.
    #[test]
    fn a_blank_api_key_is_treated_as_absent() {
        for blank in ["", "   "] {
            let endpoint =
                Endpoint::new("https://openrouter.ai/api/v1", "m", Some(blank.into()), 120)
                    .unwrap();
            assert_eq!(endpoint.api_key, None, "{blank:?}");
        }
    }

    /// The fingerprint is a cache key *and* a log line. A key in it would be a
    /// key on disk.
    #[test]
    fn the_fingerprint_never_carries_the_api_key() {
        let mut endpoint = endpoint("https://openrouter.ai/api/v1");
        endpoint.api_key = Some("sk-super-secret".into());
        let fingerprint = endpoint.fingerprint();
        assert!(!fingerprint.contains("sk-super-secret"), "{fingerprint}");
        assert!(fingerprint.contains("openrouter.ai"), "{fingerprint}");
        assert!(fingerprint.contains("qwen2.5-coder:7b"), "{fingerprint}");
    }

    #[test]
    fn an_error_object_is_read_in_both_shapes() {
        assert_eq!(
            error_message(&json!({ "message": "model not found" })),
            "model not found"
        );
        assert_eq!(error_message(&json!("plain string")), "plain string");
        assert!(error_message(&json!({})).contains("no message"));
    }

    /// The client is what makes the allowlist worth anything: a followed
    /// redirect would take the connection anywhere.
    #[test]
    fn the_client_builds_and_refuses_redirects() {
        // `redirect::Policy` exposes no getter, so this asserts the builder
        // accepts the configuration; the behaviour is pinned by
        // `check_status`'s 3xx arm being reachable at all.
        assert!(client(Duration::from_secs(5)).is_ok());
    }

    /// One-shot HTTP server on loopback, for the two end-to-end tests below.
    ///
    /// Hand-rolled rather than pulled from a crate: this is ~30 lines against
    /// `tokio::net`, which is already a direct dependency with `features =
    /// ["full"]`, and adding `wiremock` or `httpmock` to the tree for it would
    /// violate the project's ask-before-you-add rule for a test double.
    ///
    /// The response deliberately carries **no** `content-length` and no
    /// `transfer-encoding`: closing the socket is what terminates it, which is
    /// how a real SSE endpoint behaves and what makes `Response::chunk`'s loop
    /// exit.
    ///
    /// Returns the base URL and a channel carrying the request head the server
    /// saw, so a test can assert on what actually went out.
    async fn spawn_server(
        status_line: &'static str,
        headers: &'static str,
        chunks: Vec<Vec<u8>>,
    ) -> (Url, tokio::sync::oneshot::Receiver<String>) {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};

        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("loopback bind");
        let port = listener.local_addr().expect("local addr").port();
        let (tx, rx) = tokio::sync::oneshot::channel();

        tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.expect("accept");
            // Read only as far as the blank line ending the head. The body
            // follows and is not needed to reply, and it is small enough that
            // leaving it unread cannot block the client's write.
            let mut head = Vec::new();
            let mut buffer = [0u8; 4096];
            while !head.windows(4).any(|window| window == b"\r\n\r\n") {
                match socket.read(&mut buffer).await.expect("read head") {
                    0 => break,
                    read => head.extend_from_slice(&buffer[..read]),
                }
            }
            let _ = tx.send(String::from_utf8_lossy(&head).into_owned());

            socket
                .write_all(format!("{status_line}\r\n{headers}\r\n").as_bytes())
                .await
                .expect("write head");
            for chunk in chunks {
                socket.write_all(&chunk).await.expect("write chunk");
                socket.flush().await.expect("flush");
                // Encourage the client to see separate reads. The decoder is
                // byte-exact either way, which is the point of testing it this
                // way rather than trusting a framing.
                tokio::task::yield_now().await;
            }
        });

        (
            Url::parse(&format!("http://127.0.0.1:{port}/v1")).expect("base URL"),
            rx,
        )
    }

    /// Chop `body` into fixed-size byte slices.
    ///
    /// Seven bytes, which is small enough to split frames, JSON tokens *and*
    /// multi-byte characters — the three boundaries a naive reader gets wrong —
    /// and fixed rather than random so a failure is reproducible.
    fn in_small_chunks(body: &str) -> Vec<Vec<u8>> {
        body.as_bytes().chunks(7).map(<[u8]>::to_vec).collect()
    }

    /// The phase's acceptance criterion, minus the manual step: a real socket,
    /// a real `reqwest` client, chunk boundaries in hostile places, and one
    /// tool call whose arguments arrive in four pieces.
    #[tokio::test]
    async fn a_streamed_completion_assembles_text_and_a_fragmented_tool_call() {
        // Deliberately includes an accented character, so a chunk boundary
        // falling inside its two bytes is part of what is being tested.
        let body = concat!(
            "data: {\"choices\":[{\"delta\":{\"role\":\"assistant\"}}]}\n\n",
            "data: {\"choices\":[{\"delta\":{\"content\":\"Revisando la \"}}]}\n\n",
            "data: {\"choices\":[{\"delta\":{\"content\":\"tabla café…\"}}]}\n\n",
            ": keepalive\n\n",
            "data: {\"choices\":[{\"delta\":{\"tool_calls\":[{\"index\":0,\"id\":\"call_9\",\
             \"type\":\"function\",\"function\":{\"name\":\"describe_table\",\
             \"arguments\":\"\"}}]}}]}\n\n",
            "data: {\"choices\":[{\"delta\":{\"tool_calls\":[{\"index\":0,\
             \"function\":{\"arguments\":\"{\\\"tab\"}}]}}]}\n\n",
            "data: {\"choices\":[{\"delta\":{\"tool_calls\":[{\"index\":0,\
             \"function\":{\"arguments\":\"le\\\": \\\"caf\"}}]}}]}\n\n",
            "data: {\"choices\":[{\"delta\":{\"tool_calls\":[{\"index\":0,\
             \"function\":{\"arguments\":\"és\\\"}\"}}]}}]}\n\n",
            "data: {\"choices\":[{\"delta\":{},\"finish_reason\":\"tool_calls\"}]}\n\n",
            "data: [DONE]\n\n",
        );
        let (base_url, head) = spawn_server(
            "HTTP/1.1 200 OK",
            "content-type: text/event-stream\r\ncache-control: no-cache\r\n",
            in_small_chunks(body),
        )
        .await;

        let endpoint = Endpoint {
            base_url,
            model: "qwen2.5-coder:7b".into(),
            api_key: Some("sk-test".into()),
            timeout: Duration::from_secs(10),
            reasoning_effort: AiReasoningEffort::Auto,
        };
        let http = client(endpoint.timeout).unwrap();
        let request = chat_body(
            &endpoint,
            vec![json!({ "role": "user", "content": "describe café" })],
            &crate::ai::tools::catalogue(DataScope::Rows),
            true,
        );

        let mut streamed = Vec::new();
        let message = stream_chat(&http, &endpoint, &request, &mut |text| {
            streamed.push(text.to_string())
        })
        .await
        .expect("the stream must assemble");

        // Text arrived incrementally and in one piece at the end.
        assert_eq!(streamed, vec!["Revisando la ", "tabla café…"]);
        assert_eq!(message.content, "Revisando la tabla café…");
        assert_eq!(message.finish_reason.as_deref(), Some("tool_calls"));

        // And the tool call survived being split four ways, accents included.
        assert_eq!(message.tool_calls.len(), 1);
        assert_eq!(message.tool_calls[0].id, "call_9");
        assert_eq!(message.tool_calls[0].name, "describe_table");
        assert_eq!(message.tool_calls[0].arguments, json!({ "table": "cafés" }));

        // What went out: the one place that adds the bearer header did, the
        // path kept the endpoint's `/v1` prefix, and the body asked to stream.
        let head = head.await.expect("the server must report the request");
        assert!(
            head.starts_with("POST /v1/chat/completions "),
            "wrong route: {head}"
        );
        assert!(head.contains("authorization: Bearer sk-test"), "{head}");
    }

    /// A 401 must arrive as a sentence about credentials, not as "the endpoint
    /// sent a frame that is not JSON" — which is what happens when a non-2xx
    /// body reaches the SSE decoder.
    #[tokio::test]
    async fn an_unauthorized_endpoint_reports_the_credentials_and_the_servers_reason() {
        let (base_url, _head) = spawn_server(
            "HTTP/1.1 401 Unauthorized",
            "content-type: application/json\r\n",
            vec![br#"{"error":{"message":"Incorrect API key provided"}}"#.to_vec()],
        )
        .await;

        let endpoint = Endpoint {
            base_url,
            model: "gpt-4o-mini".into(),
            api_key: Some("sk-wrong".into()),
            timeout: Duration::from_secs(10),
            reasoning_effort: AiReasoningEffort::Auto,
        };
        let http = client(endpoint.timeout).unwrap();
        let body = chat_body(&endpoint, vec![], &[], true);
        let err = stream_chat(&http, &endpoint, &body, &mut |_| {})
            .await
            .expect_err("a 401 must not be reported as a stream")
            .to_string();

        assert!(err.contains("credentials"), "{err}");
        assert!(err.contains("Settings"), "{err}");
        // The server's own message is the half that identifies the problem.
        assert!(err.contains("Incorrect API key provided"), "{err}");
    }

    /// `/models` is a courtesy route, and this is the shape it answers in when
    /// it does — the probe's non-fatal handling of the other case is tested in
    /// `crate::ai::probe`.
    #[tokio::test]
    async fn list_models_reads_the_ids_out_of_the_data_array() {
        let (base_url, head) = spawn_server(
            "HTTP/1.1 200 OK",
            "content-type: application/json\r\n",
            vec![
                br#"{"object":"list","data":[{"id":"llama3.1:8b"},{"id":"qwen2.5:14b"}]}"#.to_vec(),
            ],
        )
        .await;

        let endpoint = Endpoint {
            base_url,
            model: "llama3.1:8b".into(),
            api_key: None,
            timeout: Duration::from_secs(10),
            reasoning_effort: AiReasoningEffort::Auto,
        };
        let http = client(endpoint.timeout).unwrap();
        let models = list_models(&http, &endpoint).await.expect("models");
        assert_eq!(models, vec!["llama3.1:8b", "qwen2.5:14b"]);

        let head = head.await.expect("the server must report the request");
        assert!(head.starts_with("GET /v1/models "), "wrong route: {head}");
        // No key configured means no header, rather than an empty bearer that
        // some gateways reject outright.
        assert!(
            !head.to_ascii_lowercase().contains("authorization"),
            "{head}"
        );
    }
}
