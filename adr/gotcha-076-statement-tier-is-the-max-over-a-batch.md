# Gotcha #076: A statement's tier is the strictest tier in the whole string, not the tier of its first keyword

**Fecha:** 2026-09-10

`db::sql::classify` read the first keyword of whatever text it was handed, so `SELECT 1; DELETE FROM t` classified as `Read` — and both consumers of that answer (the MCP connector's per-connection policy and `ai::exec`'s no-write rule) admitted it. It now takes the `max` over `split_statements`.

## Detail

**Whether the hidden write actually ran was a driver accident, not a decision.** A read goes down the prepared/binary path, and Postgres and MySQL both reject a multi-statement string there — which is why this never showed up as a bug report. SQLite's driver loops over the statements in the text, and a T-SQL batch is *defined* as running all of them, so on those two the `DELETE` executed under a `read-only` policy. An authorisation boundary that holds on three drivers out of five is not a boundary; it is a coincidence that the test suite happened to be sitting on.

- **`split_statements` is a lexer, not a parser** (gotcha #33's rule still holds). Knowing where a statement ends is a lexical question: a `;` separates unless it is inside a string literal, a quoted identifier (`"…"`, `` `…` ``, `[…]`), a line or block comment, or a Postgres dollar-quoted body. Doubled quotes, MySQL's backslash escapes, `]]`, nested block comments and `$tag$` are each handled because each is a way to put a semicolon in a statement without ending it. `$1` is not a dollar quote — a bind placeholder must not swallow the rest of the batch.
- **`StmtClass`'s variant order is now load-bearing**, and says so in its doc comment: `classify` derives the answer with `Ord`, so `Read < DataWrite < Ddl` is the mechanism rather than a convention. Reordering the variants for tidiness would silently pick the wrong tier.
- **Several reads stay a read.** The rule is "the strictest tier present", not "a batch is suspicious": `SELECT 1; SELECT 2` is still `Read`, because nothing in it writes. Refusing batches wholesale would have been easier and would have broken the MCP `data` tier's ability to send two `INSERT`s in one call for no security gain.
- **`is_unfiltered_write` gets the same treatment**, for the same reason: the whole-table-`DELETE` guard has to see a `DELETE FROM t` that arrives behind a harmless first statement.
- **The AI surface refuses a batch outright anyway**, one layer up, because its tools document themselves as taking one statement — but it does so with its own message (gotcha #77), not with this tier decision.
