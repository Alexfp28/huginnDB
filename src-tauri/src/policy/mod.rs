//! Managed policy: per-role permissions an administrator sets once, for every
//! installation in an organization. `docs/POLICY_ROADMAP.md` is the
//! specification; this is phase 1 of it — the part that binds **the AI**.
//!
//! For the AI this is an enforcement point, not a guardrail: the model never
//! holds a database credential, and every request it can make is a
//! [`crate::bridge::protocol::BridgeRequest`] executed by [`crate::bridge::exec::execute`], whose four
//! callers all act for an AI (the MCP sidecar served by the app, the sidecar
//! running alone, the AI panel's agent, and its assisted tasks). [`enforce`]
//! runs at the top of that function, so none of the four can miss it. The
//! three things that do not pass through it are checked where they are:
//! `EnsureConnected` (in `bridge::server::dispatch` and the sidecar's
//! `ensure_connected`), the MCP `list_connections` tool
//! ([`reachable_by_ai`]), and the AI panel's catalogue ([`free_sql_blocked`]).
//!
//! Policy only ever **narrows**. The per-connection settings — `mcp_exposed`,
//! `mcp_write`, `ai_enabled` — are still checked where they always were, so
//! what the AI may do is the policy ∩ the local settings.
//!
//! People are phase 2: the `human` blocks are read, shown in the diagnostics,
//! and bound the `ai` ones (an AI never gets more than its user), but the
//! app's own commands do not enforce them yet.

mod enforce;
pub(crate) mod grants;
pub mod model;
mod resolve;
mod source;

pub use enforce::{
    access, enforce, filter_databases, filter_databases_for, filter_tables, filter_tables_for,
    free_sql_blocked, relation_access, require, status, PolicyAccess, PolicyStatus, RelationAccess,
};
pub use model::Subject;
pub use resolve::Need;
// Only the MCP sidecar's `list_connections` asks this.
#[cfg(feature = "mcp")]
pub use enforce::reachable_by_ai;

use parking_lot::RwLock;
use std::sync::{Arc, OnceLock};
use std::time::Duration;

/// Emitted by the desktop app whenever the policy in force changes — loaded,
/// edited on the share, broken, removed — so every window re-reads what it
/// may offer instead of showing yesterday's locks until it is reopened.
pub const CHANGED_EVENT: &str = "huginndb://policy-changed";

/// Called after a reload that changed the state. The app passes one that
/// emits [`CHANGED_EVENT`]; the sidecar has nobody to tell.
pub type OnChange = Box<dyn Fn() + Send + 'static>;

/// How often the anchor and the policy it names are read again. The file is a
/// few kilobytes, so this costs nothing even on a share, and it is how an
/// administrator's change reaches running installations without a restart.
pub const RELOAD_EVERY: Duration = Duration::from_secs(5 * 60);

/// What this process knows about its policy.
#[derive(Debug, Clone)]
pub enum PolicyState {
    /// No anchor: the installation behaves exactly as it does without this
    /// feature.
    Unmanaged,
    /// An anchor names a policy on a share that has not been read yet. Blocks,
    /// like `Broken`: an AI request must not run on the assumption that the
    /// policy will turn out to allow it.
    Pending { source: String },
    Active {
        doc: Arc<model::PolicyDoc>,
        source: String,
        /// Allowed but probably unintended; shown in the diagnostics.
        warnings: Vec<String>,
    },
    /// An anchor exists and what it leads to cannot be read or is not valid.
    /// Fails closed (§5.4): there is no cached copy to fall back to (D6), and
    /// falling back to "unmanaged" would turn a broken share into an open one.
    Broken { source: String, error: String },
}

pub type SharedPolicy = Arc<RwLock<PolicyState>>;

/// The state every `AppState` starts in. [`install`] replaces it; tests and a
/// process that never calls it stay unmanaged, which is why the policy is not
/// read inside `AppState::new` — a test suite must not inherit the policy of
/// the machine it happens to run on.
pub fn unmanaged() -> SharedPolicy {
    Arc::new(RwLock::new(PolicyState::Unmanaged))
}

/// Read this machine's policy and keep it current.
///
/// The anchors are local (the registry, a file under the system directory),
/// so reading them here costs nothing and an inline policy is in force before
/// the first request. A policy on a share is left `Pending` and read by the
/// reload thread straight away, so a slow or unreachable share can never delay
/// the window appearing.
pub fn install(shared: &SharedPolicy, on_change: Option<OnChange>) {
    let first = match source::read_anchor() {
        Ok(None) => PolicyState::Unmanaged,
        Ok(Some(anchor @ source::Anchor::Inline { .. })) => evaluate(&anchor),
        Ok(Some(anchor)) => PolicyState::Pending {
            source: anchor.describe(),
        },
        Err(error) => PolicyState::Broken {
            source: source::policy_dir().display().to_string(),
            error,
        },
    };
    *shared.write() = first;
    let shared = shared.clone();
    // A plain thread rather than a tokio task: the reads block (a share can
    // take its SMB timeout to answer), and this is shared by the desktop app
    // and the sidecar, which do not share a runtime.
    let _ = std::thread::Builder::new()
        .name("huginndb-policy".into())
        .spawn(move || loop {
            let next = load();
            // `Debug` is a fingerprint of everything the state says — source,
            // error, the whole document — and this runs every five minutes, so
            // comparing it costs nothing and needs no hashing of its own.
            let changed = format!("{next:?}") != format!("{:?}", *shared.read());
            *shared.write() = next;
            if changed {
                if let Some(notify) = &on_change {
                    notify();
                }
            }
            std::thread::sleep(RELOAD_EVERY);
        });
}

fn load() -> PolicyState {
    match source::read_anchor() {
        Ok(None) => PolicyState::Unmanaged,
        Ok(Some(anchor)) => evaluate(&anchor),
        Err(error) => PolicyState::Broken {
            source: source::policy_dir().display().to_string(),
            error,
        },
    }
}

fn evaluate(anchor: &source::Anchor) -> PolicyState {
    let source = anchor.describe();
    match source::fetch(anchor).and_then(|text| model::PolicyDoc::parse(&text)) {
        Ok((doc, warnings)) => PolicyState::Active {
            doc: Arc::new(doc),
            source,
            warnings,
        },
        Err(error) => PolicyState::Broken { source, error },
    }
}

/// The OS account this process runs as, from the operating system itself
/// (`GetUserNameW`, `getpwuid`) — never from `USERNAME` / `USER`, which
/// whoever launches the process sets, so a user could otherwise start the app
/// as `USERNAME=admin` and inherit that role. Read once: it cannot change for
/// the life of the process. Empty if the OS will not say, which gets the
/// default role — the most restrictive one.
pub fn current_user() -> &'static str {
    static USER: OnceLock<String> = OnceLock::new();
    USER.get_or_init(|| whoami::fallible::username().unwrap_or_default())
}

/// The database user the policy in force pins for the person using this
/// process on `profile`'s server, if it pins one (a rule's `dbUser`). `None`
/// without an active policy: a pending or broken one refuses the connection
/// anyway (`guard::endpoint`), so there is nothing to sign in as.
pub fn pinned_db_user(
    policy: &SharedPolicy,
    profile: &crate::state::ConnectionProfile,
) -> Option<String> {
    match &*policy.read() {
        PolicyState::Active { doc, .. } => resolve::pinned_db_user(doc, current_user(), profile),
        _ => None,
    }
}

/// `user=… role=…` for the MCP audit log, so every line says who the AI was
/// acting for and under which role. `role=-` without a policy.
// The audit log is the MCP sidecar's, which the `mcp` feature gates.
#[cfg_attr(not(feature = "mcp"), allow(dead_code))]
pub fn audit_identity(state: &crate::state::AppState) -> String {
    let user = current_user();
    let role = match &*state.policy.read() {
        PolicyState::Active { doc, .. } => doc.role_for(user).0.to_string(),
        PolicyState::Unmanaged => "-".to_string(),
        PolicyState::Pending { .. } | PolicyState::Broken { .. } => "(blocked)".to_string(),
    };
    let user = if user.is_empty() { "?" } else { user };
    format!("user={user} role={role}")
}
