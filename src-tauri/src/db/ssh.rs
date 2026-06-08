//! SSH-tunnel support for server-backed connections.
//!
//! Given an [`SshTunnel`] config and a secret (password or private-key
//! passphrase), [`open_tunnel`] establishes an SSH session, binds a local
//! TCP listener, and proxies every accepted socket through an SSH
//! `direct-tcpip` channel pointing at `(remote_host, remote_port)`.
//!
//! The returned [`SshTunnelHandle`] owns:
//!
//! * the bound local port (which may differ from the configured one when
//!   the user asks for `0` / auto-assign),
//! * a [`CancellationToken`] that, when triggered (or when the handle is
//!   dropped), stops the accept loop and tears the listener down.
//!
//! ### Host-key verification
//!
//! The first thing the SSH handshake does is hand us the server's public
//! key. We compare its SHA-256 fingerprint against
//! [`crate::ssh_known_hosts`] using the policy on the tunnel config:
//!
//! * [`HostKeyPolicy::Strict`]     — only accept a fingerprint that
//!   matches a previously stored entry. Reject unknown servers.
//! * [`HostKeyPolicy::AcceptNew`]  — trust on first use: accept and
//!   persist new fingerprints, reject mismatches afterwards. Same model
//!   as `ssh -o StrictHostKeyChecking=accept-new`. Recommended default.
//! * [`HostKeyPolicy::AcceptAny`]  — accept anything. Offers no MITM
//!   protection; only useful for throwaway test setups.
//!
//! When the handler decides to reject, `russh` short-circuits the
//! handshake with a generic error. We stash a richer human-readable
//! reason in a shared cell and substitute it on the way out so the user
//! actually sees what happened.

use crate::error::{AppError, AppResult};
use crate::ssh_known_hosts::{self, SharedKnownHosts};
use crate::state::{HostKeyPolicy, SshAuth, SshTunnel};
use parking_lot::Mutex;
use russh::client::{self, Handle};
use russh::keys::ssh_key::HashAlg;
use russh::keys::{load_secret_key, PrivateKeyWithHashAlg, PublicKey};
use std::path::PathBuf;
use std::sync::Arc;
use tokio::io::copy_bidirectional;
use tokio::net::TcpListener;
use tokio_util::sync::CancellationToken;

/// Wrap any `russh` error into [`AppError::Ssh`].
fn ssh_err(label: &str, e: impl std::fmt::Display) -> AppError {
    AppError::Ssh(format!("{label}: {e}"))
}

/// Whether a `TcpListener::bind` error on a *pinned* local port means the
/// port simply can't be used (so we should fall back to an ephemeral one)
/// rather than a fatal problem. See the call site for the per-platform
/// `ErrorKind` rationale.
fn is_port_unavailable(kind: std::io::ErrorKind) -> bool {
    use std::io::ErrorKind::*;
    matches!(kind, AddrInUse | PermissionDenied | AddrNotAvailable)
}

/// Active SSH tunnel. Drop the handle to tear the tunnel down.
pub struct SshTunnelHandle {
    /// Local TCP port the tunnel is listening on. When the caller asked
    /// for `local_port = 0`, this exposes the OS-assigned port so the
    /// downstream `sqlx` URL can target it.
    pub local_port: u16,
    cancel: CancellationToken,
}

impl Drop for SshTunnelHandle {
    fn drop(&mut self) {
        // Cancellation cascades into both the accept loop and any in-flight
        // proxy task, allowing them to release the listener and the SSH
        // session promptly.
        self.cancel.cancel();
    }
}

/// Outcome of host-key verification carried out of [`Client::check_server_key`].
#[derive(Debug, Default, Clone)]
struct VerifyOutcome {
    /// Set when the handler rejected the key; used to substitute a useful
    /// error message for the generic one russh emits on close.
    rejection: Option<String>,
    /// `true` when we accepted an unknown key under [`HostKeyPolicy::AcceptNew`]
    /// and the store needs to be flushed to disk.
    persisted_new: bool,
}

/// `russh` client handler that runs host-key verification according to the
/// configured policy and records its decision on the shared
/// [`VerifyOutcome`] so callers can react.
struct Client {
    policy: HostKeyPolicy,
    host_port: String,
    store: SharedKnownHosts,
    outcome: Arc<Mutex<VerifyOutcome>>,
}

impl client::Handler for Client {
    type Error = russh::Error;

    async fn check_server_key(
        &mut self,
        server_public_key: &PublicKey,
    ) -> Result<bool, Self::Error> {
        // OpenSSH-style "SHA256:<base64>" representation. Stable across
        // crate versions because it's the on-wire fingerprint format.
        let fp = server_public_key.fingerprint(HashAlg::Sha256).to_string();

        match self.policy {
            HostKeyPolicy::AcceptAny => Ok(true),

            HostKeyPolicy::Strict => {
                let known = self.store.read().get(&self.host_port).cloned();
                match known {
                    Some(stored) if stored == fp => Ok(true),
                    Some(stored) => {
                        self.outcome.lock().rejection = Some(format!(
                            "host key mismatch for {} — stored {}, presented {}. Use \"Forget host key\" if the server was legitimately reinstalled.",
                            self.host_port, stored, fp
                        ));
                        Ok(false)
                    }
                    None => {
                        self.outcome.lock().rejection = Some(format!(
                            "host key for {} is not trusted (got {}). Switch the policy to \"Trust on first use\" to accept it.",
                            self.host_port, fp
                        ));
                        Ok(false)
                    }
                }
            }

            HostKeyPolicy::AcceptNew => {
                let known = self.store.read().get(&self.host_port).cloned();
                match known {
                    Some(stored) if stored == fp => Ok(true),
                    Some(stored) => {
                        self.outcome.lock().rejection = Some(format!(
                            "host key changed for {} — previously stored {}, now {}. Use \"Forget host key\" if the server was legitimately reinstalled.",
                            self.host_port, stored, fp
                        ));
                        Ok(false)
                    }
                    None => {
                        self.store.write().insert(self.host_port.clone(), fp);
                        self.outcome.lock().persisted_new = true;
                        Ok(true)
                    }
                }
            }
        }
    }
}

/// Open an SSH session, authenticate, bind the local listener and spawn
/// the accept loop.
pub async fn open_tunnel(
    tunnel: &SshTunnel,
    secret: Option<String>,
    remote_host: &str,
    remote_port: u16,
    store: SharedKnownHosts,
) -> AppResult<SshTunnelHandle> {
    let outcome = Arc::new(Mutex::new(VerifyOutcome::default()));
    let host_port = format!("{}:{}", tunnel.host, tunnel.port);

    let handler = Client {
        policy: tunnel.host_key_policy,
        host_port: host_port.clone(),
        store: store.clone(),
        outcome: outcome.clone(),
    };

    let config = Arc::new(client::Config::default());
    let mut session = client::connect(config, (tunnel.host.as_str(), tunnel.port), handler)
        .await
        .map_err(|e| {
            // If our handler rejected the host key, surface the real reason
            // instead of the generic "connection closed" russh emits.
            if let Some(reason) = outcome.lock().rejection.take() {
                AppError::Ssh(reason)
            } else {
                ssh_err("connect", e)
            }
        })?;

    // First-use under AcceptNew adds an entry; flush it to disk so the
    // trust decision survives a restart.
    if outcome.lock().persisted_new {
        let snapshot = store.read().clone();
        if let Err(e) = ssh_known_hosts::save(&snapshot) {
            eprintln!("[ssh] failed to persist known_hosts: {e}");
        }
    }

    let authenticated = match &tunnel.auth {
        SshAuth::Password => {
            let pw = secret.unwrap_or_default();
            session
                .authenticate_password(&tunnel.username, pw)
                .await
                .map_err(|e| ssh_err("auth-password", e))?
        }
        SshAuth::Key { path } => {
            let passphrase = secret.filter(|s| !s.is_empty());
            let key = load_secret_key(PathBuf::from(path), passphrase.as_deref())
                .map_err(|e| ssh_err("load-key", e))?;
            session
                .authenticate_publickey(
                    &tunnel.username,
                    PrivateKeyWithHashAlg::new(Arc::new(key), None),
                )
                .await
                .map_err(|e| ssh_err("auth-publickey", e))?
        }
    };
    if !authenticated.success() {
        return Err(AppError::Ssh("authentication rejected by server".into()));
    }

    // Bind locally. `local_port = 0` requests an ephemeral port from the
    // OS; we read the actual port back via `local_addr()`.
    //
    // If the user pinned a fixed `local_port` and something else already holds
    // it (e.g. another SSH tunnel the user opened by hand, or an unrelated
    // service on the same port), the bind fails and the whole connection would
    // break. Rather than surface a raw OS error, fall back to an ephemeral
    // port: the pool is pointed at the *bound* port we return on the handle,
    // so swapping the local port at runtime is transparent. The saved profile
    // is left untouched — the override only lasts for this tunnel's lifetime.
    //
    // The conflict surfaces as different `ErrorKind`s across platforms:
    //   * `AddrInUse`        — the common case (POSIX `EADDRINUSE`, and a
    //     plain Windows `WSAEADDRINUSE`).
    //   * `PermissionDenied` — Windows returns `WSAEACCES` when the port is
    //     held by a socket opened with exclusive access, or sits inside a
    //     reserved/excluded range (e.g. Hyper-V / WSL `netsh` reservations).
    //   * `AddrNotAvailable` — occasionally seen for excluded ranges too.
    // All three mean "this specific port won't work"; for a pinned port that
    // is exactly when we want to retry on an OS-assigned one.
    let listener = match TcpListener::bind(("127.0.0.1", tunnel.local_port)).await {
        Ok(l) => l,
        Err(e) if tunnel.local_port != 0 && is_port_unavailable(e.kind()) => {
            eprintln!(
                "[ssh] local port {} unavailable ({:?}); falling back to an ephemeral port",
                tunnel.local_port,
                e.kind()
            );
            TcpListener::bind(("127.0.0.1", 0))
                .await
                .map_err(|e| ssh_err("bind-local-fallback", e))?
        }
        Err(e) => return Err(ssh_err("bind-local", e)),
    };
    let bound_port = listener
        .local_addr()
        .map_err(|e| ssh_err("local-addr", e))?
        .port();

    let cancel = CancellationToken::new();
    let cancel_loop = cancel.clone();
    let session = Arc::new(session);
    let remote_host_owned = remote_host.to_string();

    tokio::spawn(async move {
        accept_loop(
            listener,
            session,
            remote_host_owned,
            remote_port,
            bound_port,
            cancel_loop,
        )
        .await;
    });

    Ok(SshTunnelHandle {
        local_port: bound_port,
        cancel,
    })
}

/// Accept incoming TCP connections on the local listener and proxy each
/// one through a fresh `direct-tcpip` SSH channel until cancelled.
async fn accept_loop(
    listener: TcpListener,
    session: Arc<Handle<Client>>,
    remote_host: String,
    remote_port: u16,
    local_port: u16,
    cancel: CancellationToken,
) {
    loop {
        tokio::select! {
            _ = cancel.cancelled() => return,
            accepted = listener.accept() => {
                let Ok((socket, _peer)) = accepted else { return };
                let session = session.clone();
                let remote_host = remote_host.clone();
                let cancel = cancel.clone();
                tokio::spawn(async move {
                    let _ = proxy_one(
                        socket,
                        session,
                        remote_host,
                        remote_port,
                        local_port,
                        cancel,
                    )
                    .await;
                });
            }
        }
    }
}

/// Proxy a single accepted TCP socket end-to-end through a freshly opened
/// SSH `direct-tcpip` channel using `copy_bidirectional` over the channel's
/// `AsyncRead + AsyncWrite` adapter.
async fn proxy_one(
    mut socket: tokio::net::TcpStream,
    session: Arc<Handle<Client>>,
    remote_host: String,
    remote_port: u16,
    local_port: u16,
    cancel: CancellationToken,
) -> AppResult<()> {
    let channel = session
        .channel_open_direct_tcpip(
            remote_host,
            remote_port as u32,
            "127.0.0.1".to_string(),
            local_port as u32,
        )
        .await
        .map_err(|e| ssh_err("open-channel", e))?;

    let mut stream = channel.into_stream();
    tokio::select! {
        _ = cancel.cancelled() => Ok(()),
        result = copy_bidirectional(&mut socket, &mut stream) => {
            result.map(|_| ()).map_err(|e| ssh_err("proxy", e))
        }
    }
}
