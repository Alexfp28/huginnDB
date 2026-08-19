//! Unit tests for the library model, the glob matcher and the cascade.
//!
//! In a file of their own rather than an inline `mod tests` because
//! `mod.rs` is already long, and because the cascade is the part of this
//! feature whose failure mode is silent — a mis-ranked binding produces "no
//! autocompletion", which nobody reports as a bug.

use super::*;

fn schema(id: &str, name: &str) -> JsonSchemaItem {
    JsonSchemaItem {
        id: id.into(),
        name: name.into(),
        body: r#"{"type":"object"}"#.into(),
        created_at: "2026-08-19T00:00:00Z".into(),
        updated_at: "2026-08-19T00:00:00Z".into(),
        ..Default::default()
    }
}

/// Builder for the axes under test; everything else stays at its default.
fn binding(
    id: &str,
    schema_id: &str,
    conn: Option<&str>,
    db: Option<&str>,
    table: Option<&str>,
    column: &str,
) -> JsonSchemaBinding {
    JsonSchemaBinding {
        id: id.into(),
        schema_id: schema_id.into(),
        connection_id: conn.map(str::to_string),
        db_schema: db.map(str::to_string),
        table: table.map(str::to_string),
        column: column.into(),
        ..Default::default()
    }
}

fn target<'a>(
    conn: Option<&'a str>,
    db: Option<&'a str>,
    table: Option<&'a str>,
    column: &'a str,
) -> ResolveTarget<'a> {
    ResolveTarget {
        connection_id: conn,
        db_schema: db,
        table,
        column,
    }
}

fn lib(schemas: Vec<JsonSchemaItem>, bindings: Vec<JsonSchemaBinding>) -> JsonSchemaLibrary {
    JsonSchemaLibrary {
        version: CURRENT_VERSION,
        schemas,
        bindings,
    }
}

// -- serde ----------------------------------------------------------------

#[test]
fn defaults_round_trip() {
    let json = serde_json::to_string(&JsonSchemaLibrary::default()).unwrap();
    let back: JsonSchemaLibrary = serde_json::from_str(&json).unwrap();
    assert_eq!(back.version, CURRENT_VERSION);
    assert!(back.schemas.is_empty());
    assert!(back.bindings.is_empty());
}

#[test]
fn missing_fields_fall_back_to_defaults() {
    let back: JsonSchemaLibrary = serde_json::from_str("{}").unwrap();
    assert_eq!(back.version, CURRENT_VERSION);
}

#[test]
fn a_binding_missing_the_enabled_field_defaults_to_enabled() {
    // The reason `Default` is hand-written: a derived one would make this
    // `false` and silently disable every binding an older client wrote.
    let b: JsonSchemaBinding =
        serde_json::from_str(r#"{"id":"b","schemaId":"s","column":"c"}"#).unwrap();
    assert!(b.enabled);
}

#[test]
fn unknown_future_keys_are_ignored() {
    let b: JsonSchemaBinding =
        serde_json::from_str(r#"{"id":"b","schemaId":"s","column":"c","fromTheFuture":9}"#)
            .unwrap();
    assert_eq!(b.id, "b");
}

#[test]
fn the_wire_format_is_camel_case() {
    let json = serde_json::to_string(&binding("b", "s", Some("c1"), None, None, "col")).unwrap();
    assert!(json.contains("\"schemaId\""));
    assert!(json.contains("\"connectionId\""));
    assert!(!json.contains("\"schema_id\""));
}

// -- glob -----------------------------------------------------------------

#[test]
fn glob_without_a_star_is_an_exact_match() {
    assert!(glob_match("config", "config"));
    assert!(!glob_match("config", "configuration"));
}

#[test]
fn glob_matches_prefix_suffix_and_infix() {
    assert!(glob_match("*_json", "payload_json"));
    assert!(glob_match("widget_*", "widget_settings"));
    assert!(glob_match("a*z", "abcz"));
    assert!(!glob_match("a*z", "abcy"));
}

#[test]
fn glob_star_matches_the_empty_string_and_dots() {
    assert!(glob_match("a*", "a"));
    assert!(glob_match("*", ""));
    assert!(glob_match("customData.*", "customData.format"));
    assert!(glob_match("customData.*", "customData.a.b"));
}

#[test]
fn glob_is_case_insensitive_for_ascii() {
    assert!(glob_match("Config", "config"));
    assert!(glob_match("*JSON", "payload_json"));
}

#[test]
fn glob_handles_many_stars_without_catastrophic_backtracking() {
    // Iterative backtracking, so this returns rather than hanging.
    let value = "a".repeat(64);
    assert!(!glob_match("****************b", &value));
    assert!(glob_match("****************a", &value));
}

#[test]
fn glob_matches_multibyte_values_bytewise() {
    assert!(glob_match("config_*", "config_año"));
    assert!(glob_match("*ñ", "añ"));
}

// -- cascade --------------------------------------------------------------

#[test]
fn exact_column_beats_wildcard_column() {
    let l = lib(
        vec![schema("s1", "exact"), schema("s2", "wide")],
        vec![
            binding("wide", "s2", None, None, None, "*"),
            binding("exact", "s1", None, None, None, "payload"),
        ],
    );
    let win = resolve_one(&l, &target(None, None, None, "payload")).unwrap();
    assert_eq!(win.binding.id, "exact");
}

#[test]
fn a_table_scoped_binding_beats_a_global_one_for_the_same_column() {
    let l = lib(
        vec![schema("s1", "a"), schema("s2", "b")],
        vec![
            binding("global", "s1", None, None, None, "configuration"),
            binding("scoped", "s2", None, None, Some("widgets"), "configuration"),
        ],
    );
    // The motivating case: a default for `configuration` everywhere,
    // overridden on the tables whose shape differs.
    let on_widgets =
        resolve_one(&l, &target(None, None, Some("widgets"), "configuration")).unwrap();
    assert_eq!(on_widgets.binding.id, "scoped");
    let elsewhere = resolve_one(&l, &target(None, None, Some("charts"), "configuration")).unwrap();
    assert_eq!(elsewhere.binding.id, "global");
}

#[test]
fn connection_scope_only_breaks_ties_among_equally_specific_bindings() {
    // A whole-server blanket rule must NOT beat a rule that names the table
    // and column — that is why connection is the lightest axis.
    let l = lib(
        vec![schema("s1", "server"), schema("s2", "precise")],
        vec![
            binding("server", "s1", Some("c1"), None, None, "*"),
            binding(
                "precise",
                "s2",
                None,
                None,
                Some("widgets"),
                "configuration",
            ),
        ],
    );
    let win = resolve_one(
        &l,
        &target(Some("c1"), None, Some("widgets"), "configuration"),
    )
    .unwrap();
    assert_eq!(win.binding.id, "precise");

    // …but between two otherwise identical rules, the pinned one wins.
    let l2 = lib(
        vec![schema("s1", "any"), schema("s2", "pinned")],
        vec![
            binding("any", "s1", None, None, Some("widgets"), "config"),
            binding("pinned", "s2", Some("c1"), None, Some("widgets"), "config"),
        ],
    );
    let win2 = resolve_one(&l2, &target(Some("c1"), None, Some("widgets"), "config")).unwrap();
    assert_eq!(win2.binding.id, "pinned");
}

#[test]
fn exact_beats_glob_on_the_same_axis() {
    let l = lib(
        vec![schema("s1", "glob"), schema("s2", "exact")],
        vec![
            binding("glob", "s1", None, None, None, "*_json"),
            binding("exact", "s2", None, None, None, "payload_json"),
        ],
    );
    let win = resolve_one(&l, &target(None, None, None, "payload_json")).unwrap();
    assert_eq!(win.binding.id, "exact");
}

#[test]
fn a_specificity_tie_is_broken_by_order_then_by_position() {
    let mut first = binding("first", "s1", None, None, Some("t"), "c");
    let mut second = binding("second", "s1", None, None, Some("t"), "c");
    first.order = 5;
    second.order = 1;
    let l = lib(vec![schema("s1", "one")], vec![first, second]);
    // Lower `order` wins even though it comes second in the vec.
    assert_eq!(
        resolve_one(&l, &target(None, None, Some("t"), "c"))
            .unwrap()
            .binding
            .id,
        "second"
    );

    // With `order` equal, position decides — a total order, so the result
    // never depends on sort stability.
    let l2 = lib(
        vec![schema("s1", "one")],
        vec![
            binding("a", "s1", None, None, Some("t"), "c"),
            binding("b", "s1", None, None, Some("t"), "c"),
        ],
    );
    assert_eq!(
        resolve_one(&l2, &target(None, None, Some("t"), "c"))
            .unwrap()
            .binding
            .id,
        "a"
    );
}

#[test]
fn a_pinned_axis_does_not_match_a_target_that_omits_it() {
    // An ad-hoc query result carries no connection or table, so a rule pinned
    // to one must not fire there.
    let l = lib(
        vec![schema("s1", "one")],
        vec![binding("b", "s1", Some("c1"), None, None, "payload")],
    );
    assert!(resolve_one(&l, &target(None, None, None, "payload")).is_none());
    assert!(resolve_one(&l, &target(Some("c1"), None, None, "payload")).is_some());
}

#[test]
fn the_db_schema_axis_matches_case_insensitively() {
    let l = lib(
        vec![schema("s1", "one")],
        vec![binding("b", "s1", None, Some("Public"), None, "payload")],
    );
    assert!(resolve_one(&l, &target(None, Some("public"), None, "payload")).is_some());
}

#[test]
fn disabled_bindings_never_match() {
    let mut b = binding("b", "s1", None, None, None, "payload");
    b.enabled = false;
    let l = lib(vec![schema("s1", "one")], vec![b]);
    assert!(resolve_one(&l, &target(None, None, None, "payload")).is_none());
}

#[test]
fn a_binding_with_a_dangling_schema_id_is_ignored_not_an_error() {
    let l = lib(
        vec![schema("s1", "one")],
        vec![
            binding("dangling", "gone", None, None, None, "payload"),
            binding("ok", "s1", None, None, None, "*"),
        ],
    );
    let win = resolve_one(&l, &target(None, None, None, "payload")).unwrap();
    assert_eq!(win.binding.id, "ok");
}

#[test]
fn a_mongo_dotted_path_matches_a_dotted_binding() {
    let l = lib(
        vec![schema("s1", "one")],
        vec![binding("b", "s1", None, None, None, "customData.format")],
    );
    assert!(resolve_one(&l, &target(None, None, None, "customData.format")).is_some());
}

#[test]
fn a_binding_for_a_root_field_does_not_match_its_dotted_children() {
    // `.` is not a metacharacter, which is what keeps a root binding from
    // silently applying to every nested field beneath it.
    let l = lib(
        vec![schema("s1", "one")],
        vec![binding("b", "s1", None, None, None, "customData")],
    );
    assert!(resolve_one(&l, &target(None, None, None, "customData")).is_some());
    assert!(resolve_one(&l, &target(None, None, None, "customData.format")).is_none());
}

#[test]
fn resolved_marks_an_inherited_match_as_not_exact() {
    let l = lib(
        vec![schema("s1", "one")],
        vec![binding("b", "s1", None, None, None, "*_json")],
    );
    let win = resolve_one(&l, &target(None, None, None, "payload_json")).unwrap();
    assert!(!to_resolved(&win, "payload_json").exact);

    let l2 = lib(
        vec![schema("s1", "one")],
        vec![binding("b", "s1", None, None, None, "payload_json")],
    );
    let win2 = resolve_one(&l2, &target(None, None, None, "payload_json")).unwrap();
    assert!(to_resolved(&win2, "payload_json").exact);
}

#[test]
fn explain_ranks_every_match_from_one() {
    let l = lib(
        vec![schema("s1", "a"), schema("s2", "b")],
        vec![
            binding("wide", "s2", None, None, None, "*"),
            binding("exact", "s1", None, None, None, "payload"),
        ],
    );
    let all = explain(&l, &target(None, None, None, "payload"));
    assert_eq!(all.len(), 2);
    assert_eq!(all[0].binding.id, "exact");
    assert_eq!(all[0].rank, 1);
    assert_eq!(all[1].rank, 2);
}

// -- normalisation --------------------------------------------------------

#[test]
fn a_blank_or_starred_optional_axis_normalises_to_a_wildcard() {
    let mut b = binding("b", "s1", None, Some(""), Some("*"), " payload ");
    normalise_binding(&mut b).unwrap();
    assert_eq!(b.db_schema, None);
    assert_eq!(b.table, None);
    assert_eq!(b.column, "payload");
}

#[test]
fn a_binding_without_a_column_is_rejected() {
    let mut b = binding("b", "s1", None, None, None, "   ");
    assert!(normalise_binding(&mut b).is_err());
}

#[test]
fn a_binding_without_a_schema_is_rejected() {
    let mut b = binding("b", "", None, None, None, "payload");
    assert!(normalise_binding(&mut b).is_err());
}

#[test]
fn an_oversize_schema_body_is_rejected() {
    assert!(validate_body("{}").is_ok());
    assert!(validate_body(&"x".repeat(MAX_SCHEMA_BYTES + 1)).is_err());
}

// -- sweeps ---------------------------------------------------------------

#[test]
fn sweeping_a_deleted_profile_removes_only_the_bindings_that_pin_it() {
    let mut l = lib(
        vec![schema("s1", "one")],
        vec![
            binding("pinned", "s1", Some("gone"), None, None, "a"),
            binding("other", "s1", Some("stays"), None, None, "b"),
            binding("global", "s1", None, None, None, "c"),
        ],
    );
    assert_eq!(sweep_connection(&mut l, "gone"), 1);
    assert_eq!(l.bindings.len(), 2);
    // The expensive artefact is never collateral damage.
    assert_eq!(l.schemas.len(), 1);
}

#[test]
fn deleting_a_schema_cascades_its_bindings() {
    let mut l = lib(
        vec![schema("s1", "one"), schema("s2", "two")],
        vec![
            binding("a", "s1", None, None, None, "a"),
            binding("b", "s1", None, None, None, "b"),
            binding("c", "s2", None, None, None, "c"),
        ],
    );
    assert_eq!(sweep_schema(&mut l, "s1"), 2);
    assert_eq!(l.schemas.len(), 1);
    assert_eq!(l.bindings.len(), 1);
    assert_eq!(l.bindings[0].id, "c");
}

#[test]
fn remap_connection_ids_rewrites_only_the_ids_it_is_given() {
    let mut l = lib(
        vec![schema("s1", "one")],
        vec![
            binding("a", "s1", Some("old"), None, None, "a"),
            binding("b", "s1", Some("untouched"), None, None, "b"),
            binding("c", "s1", None, None, None, "c"),
        ],
    );
    let mut remap = HashMap::new();
    remap.insert("old".to_string(), "new".to_string());
    assert_eq!(remap_connection_ids(&mut l, &remap), 1);
    assert_eq!(l.bindings[0].connection_id.as_deref(), Some("new"));
    assert_eq!(l.bindings[1].connection_id.as_deref(), Some("untouched"));
    assert_eq!(l.bindings[2].connection_id, None);
}

#[test]
fn renaming_a_column_moves_literal_bindings_but_not_globs() {
    let mut l = lib(
        vec![schema("s1", "one")],
        vec![
            binding(
                "literal",
                "s1",
                Some("c1"),
                Some("public"),
                Some("t"),
                "old",
            ),
            binding(
                "glob",
                "s1",
                Some("c1"),
                Some("public"),
                Some("t"),
                "*_json",
            ),
            binding(
                "elsewhere",
                "s1",
                Some("c1"),
                Some("public"),
                Some("other"),
                "old",
            ),
        ],
    );
    assert_eq!(
        rename_column(&mut l, Some("c1"), Some("public"), Some("t"), "old", "new"),
        1
    );
    assert_eq!(l.bindings[0].column, "new");
    assert_eq!(l.bindings[1].column, "*_json");
    assert_eq!(l.bindings[2].column, "old");
}

#[test]
fn reordering_rewrites_order_and_sorts() {
    let mut l = lib(
        vec![schema("s1", "one")],
        vec![
            binding("a", "s1", None, None, None, "a"),
            binding("b", "s1", None, None, None, "b"),
        ],
    );
    reorder_bindings(&mut l, &["b".to_string(), "a".to_string()]);
    assert_eq!(l.bindings[0].id, "b");
    assert_eq!(l.bindings[0].order, 0);
    assert_eq!(l.bindings[1].order, 1);
}

// -- import helpers -------------------------------------------------------

#[test]
fn disambiguate_name_climbs_the_imported_then_numbered_ladder() {
    assert_eq!(disambiguate_name("cfg", ["other"].into_iter()), "cfg");
    assert_eq!(
        disambiguate_name("cfg", ["cfg"].into_iter()),
        "cfg (imported)"
    );
    assert_eq!(
        disambiguate_name("cfg", ["cfg", "cfg (imported)"].into_iter()),
        "cfg (2)"
    );
    assert_eq!(
        disambiguate_name("cfg", ["cfg", "cfg (imported)", "cfg (2)"].into_iter()),
        "cfg (3)"
    );
}

#[test]
fn next_order_lands_after_everything_present() {
    let empty = JsonSchemaLibrary::default();
    assert_eq!(next_order(&empty), 0);

    let mut b = binding("a", "s1", None, None, None, "a");
    b.order = 7;
    let l = lib(vec![], vec![b]);
    assert_eq!(next_order(&l), 8);
}

#[test]
fn has_same_rule_ignores_identity_and_ordering() {
    let l = lib(
        vec![schema("s1", "one")],
        vec![binding("a", "s1", Some("c1"), None, Some("t"), "col")],
    );
    let mut candidate = binding("different-id", "s1", Some("c1"), None, Some("t"), "col");
    candidate.order = 99;
    assert!(has_same_rule(&l, &candidate));

    let other = binding("x", "s1", Some("c1"), None, Some("t"), "elsewhere");
    assert!(!has_same_rule(&l, &other));
}
