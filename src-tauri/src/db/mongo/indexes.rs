//! MongoDB index management: the real index catalogue, plus create / hide /
//! recreate / drop.
//!
//! **Why this doesn't reuse [`super::schema::list_indexes`].** That function
//! deserializes into `mongodb::IndexModel` and keeps three things — the name,
//! the *field names*, and `unique` — because all the SQL explorer's
//! [`crate::commands::schema::IndexInfo`] can carry is a name, a column list
//! and a uniqueness flag. Everything else is dropped: the per-key direction
//! (`1` / `-1`), the index type (`text`, `2dsphere`, `hashed`), `sparse`,
//! `expireAfterSeconds`, `partialFilterExpression`, `collation`, `weights`,
//! `hidden`. That is fine for a read-only listing and fatal for an editor:
//! recreating `{ createdAt: -1 }` from a field-name list would silently
//! rebuild it ascending, which is invisible in testing and permanent in the
//! data — gotcha #29's failure mode, one subsystem over.
//!
//! So the catalogue is read from the **raw `listIndexes` reply documents**
//! rather than through the typed helper. A raw document preserves the key
//! order, the key values, and every option — including ones the driver's typed
//! `IndexOptions` doesn't model and ones a future server version adds. What
//! this module doesn't model explicitly still survives, in
//! [`MongoIndexInfo::extra_options`], as source text.
//!
//! **Source text, not JSON.** Key values, partial filters, collations and
//! weights all cross the IPC boundary as the text the user would type
//! (rendered by [`bson_to_shell_text`], parsed back by
//! [`parse_relaxed_value`]) — never as display JSON, and never parsed on the
//! frontend. Same rule, and the same reason, as the aggregation editor's
//! pipelines (gotcha #33): one grammar, in Rust, or the two ends drift and
//! the drift is silent. An `ObjectId` or a `NumberLong` inside a partial
//! filter has to come back out exactly as it went in, or reopening an index
//! and saving it unchanged would quietly stop it matching.
//!
//! **Writes go through `run_command`, not `Collection::create_index`.** The
//! typed builder is lossy in the outbound direction for the same reason it is
//! inbound: options it doesn't model (`wildcardProjection`, `storageEngine`,
//! a version-specific geo tunable) can't be expressed at all. A raw
//! `createIndexes` command can send whatever the server accepts.

use super::schema::{resolve_db, validate_collection};
use super::shell::parse_relaxed_value;
use super::values::bson_to_shell_text;
use crate::error::{AppError, AppResult};
use crate::state::MongoConn;
use mongodb::bson::{doc, Bson, Document};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;

/// The index MongoDB maintains on `_id` for every collection. It cannot be
/// dropped or hidden — the server refuses both — so the UI greys those actions
/// out and this module refuses them ahead of the round trip, with a message
/// that explains why rather than relaying a bare server error.
const ID_INDEX: &str = "_id_";

/// Spec keys this module surfaces as their own field on [`MongoIndexInfo`].
const MODELLED_OPTIONS: &[&str] = &[
    "key",
    "name",
    "unique",
    "sparse",
    "hidden",
    "expireAfterSeconds",
    "partialFilterExpression",
    "collation",
    "weights",
    "default_language",
];

/// Spec keys that are server bookkeeping rather than user intent. Showing them
/// as "extra options" would invite someone to edit a value the server owns.
const NOISE_OPTIONS: &[&str] = &["v", "ns", "textIndexVersion", "2dsphereIndexVersion"];

/// One entry of an index's `key` document, in order.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MongoIndexKey {
    /// The indexed field path (`customData.format`, `tags`, `$**`).
    pub field: String,
    /// The key's value as source text: `1`, `-1`, `"text"`, `"2dsphere"`,
    /// `"hashed"`. Text rather than a number because the value is genuinely a
    /// union — a direction *or* an index type — and flattening it to one of
    /// the two would lose the other.
    pub value: String,
}

/// A collection's index, as read from `listIndexes`.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MongoIndexInfo {
    pub name: String,
    pub keys: Vec<MongoIndexKey>,
    /// The whole `key` document as source text — what the editor loads and
    /// what a recreate sends back, so an exotic key survives a round trip even
    /// when the per-key form can't render it as a picker.
    pub keys_source: String,
    pub unique: bool,
    pub sparse: bool,
    pub hidden: bool,
    pub expire_after_seconds: Option<i64>,
    pub partial_filter_expression: Option<String>,
    pub collation: Option<String>,
    pub weights: Option<String>,
    pub default_language: Option<String>,
    /// Derived label for the UI: `regular` | `text` | `geo` | `hashed` |
    /// `wildcard` | `ttl`. Not a server concept — MongoDB has no index "type"
    /// field, the shape of the key document (plus `expireAfterSeconds`) is
    /// what makes an index one of these.
    pub kind: String,
    /// `_id_`: undroppable, unhidable.
    pub is_id: bool,
    /// On-disk size, when `$collStats` was readable.
    pub size_bytes: Option<i64>,
    /// Operations served since `usage_since`, when `$indexStats` was readable.
    /// An index with a long uptime and zero ops is one nobody is using.
    pub usage_ops: Option<i64>,
    pub usage_since: Option<String>,
    /// Every spec key this struct doesn't model, as a source-text document.
    /// Nothing the server reports is dropped in silence.
    pub extra_options: Option<String>,
}

/// The index the editor wants to exist. Field-for-field what the dialog holds.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NewMongoIndexSpec {
    /// The `key` document as source text, e.g. `{ createdAt: -1, status: 1 }`.
    pub keys: String,
    /// `None` lets the server derive `field_1_other_-1`.
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default)]
    pub unique: bool,
    #[serde(default)]
    pub sparse: bool,
    #[serde(default)]
    pub hidden: bool,
    #[serde(default)]
    pub expire_after_seconds: Option<i64>,
    #[serde(default)]
    pub partial_filter_expression: Option<String>,
    #[serde(default)]
    pub collation: Option<String>,
    #[serde(default)]
    pub weights: Option<String>,
    #[serde(default)]
    pub default_language: Option<String>,
    /// A source-text document merged into the spec — the escape hatch for
    /// anything the dialog has no field for (`wildcardProjection`,
    /// `storageEngine`, …).
    #[serde(default)]
    pub extra_options: Option<String>,
}

/// Parse an optional source-text field into a BSON document.
///
/// Blank is `None` rather than an empty document: `{}` is a *meaningful*
/// partial filter (it matches everything, i.e. not a partial index at all),
/// and sending it would make the server build a different index than the one
/// the user asked for.
fn optional_document(label: &str, source: Option<&String>) -> AppResult<Option<Document>> {
    let Some(text) = source.map(|s| s.trim()).filter(|s| !s.is_empty()) else {
        return Ok(None);
    };
    match parse_relaxed_value(text)? {
        Bson::Document(d) => Ok(Some(d)),
        other => Err(AppError::InvalidInput(format!(
            "{label} must be a document, got {}",
            super::values::bson_type_name(&other)
        ))),
    }
}

impl NewMongoIndexSpec {
    /// Build the entry that goes into `createIndexes`' `indexes` array.
    ///
    /// Deliberately callable without touching the server: a recreate parses
    /// and validates the *new* spec before dropping the old index, so a typo
    /// in a partial filter costs an error message rather than an index.
    fn to_document(&self) -> AppResult<Document> {
        let keys = match parse_relaxed_value(self.keys.trim())? {
            Bson::Document(d) => d,
            other => {
                return Err(AppError::InvalidInput(format!(
                    "the index keys must be a document like {{ field: 1 }}, got {}",
                    super::values::bson_type_name(&other)
                )))
            }
        };
        if keys.is_empty() {
            return Err(AppError::InvalidInput(
                "an index needs at least one key".into(),
            ));
        }

        let mut spec = doc! { "key": keys };

        if let Some(name) = self
            .name
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
        {
            spec.insert("name", name);
        }
        if self.unique {
            spec.insert("unique", true);
        }
        if self.sparse {
            spec.insert("sparse", true);
        }
        if self.hidden {
            spec.insert("hidden", true);
        }
        if let Some(seconds) = self.expire_after_seconds {
            if seconds < 0 {
                return Err(AppError::InvalidInput(
                    "a TTL must be zero or more seconds".into(),
                ));
            }
            spec.insert("expireAfterSeconds", seconds);
        }
        if let Some(filter) = optional_document(
            "the partial filter expression",
            self.partial_filter_expression.as_ref(),
        )? {
            spec.insert("partialFilterExpression", filter);
        }
        if let Some(collation) = optional_document("the collation", self.collation.as_ref())? {
            spec.insert("collation", collation);
        }
        if let Some(weights) = optional_document("the text weights", self.weights.as_ref())? {
            spec.insert("weights", weights);
        }
        if let Some(lang) = self
            .default_language
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
        {
            spec.insert("default_language", lang);
        }
        // Merged last and allowed to win: it is the deliberate escape hatch,
        // so someone spelling an option out by hand overrides the form's take
        // on it rather than being silently overruled by a default.
        if let Some(extra) = optional_document("the extra options", self.extra_options.as_ref())? {
            for (k, v) in extra {
                spec.insert(k, v);
            }
        }
        Ok(spec)
    }
}

/// Reject an operation the `_id` index doesn't support.
fn reject_id_index(name: &str, verb: &str) -> AppResult<()> {
    if name == ID_INDEX {
        return Err(AppError::InvalidInput(format!(
            "the `{ID_INDEX}` index cannot be {verb} — MongoDB maintains it for every collection"
        )));
    }
    Ok(())
}

/// Read a BSON number as `i64` regardless of which numeric type it arrived as.
/// Sizes come back `i32` on small collections and `i64` on large ones, and
/// `$collStats` has been known to report a `Double`.
fn as_i64(value: Option<&Bson>) -> Option<i64> {
    match value? {
        Bson::Int32(n) => Some(*n as i64),
        Bson::Int64(n) => Some(*n),
        Bson::Double(n) => Some(*n as i64),
        _ => None,
    }
}

/// Derive the UI's index-kind label from the key document and the TTL.
fn index_kind(keys: &[MongoIndexKey], expire_after_seconds: Option<i64>) -> &'static str {
    // Key shape first: a TTL is an ordinary single-field index that happens to
    // expire, whereas text/geo/hashed/wildcard change what the index *is*.
    for key in keys {
        match key.value.trim_matches('"') {
            "text" => return "text",
            "2dsphere" | "2d" | "geoHaystack" => return "geo",
            "hashed" => return "hashed",
            _ => {}
        }
        if key.field.contains("$**") {
            return "wildcard";
        }
    }
    if expire_after_seconds.is_some() {
        return "ttl";
    }
    "regular"
}

/// Per-index on-disk size, keyed by index name.
///
/// Best-effort, in the same spirit as [`super::schema::collection_sizes`]: a
/// role without the `collStats` privilege (or a server that has moved the
/// field) leaves every size unknown rather than failing the whole listing —
/// sizes are a nice-to-have next to the catalogue itself.
async fn index_sizes(db: &mongodb::Database, collection: &str) -> HashMap<String, i64> {
    let mut sizes = HashMap::new();
    let Ok(mut cursor) = db
        .collection::<Document>(collection)
        .aggregate(vec![doc! {"$collStats": {"storageStats": {}}}])
        .await
    else {
        return sizes;
    };
    while matches!(cursor.advance().await, Ok(true)) {
        let Ok(stat) = cursor.deserialize_current() else {
            continue;
        };
        let Ok(index_sizes) = stat
            .get_document("storageStats")
            .and_then(|s| s.get_document("indexSizes"))
        else {
            continue;
        };
        for (name, value) in index_sizes {
            if let Some(size) = as_i64(Some(value)) {
                sizes.insert(name.clone(), size);
            }
        }
    }
    sizes
}

/// Per-index usage counters, keyed by index name: operations served, and the
/// instant the counter was last reset (a server restart resets it, so the two
/// numbers only mean something together).
///
/// Best-effort for the same reason as [`index_sizes`] — `$indexStats` needs
/// its own privilege and is unavailable on some hosted tiers.
async fn index_usage(
    db: &mongodb::Database,
    collection: &str,
) -> HashMap<String, (i64, Option<String>)> {
    let mut usage = HashMap::new();
    let Ok(mut cursor) = db
        .collection::<Document>(collection)
        .aggregate(vec![doc! {"$indexStats": {}}])
        .await
    else {
        return usage;
    };
    while matches!(cursor.advance().await, Ok(true)) {
        let Ok(stat) = cursor.deserialize_current() else {
            continue;
        };
        let Ok(name) = stat.get_str("name") else {
            continue;
        };
        let Ok(accesses) = stat.get_document("accesses") else {
            continue;
        };
        let ops = as_i64(accesses.get("ops")).unwrap_or(0);
        let since = accesses
            .get_datetime("since")
            .ok()
            .and_then(|d| d.try_to_rfc3339_string().ok());
        usage.insert(name.to_string(), (ops, since));
    }
    usage
}

/// Turn one raw `listIndexes` spec document into the DTO the editor consumes.
fn spec_to_info(spec: &Document) -> MongoIndexInfo {
    let key_doc = spec.get_document("key").cloned().unwrap_or_default();
    let keys: Vec<MongoIndexKey> = key_doc
        .iter()
        .map(|(field, value)| MongoIndexKey {
            field: field.clone(),
            value: bson_to_shell_text(value),
        })
        .collect();

    let name = spec
        .get_str("name")
        .map(str::to_string)
        .unwrap_or_else(|_| {
            keys.iter()
                .map(|k| format!("{}_{}", k.field, k.value))
                .collect::<Vec<_>>()
                .join("_")
        });

    let expire_after_seconds = as_i64(spec.get("expireAfterSeconds"));

    let document_option = |key: &str| {
        spec.get(key)
            .filter(|v| !matches!(v, Bson::Null))
            .map(bson_to_shell_text)
    };

    // Everything the struct doesn't model and the server doesn't own. Keeping
    // it visible is the point: an option we've never heard of should show up
    // in the editor, not vanish between a read and a recreate.
    let extra: Document = spec
        .iter()
        .filter(|(k, _)| {
            !MODELLED_OPTIONS.contains(&k.as_str()) && !NOISE_OPTIONS.contains(&k.as_str())
        })
        .map(|(k, v)| (k.clone(), v.clone()))
        .collect();

    MongoIndexInfo {
        kind: index_kind(&keys, expire_after_seconds).to_string(),
        is_id: name == ID_INDEX,
        keys_source: bson_to_shell_text(&Bson::Document(key_doc)),
        keys,
        name,
        unique: spec.get_bool("unique").unwrap_or(false),
        sparse: spec.get_bool("sparse").unwrap_or(false),
        hidden: spec.get_bool("hidden").unwrap_or(false),
        expire_after_seconds,
        partial_filter_expression: document_option("partialFilterExpression"),
        collation: document_option("collation"),
        weights: document_option("weights"),
        default_language: spec.get_str("default_language").ok().map(str::to_string),
        size_bytes: None,
        usage_ops: None,
        usage_since: None,
        extra_options: (!extra.is_empty()).then(|| bson_to_shell_text(&Bson::Document(extra))),
    }
}

/// The collection's full index catalogue, enriched with sizes and usage when
/// the connection's role can read them.
pub async fn list_indexes(conn: &MongoConn, collection: &str) -> AppResult<Vec<MongoIndexInfo>> {
    let collection = validate_collection(collection)?;
    let db = resolve_db(conn)?;

    // Raw `listIndexes` rather than the typed cursor — see the module doc.
    let reply = db.run_command(doc! { "listIndexes": collection }).await?;
    let batch = reply
        .get_document("cursor")
        .ok()
        .and_then(|c| c.get_array("firstBatch").ok())
        .cloned()
        .unwrap_or_default();

    let mut out: Vec<MongoIndexInfo> = batch
        .iter()
        .filter_map(Bson::as_document)
        .map(spec_to_info)
        .collect();

    let sizes = index_sizes(&db, collection).await;
    let usage = index_usage(&db, collection).await;
    for info in &mut out {
        info.size_bytes = sizes.get(&info.name).copied();
        if let Some((ops, since)) = usage.get(&info.name) {
            info.usage_ops = Some(*ops);
            info.usage_since = since.clone();
        }
    }

    // `_id_` first, then by name: the one index every collection has is the
    // one nobody is looking for, so it belongs at a predictable anchor rather
    // than sorted into the middle of the list.
    out.sort_by(|a, b| b.is_id.cmp(&a.is_id).then_with(|| a.name.cmp(&b.name)));
    Ok(out)
}

/// Create an index (`createIndexes`).
pub async fn create_index(
    conn: &MongoConn,
    collection: &str,
    spec: &NewMongoIndexSpec,
) -> AppResult<()> {
    let collection = validate_collection(collection)?;
    let index = spec.to_document()?;
    let db = resolve_db(conn)?;
    db.run_command(doc! {
        "createIndexes": collection,
        "indexes": [index],
    })
    .await?;
    Ok(())
}

/// Drop an index by name (`dropIndexes`).
pub async fn drop_index(conn: &MongoConn, collection: &str, name: &str) -> AppResult<()> {
    let collection = validate_collection(collection)?;
    reject_id_index(name, "dropped")?;
    let db = resolve_db(conn)?;
    db.run_command(doc! {
        "dropIndexes": collection,
        "index": name,
    })
    .await?;
    Ok(())
}

/// Hide or unhide an index (`collMod`).
///
/// Hiding is the safe rehearsal for dropping: the planner stops using the
/// index while it stays maintained and instantly restorable, so the effect of
/// removing it can be measured without paying for a rebuild if the answer is
/// "put it back".
pub async fn set_index_hidden(
    conn: &MongoConn,
    collection: &str,
    name: &str,
    hidden: bool,
) -> AppResult<()> {
    let collection = validate_collection(collection)?;
    reject_id_index(name, "hidden")?;
    let db = resolve_db(conn)?;
    db.run_command(doc! {
        "collMod": collection,
        "index": { "name": name, "hidden": hidden },
    })
    .await?;
    Ok(())
}

/// Replace an index: drop the old one, create the new one.
///
/// MongoDB has no in-place index alteration — `collMod` reaches `hidden` and
/// nothing else — so "edit" is genuinely destructive and the UI says so before
/// calling this.
///
/// The new spec is parsed and validated **before** the drop, so a malformed
/// partial filter costs an error message instead of an index. If the create
/// still fails afterwards (a duplicate-key violation on a new `unique`, say),
/// the error names the collection's now-missing index explicitly — that is a
/// state the user has to know about, not one to leave them guessing at.
pub async fn recreate_index(
    conn: &MongoConn,
    collection: &str,
    original_name: &str,
    spec: &NewMongoIndexSpec,
) -> AppResult<()> {
    let collection = validate_collection(collection)?;
    reject_id_index(original_name, "replaced")?;
    // Parse first; the drop below is not undoable.
    spec.to_document()?;

    drop_index(conn, collection, original_name).await?;
    create_index(conn, collection, spec).await.map_err(|e| {
        AppError::InvalidInput(format!(
            "`{original_name}` was dropped but the replacement could not be created: {e}. \
             `{collection}` currently has no index in its place."
        ))
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn spec_of(source: &str) -> NewMongoIndexSpec {
        NewMongoIndexSpec {
            keys: source.to_string(),
            name: None,
            unique: false,
            sparse: false,
            hidden: false,
            expire_after_seconds: None,
            partial_filter_expression: None,
            collation: None,
            weights: None,
            default_language: None,
            extra_options: None,
        }
    }

    #[test]
    fn relaxed_keys_keep_their_order_and_direction() {
        let doc = spec_of("{ createdAt: -1, status: 1 }")
            .to_document()
            .unwrap();
        let keys = doc.get_document("key").unwrap();
        let entries: Vec<_> = keys.iter().map(|(k, v)| (k.as_str(), v.clone())).collect();
        assert_eq!(entries[0].0, "createdAt");
        assert_eq!(entries[0].1, Bson::Int32(-1));
        assert_eq!(entries[1].0, "status");
        assert_eq!(entries[1].1, Bson::Int32(1));
    }

    #[test]
    fn a_key_document_survives_the_round_trip_through_bson() {
        // The editor reads `keys_source` back out of a stored index, so what
        // `spec_to_info` renders has to be what `to_document` can re-parse.
        let original = spec_of(r#"{ "location": "2dsphere", "name": "text" }"#)
            .to_document()
            .unwrap();
        let info = spec_to_info(&doc! {
            "name": "location_2dsphere_name_text",
            "key": original.get_document("key").unwrap().clone(),
        });
        let reparsed = spec_of(&info.keys_source).to_document().unwrap();
        assert_eq!(
            reparsed.get_document("key").unwrap(),
            original.get_document("key").unwrap()
        );
        assert_eq!(info.kind, "geo");
    }

    #[test]
    fn an_unmodelled_option_survives_as_extra_options() {
        let info = spec_to_info(&doc! {
            "v": 2,
            "name": "wild",
            "key": { "$**": 1 },
            "wildcardProjection": { "secrets": 0 },
        });
        let extra = info.extra_options.expect("unmodelled option was dropped");
        assert!(extra.contains("wildcardProjection"), "{extra}");
        // Server bookkeeping is not offered up as something to edit.
        assert!(!extra.contains("\"v\""), "{extra}");
        assert_eq!(info.kind, "wildcard");
    }

    #[test]
    fn ttl_and_partial_options_land_on_the_spec() {
        let mut spec = spec_of("{ createdAt: 1 }");
        spec.expire_after_seconds = Some(3600);
        spec.partial_filter_expression = Some("{ status: { $eq: \"active\" } }".into());
        spec.unique = true;
        let doc = spec.to_document().unwrap();
        assert_eq!(doc.get_i64("expireAfterSeconds").unwrap(), 3600);
        assert!(doc.get_document("partialFilterExpression").is_ok());
        assert!(doc.get_bool("unique").unwrap());
        // Flags that are off are absent, not `false` — an index spec the
        // server echoes back should read like the one the user asked for.
        assert!(!doc.contains_key("sparse"));
    }

    #[test]
    fn a_blank_partial_filter_is_absent_rather_than_an_empty_document() {
        let mut spec = spec_of("{ a: 1 }");
        spec.partial_filter_expression = Some("   ".into());
        let doc = spec.to_document().unwrap();
        // `{}` would be a *different* index: a partial one matching everything.
        assert!(!doc.contains_key("partialFilterExpression"));
    }

    #[test]
    fn keys_must_be_a_non_empty_document() {
        assert!(spec_of("{}").to_document().is_err());
        assert!(spec_of("[1, 2]").to_document().is_err());
    }

    #[test]
    fn the_id_index_refuses_destructive_verbs() {
        assert!(reject_id_index(ID_INDEX, "dropped").is_err());
        assert!(reject_id_index("createdAt_-1", "dropped").is_ok());
    }
}
