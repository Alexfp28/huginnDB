//! Which database user a connection signs in as — the one place that decides.
//!
//! Phase 3 of managed policy (`docs/POLICY_ROADMAP.md` §7) gives each person
//! their own database user, so the database itself enforces what the policy
//! says instead of only HuginnDB. A shared origin publishes a connection with
//! the team's user (`erp_app`); a person connects as `alopez`, with their own
//! password, and the team's never has to reach their machine.
//!
//! The user is decided in this order:
//!
//! 1. **The policy**, when the rule for this endpoint carries a `dbUser`
//!    template. It is pinned: an organization that gives everyone their own
//!    database user does not want one of them signing in as the shared one.
//! 2. **The person's own choice** (`ConnectionProfile::personal_username`),
//!    kept on this machine only.
//! 3. **The connection's user**, as the profile (or the origin) has it.
//!
//! Everything that opens a pool goes through [`effective_profile`] first —
//! `connect_inner`, `test_connection`, a per-database view, the MCP sidecar's
//! `ensure_connected` — so the user the driver signs in as and the keychain
//! account the password is read from (`id::<user>`) can never disagree.

use crate::policy::SharedPolicy;
use crate::state::{ConnectionProfile, Driver};

/// Where a connection's personal user came from, for the interface.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub enum PersonalSource {
    /// A rule's `dbUser`: fixed by the organization.
    Policy,
    /// The person chose it on this machine.
    Local,
}

/// The personal user in force for `profile`, and where it came from; `None`
/// when the connection signs in with its own user.
pub fn personal_user(
    policy: &SharedPolicy,
    profile: &ConnectionProfile,
) -> Option<(String, PersonalSource)> {
    if profile.driver == Driver::Sqlite {
        // No users: a file is protected by its ACL alone.
        return None;
    }
    if let Some(user) = crate::policy::pinned_db_user(policy, profile) {
        return Some((user, PersonalSource::Policy));
    }
    profile
        .personal_username
        .as_deref()
        .map(str::trim)
        .filter(|u| !u.is_empty())
        .map(|u| (u.to_string(), PersonalSource::Local))
}

/// `profile` as it signs in: with the personal user in place of the
/// published one when there is one. A clone, for opening a pool — never
/// written back, so `profiles.json` keeps the connection as it was published.
///
/// On the copy, `personal_username` is set whenever a personal user is in
/// force, so [`crate::commands::connection::resolve_password`] can tell that
/// the password is the person's own and must be there, even on MongoDB (whose
/// password is otherwise optional).
pub fn effective_profile(policy: &SharedPolicy, profile: &ConnectionProfile) -> ConnectionProfile {
    let mut effective = profile.clone();
    let Some((user, _)) = personal_user(policy, profile) else {
        return effective;
    };
    if effective.driver == Driver::Mongo {
        // A MongoDB connection string carries its own user, and the driver
        // prefers it to anything we set — so the published user (and any
        // password embedded with it) is taken out of the string, and the
        // credential is built from the personal user and their own password.
        if let Some(cs) = effective.connection_string.as_deref() {
            effective.connection_string = Some(strip_uri_userinfo(cs));
        }
    }
    effective.username = user.clone();
    effective.personal_username = Some(user);
    effective
}

/// `mongodb://user:pass@h1,h2/db?x` → `mongodb://h1,h2/db?x`. The authority
/// ends at the first `/` or `?` after the scheme (a host list cannot contain
/// either), and its user info is everything up to the **last** `@` in it —
/// a password may contain an `@` only percent-encoded, but a sloppy one is
/// still better cut at the last than the first.
fn strip_uri_userinfo(uri: &str) -> String {
    let Some(scheme_end) = uri.find("://").map(|i| i + 3) else {
        return uri.to_string();
    };
    let rest = &uri[scheme_end..];
    let authority_end = rest.find(['/', '?']).unwrap_or(rest.len());
    match rest[..authority_end].rfind('@') {
        Some(at) => format!("{}{}", &uri[..scheme_end], &rest[at + 1..]),
        None => uri.to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::policy::PolicyState;
    use crate::testkit;
    use parking_lot::RwLock;
    use std::sync::Arc;

    fn unmanaged() -> SharedPolicy {
        Arc::new(RwLock::new(PolicyState::Unmanaged))
    }

    /// A policy whose `dbUser` on `erp.local` is `template`, for whoever runs
    /// the tests (the rules match the OS account through `defaultRole`).
    fn pinning(template: &str) -> SharedPolicy {
        let text = format!(
            r#"{{
                "version": 1, "defaultRole": "staff",
                "roles": {{ "staff": {{ "rules": [
                    {{ "endpoint": {{ "host": "other.local" }}, "dbUser": "nope" }},
                    {{ "endpoint": {{ "host": "erp.local" }}, "dbUser": {template:?},
                       "human": ["select"] }}
                ] }} }}
            }}"#
        );
        let (doc, _) = crate::policy::model::PolicyDoc::parse(&text).unwrap();
        Arc::new(RwLock::new(PolicyState::Active {
            doc: Arc::new(doc),
            source: "test".into(),
            warnings: Vec::new(),
        }))
    }

    fn erp() -> ConnectionProfile {
        ConnectionProfile {
            driver: Driver::Postgres,
            host: "erp.local".into(),
            username: "erp_app".into(),
            ..testkit::profile("erp")
        }
    }

    #[test]
    fn without_a_personal_user_the_published_one_signs_in() {
        let p = effective_profile(&unmanaged(), &erp());
        assert_eq!(p.username, "erp_app");
        assert_eq!(p.personal_username, None);
        assert_eq!(p.keyring_account(), "erp::erp_app");
    }

    #[test]
    fn a_local_choice_replaces_the_user_and_the_keychain_account() {
        let profile = ConnectionProfile {
            personal_username: Some(" alopez ".into()),
            ..erp()
        };
        let p = effective_profile(&unmanaged(), &profile);
        assert_eq!(p.username, "alopez");
        assert_eq!(p.keyring_account(), "erp::alopez");
        assert_eq!(
            personal_user(&unmanaged(), &profile),
            Some(("alopez".into(), PersonalSource::Local))
        );
    }

    #[test]
    fn the_policy_pins_the_user_over_a_local_choice() {
        let user = crate::policy::current_user();
        if user.is_empty() {
            return;
        }
        let profile = ConnectionProfile {
            personal_username: Some("someone_else".into()),
            ..erp()
        };
        let expected = format!("{}_ro", crate::policy::model::normalise_user(user));
        let (got, source) = personal_user(&pinning("{user}_ro"), &profile).unwrap();
        assert_eq!(
            (got.as_str(), source),
            (expected.as_str(), PersonalSource::Policy)
        );
        // A rule for another endpoint pins nothing here.
        let elsewhere = ConnectionProfile {
            host: "crm.local".into(),
            ..erp()
        };
        assert_eq!(personal_user(&pinning("{user}"), &elsewhere), None);
    }

    #[test]
    fn sqlite_has_no_users_to_pin() {
        let file = ConnectionProfile {
            driver: Driver::Sqlite,
            personal_username: Some("alopez".into()),
            ..testkit::profile("f")
        };
        assert_eq!(personal_user(&unmanaged(), &file), None);
    }

    #[test]
    fn a_mongo_uri_loses_the_published_user_and_password() {
        let profile = ConnectionProfile {
            driver: Driver::Mongo,
            connection_string: Some(
                "mongodb://erp_app:s%40cret@h1:27017,h2:27017/billing?authSource=admin".into(),
            ),
            personal_username: Some("alopez".into()),
            ..erp()
        };
        let p = effective_profile(&unmanaged(), &profile);
        assert_eq!(
            p.connection_string.as_deref(),
            Some("mongodb://h1:27017,h2:27017/billing?authSource=admin")
        );
        assert_eq!(p.username, "alopez");
    }

    #[test]
    fn stripping_leaves_a_uri_without_user_info_alone() {
        for uri in [
            "mongodb://h1/db",
            "mongodb+srv://cluster.example.net/?retryWrites=true",
            "mongodb://h1/db?note=a@b",
        ] {
            assert_eq!(strip_uri_userinfo(uri), uri);
        }
        assert_eq!(
            strip_uri_userinfo("mongodb+srv://u:p@cluster.example.net"),
            "mongodb+srv://cluster.example.net"
        );
    }
}
