//! Small SQL helpers shared across command handlers.

/// Wrap `name` in the quoting characters appropriate for the driver.
///
/// * `pg_or_sqlite = true`  → use double quotes (`"name"`).
/// * `pg_or_sqlite = false` → use backticks (`` `name` ``), MySQL style.
///
/// The function escapes any embedded quote characters by doubling them,
/// matching the standard SQL identifier-quoting rules. Callers are still
/// responsible for sourcing `name` from a trusted catalog query — this
/// helper is for layout, not for sanitising arbitrary user input.
pub fn quote_ident(pg_or_sqlite: bool, name: &str) -> String {
    if pg_or_sqlite {
        format!("\"{}\"", name.replace('"', "\"\""))
    } else {
        format!("`{}`", name.replace('`', "``"))
    }
}

/// Best-effort classification of a SQL statement as a read-only query.
///
/// We use this to decide whether [`crate::commands::query::execute_query`]
/// should fetch a result set or just report `rows_affected`. The check is
/// intentionally simple — it inspects the first keyword after leading
/// whitespace. Anything unusual (e.g. multi-statement scripts, DDL that
/// returns rows on some drivers) falls back to the write path and the user
/// still sees the row-count summary.
pub fn is_read_only(sql: &str) -> bool {
    let head = sql.trim_start().to_ascii_lowercase();
    head.starts_with("select")
        || head.starts_with("with")
        || head.starts_with("show")
        || head.starts_with("explain")
        || head.starts_with("pragma")
}
