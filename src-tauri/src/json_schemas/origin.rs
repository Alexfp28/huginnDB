//! Merging the JSON Schema slice a shared origin publishes into this machine's
//! library.
//!
//! Deliberately **not** [`super::import::apply_imports`], and the difference is
//! the whole reason this file exists. That one is a *one-shot import*: it mints a
//! fresh uuid for every entry, clears `origin_id`, and resolves conflicts by
//! **name**, because two machines mint independent ids for "the same" schema and
//! an id can therefore never collide. All three are right for a file the user
//! picked once.
//!
//! A continuous origin sync is the other shape entirely, and it is the shape
//! [`crate::commands::origins::merge_into`] already has for profiles: the ids in
//! the file *are* the identity, they are stable across syncs, and an entry is
//! only ever refreshed when this origin already owns it. Re-importing by name on
//! every pull would either duplicate the library (`cfg (2)`, `cfg (3)`, … every
//! four hours) or silently adopt a locally-authored schema that happens to share
//! a name.
//!
//! Two rules carry over from elsewhere and must not be re-decided here:
//!
//! * **A binding naming a connection this machine does not have arrives
//!   `enabled: false`.** Widening it to a wildcard would change what the rule
//!   means; dropping it would lose the intent with no way to notice. Same rule
//!   `import::apply_imports` follows, documented in `docs/JSON_SCHEMAS.md`.
//! * **Nothing here deletes.** Disappearances are counted and reported, exactly
//!   like a profile's (`OriginSyncReport`'s type-level note): another user's edit
//!   to a shared file must not destroy what is on this machine. The counts are
//!   what tells the user to go and tidy up.

use std::collections::HashSet;

use super::{JsonSchemaBinding, JsonSchemaItem, JsonSchemaLibrary, JsonSchemaSource};
use crate::transfer::JsonSchemaBundle;

/// What one origin's schema slice did to the library.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct OriginSchemaMerge {
    pub schemas_added: usize,
    pub schemas_updated: usize,
    /// Owned by this origin locally, absent from the file. Reported only.
    pub schemas_vanished: usize,
    pub bindings_added: usize,
    pub bindings_updated: usize,
    pub bindings_vanished: usize,
    /// Landed with `enabled: false` because they name a connection this machine
    /// does not have.
    pub bindings_disabled: usize,
}

/// Apply `bundle` to `lib` as the published state of `origin_id`.
///
/// Pure: no disk, no keychain, no clock beyond the `now` it is handed. `known`
/// is the set of connection ids this machine has, injected for the same reason
/// `already_landed`'s `present` is — the disabling rule is then testable without
/// a profile store.
pub fn merge_origin_bundle(
    lib: &mut JsonSchemaLibrary,
    origin_id: &str,
    bundle: &JsonSchemaBundle,
    known: &HashSet<String>,
    now: &str,
) -> OriginSchemaMerge {
    let mut report = OriginSchemaMerge::default();

    let incoming_schema_ids: HashSet<&str> = bundle.schemas.iter().map(|s| s.id.as_str()).collect();
    let incoming_binding_ids: HashSet<&str> =
        bundle.bindings.iter().map(|b| b.id.as_str()).collect();

    report.schemas_vanished = lib
        .schemas
        .iter()
        .filter(|s| s.origin_id.as_deref() == Some(origin_id))
        .filter(|s| !incoming_schema_ids.contains(s.id.as_str()))
        .count();
    report.bindings_vanished = lib
        .bindings
        .iter()
        .filter(|b| b.origin_id.as_deref() == Some(origin_id))
        .filter(|b| !incoming_binding_ids.contains(b.id.as_str()))
        .count();

    // Names an origin-owned entry may not take: whatever a *locally* authored
    // one already holds. The published name wins over another origin's, since
    // both are mirrors and neither is the user's own work.
    let local_names: HashSet<String> = lib
        .schemas
        .iter()
        .filter(|s| s.origin_id.is_none())
        .map(|s| s.name.clone())
        .collect();

    for incoming in &bundle.schemas {
        match lib.schemas.iter_mut().find(|s| s.id == incoming.id) {
            Some(existing) => {
                // Only ever refresh an entry this origin already owns. A local
                // schema that happens to share an id (an earlier import, later
                // detached) is the user's, not the file's — the same ownership
                // rule `merge_into` applies one level up.
                if existing.origin_id.as_deref() != Some(origin_id) {
                    continue;
                }
                existing.name = disambiguated(&incoming.name, &local_names);
                existing.description = incoming.description.clone();
                existing.body = incoming.body.clone();
                existing.updated_at = now.to_string();
                report.schemas_updated += 1;
            }
            None => {
                lib.schemas.push(JsonSchemaItem {
                    id: incoming.id.clone(),
                    name: disambiguated(&incoming.name, &local_names),
                    description: incoming.description.clone(),
                    body: incoming.body.clone(),
                    created_at: now.to_string(),
                    updated_at: now.to_string(),
                    source: JsonSchemaSource::Imported,
                    origin_id: Some(origin_id.to_string()),
                });
                report.schemas_added += 1;
            }
        }
    }

    // A binding whose schema is not in the library after the loop above would
    // resolve to nothing, so it is skipped rather than inserted dangling.
    let present: HashSet<&str> = lib.schemas.iter().map(|s| s.id.as_str()).collect();
    let mut next_order = lib.bindings.iter().map(|b| b.order).max().unwrap_or(0) + 1;

    for incoming in &bundle.bindings {
        if !present.contains(incoming.schema_id.as_str()) {
            continue;
        }
        let resolvable = incoming
            .connection_id
            .as_deref()
            .map(|id| known.contains(id))
            .unwrap_or(true);
        if !resolvable {
            report.bindings_disabled += 1;
        }
        let enabled = incoming.enabled && resolvable;

        match lib.bindings.iter_mut().find(|b| b.id == incoming.id) {
            Some(existing) => {
                if existing.origin_id.as_deref() != Some(origin_id) {
                    continue;
                }
                let order = existing.order;
                *existing = JsonSchemaBinding {
                    enabled,
                    order,
                    origin_id: Some(origin_id.to_string()),
                    ..incoming.clone()
                };
                report.bindings_updated += 1;
            }
            None => {
                lib.bindings.push(JsonSchemaBinding {
                    enabled,
                    order: next_order,
                    origin_id: Some(origin_id.to_string()),
                    ..incoming.clone()
                });
                next_order += 1;
                report.bindings_added += 1;
            }
        }
    }

    report
}

/// Keep a published name out of a locally-authored one's way, without touching
/// the local entry. `HashMap`-free on purpose: the collision is rare and the
/// ladder is the shared one every importer uses.
fn disambiguated(name: &str, local_names: &HashSet<String>) -> String {
    if !local_names.contains(name) {
        return name.to_string();
    }
    crate::transfer::disambiguate_name(name, local_names.iter().map(String::as_str))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn library() -> JsonSchemaLibrary {
        JsonSchemaLibrary::default()
    }

    fn schema(id: &str, name: &str, body: &str) -> JsonSchemaItem {
        JsonSchemaItem {
            id: id.into(),
            name: name.into(),
            description: None,
            body: body.into(),
            created_at: "2026-01-01T00:00:00Z".into(),
            updated_at: "2026-01-01T00:00:00Z".into(),
            source: JsonSchemaSource::Manual,
            origin_id: None,
        }
    }

    fn binding(id: &str, schema_id: &str, connection: Option<&str>) -> JsonSchemaBinding {
        JsonSchemaBinding {
            id: id.into(),
            schema_id: schema_id.into(),
            connection_id: connection.map(str::to_string),
            column: "payload".into(),
            ..JsonSchemaBinding::default()
        }
    }

    fn bundle(schemas: Vec<JsonSchemaItem>, bindings: Vec<JsonSchemaBinding>) -> JsonSchemaBundle {
        JsonSchemaBundle { schemas, bindings }
    }

    fn known(ids: &[&str]) -> HashSet<String> {
        ids.iter().map(|s| s.to_string()).collect()
    }

    /// The identity is the **id**, not the name — which is what keeps a
    /// four-hourly poll from growing `cfg (2)`, `cfg (3)`, … forever. That is
    /// exactly what would happen if this reused the one-shot importer.
    #[test]
    fn syncing_twice_adds_nothing_the_second_time() {
        let mut lib = library();
        let b = bundle(
            vec![schema("s1", "cfg", "{}")],
            vec![binding("b1", "s1", None)],
        );

        let first = merge_origin_bundle(&mut lib, "o1", &b, &known(&[]), "now");
        assert_eq!(1, first.schemas_added);
        assert_eq!(1, first.bindings_added);

        let second = merge_origin_bundle(&mut lib, "o1", &b, &known(&[]), "now");
        assert_eq!(0, second.schemas_added);
        assert_eq!(1, second.schemas_updated);
        assert_eq!(1, lib.schemas.len());
        assert_eq!(1, lib.bindings.len());
    }

    /// A refresh overwrites the body but keeps the entry — bindings already
    /// pointing at it keep working.
    #[test]
    fn a_refresh_updates_the_body_in_place() {
        let mut lib = library();
        merge_origin_bundle(
            &mut lib,
            "o1",
            &bundle(vec![schema("s1", "cfg", "{}")], vec![]),
            &known(&[]),
            "t1",
        );
        merge_origin_bundle(
            &mut lib,
            "o1",
            &bundle(vec![schema("s1", "cfg", r#"{"type":"object"}"#)], vec![]),
            &known(&[]),
            "t2",
        );
        assert_eq!(r#"{"type":"object"}"#, lib.schemas[0].body);
        assert_eq!("t2", lib.schemas[0].updated_at);
        assert_eq!(Some("o1"), lib.schemas[0].origin_id.as_deref());
    }

    /// A locally-authored entry is the user's, even when it shares an id with
    /// something the origin publishes. Same ownership rule as `merge_into`.
    #[test]
    fn a_local_schema_is_never_overwritten() {
        let mut lib = library();
        lib.schemas.push(schema("s1", "mine", "{}"));
        let report = merge_origin_bundle(
            &mut lib,
            "o1",
            &bundle(vec![schema("s1", "theirs", "{}")], vec![]),
            &known(&[]),
            "now",
        );
        assert_eq!(0, report.schemas_updated);
        assert_eq!("mine", lib.schemas[0].name);
        assert_eq!(None, lib.schemas[0].origin_id);
    }

    /// A published name that collides with a locally-authored one steps aside
    /// rather than renaming the user's entry.
    #[test]
    fn a_published_name_yields_to_a_local_one() {
        let mut lib = library();
        lib.schemas.push(schema("local", "cfg", "{}"));
        merge_origin_bundle(
            &mut lib,
            "o1",
            &bundle(vec![schema("s1", "cfg", "{}")], vec![]),
            &known(&[]),
            "now",
        );
        assert_eq!("cfg", lib.schemas[0].name);
        assert_eq!("cfg (imported)", lib.schemas[1].name);
    }

    /// The documented rule: a rule naming a connection this machine does not
    /// have arrives **disabled**, keeping its original pin. Widening it would
    /// change what it means; dropping it would lose the intent silently.
    #[test]
    fn a_binding_for_an_unknown_connection_lands_disabled() {
        let mut lib = library();
        let report = merge_origin_bundle(
            &mut lib,
            "o1",
            &bundle(
                vec![schema("s1", "cfg", "{}")],
                vec![
                    binding("b1", "s1", Some("known-conn")),
                    binding("b2", "s1", Some("absent-conn")),
                ],
            ),
            &known(&["known-conn"]),
            "now",
        );
        assert_eq!(1, report.bindings_disabled);
        assert!(lib.bindings.iter().find(|b| b.id == "b1").unwrap().enabled);
        let orphan = lib.bindings.iter().find(|b| b.id == "b2").unwrap();
        assert!(!orphan.enabled);
        assert_eq!(Some("absent-conn"), orphan.connection_id.as_deref());
    }

    /// A binding whose schema was skipped (because it is locally owned, so the
    /// incoming one was never inserted) would resolve to nothing.
    #[test]
    fn a_binding_without_its_schema_is_skipped() {
        let mut lib = library();
        let report = merge_origin_bundle(
            &mut lib,
            "o1",
            &bundle(vec![], vec![binding("b1", "missing", None)]),
            &known(&[]),
            "now",
        );
        assert_eq!(0, report.bindings_added);
        assert!(lib.bindings.is_empty());
    }

    /// Nothing here deletes: a disappearance is counted so the user can act on
    /// it, exactly like a vanished profile.
    #[test]
    fn a_disappearance_is_reported_not_applied() {
        let mut lib = library();
        merge_origin_bundle(
            &mut lib,
            "o1",
            &bundle(
                vec![schema("s1", "cfg", "{}")],
                vec![binding("b1", "s1", None)],
            ),
            &known(&[]),
            "now",
        );
        let report =
            merge_origin_bundle(&mut lib, "o1", &bundle(vec![], vec![]), &known(&[]), "now");
        assert_eq!(1, report.schemas_vanished);
        assert_eq!(1, report.bindings_vanished);
        assert_eq!(1, lib.schemas.len(), "still there");
        assert_eq!(1, lib.bindings.len());
    }
}
