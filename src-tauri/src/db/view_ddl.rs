//! Pure, driver-aware DDL generation for the view editor.
//!
//! Mirrors [`crate::db::ddl`]'s "diff original vs desired, return ordered
//! statements" shape, but for `CREATE VIEW` instead of `CREATE TABLE`: the
//! editor sends the *desired* view definition (and, when editing, the
//! original snapshot); [`build_view_ddl`] diffs them and returns the
//! statements. Preview and apply call the same function, so what the user
//! sees is exactly what runs.
//!
//! A view has no ALTER-column machinery to diff — the entire body is a
//! single opaque SQL string — so unlike [`crate::db::ddl`] there is no
//! per-column comparison here, only "did the name change" / "did the body
//! change". Identifier safety (SECURITY.md, gotcha #4): the view/schema name
//! goes through [`crate::db::ddl::validate_ident`] before being quoted. The
//! query body itself is arbitrary user SQL — it cannot be bound as a
//! parameter in DDL, so it is only checked for non-emptiness. This is the
//! same risk class the free-form Query Editor already accepts, not a new
//! one introduced here.

use crate::db::ddl::{validate_ident, Driver};
use crate::db::sql::quote_ident;
use crate::error::{AppError, AppResult};
use serde::{Deserialize, Serialize};

/// Quote a *validated* identifier for this driver. [`Driver`]'s own `quote`
/// helper in `ddl.rs` is private to that module, so this mirrors it rather
/// than widening `ddl.rs`'s visibility just for this one call site.
fn quote(driver: Driver, ident: &str) -> String {
    quote_ident(matches!(driver, Driver::Postgres | Driver::Sqlite), ident)
}

// ---------------------------------------------------------------------------
// DTOs — mirrored in src/types.ts (camelCase on the wire).
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ViewDefinition {
    #[serde(default)]
    pub schema: Option<String>,
    pub name: String,
    /// The view body only (a `SELECT ...` statement), never the surrounding
    /// `CREATE VIEW ... AS`. Drivers that only expose the full statement
    /// (SQLite) have it stripped before reaching this struct.
    pub query: String,
}

fn validate_view(v: &ViewDefinition) -> AppResult<()> {
    validate_ident("view", &v.name)?;
    if let Some(schema) = &v.schema {
        if !schema.is_empty() {
            validate_ident("schema", schema)?;
        }
    }
    if v.query.trim().is_empty() {
        return Err(AppError::InvalidInput("view query is empty".into()));
    }
    Ok(())
}

/// Qualified `schema.view` (or bare view) for the driver.
fn qualified(driver: Driver, schema: Option<&str>, name: &str) -> String {
    match schema {
        Some(s) if !s.is_empty() && driver != Driver::Sqlite => {
            format!("{}.{}", quote(driver, s), quote(driver, name))
        }
        _ => quote(driver, name),
    }
}

/// Build the ordered DDL statements to take `original` to `desired`.
///
/// `original = None` means "create a new view"; `Some(snapshot)` diffs the
/// two on name and body.
pub fn build_view_ddl(
    driver: Driver,
    original: Option<&ViewDefinition>,
    desired: &ViewDefinition,
) -> AppResult<(Vec<String>, bool)> {
    validate_view(desired)?;
    let qt = qualified(driver, desired.schema.as_deref(), &desired.name);

    let Some(orig) = original else {
        return Ok((
            vec![format!("CREATE VIEW {qt} AS {}", desired.query.trim())],
            false,
        ));
    };
    validate_view(orig)?;

    let renamed = orig.name != desired.name || orig.schema.as_deref() != desired.schema.as_deref();
    let body_changed = orig.query.trim() != desired.query.trim();
    if !renamed && !body_changed {
        return Ok((vec![], false));
    }

    match driver {
        Driver::Sqlite => {
            // No CREATE OR REPLACE / ALTER VIEW on SQLite — always drop the
            // original name and recreate under the desired one.
            let old_qt = qualified(driver, orig.schema.as_deref(), &orig.name);
            let stmts = vec![
                format!("DROP VIEW IF EXISTS {old_qt}"),
                format!("CREATE VIEW {qt} AS {}", desired.query.trim()),
            ];
            Ok((stmts, true))
        }
        Driver::Postgres => {
            let mut stmts = Vec::new();
            if renamed {
                let old_qt = qualified(driver, orig.schema.as_deref(), &orig.name);
                stmts.push(format!(
                    "ALTER VIEW {old_qt} RENAME TO {}",
                    quote(driver, &desired.name)
                ));
            }
            if body_changed {
                stmts.push(format!(
                    "CREATE OR REPLACE VIEW {qt} AS {}",
                    desired.query.trim()
                ));
            }
            Ok((stmts, false))
        }
        Driver::Mysql => {
            let mut stmts = Vec::new();
            if renamed {
                let old_qt = qualified(driver, orig.schema.as_deref(), &orig.name);
                stmts.push(format!("RENAME TABLE {old_qt} TO {qt}"));
            }
            if body_changed {
                stmts.push(format!(
                    "CREATE OR REPLACE VIEW {qt} AS {}",
                    desired.query.trim()
                ));
            }
            Ok((stmts, false))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn view(schema: Option<&str>, name: &str, query: &str) -> ViewDefinition {
        ViewDefinition {
            schema: schema.map(String::from),
            name: name.into(),
            query: query.into(),
        }
    }

    #[test]
    fn create_new_view() {
        let (stmts, rebuild) = build_view_ddl(
            Driver::Postgres,
            None,
            &view(Some("public"), "v_active", "SELECT 1"),
        )
        .unwrap();
        assert_eq!(
            stmts,
            vec!["CREATE VIEW \"public\".\"v_active\" AS SELECT 1"]
        );
        assert!(!rebuild);
    }

    #[test]
    fn postgres_body_change_uses_create_or_replace() {
        let orig = view(None, "v", "SELECT 1");
        let desired = view(None, "v", "SELECT 2");
        let (stmts, rebuild) = build_view_ddl(Driver::Postgres, Some(&orig), &desired).unwrap();
        assert_eq!(stmts, vec!["CREATE OR REPLACE VIEW \"v\" AS SELECT 2"]);
        assert!(!rebuild);
    }

    #[test]
    fn postgres_rename_and_redefine() {
        let orig = view(None, "old", "SELECT 1");
        let desired = view(None, "new", "SELECT 2");
        let (stmts, _) = build_view_ddl(Driver::Postgres, Some(&orig), &desired).unwrap();
        assert_eq!(
            stmts,
            vec![
                "ALTER VIEW \"old\" RENAME TO \"new\"",
                "CREATE OR REPLACE VIEW \"new\" AS SELECT 2"
            ]
        );
    }

    #[test]
    fn mysql_rename_only_no_body_change() {
        let orig = view(None, "old", "SELECT 1");
        let desired = view(None, "new", "SELECT 1");
        let (stmts, _) = build_view_ddl(Driver::Mysql, Some(&orig), &desired).unwrap();
        assert_eq!(stmts, vec!["RENAME TABLE `old` TO `new`"]);
    }

    #[test]
    fn sqlite_always_drop_and_recreate() {
        let orig = view(None, "v", "SELECT 1");
        let desired = view(None, "v", "SELECT 2");
        let (stmts, rebuild) = build_view_ddl(Driver::Sqlite, Some(&orig), &desired).unwrap();
        assert_eq!(
            stmts,
            vec!["DROP VIEW IF EXISTS \"v\"", "CREATE VIEW \"v\" AS SELECT 2"]
        );
        assert!(rebuild);
    }

    #[test]
    fn no_change_yields_no_statements() {
        let orig = view(None, "v", "SELECT 1");
        let (stmts, rebuild) =
            build_view_ddl(Driver::Postgres, Some(&orig), &orig.clone()).unwrap();
        assert!(stmts.is_empty());
        assert!(!rebuild);
    }

    #[test]
    fn empty_query_rejected() {
        assert!(build_view_ddl(Driver::Postgres, None, &view(None, "v", "   ")).is_err());
    }
}
