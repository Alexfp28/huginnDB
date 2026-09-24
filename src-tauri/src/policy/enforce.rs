//! Policy applied to what an AI asks for: every [`BridgeRequest`] mapped onto
//! what it needs, and the discovery results filtered to what the AI may see.

use super::resolve::{Ctx, Need};
use super::{current_user, PolicyState};
use crate::bridge::protocol::BridgeRequest;
use crate::commands::schema::{DatabaseInfo, TableInfo};
use crate::db::sql::Verbs;
use crate::error::{AppError, AppResult};
use crate::state::{AppState, ConnectionProfile};
use serde::Serialize;
use std::sync::Arc;

/// What an AI request needs, variant by variant.
///
/// Exhaustive, with **no `_` arm** (gotchas #49, #71): a new `BridgeRequest`
/// cannot be added without saying what policy it needs, because the failure
/// mode of a default is an AI reaching a relation its user's role hides.
fn needs_of(request: &BridgeRequest) -> Vec<Need> {
    use BridgeRequest::*;
    let rel = |schema: &Option<String>, name: &str, verbs: Verbs| Need::Relation {
        schema: schema.clone(),
        name: name.to_string(),
        verbs,
    };
    match request {
        // Opening the pool, and the plumbing that only answers about it.
        EnsureConnected { .. } | IsMongo { .. } | ServerVersion { .. } => vec![Need::Endpoint],
        ResolveMongoTarget { database, .. } => vec![Need::Database(database.clone())],
        // Discovery is allowed and *filtered* ([`filter_databases`],
        // [`filter_tables`]), so the AI never learns a hidden relation's name.
        ListDatabases { .. } | ListTables { .. } => vec![Need::Endpoint],
        GetTableStructure { schema, table, .. } | ListIndexes { schema, table, .. } => {
            vec![rel(schema, table, Verbs::SELECT)]
        }
        GetViewDefinition { schema, view, .. } => vec![rel(schema, view, Verbs::SELECT)],
        FetchTableData { schema, table, .. } => vec![rel(schema, table, Verbs::SELECT)],
        InsertRow { schema, table, .. } => vec![rel(schema, table, Verbs::INSERT)],
        UpdateCell { schema, table, .. } => vec![rel(schema, table, Verbs::UPDATE)],
        DeleteRows { schema, table, .. } => vec![rel(schema, table, Verbs::DELETE)],
        // Free text: its verbs are whatever the classifier finds in it, and a
        // scoped rule refuses it whatever they are (D3).
        RunStatement { sql, .. } => vec![Need::FreeSql(crate::db::classify::verbs_of(sql))],
        // Other people's statements, the server's sessions, its accounts.
        ListUsers { .. }
        | ListPrivileges { .. }
        | PulseHealth { .. }
        | PulseMetrics { .. }
        | PulseTopQueries { .. }
        | PulseStorage { .. }
        | PulseSessions { .. }
        | PulseIndexUsage { .. } => vec![Need::Monitor],
        // A plan is read from text the AI supplies, so it is free SQL too.
        PulseExplain { sample, .. } => vec![
            Need::Monitor,
            Need::FreeSql(crate::db::classify::verbs_of(sample)),
        ],
        // A dry run executes nothing, but names the view it would change.
        PreviewViewChange { schema, name, .. } => vec![rel(schema, name, Verbs::SELECT)],
        ApplyViewChange {
            schema,
            name,
            rename_from,
            ..
        } => {
            let mut needs = vec![rel(schema, name, Verbs::DDL)];
            if let Some(old) = rename_from {
                needs.push(rel(schema, old, Verbs::DDL));
            }
            needs
        }
        DropView { schema, view, .. } => vec![rel(schema, view, Verbs::DDL)],
        CreateMongoIndex { collection, .. } | DropMongoIndex { collection, .. } => {
            vec![rel(&None, collection, Verbs::DDL)]
        }
    }
}

/// The profile behind a connection id — a per-database view folds to its
/// parent — read from disk first, as `bridge::server::check_policy` does, so
/// the sidecar sees a profile edited in the app since it started.
fn profile_for(state: &AppState, connection_id: &str) -> Option<ConnectionProfile> {
    let root = crate::state::parent_connection_id(connection_id);
    crate::store::load_profiles()
        .ok()
        .and_then(|ps| ps.into_iter().find(|p| p.id == root))
        .or_else(|| state.profiles.read().iter().find(|p| p.id == root).cloned())
}

/// The database a request is addressed to: the `::db::` part of a
/// per-database view, else the profile's own, if it names one.
fn database_of<'a>(
    connection_id: &'a str,
    profile: Option<&'a ConnectionProfile>,
) -> Option<&'a str> {
    crate::state::split_database_view(connection_id)
        .map(|(_, db)| db)
        .or_else(|| {
            profile
                .map(|p| p.database.as_str())
                .filter(|db| !db.is_empty())
        })
}

/// The active document, or `Ok(None)` when the machine is unmanaged, or the
/// refusal when the policy is pending or broken — which blocks every AI
/// request, since which endpoints it would have governed is unknowable.
fn active(state: &AppState) -> AppResult<Option<Arc<super::model::PolicyDoc>>> {
    match &*state.policy.read() {
        PolicyState::Unmanaged => Ok(None),
        PolicyState::Active { doc, .. } => Ok(Some(doc.clone())),
        PolicyState::Pending { source } => Err(AppError::InvalidInput(format!(
            "your organization's HuginnDB policy is still being read from {source}; the AI is \
             paused until it is. Try again in a moment."
        ))),
        PolicyState::Broken { source, error } => Err(AppError::InvalidInput(format!(
            "your organization's HuginnDB policy could not be applied, so the AI is blocked \
             ({source}: {error}). Ask your administrator to fix it."
        ))),
    }
}

/// Refuse `request` unless the policy lets the AI make it. Called at the top
/// of `bridge::exec::execute`, and for `EnsureConnected` where that is
/// intercepted before it.
pub fn enforce(state: &AppState, request: &BridgeRequest) -> AppResult<()> {
    let Some(doc) = active(state)? else {
        return Ok(());
    };
    let connection_id = crate::bridge::server::connection_id_of(request);
    let profile = profile_for(state, &connection_id);
    let ctx = Ctx {
        doc: &doc,
        user: current_user(),
        profile: profile.as_ref(),
        database: database_of(&connection_id, profile.as_ref()),
    };
    for need in needs_of(request) {
        ctx.decide(&need).map_err(AppError::InvalidInput)?;
    }
    Ok(())
}

/// Run `f` against the policy context for `connection_id`, or return `unmanaged`
/// when there is no active policy.
fn with_ctx<T>(
    state: &AppState,
    connection_id: &str,
    unmanaged: T,
    f: impl FnOnce(&Ctx<'_>) -> T,
) -> T {
    let Ok(Some(doc)) = active(state) else {
        return unmanaged;
    };
    let profile = profile_for(state, connection_id);
    let ctx = Ctx {
        doc: &doc,
        user: current_user(),
        profile: profile.as_ref(),
        database: database_of(connection_id, profile.as_ref()),
    };
    f(&ctx)
}

/// The databases the AI may see.
pub fn filter_databases(
    state: &AppState,
    connection_id: &str,
    databases: Vec<DatabaseInfo>,
) -> Vec<DatabaseInfo> {
    let keep: Option<Vec<bool>> = with_ctx(state, connection_id, None, |ctx| {
        Some(
            databases
                .iter()
                .map(|d| ctx.database_visible(&d.name))
                .collect(),
        )
    });
    retain_marked(databases, keep)
}

/// `items` without the ones `keep` marks false; all of them when there is no
/// policy to filter by.
fn retain_marked<T>(items: Vec<T>, keep: Option<Vec<bool>>) -> Vec<T> {
    match keep {
        None => items,
        Some(keep) => items
            .into_iter()
            .zip(keep)
            .filter_map(|(item, k)| k.then_some(item))
            .collect(),
    }
}

/// The tables and views the AI may see.
pub fn filter_tables(
    state: &AppState,
    connection_id: &str,
    tables: Vec<TableInfo>,
) -> Vec<TableInfo> {
    let keep: Option<Vec<bool>> = with_ctx(state, connection_id, None, |ctx| {
        Some(
            tables
                .iter()
                .map(|t| {
                    let schema = (!t.schema.is_empty()).then_some(t.schema.as_str());
                    ctx.relation_visible(schema, &t.name)
                })
                .collect(),
        )
    });
    retain_marked(tables, keep)
}

/// Whether free SQL is withheld from the AI on this connection, so the AI
/// panel can leave `run_query` out of its catalogue instead of offering a tool
/// that always refuses (gotcha #74: absence beats present-but-refused). Over
/// MCP the tool list cannot vary per connection (gotchas #58, #59), so there
/// the call is refused instead.
pub fn free_sql_blocked(state: &AppState, connection_id: &str) -> bool {
    match active(state) {
        Err(_) => true,
        Ok(None) => false,
        Ok(Some(_)) => with_ctx(state, connection_id, false, |ctx| ctx.free_sql_blocked()),
    }
}

/// Whether the AI may reach this connection at all — what the MCP
/// `list_connections` tool filters by, so a model is not shown connections it
/// will be refused on.
// Used by the MCP `list_connections` tool only, which the `mcp` feature gates.
#[cfg_attr(not(feature = "mcp"), allow(dead_code))]
pub fn reachable_by_ai(state: &AppState, profile: &ConnectionProfile) -> bool {
    match active(state) {
        Err(_) => false,
        Ok(None) => true,
        Ok(Some(doc)) => Ctx {
            doc: &doc,
            user: current_user(),
            profile: Some(profile),
            database: None,
        }
        .decide(&Need::Endpoint)
        .is_ok(),
    }
}

/// What Settings → Policy shows: where the policy came from, who this is, and
/// what each connection allows.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PolicyStatus {
    /// `unmanaged` / `pending` / `active` / `broken`.
    pub state: &'static str,
    pub source: Option<String>,
    pub error: Option<String>,
    pub warnings: Vec<String>,
    pub user: String,
    pub role: Option<String>,
    pub unmanaged_connections: Option<&'static str>,
    pub connections: Vec<ConnectionPolicy>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionPolicy {
    pub id: String,
    pub name: String,
    /// No rule of the role names this connection.
    pub unmatched: bool,
    /// When unmatched: whether the policy leaves it alone (`allow`) or not.
    pub left_alone: bool,
    pub rules: Vec<RulePolicy>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RulePolicy {
    pub databases: Option<Vec<String>>,
    pub allow: Option<Vec<String>>,
    pub deny: Vec<String>,
    pub human: Vec<&'static str>,
    /// What the AI effectively gets: `ai ∩ human`.
    pub ai: Vec<&'static str>,
    /// Whether free SQL is available to the AI under this rule.
    pub free_sql: bool,
}

pub fn status(state: &AppState) -> PolicyStatus {
    let user = current_user().to_string();
    let (state_label, source, error, warnings, doc) = match &*state.policy.read() {
        PolicyState::Unmanaged => ("unmanaged", None, None, Vec::new(), None),
        PolicyState::Pending { source } => {
            ("pending", Some(source.clone()), None, Vec::new(), None)
        }
        PolicyState::Broken { source, error } => (
            "broken",
            Some(source.clone()),
            Some(error.clone()),
            Vec::new(),
            None,
        ),
        PolicyState::Active {
            doc,
            source,
            warnings,
        } => (
            "active",
            Some(source.clone()),
            None,
            warnings.clone(),
            Some(doc.clone()),
        ),
    };
    let Some(doc) = doc else {
        return PolicyStatus {
            state: state_label,
            source,
            error,
            warnings,
            user,
            role: None,
            unmanaged_connections: None,
            connections: Vec::new(),
        };
    };
    let profiles = state.profiles.read().clone();
    let connections = profiles
        .iter()
        .filter(|p| !p.ephemeral)
        .map(|p| {
            let ctx = Ctx {
                doc: &doc,
                user: &user,
                profile: Some(p),
                database: None,
            };
            let rules: Vec<RulePolicy> = ctx
                .endpoint_rules()
                .into_iter()
                .map(|r| {
                    let ai = r.ai_grant();
                    RulePolicy {
                        databases: r.databases.clone(),
                        allow: r.relations.allow.clone(),
                        deny: r.relations.deny.clone(),
                        human: r.human_grant().names(),
                        ai: ai.names(),
                        free_sql: !r.is_scoped() && !ai.is_empty(),
                    }
                })
                .collect();
            ConnectionPolicy {
                id: p.id.clone(),
                name: p.name.clone(),
                unmatched: rules.is_empty(),
                left_alone: ctx.is_unmanaged(),
                rules,
            }
        })
        .collect();
    PolicyStatus {
        state: state_label,
        source,
        error,
        warnings,
        role: Some(doc.role_for(&user).0.to_string()),
        unmanaged_connections: Some(doc.unmanaged_connections.label()),
        user,
        connections,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::state::Driver;
    use crate::testkit;

    const POLICY: &str = r#"{
        "version": 1,
        "defaultRole": "none",
        "users": {},
        "roles": {
            "none": {},
            "sales": { "rules": [{
                "endpoint": { "host": "erp.local" },
                "databases": ["billing"],
                "relations": { "allow": ["invoices"] },
                "human": ["select", "insert"],
                "ai": ["select", "insert"]
            }] }
        }
    }"#;

    /// A state with one ERP profile and the policy above, with the running
    /// account assigned to `sales` so the test does not depend on who runs it.
    fn state_with_policy() -> AppState {
        let state = AppState::new();
        let text = POLICY.replace(
            "\"users\": {}",
            &format!("\"users\": {{ {:?}: \"sales\" }}", current_user_or_test()),
        );
        let (doc, _) = super::super::model::PolicyDoc::parse(&text).unwrap();
        *state.policy.write() = PolicyState::Active {
            doc: Arc::new(doc),
            source: "test".into(),
            warnings: Vec::new(),
        };
        state.profiles.write().push(ConnectionProfile {
            driver: Driver::Mysql,
            host: "erp.local".into(),
            port: 3306,
            database: "billing".into(),
            ..testkit::profile("policy-test-erp")
        });
        state
    }

    /// The account key the test policy names. `current_user` can be empty on
    /// an exotic CI runner, and an empty key is refused by the parser, so the
    /// empty case gets the default role instead — the test then checks refusals
    /// only. Real runs always have a name.
    fn current_user_or_test() -> String {
        let u = current_user();
        if u.is_empty() {
            "nobody-at-all".into()
        } else {
            u.to_string()
        }
    }

    fn fetch(table: &str) -> BridgeRequest {
        BridgeRequest::FetchTableData {
            connection_id: "policy-test-erp".into(),
            policy_id: "policy-test-erp".into(),
            schema: None,
            table: table.into(),
            limit: 10,
            offset: 0,
            with_count: None,
        }
    }

    #[test]
    fn unmanaged_state_enforces_nothing() {
        let state = AppState::new();
        assert!(enforce(&state, &fetch("anything")).is_ok());
        assert!(!free_sql_blocked(&state, "x"));
    }

    #[test]
    fn a_broken_or_pending_policy_blocks_every_ai_request() {
        let state = AppState::new();
        *state.policy.write() = PolicyState::Broken {
            source: "\\\\srv\\it\\huginn.json".into(),
            error: "cannot read".into(),
        };
        let err = enforce(&state, &fetch("invoices")).unwrap_err().to_string();
        assert!(err.contains("could not be applied"), "{err}");
        assert!(free_sql_blocked(&state, "x"));
        assert!(!reachable_by_ai(&state, &testkit::profile("x")));

        *state.policy.write() = PolicyState::Pending {
            source: "share".into(),
        };
        assert!(enforce(&state, &fetch("invoices")).is_err());
    }

    #[test]
    fn requests_are_checked_against_the_role() {
        if current_user().is_empty() {
            return;
        }
        let state = state_with_policy();
        assert!(enforce(&state, &fetch("invoices")).is_ok());
        assert!(enforce(&state, &fetch("payroll")).is_err());
        let run = BridgeRequest::RunStatement {
            connection_id: "policy-test-erp".into(),
            policy_id: "policy-test-erp".into(),
            sql: "SELECT * FROM payroll".into(),
        };
        let err = enforce(&state, &run).unwrap_err().to_string();
        assert!(err.contains("free-form queries are disabled"), "{err}");
        assert!(free_sql_blocked(&state, "policy-test-erp"));
        let users = BridgeRequest::ListUsers {
            connection_id: "policy-test-erp".into(),
        };
        assert!(enforce(&state, &users).is_err());
    }

    #[test]
    fn discovery_only_shows_what_the_ai_may_reach() {
        if current_user().is_empty() {
            return;
        }
        let state = state_with_policy();
        let table = |name: &str| TableInfo {
            schema: "billing".into(),
            name: name.into(),
            kind: "table".into(),
            row_count: None,
            size_bytes: None,
        };
        let kept = filter_tables(
            &state,
            "policy-test-erp",
            vec![table("invoices"), table("payroll")],
        );
        assert_eq!(
            kept.iter().map(|t| t.name.as_str()).collect::<Vec<_>>(),
            ["invoices"]
        );

        let db = |name: &str| DatabaseInfo { name: name.into() };
        let kept = filter_databases(&state, "policy-test-erp", vec![db("billing"), db("hr")]);
        assert_eq!(
            kept.iter().map(|d| d.name.as_str()).collect::<Vec<_>>(),
            ["billing"]
        );
    }

    #[test]
    fn the_status_describes_each_connection() {
        if current_user().is_empty() {
            return;
        }
        let state = state_with_policy();
        let status = status(&state);
        assert_eq!(status.state, "active");
        assert_eq!(status.role.as_deref(), Some("sales"));
        let erp = status
            .connections
            .iter()
            .find(|c| c.id == "policy-test-erp")
            .unwrap();
        assert!(!erp.unmatched);
        assert_eq!(erp.rules[0].ai, ["select", "insert"]);
        assert!(!erp.rules[0].free_sql);
    }
}
