//! Persisted SSH host-key fingerprints.
//!
//! Stored next to `prefs.json` in the platform config dir as
//! `known_hosts.json`:
//!
//! ```json
//! {
//!   "version": 1,
//!   "hosts": {
//!     "db.example.com:22": "SHA256:abc..."
//!   }
//! }
//! ```
//!
//! Keyed by `host:port` so multiple HuginnDB profiles pointing at the same
//! SSH server share the same trust decision — same model OpenSSH uses for
//! its `~/.ssh/known_hosts`.
//!
//! A missing or corrupted file degrades silently to an empty store, which
//! means the next connection under `AcceptNew` will simply trust the
//! presented key on first use again. Writes go through an atomic
//! temp-file rename so a crash mid-save cannot leave a partial file.

use crate::error::AppResult;
use parking_lot::RwLock;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::Arc;

const FILE: &str = "known_hosts.json";

/// On-disk shape of the host-key store.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct KnownHosts {
    pub version: u32,
    /// `host:port` → `SHA256:<base64>` fingerprint string.
    pub hosts: HashMap<String, String>,
}

impl KnownHosts {
    /// Look up a fingerprint by `host:port`.
    pub fn get(&self, host_port: &str) -> Option<&String> {
        self.hosts.get(host_port)
    }

    /// Insert or replace a fingerprint for `host:port`.
    pub fn insert(&mut self, host_port: String, fingerprint: String) {
        self.hosts.insert(host_port, fingerprint);
    }

    /// Remove the fingerprint for `host:port`. Returns whether an entry
    /// was removed — used by the frontend to confirm a "forget" action.
    pub fn remove(&mut self, host_port: &str) -> bool {
        self.hosts.remove(host_port).is_some()
    }
}

/// Read the store from disk, returning an empty one when missing or
/// unparseable. Mirrors the silent-degradation policy used by `prefs.rs`.
pub fn load() -> KnownHosts {
    crate::state_file::load_or_default(FILE, "ssh-known-hosts")
}

/// Persist `store` to disk atomically (see [`crate::state_file::save_atomic`]).
pub fn save(store: &KnownHosts) -> AppResult<()> {
    crate::state_file::save_atomic(FILE, store)
}

/// Shared, thread-safe handle to the in-memory store. Loaded once at app
/// startup and shared across SSH connections.
pub type SharedKnownHosts = Arc<RwLock<KnownHosts>>;

/// Build a fresh shared handle around the on-disk store.
pub fn load_shared() -> SharedKnownHosts {
    Arc::new(RwLock::new(load()))
}
