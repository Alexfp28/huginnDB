//! Small SQL helpers shared across command handlers.

use crate::error::{AppError, AppResult};
use crate::state::DbPool;

/// The SQL dialect spoken by one connection.
///
/// This is the single source of truth for every place the generated SQL has to
/// differ per engine: identifier quoting, positional placeholders, the cast
/// target used by text predicates, `LIKE` semantics and pagination. It
/// deliberately has **no MongoDB variant** — Mongo is not a SQL dialect and
/// every command dispatches it to [`crate::db::mongo`] before any SQL is built,
/// so [`Dialect::try_of`] rejects it instead of inventing a meaningless answer.
///
/// It replaces the old `quote_ident(pg_or_sqlite: bool, …)` flag, which encoded
/// a three-way choice in one bit and could not express a fourth engine (SQL
/// Server quotes with `[brackets]`, numbers placeholders `@P1`, and has no
/// `LIMIT`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Dialect {
    Postgres,
    Mysql,
    Sqlite,
    MsSql,
}

impl Dialect {
    /// The dialect of a live pool.
    ///
    /// `Err(UnsupportedDriver)` for MongoDB: callers that can reach a Mongo
    /// pool must have handled it before asking for a dialect.
    pub fn try_of(pool: &DbPool) -> AppResult<Self> {
        match pool {
            DbPool::Postgres(_) => Ok(Self::Postgres),
            DbPool::Mysql(_) => Ok(Self::Mysql),
            DbPool::Sqlite(_) => Ok(Self::Sqlite),
            DbPool::MsSql(_) => Ok(Self::MsSql),
            DbPool::Mongo(_) => Err(AppError::UnsupportedDriver(
                "MongoDB does not speak SQL; this operation is SQL-only".into(),
            )),
        }
    }

    /// Wrap `name` in this dialect's identifier quotes, escaping any embedded
    /// quote character by doubling it (the standard SQL rule, and the one SQL
    /// Server follows for `]` inside brackets).
    ///
    /// Callers are still responsible for sourcing `name` from a trusted catalog
    /// query — this is for layout, not for sanitising arbitrary user input. The
    /// one sanctioned exception is the DDL builder, which validates every
    /// user-entered name through [`crate::db::ddl::validate_ident`] first.
    pub fn quote_ident(self, name: &str) -> String {
        match self {
            Self::Postgres | Self::Sqlite => format!("\"{}\"", name.replace('"', "\"\"")),
            Self::Mysql => format!("`{}`", name.replace('`', "``")),
            Self::MsSql => format!("[{}]", name.replace(']', "]]")),
        }
    }

    /// The `index`-th (1-based) positional placeholder.
    ///
    /// Postgres and SQL Server number their placeholders, so the caller has to
    /// thread a counter; MySQL/SQLite ignore `index` entirely.
    pub fn placeholder(self, index: usize) -> String {
        match self {
            Self::Postgres => format!("${index}"),
            Self::Mysql | Self::Sqlite => "?".to_string(),
            Self::MsSql => format!("@P{index}"),
        }
    }

    /// Cast target that turns any column into text, for the `LIKE`-based
    /// filters. MySQL rejects `CAST(x AS TEXT)`; SQL Server needs a length.
    pub fn cast_to_text(self) -> &'static str {
        match self {
            Self::Postgres | Self::Sqlite => "TEXT",
            Self::Mysql => "CHAR",
            Self::MsSql => "NVARCHAR(MAX)",
        }
    }

    /// Keyword for a case-insensitive `LIKE`. Only Postgres has a dedicated
    /// one; MySQL and SQL Server are case-insensitive through their default
    /// collation, and SQLite's `LIKE` is ASCII-case-insensitive by default.
    pub fn like_kw(self) -> &'static str {
        match self {
            Self::Postgres => "ILIKE",
            Self::Mysql | Self::Sqlite | Self::MsSql => "LIKE",
        }
    }

    /// Whether a *negated* case-insensitive match has to fold both sides with
    /// `lower()`.
    ///
    /// `ILIKE` has no negated spelling that composes with the surrounding
    /// `CAST(...)`, so on Postgres "not contains" is emitted as
    /// `lower(CAST(col AS TEXT)) NOT LIKE lower($1)`. The other dialects get
    /// case-insensitivity from the collation, so their plain `NOT LIKE` is
    /// already case-insensitive.
    pub fn not_like_needs_lower(self) -> bool {
        matches!(self, Self::Postgres)
    }

    /// `ESCAPE` clause matching the `\` escape character the filter builder
    /// emits, rendered correctly for this dialect.
    ///
    /// MySQL/MariaDB interprets `\` as an escape inside *string literals*, so
    /// the SQL text must carry `ESCAPE '\\'` (two backslashes → one literal
    /// backslash); the single-backslash form leaves the literal unterminated
    /// and raises error 1064. The others use standard-SQL string literals where
    /// `\` is itself. Returned with a leading space so callers can append it
    /// straight after the placeholder.
    pub fn like_escape_clause(self) -> &'static str {
        match self {
            Self::Mysql => " ESCAPE '\\\\'",
            Self::Postgres | Self::Sqlite | Self::MsSql => " ESCAPE '\\'",
        }
    }

    /// Trailing pagination clause, with a leading space, for a statement that
    /// already carries `order_clause` (empty when the user hasn't sorted).
    ///
    /// SQL Server has no `LIMIT`: it needs `OFFSET n ROWS FETCH NEXT m ROWS
    /// ONLY`, which is only legal after an `ORDER BY` — hence the
    /// `ORDER BY (SELECT NULL)` filler when there is no user sort. That syntax
    /// requires **SQL Server 2012 or newer**; 2008 and older would need a
    /// `ROW_NUMBER()` window instead.
    pub fn paginate(self, limit: i64, offset: i64, has_order_by: bool) -> String {
        match self {
            Self::Postgres | Self::Mysql | Self::Sqlite => {
                format!(" LIMIT {limit} OFFSET {offset}")
            }
            Self::MsSql => {
                let filler = if has_order_by {
                    ""
                } else {
                    " ORDER BY (SELECT NULL)"
                };
                format!("{filler} OFFSET {offset} ROWS FETCH NEXT {limit} ROWS ONLY")
            }
        }
    }

    /// Whether this dialect namespaces objects under a schema. SQLite doesn't
    /// (its `main`/`temp` prefixes are attached databases, not schemas), so
    /// every qualifier builder skips it there.
    pub fn has_schemas(self) -> bool {
        !matches!(self, Self::Sqlite)
    }

    /// The schema assumed when the caller doesn't name one. `None` for MySQL
    /// (the session's current database already scopes an unqualified name) and
    /// SQLite (no schemas at all).
    pub fn default_schema(self) -> Option<&'static str> {
        match self {
            Self::Postgres => Some("public"),
            Self::MsSql => Some("dbo"),
            Self::Mysql | Self::Sqlite => None,
        }
    }

    /// `schema.table`, quoted — schema included only when this dialect has
    /// schemas and the caller supplied a non-empty one.
    pub fn qualify(self, schema: Option<&str>, table: &str) -> String {
        match schema {
            Some(s) if !s.is_empty() && self.has_schemas() => {
                format!("{}.{}", self.quote_ident(s), self.quote_ident(table))
            }
            _ => self.quote_ident(table),
        }
    }

    /// Like [`Self::qualify`], but falling back to [`Self::default_schema`]
    /// when the caller passed none. Used by the data-browsing path, where an
    /// unqualified Postgres name would resolve through `search_path` instead of
    /// the schema the explorer actually showed.
    pub fn qualify_defaulted(self, schema: Option<&str>, table: &str) -> String {
        match schema {
            Some(s) if !s.is_empty() => self.qualify(Some(s), table),
            _ => self.qualify(self.default_schema(), table),
        }
    }

    /// The statement that empties `qualified` of every row.
    ///
    /// `TRUNCATE TABLE` everywhere it exists; SQLite has no `TRUNCATE`, so it
    /// gets an unfiltered `DELETE FROM` (which SQLite itself optimises into the
    /// truncate fast path when there are no triggers).
    ///
    /// Spelled out per dialect rather than "SQLite, else TRUNCATE". The
    /// difference is not "SQLite is the odd one out" — it is a per-engine fact
    /// about which statement exists, and the next engine added has to state its
    /// own answer instead of silently inheriting Postgres's. That is the whole
    /// reason this enum owns the generated SQL, and this call site was the one
    /// place still guessing.
    pub fn truncate_stmt(self, qualified: &str) -> String {
        match self {
            Dialect::Postgres | Dialect::Mysql | Dialect::MsSql => {
                format!("TRUNCATE TABLE {qualified}")
            }
            Dialect::Sqlite => format!("DELETE FROM {qualified}"),
        }
    }
}

/// Skip leading whitespace and SQL comments (`-- …` line comments and
/// `/* … */` block comments) so the keyword-prefix classifiers below aren't
/// fooled by a comment sitting in front of the real statement — e.g. the
/// query editor's own placeholder text (`-- write a SQL query…`) left above
/// a pasted `SELECT` used to make [`is_read_only`] fall through to the write
/// path: the statement still ran and reported a row count, but
/// `execute_query` only fetches a result set on the read path, so the grid
/// stayed empty even though the query genuinely returned rows.
///
/// Not a real lexer — doesn't understand string/identifier quoting, so a
/// `--` or `/*` inside a string literal before the statement proper would
/// misfire. Statements never legitimately start with a quoted literal, so
/// this is good enough for "what kind of statement is this".
fn skip_leading_noise(sql: &str) -> &str {
    let mut s = sql;
    loop {
        let trimmed = s.trim_start();
        if let Some(rest) = trimmed.strip_prefix("--") {
            match rest.find('\n') {
                Some(nl) => {
                    s = &rest[nl + 1..];
                    continue;
                }
                None => return "",
            }
        }
        if let Some(rest) = trimmed.strip_prefix("/*") {
            match rest.find("*/") {
                Some(end) => {
                    s = &rest[end + 2..];
                    continue;
                }
                None => return "",
            }
        }
        return trimmed;
    }
}

/// Best-effort classification of a SQL statement as a read-only query.
///
/// We use this to decide whether [`crate::commands::query::execute_query`]
/// should fetch a result set or just report `rows_affected`. The check is
/// intentionally simple — it inspects the first keyword after leading
/// whitespace/comments. Anything unusual (e.g. multi-statement scripts, DDL
/// that returns rows on some drivers) falls back to the write path and the
/// user still sees the row-count summary.
pub fn is_read_only(sql: &str) -> bool {
    let head = skip_leading_noise(sql).to_ascii_lowercase();
    head.starts_with("select")
        || head.starts_with("with")
        || head.starts_with("show")
        || head.starts_with("explain")
        || head.starts_with("pragma")
}

/// Write-capability tier a single SQL statement requires. Drives the MCP
/// connector's per-connection enforcement against [`crate::state::McpWritePolicy`]:
/// a `read-only` connection admits only [`StmtClass::Read`], `data` admits
/// [`StmtClass::DataWrite`] as well, and `full` admits [`StmtClass::Ddl`] too.
///
/// This classifier (and its siblings below) is consumed only by the `mcp`
/// feature's enforcement path, but its unit tests run under the default
/// feature set, so it stays compiled unconditionally and only silences the
/// dead-code lint when `mcp` is off.
#[cfg_attr(not(feature = "mcp"), allow(dead_code))]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StmtClass {
    /// `SELECT` / `WITH` / `SHOW` / `EXPLAIN` / `PRAGMA` — reads nothing back
    /// that changes state.
    Read,
    /// Row-level DML: `INSERT` / `UPDATE` / `DELETE` / `MERGE` / … — changes
    /// data but not schema.
    DataWrite,
    /// Schema / privilege change: `CREATE` / `DROP` / `ALTER` / `TRUNCATE` /
    /// `RENAME` / `GRANT` / `REVOKE` / `COMMENT`.
    Ddl,
}

/// Best-effort classification of a statement as DDL (schema/privilege change).
///
/// Mostly the same first-keyword heuristic as [`is_read_only`]. `TRUNCATE` is
/// grouped with DDL rather than DML on purpose: it is an irreversible
/// whole-table operation, so it belongs behind the strictest (`full`) tier, not
/// the row-level `data` tier.
///
/// Two additions exist for T-SQL, whose statement vocabulary the plain
/// keyword-prefix rule classifies too leniently:
///
/// * **`EXEC` / `EXECUTE`** is opaque. `EXEC sp_rename …` renames an object and
///   `EXEC('DROP TABLE t')` runs arbitrary text, so a procedure call cannot be
///   assumed to be data-only. It is put behind the `full` tier, which means a
///   read-only `EXEC sp_help` is refused too — the safe direction for a
///   security boundary.
/// * **`SELECT … INTO t`** creates a table. It starts with `select`, so the
///   prefix rule alone reports a read.
#[cfg_attr(not(feature = "mcp"), allow(dead_code))]
pub fn is_ddl(sql: &str) -> bool {
    let head = skip_leading_noise(sql).to_ascii_lowercase();
    const DDL_PREFIXES: [&str; 10] = [
        "create", "drop", "alter", "truncate", "rename", "grant", "revoke", "comment", "exec",
        "execute",
    ];
    DDL_PREFIXES.iter().any(|p| head.starts_with(p)) || is_select_into(&head)
}

/// Whether an already-lowercased, comment-stripped statement is T-SQL's
/// table-creating `SELECT … INTO <table> FROM …`.
///
/// `INTO` is matched as a whole word anywhere in the statement rather than
/// positionally, so a literal or alias that merely contains the word can push a
/// genuine read into the DDL tier. That is the deliberate direction: the cost is
/// a refused `SELECT 'into'` under a restricted MCP policy, whereas the
/// opposite error would let a statement that creates a table pass as a read.
/// [`is_read_only`] is intentionally *not* changed by this — it also drives
/// whether the GUI fetches a result set, and there a false positive would blank
/// the grid for an ordinary query.
#[cfg_attr(not(feature = "mcp"), allow(dead_code))]
fn is_select_into(head_lower: &str) -> bool {
    (head_lower.starts_with("select") || head_lower.starts_with("with"))
        && contains_word(head_lower, "into")
}

/// Classify a single statement into the write tier it requires.
///
/// DDL is checked first, then reads, then everything else falls to row-level
/// DML — the conservative default, since an unrecognised non-read statement
/// must not slip in under a read-only or data-only policy. The DDL-first order
/// matters: [`is_ddl`] catches statements that *look* like reads by their first
/// keyword but change schema (`SELECT … INTO`), and it must win over
/// [`is_read_only`] for those.
#[cfg_attr(not(feature = "mcp"), allow(dead_code))]
pub fn classify(sql: &str) -> StmtClass {
    if is_ddl(sql) {
        StmtClass::Ddl
    } else if is_read_only(sql) {
        StmtClass::Read
    } else {
        StmtClass::DataWrite
    }
}

/// Whether `sql` is an `UPDATE` or `DELETE` with no `WHERE` clause — a
/// whole-table mutation. The MCP connector refuses these outright (even at
/// `data`/`full` tiers): an AI client emitting an unqualified `DELETE FROM t`
/// or `UPDATE t SET …` is a classic footgun, and requiring an explicit
/// predicate (a literal `WHERE 1=1` if the user really means "all rows")
/// turns a silent whole-table wipe into a deliberate one.
///
/// `WHERE` is matched as a whole token (case-insensitive) so a column or value
/// merely containing the substring doesn't count. A `WHERE` living only inside
/// a comment is a tolerated blind spot — single AI-authored statements rarely
/// carry comments, and this is a guard-rail layered on top of the tier check,
/// not the primary authorisation.
#[cfg_attr(not(feature = "mcp"), allow(dead_code))]
pub fn is_unfiltered_write(sql: &str) -> bool {
    let head = sql.trim_start().to_ascii_lowercase();
    if !(head.starts_with("update") || head.starts_with("delete")) {
        return false;
    }
    !contains_word(&head, "where")
}

/// True if `word` appears in `haystack_lower` (already lowercased) delimited by
/// non-identifier characters on both sides — a poor-man's tokeniser good enough
/// to spot SQL keywords without a full parser.
#[cfg_attr(not(feature = "mcp"), allow(dead_code))]
fn contains_word(haystack_lower: &str, word: &str) -> bool {
    haystack_lower
        .split(|c: char| !c.is_ascii_alphanumeric() && c != '_')
        .any(|tok| tok == word)
}

#[cfg(test)]
mod tests {
    use super::{classify, is_ddl, is_read_only, is_unfiltered_write, Dialect, StmtClass};

    #[test]
    fn truncate_stmt_is_delete_only_on_sqlite() {
        assert_eq!(
            Dialect::Postgres.truncate_stmt("\"public\".\"t\""),
            "TRUNCATE TABLE \"public\".\"t\""
        );
        assert_eq!(
            Dialect::Mysql.truncate_stmt("`db`.`t`"),
            "TRUNCATE TABLE `db`.`t`"
        );
        assert_eq!(
            Dialect::MsSql.truncate_stmt("[dbo].[t]"),
            "TRUNCATE TABLE [dbo].[t]"
        );
        // SQLite has no TRUNCATE at all.
        assert_eq!(Dialect::Sqlite.truncate_stmt("\"t\""), "DELETE FROM \"t\"");
    }

    #[test]
    fn quotes_identifiers_per_dialect() {
        assert_eq!(Dialect::Postgres.quote_ident("tbl"), "\"tbl\"");
        assert_eq!(Dialect::Sqlite.quote_ident("tbl"), "\"tbl\"");
        assert_eq!(Dialect::Mysql.quote_ident("tbl"), "`tbl`");
        assert_eq!(Dialect::MsSql.quote_ident("tbl"), "[tbl]");
    }

    #[test]
    fn escapes_the_closing_quote_character_by_doubling_it() {
        // A catalog can legitimately hand us an identifier containing the
        // quote character; doubling it is the standard SQL escape and the one
        // SQL Server uses for `]` inside brackets.
        assert_eq!(Dialect::Postgres.quote_ident("we\"ird"), "\"we\"\"ird\"");
        assert_eq!(Dialect::Mysql.quote_ident("we`ird"), "`we``ird`");
        assert_eq!(Dialect::MsSql.quote_ident("we]ird"), "[we]]ird]");
    }

    #[test]
    fn numbers_placeholders_only_where_the_dialect_does() {
        assert_eq!(Dialect::Postgres.placeholder(3), "$3");
        assert_eq!(Dialect::MsSql.placeholder(3), "@P3");
        assert_eq!(Dialect::Mysql.placeholder(3), "?");
        assert_eq!(Dialect::Sqlite.placeholder(3), "?");
    }

    #[test]
    fn paginates_with_limit_offset_or_offset_fetch() {
        assert_eq!(
            Dialect::Postgres.paginate(50, 100, true),
            " LIMIT 50 OFFSET 100"
        );
        // The ORDER BY is not optional in T-SQL's OFFSET/FETCH, so an unsorted
        // browse gets a filler one.
        assert_eq!(
            Dialect::MsSql.paginate(50, 100, true),
            " OFFSET 100 ROWS FETCH NEXT 50 ROWS ONLY"
        );
        assert_eq!(
            Dialect::MsSql.paginate(50, 0, false),
            " ORDER BY (SELECT NULL) OFFSET 0 ROWS FETCH NEXT 50 ROWS ONLY"
        );
    }

    #[test]
    fn qualifies_names_per_dialect() {
        assert_eq!(
            Dialect::Postgres.qualify(Some("s"), "t"),
            "\"s\".\"t\"".to_string()
        );
        assert_eq!(
            Dialect::MsSql.qualify(Some("s"), "t"),
            "[s].[t]".to_string()
        );
        assert_eq!(Dialect::Mysql.qualify(None, "t"), "`t`".to_string());
        // SQLite has no schemas: a stray one is dropped rather than emitted as
        // an attached-database prefix.
        assert_eq!(Dialect::Sqlite.qualify(Some("main"), "t"), "\"t\"");
        // The defaulted variant pins the engine's default schema so an
        // unqualified name can't resolve through `search_path`.
        assert_eq!(
            Dialect::Postgres.qualify_defaulted(None, "t"),
            "\"public\".\"t\""
        );
        assert_eq!(Dialect::MsSql.qualify_defaulted(None, "t"), "[dbo].[t]");
        assert_eq!(Dialect::Mysql.qualify_defaulted(None, "t"), "`t`");
        assert_eq!(Dialect::Sqlite.qualify_defaulted(None, "t"), "\"t\"");
    }

    #[test]
    fn classifies_reads_as_read_only() {
        for sql in [
            "SELECT * FROM t",
            "  select 1",
            "\n\tWITH x AS (SELECT 1) SELECT * FROM x",
            "SHOW TABLES",
            "EXPLAIN SELECT 1",
            "PRAGMA table_info(t)",
        ] {
            assert!(is_read_only(sql), "expected read-only: {sql:?}");
        }
    }

    #[test]
    fn a_leading_comment_does_not_defeat_read_only_detection() {
        // The query editor's own placeholder ("-- write a SQL query and
        // press Ctrl+Enter") left above a pasted SELECT used to make this
        // fall through to the write path, which silently drops the result
        // set (execute_query only fetches rows on the read path).
        for sql in [
            "-- write a SQL query and press Ctrl+Enter\nSELECT * FROM t",
            "-- a comment\n-- another comment\nselect 1",
            "/* block comment */ SELECT 1",
            "/* multi\nline */\nSELECT 1",
        ] {
            assert!(is_read_only(sql), "expected read-only: {sql:?}");
        }
    }

    #[test]
    fn an_unterminated_leading_comment_is_not_read_only() {
        // No real statement follows the comment, so there is nothing to
        // classify as a read — falling to the write path is the safe default.
        for sql in ["-- trailing comment with no newline", "/* unterminated"] {
            assert!(!is_read_only(sql), "expected non-read-only: {sql:?}");
        }
    }

    #[test]
    fn classifies_writes_as_not_read_only() {
        // Backs the MCP `run_query` guard: none of these may pass in the
        // read-only server mode.
        for sql in [
            "UPDATE t SET a = 1",
            "DELETE FROM t",
            "INSERT INTO t VALUES (1)",
            "DROP TABLE t",
            "CREATE TABLE t (id INT)",
            "ALTER TABLE t ADD COLUMN c INT",
            "TRUNCATE t",
        ] {
            assert!(!is_read_only(sql), "expected write: {sql:?}");
        }
    }

    #[test]
    fn classify_splits_read_data_and_ddl() {
        assert_eq!(classify("SELECT 1"), StmtClass::Read);
        assert_eq!(
            classify("  with x as (select 1) select * from x"),
            StmtClass::Read
        );
        assert_eq!(classify("INSERT INTO t VALUES (1)"), StmtClass::DataWrite);
        assert_eq!(
            classify("UPDATE t SET a = 1 WHERE id = 2"),
            StmtClass::DataWrite
        );
        assert_eq!(classify("delete from t where id = 1"), StmtClass::DataWrite);
        assert_eq!(classify("CREATE TABLE t (id INT)"), StmtClass::Ddl);
        assert_eq!(classify("drop table t"), StmtClass::Ddl);
        assert_eq!(classify("ALTER TABLE t ADD COLUMN c INT"), StmtClass::Ddl);
        assert_eq!(classify("TRUNCATE t"), StmtClass::Ddl);
        assert_eq!(classify("GRANT SELECT ON t TO u"), StmtClass::Ddl);
        // An unrecognised non-read statement is conservatively DataWrite so it
        // can never pass under a read-only policy. `MERGE INTO` is DML, not
        // DDL, even though it carries the `INTO` that `SELECT … INTO` is
        // detected by — the `select`/`with` prefix requirement keeps them
        // apart.
        assert_eq!(
            classify("MERGE INTO t USING s ON (t.id = s.id)"),
            StmtClass::DataWrite
        );
    }

    #[test]
    fn t_sql_statements_that_look_like_reads_are_classified_as_ddl() {
        // `SELECT … INTO` creates a table; the first-keyword rule alone reads
        // it as a plain SELECT, which would let it through a read-only MCP
        // policy.
        assert_eq!(
            classify("SELECT * INTO archive FROM orders"),
            StmtClass::Ddl
        );
        assert_eq!(
            classify("with x as (select 1) select * into t from x"),
            StmtClass::Ddl
        );
        // A procedure call is opaque: it can rename objects or run dynamic
        // DDL, so it sits behind the strictest tier.
        assert_eq!(classify("EXEC sp_rename 'a', 'b'"), StmtClass::Ddl);
        assert_eq!(classify("execute dbo.DoSomething"), StmtClass::Ddl);
        // A plain SELECT with no INTO stays a read.
        assert_eq!(classify("SELECT TOP 10 * FROM orders"), StmtClass::Read);
    }

    #[test]
    fn is_ddl_matches_schema_and_privilege_statements() {
        for sql in [
            "CREATE TABLE t (id INT)",
            "drop index i",
            "REVOKE ALL ON t FROM u",
        ] {
            assert!(is_ddl(sql), "expected DDL: {sql:?}");
        }
        for sql in ["SELECT 1", "UPDATE t SET a = 1", "INSERT INTO t VALUES (1)"] {
            assert!(!is_ddl(sql), "expected non-DDL: {sql:?}");
        }
    }

    #[test]
    fn flags_whole_table_updates_and_deletes() {
        for sql in [
            "DELETE FROM t",
            "  delete from t  ",
            "UPDATE t SET a = 1",
            "update t set a = 1",
            // A column whose name merely contains "where" is not a WHERE clause,
            // so this whole-table update is still flagged.
            "UPDATE t SET wherever = 1",
        ] {
            assert!(
                is_unfiltered_write(sql),
                "expected whole-table write: {sql:?}"
            );
        }
        for sql in [
            "DELETE FROM t WHERE id = 1",
            "UPDATE t SET a = 1 WHERE id = 2",
            "SELECT * FROM t",
            "INSERT INTO t VALUES (1)",
            // Real WHERE clause even though a value also contains the substring.
            "DELETE FROM t WHERE note = 'nowhere'",
        ] {
            assert!(!is_unfiltered_write(sql), "expected not-flagged: {sql:?}");
        }
    }
}
