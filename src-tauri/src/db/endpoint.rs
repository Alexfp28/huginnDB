//! Per-server connection budgets.
//!
//! Everything up to 1.13.0 accounted for connections **per profile**: each
//! saved connection got its own ceiling, and each per-database view got its
//! own on top. Nothing anywhere could answer the only question that actually
//! matters to a server — *how many sockets do I hold against `host:port`?* —
//! so three profiles pointing at one Postgres box were three independent
//! budgets, and browsing databases inside each of them multiplied further.
//!
//! This module makes the **server endpoint** the unit of accounting. Every
//! pool that will really open connections first reserves capacity from its
//! endpoint's budget and holds an [`EndpointGrant`] for as long as it lives;
//! the grant releases on `Drop`, so no teardown path can leak one even if it
//! forgets to.
//!
//! # Admission control, not checkout interception
//!
//! The reservation is taken when a pool is **opened**, sized by that pool's
//! ceiling — not per connection checkout. Intercepting checkouts would mean
//! wrapping every `execute`/`fetch` in the command layer (hundreds of call
//! sites, each a chance to forget) and would still not bound what a pool is
//! *allowed* to grow to. Reserving the ceiling up front is coarser — a pool
//! that never fills holds budget it isn't using — but it yields a real
//! guarantee that is easy to reason about and impossible to bypass:
//!
//! > HuginnDB never has more than `budget` connections' worth of pool capacity
//! > open against one server, no matter how many profiles or database views
//! > point at it.
//!
//! The slack is bounded by the same thing that bounds everything else here:
//! pools are small ([`crate::db::pool`]) and idle ones are reaped
//! ([`crate::pool_reaper`]).
//!
//! # What is *not* one endpoint
//!
//! * **SQLite** has no server and no limit — [`EndpointKey::for_profile`]
//!   returns `None` and those pools are never metered.
//! * **A Mongo per-database view** reuses its parent's `Client`
//!   (`resolve_mongo_database_view`) and opens nothing, so it takes no grant.
//! * **Two profiles behind different SSH tunnels** are different endpoints
//!   even when both name `localhost:5432`, because each tunnel's remote is
//!   resolved relative to its own SSH host. The tunnel's `(host, port)` is
//!   therefore part of the key.
//!
//! Conversely, the username is deliberately **not** part of the key: the
//! server's limit is global, so two profiles connecting as different users are
//! still competing for the same pool of slots.

use crate::state::{ConnectionProfile, Driver};
use parking_lot::Mutex;
use std::collections::HashMap;
use std::sync::Arc;

/// Identifies the server a pool will actually connect to.
///
/// Derived from the profile's *declared* remote rather than from whatever the
/// pool ends up dialling: a tunnelled connection targets `127.0.0.1:<local>`,
/// which says nothing about which server's budget it is spending. Hosts are
/// normalised (trimmed, lowercased) so `DB.example.com` and `db.example.com `
/// share a budget; no DNS resolution is attempted, since that would be async,
/// would need invalidating, and could silently merge or split budgets when a
/// record changed.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct EndpointKey {
    driver: Driver,
    host: String,
    port: u16,
    /// `(ssh_host, ssh_port)` when the connection is tunnelled. See the module
    /// docs for why this disambiguates rather than being noise.
    tunnel: Option<(String, u16)>,
}

impl EndpointKey {
    /// The endpoint `profile` will connect to, or `None` when the profile has
    /// no server to ration (SQLite).
    pub fn for_profile(profile: &ConnectionProfile) -> Option<Self> {
        if matches!(profile.driver, Driver::Sqlite) {
            return None;
        }
        Some(Self {
            driver: profile.driver,
            host: normalise_host(&profile.host),
            port: profile.port,
            tunnel: profile
                .ssh_tunnel
                .as_ref()
                .map(|t| (normalise_host(&t.host), t.port)),
        })
    }

    /// Human-readable `host:port` (plus the tunnel, when there is one) for the
    /// pool-usage panel and for the connection-limit error message.
    pub fn label(&self) -> String {
        match &self.tunnel {
            Some((ssh_host, ssh_port)) => {
                format!("{}:{} via {ssh_host}:{ssh_port}", self.host, self.port)
            }
            None => format!("{}:{}", self.host, self.port),
        }
    }
}

fn normalise_host(host: &str) -> String {
    host.trim().to_ascii_lowercase()
}

/// Live reservation against one endpoint's budget.
///
/// Held by the [`crate::state::ActivePool`] whose pool it covers. Releasing on
/// `Drop` rather than from the teardown paths is deliberate: pools are removed
/// from four different places (`disconnect`, the idle reaper, the per-parent
/// LRU cap, `drop_database`) and a budget that leaks on any one of them
/// degrades into the per-profile accounting this module exists to replace.
pub struct EndpointGrant {
    registry: Arc<EndpointRegistry>,
    key: EndpointKey,
    amount: u32,
}

impl std::fmt::Debug for EndpointGrant {
    /// Hand-written because the registry behind the `Arc` is neither
    /// `Debug`-able nor interesting; what a reader wants is which endpoint and
    /// how much.
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("EndpointGrant")
            .field("endpoint", &self.key.label())
            .field("amount", &self.amount)
            .finish()
    }
}

impl EndpointGrant {
    /// The endpoint this grant is drawn against.
    pub fn key(&self) -> &EndpointKey {
        &self.key
    }

    /// How many connections it reserves.
    pub fn amount(&self) -> u32 {
        self.amount
    }
}

impl Drop for EndpointGrant {
    fn drop(&mut self) {
        self.registry.release(&self.key, self.amount);
    }
}

/// Why a reservation could not be satisfied.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EndpointExhausted {
    pub label: String,
    pub budget: u32,
    pub in_use: u32,
}

/// Reserved capacity per endpoint. One instance lives in
/// [`crate::state::AppState`].
#[derive(Default)]
pub struct EndpointRegistry {
    inner: Mutex<HashMap<EndpointKey, u32>>,
}

impl EndpointRegistry {
    /// Reserve up to `requested` connections against `key`.
    ///
    /// Grants the largest amount available that is still at least `floor`;
    /// a smaller pool than asked for is better than no pool, but one below the
    /// floor is worse than none at all (see
    /// [`crate::db::pool::MIN_MAX_CONNECTIONS`] — a single-connection pool
    /// deadlocks against a multi-statement batch that holds its connection).
    ///
    /// `Err` carries the numbers the caller needs to tell the user *which*
    /// server is full and how much of it is ours.
    pub fn reserve(
        self: &Arc<Self>,
        key: &EndpointKey,
        requested: u32,
        budget: u32,
        floor: u32,
    ) -> Result<EndpointGrant, EndpointExhausted> {
        let mut inner = self.inner.lock();
        let in_use = inner.get(key).copied().unwrap_or(0);
        let available = budget.saturating_sub(in_use);
        // `min(requested, available)`, but never below the floor — and never
        // above the budget itself, so a single pool asking for more than the
        // whole endpoint allows is trimmed rather than granted.
        let amount = requested.min(available).min(budget);
        if amount < floor {
            return Err(EndpointExhausted {
                label: key.label(),
                budget,
                in_use,
            });
        }
        *inner.entry(key.clone()).or_insert(0) += amount;
        Ok(EndpointGrant {
            registry: Arc::clone(self),
            key: key.clone(),
            amount,
        })
    }

    /// Give `amount` back. Called only from [`EndpointGrant::drop`].
    fn release(&self, key: &EndpointKey, amount: u32) {
        let mut inner = self.inner.lock();
        if let Some(current) = inner.get_mut(key) {
            *current = current.saturating_sub(amount);
            if *current == 0 {
                // Drop the entry so the map tracks live endpoints only — it is
                // read whole by the usage panel.
                inner.remove(key);
            }
        }
    }

    /// Connections currently reserved against `key`.
    ///
    /// Test-only: production readers want [`Self::usage`], which reports every
    /// endpoint at once for the pool-usage panel rather than probing one.
    #[cfg(test)]
    pub fn in_use(&self, key: &EndpointKey) -> u32 {
        self.inner.lock().get(key).copied().unwrap_or(0)
    }

    /// Every endpoint with a live reservation, as `(label, in_use)`, sorted by
    /// label so the usage panel doesn't reshuffle on every poll.
    pub fn usage(&self) -> Vec<(String, u32)> {
        let mut rows: Vec<(String, u32)> = self
            .inner
            .lock()
            .iter()
            .map(|(key, amount)| (key.label(), *amount))
            .collect();
        rows.sort_by(|a, b| a.0.cmp(&b.0));
        rows
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::state::{HostKeyPolicy, SshAuth, SshTunnel};

    fn profile(driver: Driver, host: &str, port: u16) -> ConnectionProfile {
        ConnectionProfile {
            driver,
            host: host.into(),
            port,
            ..crate::testkit::profile("p")
        }
    }

    fn tunnel(host: &str, port: u16) -> SshTunnel {
        SshTunnel {
            host: host.into(),
            port,
            username: "ssh".into(),
            auth: SshAuth::Password,
            local_port: 0,
            host_key_policy: HostKeyPolicy::AcceptNew,
        }
    }

    #[test]
    fn sqlite_has_no_endpoint() {
        assert!(EndpointKey::for_profile(&profile(Driver::Sqlite, "", 0)).is_none());
    }

    #[test]
    fn host_case_and_padding_do_not_split_a_budget() {
        let a = EndpointKey::for_profile(&profile(Driver::Postgres, "DB.example.com", 5432));
        let b = EndpointKey::for_profile(&profile(Driver::Postgres, " db.example.com ", 5432));
        assert_eq!(a, b);
    }

    #[test]
    fn the_username_does_not_split_a_budget() {
        // The server's limit is global: connecting as a second user competes
        // for the same slots, it doesn't get its own allowance.
        let mut alice = profile(Driver::Postgres, "db", 5432);
        alice.username = "alice".into();
        let mut bob = profile(Driver::Postgres, "db", 5432);
        bob.username = "bob".into();
        assert_eq!(
            EndpointKey::for_profile(&alice),
            EndpointKey::for_profile(&bob)
        );
    }

    #[test]
    fn different_tunnels_to_the_same_named_host_are_different_endpoints() {
        // Each tunnel resolves `localhost` relative to its own SSH host, so
        // these are two unrelated servers that merely share a name.
        let mut via_a = profile(Driver::Postgres, "localhost", 5432);
        via_a.ssh_tunnel = Some(tunnel("bastion-a", 22));
        let mut via_b = profile(Driver::Postgres, "localhost", 5432);
        via_b.ssh_tunnel = Some(tunnel("bastion-b", 22));
        assert_ne!(
            EndpointKey::for_profile(&via_a),
            EndpointKey::for_profile(&via_b)
        );
    }

    fn key() -> EndpointKey {
        EndpointKey::for_profile(&profile(Driver::Postgres, "db", 5432)).unwrap()
    }

    #[test]
    fn separate_profiles_on_one_server_share_a_budget() {
        let registry = Arc::new(EndpointRegistry::default());
        let k = key();
        let _first = registry.reserve(&k, 5, 10, 2).unwrap();
        let second = registry.reserve(&k, 5, 10, 2).unwrap();
        assert_eq!(registry.in_use(&k), 10);
        // The third finds nothing left — the whole point: before this, each
        // profile got its own independent five.
        let err = registry.reserve(&k, 5, 10, 2).unwrap_err();
        assert_eq!(err.in_use, 10);
        assert_eq!(err.budget, 10);

        drop(second);
        assert_eq!(registry.in_use(&k), 5);
        assert!(registry.reserve(&k, 5, 10, 2).is_ok());
    }

    #[test]
    fn a_partial_grant_is_better_than_none() {
        let registry = Arc::new(EndpointRegistry::default());
        let k = key();
        let _big = registry.reserve(&k, 8, 10, 2).unwrap();
        let rest = registry.reserve(&k, 5, 10, 2).unwrap();
        assert_eq!(rest.amount(), 2, "trimmed to what was left, not refused");
    }

    #[test]
    fn a_grant_below_the_floor_is_refused_outright() {
        let registry = Arc::new(EndpointRegistry::default());
        let k = key();
        let _big = registry.reserve(&k, 9, 10, 2).unwrap();
        // One slot left, floor is two: handing out a single-connection pool
        // would deadlock a multi-statement batch, so refuse instead.
        assert!(registry.reserve(&k, 5, 10, 2).is_err());
    }

    #[test]
    fn a_request_larger_than_the_budget_is_trimmed_to_it() {
        let registry = Arc::new(EndpointRegistry::default());
        let k = key();
        let grant = registry.reserve(&k, 50, 6, 2).unwrap();
        assert_eq!(grant.amount(), 6);
    }

    #[test]
    fn releasing_everything_clears_the_endpoint_from_usage() {
        let registry = Arc::new(EndpointRegistry::default());
        let k = key();
        let grant = registry.reserve(&k, 4, 10, 2).unwrap();
        assert_eq!(registry.usage(), vec![("db:5432".to_string(), 4)]);
        drop(grant);
        assert!(registry.usage().is_empty());
    }
}
