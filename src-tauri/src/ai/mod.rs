//! The in-app AI assistant's backend: what HuginnDB describes to a model, and
//! what a model is allowed to make it do.
//!
//! Phase 1 of `docs/AI_ROADMAP.md`. This is a second, deliberately thin
//! *presentation* layer over [`crate::bridge::protocol::BridgeRequest`] — the
//! same enum the headless MCP connector presents through `rmcp`'s `#[tool]`
//! macros. The substance (pool ownership, the `_inner` data-path functions,
//! the per-connection write policy) is already shared, so nothing here
//! reimplements a database call and nothing here belongs in `crate::mcp`.
//!
//! # The egress invariant
//!
//! **The webview never talks to the model.** Every byte of HTTP to an
//! inference endpoint happens in Rust, through one client, against an
//! allowlist derived solely from the configured base URL — see
//! [`provider::request`], the only function in the crate that can address an
//! endpoint. This is the network counterpart of "the frontend never
//! talks to a database", and it is load-bearing precisely *because* `csp` is
//! `null` — Monaco loads its workers as blobs, so the webview is not a barrier
//! to anything. Egress is auditable only if exactly one function can make the
//! call.
//!
//! # The coupling rule
//!
//! Two independent axes, and conflating them is the mistake this module exists
//! to avoid:
//!
//! * **Where inference runs** — loopback, the LAN, or the user's own gateway,
//!   versus a third-party cloud. Declared by the user, never sniffed: a
//!   hostname resolves wherever DNS says it does, so DNS is not a security
//!   boundary.
//! * **What enters the model's context** — metadata (table and column names,
//!   types, indexes, view bodies, `EXPLAIN` output) versus metadata *plus
//!   rows*.
//!
//! "Read-only" does not mean "nothing leaves": a read-only agent that runs
//! `SELECT * FROM patients LIMIT 50` has just sent fifty patient records to
//! whatever endpoint is configured. So [`scope::DataScope`] gates the two
//! row-reading tools — and under [`scope::DataScope::MetadataOnly`] they are
//! **removed from the catalogue** rather than refused when called. A small
//! model that can see a tool it may not use will burn its turns trying;
//! absence is cheaper than refusal, and a stronger guarantee.
//!
//! # v1 is read-only, and proposes the rest
//!
//! No write variant appears in the catalogue at all (roadmap decision D4). A
//! mutation the assistant thinks is warranted is *proposed* as SQL for the user
//! to run themselves, through the editor's existing per-statement ▶ Run
//! CodeLens. [`exec`] enforces that a second time for the one tool whose
//! argument is free text: a `run_query` statement that
//! [`crate::db::classify`] does not call a read is refused, with a message
//! telling the model to propose it instead.

// Nothing calls this module yet. Phase 1 builds the catalogue and the executor;
// phase 3's `commands::ai` is what invokes them, and `clippy -D warnings` in CI
// would otherwise fail the build on every item here.
//
// **Delete this the moment `commands::ai` lands.** A blanket allow that
// outlives its reason is how a module starts accumulating unreachable code.
#![allow(dead_code)]

pub mod exec;
pub mod probe;
pub mod provider;
pub mod scope;
pub mod secrets;
pub mod stream;
pub mod tools;
