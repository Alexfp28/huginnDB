//! MongoDB driver support.
//!
//! MongoDB's document model diverges sharply from the SQL drivers, so all of
//! its logic lives here rather than being woven into the SQL command paths. The
//! command layer keeps thin `DbPool::Mongo(_)` arms that delegate to this
//! module:
//!
//! * [`query`]  — execute `mongosh`-style statements + collection CRUD, shaped
//!   into the SQL-shaped DTOs the frontend already consumes.
//! * [`schema`] — introspection (databases, collections, inferred fields,
//!   indexes). MongoDB is schemaless, so field lists are *sampled*.
//! * [`shell`]  — a bounded parser for `db.coll.method(...)` statements.
//! * [`values`] — BSON ⇄ JSON conversion (display + round-trip).
//!
//! [`open_pool`] builds the client from a connection URI (the primary input,
//! covering Atlas `mongodb+srv://`, replica sets, and URI options) or from the
//! discrete profile fields, and gates SSH tunnelling to single-host
//! `mongodb://` URIs (an SRV record resolves to several hosts, which the
//! single-port tunnel model can't represent — see the roadmap).

pub mod query;
pub mod schema;
pub mod shell;
pub mod values;

use crate::db::ssh::{self, SshTunnelHandle};
use crate::error::{AppError, AppResult};
use crate::ssh_known_hosts::SharedKnownHosts;
use crate::state::{ConnectionProfile, DbPool, MongoConn};
use mongodb::options::{ClientOptions, Credential, ServerAddress};
use mongodb::Client;
use std::time::Duration;

/// URL-encode a component for use inside a `mongodb://` URI.
fn enc(value: &str) -> String {
    url::form_urlencoded::byte_serialize(value.as_bytes()).collect()
}

/// Open a MongoDB client for `profile`.
///
/// Returns the same `(DbPool, Option<SshTunnelHandle>)` shape as the SQL
/// [`crate::db::pool::open_pool`] so the connection lifecycle code is uniform.
pub async fn open_pool(
    profile: &ConnectionProfile,
    password: &str,
    ssh_secret: Option<String>,
    known_hosts: SharedKnownHosts,
) -> AppResult<(DbPool, Option<SshTunnelHandle>)> {
    // Primary input is the connection string; fall back to assembling one from
    // the discrete fields when it is absent.
    let uri = match profile
        .connection_string
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
    {
        Some(cs) => cs.to_string(),
        None => {
            let db = if profile.database.is_empty() {
                String::new()
            } else {
                format!("/{}", profile.database)
            };
            if profile.username.is_empty() {
                format!("mongodb://{}:{}{}", profile.host, profile.port, db)
            } else {
                format!(
                    "mongodb://{}:{}@{}:{}{}",
                    enc(&profile.username),
                    enc(password),
                    profile.host,
                    profile.port,
                    db
                )
            }
        }
    };

    let is_srv = uri.starts_with("mongodb+srv://");
    let mut options = ClientOptions::parse(&uri).await?;
    // Fail fast in the UI instead of waiting out the 30 s default.
    options.server_selection_timeout = Some(Duration::from_secs(8));
    options.app_name = Some("HuginnDB".to_string());

    // Inject a keychain-sourced password when the URI carried none (URI-primary
    // mode where the secret is stored separately rather than embedded). The
    // credential builder is type-state, so we take any existing credential (or
    // an all-default one) and mutate its optional fields rather than chaining.
    if !password.is_empty() {
        let mut cred = options
            .credential
            .take()
            .unwrap_or_else(|| Credential::builder().build());
        if cred.password.is_none() {
            cred.password = Some(password.to_string());
        }
        if cred.username.is_none() && !profile.username.is_empty() {
            cred.username = Some(profile.username.clone());
        }
        options.credential = Some(cred);
    }

    // SSH tunnel: supported only for a single-host `mongodb://` URI. An SRV URI
    // resolves to several hosts via DNS, which the single-port tunnel can't
    // represent; a multi-host seed list has the same problem.
    let mut handle: Option<SshTunnelHandle> = None;
    if let Some(tunnel) = profile.ssh_tunnel.as_ref() {
        if is_srv {
            return Err(AppError::InvalidInput(
                "SSH tunnelling is not supported for mongodb+srv:// connections (SRV resolves to \
                 multiple hosts). Use a direct mongodb://host:port URI to tunnel."
                    .into(),
            ));
        }
        if options.hosts.len() != 1 {
            return Err(AppError::InvalidInput(
                "SSH tunnelling requires a single-host mongodb://host:port URI; this connection \
                 lists multiple hosts."
                    .into(),
            ));
        }
        let (remote_host, remote_port) = match &options.hosts[0] {
            ServerAddress::Tcp { host, port } => (host.clone(), port.unwrap_or(27017)),
            other => {
                return Err(AppError::InvalidInput(format!(
                    "SSH tunnelling is not supported for this host type: {other}"
                )))
            }
        };
        let h =
            ssh::open_tunnel(tunnel, ssh_secret, &remote_host, remote_port, known_hosts).await?;
        // Point the driver at the local tunnel endpoint and force a direct
        // connection so topology discovery doesn't try to reach the real host.
        options.hosts = vec![ServerAddress::Tcp {
            host: "127.0.0.1".to_string(),
            port: Some(h.local_port),
        }];
        options.direct_connection = Some(true);
        options.repl_set_name = None;
        handle = Some(h);
    }

    // The connection's default database (URI path or explicit field), used as
    // the "current db" for `db.coll.…` statements until the user picks another.
    let database = options.default_database.clone().or_else(|| {
        if profile.database.is_empty() {
            None
        } else {
            Some(profile.database.clone())
        }
    });

    let client = Client::with_options(options)?;
    Ok((DbPool::Mongo(MongoConn { client, database }), handle))
}
