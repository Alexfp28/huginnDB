//! MongoDB introspection: databases, collections, inferred fields, indexes.
//!
//! MongoDB is schemaless, so there is no catalog to read column types from the
//! way the SQL drivers do. Field lists are **inferred** by sampling documents
//! ([`infer_columns`]); the result is best-effort and reflects only what the
//! sample contained. Everything here returns the same DTOs the SQL explorer
//! uses ([`DatabaseInfo`], [`TableInfo`], [`ColumnInfo`], [`IndexInfo`]) so the
//! frontend tree renders MongoDB without a separate code path.

use crate::commands::schema::{ColumnInfo, DatabaseInfo, IndexInfo, PrivilegeInfo, TableInfo, UserInfo};
use crate::db::ddl::{ColumnDef, IndexDef, TableStructure};
use crate::error::{AppError, AppResult};
use crate::state::MongoConn;
use mongodb::bson::{doc, Document};
use mongodb::results::CollectionType;

/// Number of documents sampled when inferring a collection's field list.
const SAMPLE_SIZE: i64 = 100;

/// Resolve the [`mongodb::Database`] a connection handle targets, or fail if no
/// database has been selected (the parent cluster connection before the user
/// expands a database in the explorer).
pub fn resolve_db(conn: &MongoConn) -> AppResult<mongodb::Database> {
    let name = conn
        .database
        .as_deref()
        .filter(|s| !s.is_empty())
        .ok_or_else(|| {
            AppError::InvalidInput(
                "no database selected — expand a database in the explorer or include one in the \
             connection URI (mongodb://host/<database>)"
                    .into(),
            )
        })?;
    Ok(conn.client.database(name))
}

/// List every database in the cluster.
pub async fn list_databases(conn: &MongoConn) -> AppResult<Vec<DatabaseInfo>> {
    let names = conn.client.list_database_names().await?;
    Ok(names
        .into_iter()
        .map(|name| DatabaseInfo { name })
        .collect())
}

/// List the collections (and views) of the target database, with approximate
/// document counts. Size is left `None` for the MVP — exact per-collection size
/// needs a `collStats` round-trip per collection (deferred; see the roadmap).
pub async fn list_collections(conn: &MongoConn) -> AppResult<Vec<TableInfo>> {
    let db = resolve_db(conn)?;
    let db_name = db.name().to_string();

    let mut cursor = db.list_collections().await?;
    let mut out = Vec::new();
    while cursor.advance().await? {
        let spec = cursor.deserialize_current()?;
        let is_view = spec.collection_type == CollectionType::View;
        let row_count = if is_view {
            None
        } else {
            // estimated_document_count uses collection metadata: a single fast
            // call, unlike a full COUNT scan.
            db.collection::<Document>(&spec.name)
                .estimated_document_count()
                .await
                .ok()
        };
        out.push(TableInfo {
            schema: db_name.clone(),
            name: spec.name,
            kind: if is_view {
                "view".into()
            } else {
                "table".into()
            },
            row_count,
            size_bytes: None,
        });
    }
    out.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(out)
}

/// Infer a collection's field list by sampling documents.
///
/// Returns one [`ColumnInfo`] per distinct top-level field seen across the
/// sample, `_id` first. `data_type` is the BSON type name of the field's first
/// observed value; `nullable` is true when the field was absent from at least
/// one sampled document (so it is not guaranteed present). `is_primary_key` is
/// set only for `_id`.
pub async fn infer_columns(conn: &MongoConn, collection: &str) -> AppResult<Vec<ColumnInfo>> {
    let db = resolve_db(conn)?;
    let coll = db.collection::<Document>(collection);

    let mut cursor = coll
        .aggregate(vec![doc! {"$sample": {"size": SAMPLE_SIZE}}])
        .await?;

    // Preserve first-seen field order; track type + how many docs contained it.
    let mut order: Vec<String> = Vec::new();
    let mut types: std::collections::HashMap<String, &'static str> =
        std::collections::HashMap::new();
    let mut present: std::collections::HashMap<String, usize> = std::collections::HashMap::new();
    let mut sampled = 0usize;

    while cursor.advance().await? {
        let docu = cursor.deserialize_current()?;
        sampled += 1;
        for (k, v) in &docu {
            if !types.contains_key(k) {
                order.push(k.clone());
                types.insert(k.clone(), super::values::bson_type_name(v));
            }
            *present.entry(k.clone()).or_insert(0) += 1;
        }
    }

    // Ensure `_id` is first even if the sample happened to order it later.
    order.sort_by_key(|k| if k == "_id" { 0 } else { 1 });

    let cols = order
        .into_iter()
        .map(|name| {
            let always_present = present.get(&name).copied().unwrap_or(0) >= sampled.max(1);
            ColumnInfo {
                data_type: types.get(&name).copied().unwrap_or("null").to_string(),
                nullable: name != "_id" && !always_present,
                is_primary_key: name == "_id",
                referenced_schema: None,
                referenced_table: None,
                referenced_column: None,
                name,
            }
        })
        .collect();
    Ok(cols)
}

/// List the indexes defined on a collection.
pub async fn list_indexes(conn: &MongoConn, collection: &str) -> AppResult<Vec<IndexInfo>> {
    let db = resolve_db(conn)?;
    let coll = db.collection::<Document>(collection);
    let mut cursor = coll.list_indexes().await?;
    let mut out = Vec::new();
    while cursor.advance().await? {
        let model = cursor.deserialize_current()?;
        let columns: Vec<String> = model.keys.keys().cloned().collect();
        let name = model
            .options
            .as_ref()
            .and_then(|o| o.name.clone())
            .unwrap_or_else(|| columns.join("_"));
        let unique = model
            .options
            .as_ref()
            .and_then(|o| o.unique)
            .unwrap_or(false);
        out.push(IndexInfo {
            name,
            columns,
            unique,
        });
    }
    Ok(out)
}

/// Build a read-only [`TableStructure`] for a collection (inferred fields +
/// real indexes). MongoDB has no foreign keys; structure *editing* is deferred
/// to the roadmap, so the visual editor renders this in read-only mode.
pub async fn table_structure(conn: &MongoConn, collection: &str) -> AppResult<TableStructure> {
    let db_name = resolve_db(conn)?.name().to_string();
    let columns = infer_columns(conn, collection).await?;
    let indexes = list_indexes(conn, collection).await?;

    let column_defs = columns
        .into_iter()
        .map(|c| ColumnDef {
            name: c.name,
            original_name: None,
            data_type: c.data_type,
            nullable: c.nullable,
            default: None,
            is_primary_key: c.is_primary_key,
            auto_increment: false,
        })
        .collect();

    let index_defs = indexes
        .into_iter()
        .map(|i| IndexDef {
            name: Some(i.name),
            columns: i.columns,
            unique: i.unique,
        })
        .collect();

    Ok(TableStructure {
        schema: Some(db_name),
        name: collection.to_string(),
        columns: column_defs,
        indexes: index_defs,
        foreign_keys: vec![],
    })
}

/// Roles that imply admin-equivalent access, used to derive
/// [`UserInfo::is_superuser`]. Not exhaustive (custom roles can grant
/// equivalent power) — best-effort, matching the built-in role names
/// MongoDB ships.
const SUPERUSER_ROLES: &[&str] = &[
    "root",
    "dbOwner",
    "userAdminAnyDatabase",
    "dbAdminAnyDatabase",
    "clusterAdmin",
    "atlasAdmin",
];

/// List the users defined on the resolved database via `usersInfo`.
///
/// MongoDB scopes users per-database (not per-cluster), so this mirrors
/// [`list_collections`] in only covering the database the connection handle
/// currently targets.
pub async fn list_users(conn: &MongoConn) -> AppResult<Vec<UserInfo>> {
    let db = resolve_db(conn)?;
    let result = db.run_command(doc! {"usersInfo": 1}).await?;
    let users = result.get_array("users").cloned().unwrap_or_default();

    let mut out: Vec<UserInfo> = users
        .into_iter()
        .filter_map(|u| u.as_document().cloned())
        .map(|u| {
            let name = u.get_str("user").unwrap_or("").to_string();
            let roles: Vec<(String, bool)> = u
                .get_array("roles")
                .ok()
                .into_iter()
                .flatten()
                .filter_map(|r| r.as_document())
                .map(|r| {
                    let role = r.get_str("role").unwrap_or("").to_string();
                    let db_name = r.get_str("db").unwrap_or("").to_string();
                    let is_super = SUPERUSER_ROLES.contains(&role.as_str());
                    (format!("{role}@{db_name}"), is_super)
                })
                .collect();
            UserInfo {
                name,
                is_superuser: roles.iter().any(|(_, is_super)| *is_super),
                // MongoDB has no per-account lock flag reachable via
                // usersInfo; a user document existing means it can log in.
                can_login: true,
                roles: roles.into_iter().map(|(r, _)| r).collect(),
            }
        })
        .collect();
    out.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(out)
}

/// List `user`'s effective privileges (resource + action) on the resolved
/// database, via `usersInfo` with `showPrivileges: true`.
pub async fn list_privileges(conn: &MongoConn, user: &str) -> AppResult<Vec<PrivilegeInfo>> {
    let db = resolve_db(conn)?;
    let db_name = db.name().to_string();
    let result = db
        .run_command(doc! {
            "usersInfo": {"user": user, "db": db_name},
            "showPrivileges": true,
        })
        .await?;
    let users = result.get_array("users").cloned().unwrap_or_default();

    let mut out = Vec::new();
    for u in users.iter().filter_map(|u| u.as_document()) {
        let privs = u.get_array("inheritedPrivileges").ok().into_iter().flatten();
        for p in privs.filter_map(|p| p.as_document()) {
            let resource = p.get_document("resource").ok();
            let schema = resource
                .and_then(|r| r.get_str("db").ok())
                .filter(|s| !s.is_empty())
                .map(|s| s.to_string());
            let table = resource
                .and_then(|r| r.get_str("collection").ok())
                .filter(|s| !s.is_empty())
                .map(|s| s.to_string());
            for action in p.get_array("actions").ok().into_iter().flatten() {
                if let Some(action) = action.as_str() {
                    out.push(PrivilegeInfo {
                        privilege: action.to_string(),
                        schema: schema.clone(),
                        table: table.clone(),
                    });
                }
            }
        }
    }
    Ok(out)
}

/// Best-effort liveness check used by `test_connection`: ping the admin db.
pub async fn ping(conn: &MongoConn) -> AppResult<()> {
    conn.client
        .database("admin")
        .run_command(doc! {"ping": 1})
        .await?;
    Ok(())
}
