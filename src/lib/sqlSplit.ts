/**
 * Split a SQL document into individual statements.
 *
 * Used by the editor's per-statement "run" CodeLens so each `;`-delimited
 * statement gets its own gutter icon. The parser is intentionally
 * pragmatic — it understands the four lexical contexts that would cause
 * naïve splitting to break:
 *
 *  - single-quoted strings (`'…'`) with `''` escapes,
 *  - double-quoted identifiers (`"…"`),
 *  - backtick-quoted identifiers (`` `…` ``) — MySQL,
 *  - line comments (`-- …` to end of line),
 *  - block comments (`/* … *​/` — non-nested, ANSI behaviour),
 *  - Postgres dollar-quoted strings (`$tag$ … $tag$`, including the
 *    empty tag `$$ … $$`).
 *
 * Everything outside those contexts is a candidate for a `;` boundary.
 * Empty statements (e.g. a stray trailing semicolon) are skipped.
 *
 * The output positions use Monaco's convention: line and column are
 * **1-based**, so a CodeLens can be anchored straight on them without
 * a coordinate shim.
 */

export interface SqlStatement {
  /** 1-based line where the statement starts. */
  startLine: number;
  /** 1-based column where the statement starts. */
  startColumn: number;
  /** 1-based line where the statement ends (inclusive). */
  endLine: number;
  /** 1-based column right after the last character of the statement. */
  endColumn: number;
  /** The statement's text, with leading whitespace / comments trimmed
   *  off the front so an empty `";"` between statements is filtered out. */
  text: string;
}

type Mode =
  | "default"
  | "single-string"
  | "double-string"
  | "back-string"
  | "line-comment"
  | "block-comment"
  | "dollar-string";

/**
 * Detect a dollar-quoted opening at `pos` and return the full tag
 * (including the leading and trailing `$`). Returns `null` if `pos`
 * doesn't start a valid dollar-quote.
 *
 * The Postgres grammar allows an identifier-like body between the
 * dollars: `$$`, `$body$`, `$_my_tag$`. We restrict to that minimum
 * because any tighter rules would reject syntactically valid input.
 */
function readDollarTag(source: string, pos: number): string | null {
  if (source[pos] !== "$") return null;
  let end = pos + 1;
  while (end < source.length) {
    const ch = source[end];
    if (ch === "$") return source.slice(pos, end + 1);
    if (!/[A-Za-z0-9_]/.test(ch)) return null;
    end++;
  }
  return null;
}

export function splitSql(source: string): SqlStatement[] {
  const out: SqlStatement[] = [];
  if (!source) return out;

  // Cursor state. We track line / column alongside the absolute index
  // so we can build Monaco-friendly positions without a second pass.
  let line = 1;
  let column = 1;
  let mode: Mode = "default";
  /** Active dollar-quote tag (e.g. `"$body$"`) while inside one. */
  let dollarTag = "";

  /** Index of the first non-whitespace, non-comment character of the
   *  current statement; -1 when nothing has been seen yet. */
  let stmtStart = -1;
  let stmtStartLine = 1;
  let stmtStartColumn = 1;

  function commit(endIdx: number, endLineV: number, endColumnV: number) {
    if (stmtStart < 0) return;
    const raw = source.slice(stmtStart, endIdx);
    // Drop pure-whitespace statements (e.g. a stray ";").
    if (!raw.trim()) {
      stmtStart = -1;
      return;
    }
    out.push({
      startLine: stmtStartLine,
      startColumn: stmtStartColumn,
      endLine: endLineV,
      endColumn: endColumnV,
      text: raw,
    });
    stmtStart = -1;
  }

  for (let i = 0; i < source.length; i++) {
    const ch = source[i];
    const next = source[i + 1];

    // Mode-specific scanning. We deal with exit conditions here and
    // fall through to the default-mode branch otherwise.
    if (mode === "single-string") {
      // `''` is an escape, not a terminator.
      if (ch === "'" && next === "'") {
        i++;
        column += 2;
        continue;
      }
      if (ch === "'") mode = "default";
    } else if (mode === "double-string") {
      if (ch === '"' && next === '"') {
        i++;
        column += 2;
        continue;
      }
      if (ch === '"') mode = "default";
    } else if (mode === "back-string") {
      if (ch === "`" && next === "`") {
        i++;
        column += 2;
        continue;
      }
      if (ch === "`") mode = "default";
    } else if (mode === "line-comment") {
      if (ch === "\n") {
        mode = "default";
        line++;
        column = 1;
        continue;
      }
    } else if (mode === "block-comment") {
      if (ch === "*" && next === "/") {
        mode = "default";
        i++;
        column += 2;
        continue;
      }
      if (ch === "\n") {
        line++;
        column = 1;
        continue;
      }
    } else if (mode === "dollar-string") {
      if (ch === "$" && source.startsWith(dollarTag, i)) {
        i += dollarTag.length - 1;
        column += dollarTag.length;
        mode = "default";
        dollarTag = "";
        continue;
      }
      if (ch === "\n") {
        line++;
        column = 1;
        continue;
      }
    }

    if (mode === "default") {
      // Skip leading whitespace + comments when picking the statement
      // start. A `--` that begins a statement, or a `/* */` block, is
      // not "where the statement starts".
      const isWs = ch === " " || ch === "\t" || ch === "\r" || ch === "\n";
      const isLineCommentOpen = ch === "-" && next === "-";
      const isBlockCommentOpen = ch === "/" && next === "*";

      if (stmtStart < 0 && !isWs && !isLineCommentOpen && !isBlockCommentOpen) {
        stmtStart = i;
        stmtStartLine = line;
        stmtStartColumn = column;
      }

      if (ch === ";") {
        // `i + 1` is one past the `;`; column has not yet advanced for
        // the semicolon, so the end column is `column + 1`.
        commit(i + 1, line, column + 1);
      } else if (isLineCommentOpen) {
        mode = "line-comment";
        i++;
        column += 2;
        continue;
      } else if (isBlockCommentOpen) {
        mode = "block-comment";
        i++;
        column += 2;
        continue;
      } else if (ch === "'") {
        mode = "single-string";
      } else if (ch === '"') {
        mode = "double-string";
      } else if (ch === "`") {
        mode = "back-string";
      } else if (ch === "$") {
        const tag = readDollarTag(source, i);
        if (tag) {
          mode = "dollar-string";
          dollarTag = tag;
          i += tag.length - 1;
          column += tag.length;
          continue;
        }
      }
    }

    // Common bookkeeping: advance line/column for every character we
    // didn't already `continue` past above.
    if (ch === "\n") {
      line++;
      column = 1;
    } else {
      column++;
    }
  }

  // Trailing statement without a terminating `;`.
  if (stmtStart >= 0) {
    commit(source.length, line, column);
  }

  return out;
}
