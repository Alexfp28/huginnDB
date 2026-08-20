//! Tests for the import merge, the export slice, and the connection-id rules.
//!
//! The `connection_id` cases are the ones that matter most: every other
//! outcome here is visible to the user, but a binding that arrives pointing at
//! the wrong server, or silently widened to "any server", is not.

use std::collections::{HashMap, HashSet};

use super::import::*;
use super::{JsonSchemaBinding, JsonSchemaItem, JsonSchemaLibrary, JsonSchemaSource};
use crate::transfer::{ConflictAction, JsonSchemaBundle};

const NOW: &str = "2026-08-19T12:00:00Z";

fn item(id: &str, name: &str, body: &str) -> JsonSchemaItem {
    JsonSchemaItem {
        id: id.into(),
        name: name.into(),
        body: body.into(),
        created_at: "2020-01-01T00:00:00Z".into(),
        updated_at: "2020-01-01T00:00:00Z".into(),
        ..Default::default()
    }
}

fn binding(schema_id: &str, conn: Option<&str>, column: &str) -> JsonSchemaBinding {
    JsonSchemaBinding {
        id: format!("incoming-{column}"),
        schema_id: schema_id.into(),
        connection_id: conn.map(str::to_string),
        column: column.into(),
        ..Default::default()
    }
}

fn bundle(schemas: Vec<JsonSchemaItem>, bindings: Vec<JsonSchemaBinding>) -> JsonSchemaBundle {
    JsonSchemaBundle { schemas, bindings }
}

fn known(ids: &[&str]) -> HashSet<String> {
    ids.iter().map(|s| s.to_string()).collect()
}

fn no_resolutions() -> HashMap<String, ConflictAction> {
    HashMap::new()
}

// -- schemas --------------------------------------------------------------

#[test]
fn import_assigns_fresh_ids_and_rewires_bindings_to_them() {
    let mut lib = JsonSchemaLibrary::default();
    let result = apply_imports(
        &mut lib,
        bundle(
            vec![item("file-id", "cfg", "{}")],
            vec![binding("file-id", None, "payload")],
        ),
        &no_resolutions(),
        &ConnectionRemap::LocalOnly(&known(&[])),
        NOW,
    );
    assert_eq!(result.imported, vec!["cfg".to_string()]);
    assert_eq!(lib.schemas.len(), 1);
    // Never adopts the id from the file.
    assert_ne!(lib.schemas[0].id, "file-id");
    // …and the binding follows the new id, not the old one.
    assert_eq!(lib.bindings[0].schema_id, lib.schemas[0].id);
    assert_eq!(result.bindings_imported, 1);
}

#[test]
fn import_marks_every_schema_as_imported_and_strips_origin_id() {
    let mut lib = JsonSchemaLibrary::default();
    let mut incoming = item("file-id", "cfg", "{}");
    // An origin id minted on another machine names an origin this one has never
    // registered; carrying it over would make the next sync think it owns this.
    incoming.origin_id = Some("someone-elses-origin".into());
    apply_imports(
        &mut lib,
        bundle(vec![incoming], vec![]),
        &no_resolutions(),
        &ConnectionRemap::LocalOnly(&known(&[])),
        NOW,
    );
    assert_eq!(lib.schemas[0].source, JsonSchemaSource::Imported);
    assert_eq!(lib.schemas[0].origin_id, None);
}

#[test]
fn conflicts_are_detected_by_name_not_by_id() {
    let existing = vec![item("local-1", "cfg", "{}")];
    // Same name, different id — the realistic case, since two machines mint
    // independent uuids for "the same" schema.
    let incoming = vec![item("file-9", "cfg", "{}")];
    let conflicts = detect_conflicts(&existing, &incoming);
    assert_eq!(conflicts.len(), 1);
    // Keyed on the *incoming* id, which is what the frontend echoes back.
    assert_eq!(conflicts[0].id, "file-9");
    assert_eq!(conflicts[0].existing_name, "cfg");

    // An id collision with a different name is NOT a conflict here.
    assert!(detect_conflicts(&existing, &[item("local-1", "other", "{}")]).is_empty());
}

#[test]
fn import_overwrite_keeps_the_local_id_and_created_at() {
    // Keeping the id is what stops local bindings that already point at this
    // entry from being orphaned by an overwrite.
    let mut lib = JsonSchemaLibrary::default();
    lib.schemas.push(item("local-1", "cfg", "{\"old\":true}"));
    lib.bindings.push(JsonSchemaBinding {
        id: "local-binding".into(),
        schema_id: "local-1".into(),
        column: "payload".into(),
        ..Default::default()
    });

    let mut resolutions = no_resolutions();
    resolutions.insert("file-9".into(), ConflictAction::Overwrite);
    let result = apply_imports(
        &mut lib,
        bundle(vec![item("file-9", "cfg", "{\"new\":true}")], vec![]),
        &resolutions,
        &ConnectionRemap::LocalOnly(&known(&[])),
        NOW,
    );

    assert_eq!(result.overwritten, vec!["cfg".to_string()]);
    assert_eq!(lib.schemas.len(), 1);
    assert_eq!(lib.schemas[0].id, "local-1");
    assert_eq!(lib.schemas[0].created_at, "2020-01-01T00:00:00Z");
    assert_eq!(lib.schemas[0].updated_at, NOW);
    assert_eq!(lib.schemas[0].body, "{\"new\":true}");
    // The pre-existing binding still resolves.
    assert_eq!(lib.bindings[0].schema_id, "local-1");
}

#[test]
fn import_skip_drops_the_schema_and_its_bindings() {
    let mut lib = JsonSchemaLibrary::default();
    lib.schemas.push(item("local-1", "cfg", "{}"));

    let mut resolutions = no_resolutions();
    resolutions.insert("file-9".into(), ConflictAction::Skip);
    let result = apply_imports(
        &mut lib,
        bundle(
            vec![item("file-9", "cfg", "{}")],
            vec![binding("file-9", None, "payload")],
        ),
        &resolutions,
        &ConnectionRemap::LocalOnly(&known(&[])),
        NOW,
    );

    assert_eq!(result.skipped, vec!["cfg".to_string()]);
    assert_eq!(lib.schemas.len(), 1);
    // A binding with no schema is a dangling pointer, not a rule to re-enable.
    assert_eq!(result.bindings_dropped, 1);
    assert!(lib.bindings.is_empty());
}

#[test]
fn import_rename_disambiguates_with_imported_then_numbers() {
    let mut lib = JsonSchemaLibrary::default();
    lib.schemas.push(item("local-1", "cfg", "{}"));
    let mut resolutions = no_resolutions();
    resolutions.insert("file-9".into(), ConflictAction::Rename);
    let result = apply_imports(
        &mut lib,
        bundle(vec![item("file-9", "cfg", "{}")], vec![]),
        &resolutions,
        &ConnectionRemap::LocalOnly(&known(&[])),
        NOW,
    );
    assert_eq!(
        result.renamed,
        vec![("cfg".to_string(), "cfg (imported)".to_string())]
    );
    assert_eq!(lib.schemas.len(), 2);
}

#[test]
fn an_unresolved_conflict_defaults_to_skip_not_rename() {
    // Matches `apply_profile_imports`. Renaming would make re-importing your own
    // export accumulate `cfg (imported)`, `cfg (2)`, … on every round trip, which
    // is the dominant real case; a genuinely different schema is still one click
    // from Rename or Overwrite in the conflict step.
    let mut lib = JsonSchemaLibrary::default();
    lib.schemas.push(item("local-1", "cfg", "{\"old\":true}"));
    let result = apply_imports(
        &mut lib,
        bundle(vec![item("file-9", "cfg", "{\"new\":true}")], vec![]),
        &no_resolutions(),
        &ConnectionRemap::LocalOnly(&known(&[])),
        NOW,
    );
    assert_eq!(result.skipped, vec!["cfg".to_string()]);
    assert!(result.imported.is_empty());
    assert!(result.renamed.is_empty());
    assert_eq!(lib.schemas.len(), 1, "no duplicate schema must be created");
    assert_eq!(lib.schemas[0].body, "{\"old\":true}");
}

#[test]
fn an_unresolved_non_conflict_is_still_inserted() {
    // The `Skip` default applies only to a *conflict*: an incoming schema whose
    // name is free must still land, or an import of new material would do nothing.
    let mut lib = JsonSchemaLibrary::default();
    let result = apply_imports(
        &mut lib,
        bundle(
            vec![item("file-9", "brand-new", "{}")],
            vec![binding("file-9", None, "payload")],
        ),
        &no_resolutions(),
        &ConnectionRemap::LocalOnly(&known(&[])),
        NOW,
    );
    assert_eq!(result.imported, vec!["brand-new".to_string()]);
    assert!(result.skipped.is_empty());
    assert_eq!(lib.schemas.len(), 1);
    // …and its bindings come with it.
    assert_eq!(result.bindings_imported, 1);
}

#[test]
fn re_importing_an_identical_file_is_a_no_op() {
    // The property the `Skip` default exists for: the round trip that motivated
    // the change must leave the library byte-identical.
    let mut lib = JsonSchemaLibrary::default();
    lib.schemas.push(item("local-1", "cfg", "{}"));
    lib.bindings.push(binding("local-1", None, "payload"));
    let before = (lib.schemas.len(), lib.bindings.len());

    let result = apply_imports(
        &mut lib,
        bundle(
            vec![item("file-9", "cfg", "{}")],
            vec![binding("file-9", None, "payload")],
        ),
        &no_resolutions(),
        &ConnectionRemap::LocalOnly(&known(&[])),
        NOW,
    );

    assert_eq!((lib.schemas.len(), lib.bindings.len()), before);
    assert_eq!(result.skipped, vec!["cfg".to_string()]);
    // The binding is dropped rather than duplicated: its schema was skipped, so
    // it has nothing local to point at.
    assert_eq!(result.bindings_dropped, 1);
    assert_eq!(result.bindings_imported, 0);
}

#[test]
fn an_overwrite_resolution_for_a_vanished_conflict_falls_back_to_inserting() {
    let mut lib = JsonSchemaLibrary::default();
    let mut resolutions = no_resolutions();
    resolutions.insert("file-9".into(), ConflictAction::Overwrite);
    let result = apply_imports(
        &mut lib,
        bundle(vec![item("file-9", "cfg", "{}")], vec![]),
        &resolutions,
        &ConnectionRemap::LocalOnly(&known(&[])),
        NOW,
    );
    assert_eq!(result.imported, vec!["cfg".to_string()]);
    assert!(result.overwritten.is_empty());
    assert_eq!(lib.schemas.len(), 1);
}

// -- bindings and the connection-id rules ---------------------------------

#[test]
fn import_leaves_a_global_binding_untouched_and_enabled() {
    let mut lib = JsonSchemaLibrary::default();
    let result = apply_imports(
        &mut lib,
        bundle(
            vec![item("file-id", "cfg", "{}")],
            vec![binding("file-id", None, "payload")],
        ),
        &no_resolutions(),
        &ConnectionRemap::LocalOnly(&known(&[])),
        NOW,
    );
    assert_eq!(result.bindings_disabled, 0);
    assert!(lib.bindings[0].enabled);
    assert_eq!(lib.bindings[0].connection_id, None);
}

#[test]
fn import_keeps_a_binding_enabled_when_its_connection_exists_locally() {
    // Re-importing your own file on the same machine works completely.
    let mut lib = JsonSchemaLibrary::default();
    let result = apply_imports(
        &mut lib,
        bundle(
            vec![item("file-id", "cfg", "{}")],
            vec![binding("file-id", Some("conn-1"), "payload")],
        ),
        &no_resolutions(),
        &ConnectionRemap::LocalOnly(&known(&["conn-1"])),
        NOW,
    );
    assert_eq!(result.bindings_disabled, 0);
    assert!(lib.bindings[0].enabled);
    assert_eq!(lib.bindings[0].connection_id.as_deref(), Some("conn-1"));
}

#[test]
fn import_disables_a_binding_whose_connection_is_unknown_here_but_keeps_the_id() {
    // Disable, never widen and never silently drop. The original id is the only
    // record of what the rule meant, and it is inert while disabled.
    let mut lib = JsonSchemaLibrary::default();
    let result = apply_imports(
        &mut lib,
        bundle(
            vec![item("file-id", "cfg", "{}")],
            vec![binding("file-id", Some("their-conn"), "payload")],
        ),
        &no_resolutions(),
        &ConnectionRemap::LocalOnly(&known(&["mine"])),
        NOW,
    );
    assert_eq!(result.bindings_disabled, 1);
    assert_eq!(result.bindings_imported, 1);
    assert!(!lib.bindings[0].enabled);
    assert_eq!(
        lib.bindings[0].connection_id.as_deref(),
        Some("their-conn"),
        "widening to a wildcard would change what the rule means"
    );
}

#[test]
fn import_translates_connection_ids_through_the_environment_id_map() {
    let mut lib = JsonSchemaLibrary::default();
    let mut id_map = HashMap::new();
    id_map.insert("orig-conn".to_string(), "fresh-conn".to_string());
    let result = apply_imports(
        &mut lib,
        bundle(
            vec![item("file-id", "cfg", "{}")],
            vec![binding("file-id", Some("orig-conn"), "payload")],
        ),
        &no_resolutions(),
        &ConnectionRemap::IdMap(&id_map),
        NOW,
    );
    assert_eq!(result.bindings_disabled, 0);
    assert_eq!(lib.bindings[0].connection_id.as_deref(), Some("fresh-conn"));
}

#[test]
fn import_disables_a_binding_whose_profile_was_skipped() {
    // A skipped profile has no entry in the id map at all.
    let mut lib = JsonSchemaLibrary::default();
    let result = apply_imports(
        &mut lib,
        bundle(
            vec![item("file-id", "cfg", "{}")],
            vec![binding("file-id", Some("skipped-conn"), "payload")],
        ),
        &no_resolutions(),
        &ConnectionRemap::IdMap(&HashMap::new()),
        NOW,
    );
    assert_eq!(result.bindings_disabled, 1);
    assert!(!lib.bindings[0].enabled);
}

#[test]
fn import_is_idempotent_for_an_identical_binding() {
    let mut lib = JsonSchemaLibrary::default();
    lib.schemas.push(item("local-1", "cfg", "{}"));
    lib.bindings.push(JsonSchemaBinding {
        id: "existing".into(),
        schema_id: "local-1".into(),
        column: "payload".into(),
        ..Default::default()
    });

    let mut resolutions = no_resolutions();
    resolutions.insert("file-9".into(), ConflictAction::Overwrite);
    let result = apply_imports(
        &mut lib,
        bundle(
            vec![item("file-9", "cfg", "{}")],
            vec![binding("file-9", None, "payload")],
        ),
        &resolutions,
        &ConnectionRemap::LocalOnly(&known(&[])),
        NOW,
    );
    assert_eq!(result.bindings_duplicate, 1);
    assert_eq!(result.bindings_imported, 0);
    assert_eq!(lib.bindings.len(), 1);
}

#[test]
fn import_orders_new_bindings_after_the_existing_ones() {
    let mut lib = JsonSchemaLibrary::default();
    lib.schemas.push(item("local-1", "cfg", "{}"));
    lib.bindings.push(JsonSchemaBinding {
        id: "existing".into(),
        schema_id: "local-1".into(),
        column: "old".into(),
        order: 4,
        ..Default::default()
    });
    apply_imports(
        &mut lib,
        bundle(
            vec![item("file-9", "other", "{}")],
            vec![binding("file-9", None, "a"), binding("file-9", None, "b")],
        ),
        &no_resolutions(),
        &ConnectionRemap::LocalOnly(&known(&[])),
        NOW,
    );
    assert_eq!(lib.bindings[1].order, 5);
    assert_eq!(lib.bindings[2].order, 6);
}

#[test]
fn a_binding_that_fails_normalisation_is_dropped_not_stored() {
    let mut lib = JsonSchemaLibrary::default();
    let result = apply_imports(
        &mut lib,
        bundle(
            vec![item("file-id", "cfg", "{}")],
            vec![binding("file-id", None, "   ")],
        ),
        &no_resolutions(),
        &ConnectionRemap::LocalOnly(&known(&[])),
        NOW,
    );
    assert_eq!(result.bindings_dropped, 1);
    assert!(lib.bindings.is_empty());
}

#[test]
fn count_unresolvable_matches_what_the_import_will_disable() {
    // The analysis step and the import must agree, or the wizard promises a
    // number the result contradicts.
    let b = bundle(
        vec![item("file-id", "cfg", "{}")],
        vec![
            binding("file-id", None, "global"),
            binding("file-id", Some("mine"), "local"),
            binding("file-id", Some("theirs"), "foreign"),
        ],
    );
    let ids = known(&["mine"]);
    assert_eq!(count_unresolvable(&b, &ConnectionRemap::LocalOnly(&ids)), 1);

    let mut lib = JsonSchemaLibrary::default();
    let result = apply_imports(
        &mut lib,
        b,
        &no_resolutions(),
        &ConnectionRemap::LocalOnly(&ids),
        NOW,
    );
    assert_eq!(result.bindings_disabled, 1);
}

// -- export slice ---------------------------------------------------------

#[test]
fn collect_bundle_excludes_bindings_pointing_outside_the_selection() {
    // A binding for a schema that is not travelling would be dangling the
    // moment the file is opened elsewhere.
    let mut lib = JsonSchemaLibrary::default();
    lib.schemas.push(item("s1", "one", "{}"));
    lib.schemas.push(item("s2", "two", "{}"));
    lib.bindings.push(binding("s1", None, "kept"));
    lib.bindings.push(binding("s2", None, "dropped"));

    let out = collect_bundle(&lib, &["s1".to_string()], true);
    assert_eq!(out.schemas.len(), 1);
    assert_eq!(out.bindings.len(), 1);
    assert_eq!(out.bindings[0].column, "kept");
}

#[test]
fn collect_bundle_can_ship_schemas_without_their_bindings() {
    // The common case for sharing: the receiver's tables are named differently,
    // and the pinned bindings are precisely the non-portable part.
    let mut lib = JsonSchemaLibrary::default();
    lib.schemas.push(item("s1", "one", "{}"));
    lib.bindings.push(binding("s1", None, "payload"));

    let out = collect_bundle(&lib, &["s1".to_string()], false);
    assert_eq!(out.schemas.len(), 1);
    assert!(out.bindings.is_empty());
}

#[test]
fn collect_bundle_ignores_ids_that_do_not_exist() {
    let lib = JsonSchemaLibrary::default();
    assert!(collect_bundle(&lib, &["ghost".to_string()], true).is_empty());
}
