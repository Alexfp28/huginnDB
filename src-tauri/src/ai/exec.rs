//! Execute one tool call the model emitted, under the gates that make the
//! feature's promises true.
//!
//! Seven steps, in this order:
//!
//! 1. resolve the connection reference — an id **or** a name, like the MCP
//!    connector's `canonical_connection` — among the connections the user has
//!    enabled for the assistant,
//! 2. resolve the [`DataScope`] from the endpoint's declared trust and that
//!    connection's own `ai_rows_allowed`,
//! 3. look the tool up *in the catalogue that scope offers*,
//! 4. resolve the MongoDB per-database target, if the call named one,
//! 5. build the [`BridgeRequest`] and refuse a `run_query` that is not a read,
//! 6. re-check the connection's write policy through
//!    [`crate::bridge::server::check_policy`],
//! 7. run it through [`crate::bridge::exec::execute`] with a [`LogSink`], then
//!    cap the reply's rows, strip the fields a model has no use for, and bound
//!    what is left by *size* — see [`MAX_TOOL_RESULT_CHARS`] for the failure
//!    that last step exists for.
//!
//! # Where the tests are
//!
//! [`execute`] itself has none, and that is deliberate rather than an
//! omission: it needs an [`AppState`], whose construction reads the real
//! `profiles.json` / `tab_state.json`, and [`crate::bridge::server::check_policy`]
//! reads `profiles.json` from disk on every call — gotcha #52 is explicit that
//! a test which reaches either is a test whose answer depends on the
//! developer's own saved connections. So every *decision* [`execute`] makes is
//! a free function over plain arguments ([`resolve_connection`],
//! [`refuse_unless_read`], [`effective_row_cap`], [`cap_rows`], and
//! `tools::available` / `tools::to_request` next door), and those are what the
//! suite pins. What is left in [`execute`] is the order they run in.
//!
//! # Two things this deliberately does not do
//!
//! * **It does not connect.** A reference that resolves to a profile with no
//!   live pool fails with [`crate::error::AppError::NotConnected`], rather than
//!   opening one from the keychain the way the headless connector does. The
//!   assistant works on connections the user has open; an AI panel that could
//!   dial out to a server nobody had opened this session is a different
//!   feature, and a worse one to have arrived by accident.
//! * **It does not write.** No write variant is in the catalogue (D4) and
//!   `run_query`'s free text is classified before it runs. See
//!   [`refuse_unless_read`].

use crate::ai::scope::{DataScope, EndpointTrust};
use crate::ai::tools::{self, ToolCtx};
use crate::bridge::protocol::BridgeRequest;
use crate::db::sql::StmtClass;
use crate::error::{AppError, AppResult};
use crate::log_bus::LogSink;
use crate::state::{AppState, ConnectionProfile};
use serde_json::Value;

/// Hard ceiling on the rows one tool reply may carry, whatever the user's
/// preference says.
///
/// The same number the MCP connector defaults `--max-rows` to. It is not the
/// operative cap here — [`DEFAULT_MAX_CONTEXT_ROWS`] is, and it is twenty times
/// smaller — but it bounds a hand-edited `prefs.json` that asks for a million.
pub const MAX_TOOL_ROWS: i64 = 1000;

/// Characters one tool reply may put in the model's context.
///
/// **The cap that actually matters, and the one this code was missing.** A row
/// count is a proxy for size and a poor one: fifty rows of a two-column lookup
/// table is nothing, and fifty rows of a configuration table whose values are
/// JSON blobs is several thousand tokens. The first real agent turn against a
/// wide table proved it — the reply filled the context, Ollama truncated *from
/// the front* (which is where the system prompt and the user's question live),
/// and the model answered a question it could no longer see, in English,
/// having been handed nothing but rows.
///
/// Four thousand characters is roughly a thousand tokens: a quarter of a
/// default 4096-token window, which leaves room for the prompt, the question
/// and the history to survive alongside it. It is deliberately not derived
/// from `max_context_rows` — that preference bounds how many rows a *user*
/// wants to see reach the model, and this bounds what the model can physically
/// hold. Both apply; whichever bites first wins.
pub const MAX_TOOL_RESULT_CHARS: usize = 4000;

/// Rows one tool reply may put in the model's context, by default.
///
/// Much tighter than the MCP connector's 1000, because the budget is different
/// in kind: an MCP client's cap protects a *transcript* a person scrolls, and
/// this one protects a context window that a 4B model has very little of, pays
/// for on every subsequent turn, and gets measurably worse at reasoning over as
/// it fills.
pub const DEFAULT_MAX_CONTEXT_ROWS: i64 = 50;

/// The refusal a write statement gets, verbatim.
///
/// A constant because it is asserted by a test *and* read by a model: this
/// string is the entire mechanism by which the assistant learns that its job on
/// a mutation is to propose, not to run. Vague wording here shows up as a model
/// retrying the same `UPDATE` three times.
pub const PROPOSE_INSTEAD: &str =
    "this tool runs read-only statements, and the assistant never writes. Do not retry: \
     present the statement to the user as a proposal instead — they run it themselves from \
     the editor.";

/// The configuration that comes from `prefs.json` rather than from the
/// connection. Phase 3 builds this from `AiPrefs`.
#[derive(Debug, Clone, Copy)]
pub struct AiRuntime {
    /// How much the user has declared the configured inference endpoint may be
    /// trusted with data. See [`EndpointTrust`] — declared, never sniffed.
    pub endpoint_trust: EndpointTrust,
    /// The user's context-row cap, before [`effective_row_cap`] bounds it.
    pub max_context_rows: i64,
}

impl Default for AiRuntime {
    fn default() -> Self {
        Self {
            endpoint_trust: EndpointTrust::default(),
            max_context_rows: DEFAULT_MAX_CONTEXT_ROWS,
        }
    }
}

/// One tool call, as it arrived from the model.
#[derive(Debug, Clone, Copy)]
pub struct AiCall<'a> {
    /// A connection id or name, as the model wrote it.
    pub connection: &'a str,
    /// The tool name.
    pub tool: &'a str,
    /// The tool's arguments, already parsed out of the model's (possibly
    /// fragmented) JSON by the provider layer.
    pub args: &'a Value,
}

/// Run one tool call. See the module docs for the order of the gates.
pub async fn execute(
    state: &AppState,
    sink: &dyn LogSink,
    runtime: AiRuntime,
    call: &AiCall<'_>,
) -> AppResult<Value> {
    // One lock, and nothing awaited inside it.
    let (policy_id, rows_allowed) = {
        let profiles = state.profiles.read();
        let id = resolve_connection(call.connection, &profiles)?;
        let rows_allowed = profiles
            .iter()
            .find(|p| p.id == id)
            .is_some_and(|p| p.ai_rows_allowed);
        (id, rows_allowed)
    };

    let scope = DataScope::resolve(runtime.endpoint_trust, rows_allowed);
    let spec = tools::available(call.tool, scope)?;
    let max_rows = effective_row_cap(runtime.max_context_rows);

    let request = tools::to_request(
        spec,
        call.args,
        &ToolCtx {
            connection_id: resolve_target(state, &policy_id, call.args).await?,
            policy_id: policy_id.clone(),
            max_context_rows: max_rows,
        },
    )?;

    // Before the policy gate, not after, and the order is the point: on this
    // surface the answer to a write is *always* "propose it", so deriving the
    // refusal from `mcp_write` would make the message the model reads depend on
    // a setting that has nothing to do with why it was refused. The policy gate
    // below still runs — it is what stops a read tool reaching a connection the
    // user has locked down for other reasons.
    if let BridgeRequest::RunStatement { sql, .. } = &request {
        refuse_unless_read(sql)?;
    }
    crate::bridge::server::check_policy(state, &request)?;

    let mut value = crate::bridge::exec::execute(state, sink, &request).await?;
    cap_rows(&mut value, max_rows);
    compact_result(&mut value);
    fit_to_budget(&mut value, MAX_TOOL_RESULT_CHARS);
    Ok(value)
}

/// Strip the fields of a `QueryResult` a model has no use for.
///
/// Three of them, and one is genuinely large: `row_types` is MongoDB's
/// per-*cell* BSON type tree, mirroring `rows` entry for entry, which doubles
/// the payload to tell a model something `columns` already implies. `elapsed_ms`
/// and `rows_affected` are facts about the *read*, not about the data, and a
/// model shown them tends to report them as though they were the answer.
///
/// `columns` stays: a model that cannot see the column names cannot describe
/// the rows underneath them.
pub fn compact_result(value: &mut Value) {
    let Some(object) = value.as_object_mut() else {
        return;
    };
    if !object.contains_key("rows") {
        return;
    }
    for noise in ["row_types", "elapsed_ms", "rows_affected"] {
        object.remove(noise);
    }
}

/// Trim `value` until its serialised form fits `max_chars`.
///
/// Returns whether anything was dropped. Halves the row count rather than
/// removing one row at a time: a payload twenty times over budget would
/// otherwise cost twenty serialisations to find that out.
///
/// The `note` it leaves behind is not decoration. A model handed a silently
/// shortened result describes it as the whole table — the cap has to be
/// *legible* to the thing reading it, exactly as the truncation marker in
/// `crate::ai::tasks`'s sections is.
pub fn fit_to_budget(value: &mut Value, max_chars: usize) -> bool {
    if serialised_len(value) <= max_chars {
        return false;
    }

    // A row-shaped reply: drop rows until it fits.
    if let Some(rows) = value
        .as_object()
        .and_then(|o| o.get("rows"))
        .and_then(Value::as_array)
        .map(Vec::len)
    {
        let mut keep = rows;
        while keep > 0 && serialised_len(value) > max_chars {
            keep /= 2;
            if let Some(Value::Array(items)) = value.as_object_mut().and_then(|o| o.get_mut("rows"))
            {
                items.truncate(keep);
            }
        }
        if let Some(object) = value.as_object_mut() {
            object.insert("truncated".into(), Value::Bool(true));
            object.insert(
                "note".into(),
                Value::String(format!(
                    "Only {keep} of the {rows} rows read are shown here; the rest did not                      fit. Say so rather than describing this as the whole table."
                )),
            );
        }
        return true;
    }

    // A bare list — `list_tables` on a server with thousands of them.
    if let Some(items) = value.as_array().map(Vec::len) {
        let mut keep = items;
        while keep > 0 && serialised_len(value) > max_chars {
            keep /= 2;
            if let Value::Array(list) = value {
                list.truncate(keep);
            }
        }
        if let Value::Array(list) = value {
            list.push(Value::String(format!(
                "… {keep} of {items} shown; the rest did not fit."
            )));
        }
        return true;
    }

    // Anything else — a very long `EXPLAIN`, a view body. Keep the prefix and
    // say what happened, which beats handing back nothing.
    let text = value.to_string();
    let cut = text
        .char_indices()
        .nth(max_chars)
        .map(|(i, _)| i)
        .unwrap_or(text.len());
    *value = Value::String(format!(
        "{}… (truncated: this result did not fit the context budget)",
        &text[..cut]
    ));
    true
}

fn serialised_len(value: &Value) -> usize {
    serde_json::to_string(value).map(|s| s.len()).unwrap_or(0)
}

/// Resolve a model-supplied connection reference — a profile **id or name** —
/// to the canonical id, among the connections the user has enabled for the
/// assistant.
///
/// Names are accepted for the same reason the MCP connector accepts them: the
/// id is a uuid the user never chose, and asking a model to copy one across
/// every call only invites it to get a character wrong. The id stays the
/// identity, so an id always beats a name that happens to equal it, and an
/// ambiguous name is an error naming the candidates rather than a guess.
///
/// Resolution is scoped to `ai_enabled` profiles **throughout**, which is the
/// half that matters here: a name must not be able to reach a connection the
/// user has not enabled, and a reference naming a real but disabled one is told
/// exactly that, with the fix, instead of "unknown connection".
pub fn resolve_connection(reference: &str, profiles: &[ConnectionProfile]) -> AppResult<String> {
    let reference = reference.trim();
    if reference.is_empty() {
        return Err(AppError::InvalidInput(
            "a connection is required: pass the name or id of one of the connections listed for \
             this conversation"
                .into(),
        ));
    }

    let enabled: Vec<&ConnectionProfile> = profiles.iter().filter(|p| p.ai_enabled).collect();
    if let Some(p) = enabled.iter().find(|p| p.id == reference) {
        return Ok(p.id.clone());
    }
    let by_name: Vec<&&ConnectionProfile> = enabled
        .iter()
        .filter(|p| p.name.eq_ignore_ascii_case(reference))
        .collect();
    match by_name.as_slice() {
        [one] => return Ok(one.id.clone()),
        [] => {}
        many => {
            let candidates = many
                .iter()
                .map(|p| format!("{:?} (id {}, host {})", p.name, p.id, p.host))
                .collect::<Vec<_>>()
                .join("; ");
            return Err(AppError::InvalidInput(format!(
                "{reference:?} matches {} connections — pass the id instead: {candidates}",
                many.len()
            )));
        }
    }

    // Known but not enabled is a different problem with a different fix, and by
    // far the likelier of the two.
    if let Some(p) = profiles
        .iter()
        .find(|p| p.id == reference || p.name.eq_ignore_ascii_case(reference))
    {
        return Err(AppError::InvalidInput(format!(
            "connection {:?} exists but is not enabled for the AI panel — tick it in \
             Settings → AI (id {})",
            p.name, p.id
        )));
    }
    Err(AppError::NotFound(format!(
        "no connection named {reference:?}"
    )))
}

/// The one place this surface decides a statement is a read.
///
/// Deliberately delegates to [`crate::db::classify::classify_statement`] rather
/// than asking whether the text "looks like a SELECT": that function is the
/// single source of truth for a statement's tier across every driver, and it is
/// driver-aware — the SQL keyword heuristic alone calls `db.users.find({})` a
/// write, which would refuse a MongoDB connection its own reads (see gotcha
/// #54).
pub fn refuse_unless_read(sql: &str) -> AppResult<()> {
    match crate::db::classify::classify_statement(sql) {
        StmtClass::Read => Ok(()),
        _ => Err(AppError::InvalidInput(PROPOSE_INSTEAD.to_string())),
    }
}

/// The row cap actually applied: the user's preference, bounded below by 1 and
/// above by [`MAX_TOOL_ROWS`].
pub fn effective_row_cap(max_context_rows: i64) -> i64 {
    max_context_rows.clamp(1, MAX_TOOL_ROWS)
}

/// Trim a `QueryResult`-shaped reply to at most `max` rows, in place.
///
/// Returns whether anything was dropped. Three details are load-bearing:
///
/// * `row_types` is row-aligned (MongoDB's per-cell BSON types), so it is
///   truncated with `rows` or the two desynchronise and a value comes back
///   typed as its neighbour's type.
/// * `rows_affected` is left alone. It is what the engine reported; the reply
///   carries fewer rows than that, which is the honest shape — the same choice
///   the connector's `truncate_rows` makes.
/// * `truncated` is set, because the field already exists for exactly this and
///   a model that cannot tell "3 rows" from "3 of 40,000 rows" will happily
///   conclude the table is small.
pub fn cap_rows(value: &mut Value, max: i64) -> bool {
    let max = max.max(0) as usize;
    let Some(object) = value.as_object_mut() else {
        return false;
    };
    let too_long = object
        .get("rows")
        .and_then(Value::as_array)
        .is_some_and(|rows| rows.len() > max);
    if !too_long {
        return false;
    }
    for key in ["rows", "row_types"] {
        if let Some(Value::Array(items)) = object.get_mut(key) {
            items.truncate(max);
        }
    }
    object.insert("truncated".into(), Value::Bool(true));
    true
}

/// Which connection id the call actually addresses.
///
/// For every driver but MongoDB this is `id` unchanged — `schema` only ever
/// meant a SQL namespace inside the already-connected database. A MongoDB
/// connection may have no database bound at all, and the app's own gesture for
/// that is a synthetic per-database pool over the *same* client
/// (`open_database_view`); a model has no gesture, so the tool's `schema` (or
/// `run_query`'s `database`) is its only way to say which database it means.
/// Both keys are read here so the tools keep the argument names the MCP
/// connector already uses for the same job.
async fn resolve_target(state: &AppState, id: &str, args: &Value) -> AppResult<String> {
    let database = args
        .get("schema")
        .or_else(|| args.get("database"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|database| !database.is_empty());
    let Some(database) = database else {
        return Ok(id.to_string());
    };
    // Guard dropped before the await below.
    let is_mongo = matches!(
        state.connections.read().get(id),
        Some(crate::state::DbPool::Mongo(_))
    );
    if !is_mongo {
        return Ok(id.to_string());
    }
    crate::commands::connection::resolve_mongo_database_view(state, id, database).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testkit;
    use serde_json::json;

    fn enabled(id: &str, name: &str) -> ConnectionProfile {
        ConnectionProfile {
            name: name.into(),
            ai_enabled: true,
            ..testkit::profile(id)
        }
    }

    #[test]
    fn a_reference_resolves_by_id_or_by_name() {
        let profiles = vec![enabled("id-1", "Bonfire"), enabled("id-2", "Producción")];
        assert_eq!(resolve_connection("id-2", &profiles).unwrap(), "id-2");
        assert_eq!(resolve_connection("Bonfire", &profiles).unwrap(), "id-1");
        // Case-insensitive, and surrounding whitespace is the model's, not the
        // user's.
        assert_eq!(resolve_connection("  bonfire ", &profiles).unwrap(), "id-1");
    }

    /// The id is the identity. A profile *named* after another profile's id
    /// must not shadow it, or a rename silently repoints every saved reference.
    #[test]
    fn an_id_beats_a_name_that_equals_it() {
        let profiles = vec![enabled("id-1", "Bonfire"), enabled("id-2", "id-1")];
        assert_eq!(resolve_connection("id-1", &profiles).unwrap(), "id-1");
    }

    #[test]
    fn an_ambiguous_name_names_the_candidates_instead_of_guessing() {
        let profiles = vec![enabled("id-1", "Bonfire"), enabled("id-2", "bonfire")];
        let err = resolve_connection("Bonfire", &profiles)
            .expect_err("two matches cannot resolve")
            .to_string();
        assert!(err.contains("id-1") && err.contains("id-2"), "{err}");
    }

    /// The phase-1 acceptance criterion: naming a disabled connection
    /// *correctly* must still not reach it — by id or by name — and the message
    /// has to say why, because "unknown connection" would send the user looking
    /// for a typo that isn't there.
    #[test]
    fn a_connection_that_is_not_ai_enabled_is_unreachable() {
        let profiles = vec![ConnectionProfile {
            name: "Producción".into(),
            ai_enabled: false,
            ..testkit::profile("id-1")
        }];
        for reference in ["id-1", "Producción", "producción"] {
            let err = resolve_connection(reference, &profiles)
                .expect_err("a disabled connection must not resolve")
                .to_string();
            assert!(err.contains("not enabled"), "{reference}: {err}");
            assert!(err.contains("Settings"), "{reference}: {err}");
        }
    }

    /// Off by default, so a profile written before these fields existed cannot
    /// come back reachable.
    #[test]
    fn the_flags_default_to_off() {
        let profile = testkit::profile("id-1");
        assert!(!profile.ai_enabled);
        assert!(!profile.ai_rows_allowed);
        assert!(resolve_connection("id-1", &[profile]).is_err());
    }

    #[test]
    fn an_empty_reference_says_what_to_pass() {
        let err = resolve_connection("   ", &[enabled("id-1", "Bonfire")])
            .expect_err("an empty reference cannot resolve")
            .to_string();
        assert!(err.contains("connection is required"), "{err}");
    }

    #[test]
    fn an_unknown_reference_is_not_found() {
        let err = resolve_connection("nope", &[enabled("id-1", "Bonfire")]).expect_err("unknown");
        assert!(matches!(err, AppError::NotFound(_)), "{err}");
    }

    /// Writes are refused in *both* grammars, and the refusal tells the model
    /// what to do instead. A message that only said "refused" is what produces
    /// three retries of the same `UPDATE`.
    #[test]
    fn a_write_statement_is_refused_and_told_to_propose_instead() {
        let writes = [
            "UPDATE users SET name = 'x' WHERE id = 1",
            "DELETE FROM users",
            "DROP TABLE users",
            "TRUNCATE users",
            "db.users.insertOne({a: 1})",
            "db.users.drop()",
            // T-SQL: opaque, so classified at the strictest tier.
            "EXEC sp_rename 'a', 'b'",
            // Starts with SELECT, creates a table.
            "SELECT * INTO backup FROM users",
        ];
        for sql in writes {
            let err = refuse_unless_read(sql)
                .expect_err("a write must be refused")
                .to_string();
            assert!(err.contains("never writes"), "{sql}: {err}");
            assert!(err.contains("proposal"), "{sql}: {err}");
        }
    }

    #[test]
    fn reads_are_allowed_in_both_grammars() {
        for sql in [
            "SELECT 1",
            "WITH t AS (SELECT 1) SELECT * FROM t",
            "SHOW TABLES",
            "db.users.find({})",
            "db.users.aggregate([{$match: {a: 1}}])",
        ] {
            refuse_unless_read(sql).unwrap_or_else(|e| panic!("{sql} should be a read: {e}"));
        }
    }

    #[test]
    fn the_row_cap_is_bounded_at_both_ends() {
        assert_eq!(effective_row_cap(50), 50);
        assert_eq!(effective_row_cap(0), 1);
        assert_eq!(effective_row_cap(-7), 1);
        assert_eq!(effective_row_cap(1_000_000), MAX_TOOL_ROWS);
        assert_eq!(
            effective_row_cap(AiRuntime::default().max_context_rows),
            DEFAULT_MAX_CONTEXT_ROWS
        );
    }

    #[test]
    fn capping_trims_rows_and_their_types_together() {
        let mut value = json!({
            "columns": [{ "name": "a" }],
            "rows": [[1], [2], [3], [4]],
            "row_types": [["int"], ["int"], ["int"], ["int"]],
            "rows_affected": 4,
            "elapsed_ms": 1,
            "truncated": false
        });
        assert!(cap_rows(&mut value, 2));
        assert_eq!(value["rows"].as_array().unwrap().len(), 2);
        // Row-aligned, so a desync here would retype a value as its
        // neighbour's type.
        assert_eq!(value["row_types"].as_array().unwrap().len(), 2);
        assert_eq!(value["truncated"], json!(true));
        // Left as the engine reported it — the reply carries fewer rows than
        // this, which is the honest shape.
        assert_eq!(value["rows_affected"], json!(4));
    }

    #[test]
    fn capping_leaves_a_short_reply_untouched() {
        let mut value = json!({ "rows": [[1]], "truncated": false });
        assert!(!cap_rows(&mut value, 50));
        assert_eq!(value["rows"].as_array().unwrap().len(), 1);
        assert_eq!(value["truncated"], json!(false));
    }

    /// The bug the first real agent turn produced: fifty rows of a wide table
    /// filled the context, the server truncated from the front — where the
    /// system prompt and the question live — and the model answered something
    /// it could no longer see.
    #[test]
    fn a_reply_over_the_character_budget_is_trimmed_and_says_so() {
        let wide: Vec<Value> = (0..50)
            .map(|i| json!([i, "x".repeat(400), "y".repeat(400)]))
            .collect();
        let mut value = json!({
            "columns": [{ "name": "id" }, { "name": "a" }, { "name": "b" }],
            "rows": wide,
        });
        assert!(fit_to_budget(&mut value, MAX_TOOL_RESULT_CHARS));

        let len = serde_json::to_string(&value).unwrap().len();
        assert!(len <= MAX_TOOL_RESULT_CHARS, "still {len} chars");
        assert_eq!(value["truncated"], json!(true));
        // Legible to the *model*, not only to us: one handed a silently
        // shortened result describes it as the whole table.
        let note = value["note"].as_str().unwrap();
        assert!(note.contains("of the 50 rows"), "{note}");
        assert!(note.contains("rather than describing this as the whole table"));
        // The columns survive — a model that cannot name them cannot describe
        // the rows underneath.
        assert!(value["columns"].is_array());
    }

    #[test]
    fn a_reply_within_the_budget_is_left_exactly_as_it_was() {
        let mut value = json!({ "columns": [], "rows": [[1], [2]] });
        let before = value.clone();
        assert!(!fit_to_budget(&mut value, MAX_TOOL_RESULT_CHARS));
        assert_eq!(value, before);
    }

    /// `list_tables` on a server with thousands of them.
    #[test]
    fn a_long_bare_list_is_trimmed_with_a_count_appended() {
        let mut value = Value::Array(
            (0..2000)
                .map(|i| Value::String(format!("table_number_{i}")))
                .collect(),
        );
        assert!(fit_to_budget(&mut value, 500));
        let items = value.as_array().unwrap();
        assert!(serde_json::to_string(&value).unwrap().len() <= 700);
        assert!(items
            .last()
            .unwrap()
            .as_str()
            .unwrap()
            .contains("of 2000 shown"));
    }

    /// A shape with neither rows nor items — a very long `EXPLAIN`, a view
    /// body. Handing back a prefix beats handing back nothing.
    #[test]
    fn an_unshaped_oversized_reply_keeps_its_prefix() {
        let mut value = json!({ "plan": "Seq Scan ".repeat(2000) });
        assert!(fit_to_budget(&mut value, 300));
        let text = value.as_str().expect("collapsed to a string");
        assert!(text.starts_with("{\"plan\":\"Seq Scan "));
        assert!(text.contains("did not fit the context budget"));
    }

    /// `row_types` mirrors `rows` cell for cell, so leaving it in doubles the
    /// payload to say what `columns` already implies — and the two timing
    /// fields get reported by a model as though they were the answer.
    #[test]
    fn compacting_drops_the_fields_a_model_has_no_use_for() {
        let mut value = json!({
            "columns": [{ "name": "id", "data_type": "int" }],
            "rows": [[1]],
            "row_types": [["int"]],
            "elapsed_ms": 12,
            "rows_affected": 1,
            "total": 900,
        });
        compact_result(&mut value);
        assert!(value.get("row_types").is_none());
        assert!(value.get("elapsed_ms").is_none());
        assert!(value.get("rows_affected").is_none());
        // Kept: the names the rows are described by, and the table's real size.
        assert!(value.get("columns").is_some());
        assert_eq!(value["total"], json!(900));
    }

    #[test]
    fn compacting_leaves_a_metadata_reply_alone() {
        let mut value = json!({ "version": "8.0.36", "elapsed_ms": 3 });
        compact_result(&mut value);
        // No `rows`, so this is not a result set and its fields are its own.
        assert_eq!(value["elapsed_ms"], json!(3));
    }

    /// Every metadata reply is a different shape — a list of tables, a version
    /// string, an `EXPLAIN` plan — and none of them has `rows`. Capping must be
    /// a no-op on all of them rather than something the caller has to know when
    /// to skip.
    #[test]
    fn capping_is_a_no_op_on_a_reply_that_has_no_rows() {
        for mut value in [
            json!({ "version": "PostgreSQL 16.2" }),
            json!(["users", "orders"]),
            json!(null),
        ] {
            assert!(!cap_rows(&mut value, 1));
        }
    }
}
