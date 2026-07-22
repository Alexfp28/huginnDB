//! A bounded `mongosh`-style command parser.
//!
//! Parses the subset of the Mongo shell HuginnDB's query editor supports:
//!
//! ```text
//! db.<collection>.<method>(<args>) [.sort({…})] [.limit(n)] [.skip(n)] [.projection({…})]
//! ```
//!
//! It is deliberately *not* a JavaScript engine — it understands a fixed set of
//! collection methods and a relaxed-JSON argument grammar (unquoted keys, single
//! quotes, trailing commas) plus the common BSON constructors (`ObjectId(...)`,
//! `ISODate(...)`/`new Date(...)`, `NumberLong/Int/Double/Decimal(...)`). Those
//! constructors are lowered to Extended JSON-shaped BSON via the same path as
//! [`super::values::json_to_bson`], so the document model stays in one place.
//!
//! Anything outside the grammar (an unknown method, JS expressions, variable
//! references) is rejected with a clear [`AppError::InvalidInput`] rather than
//! silently mis-parsed.

use crate::error::{AppError, AppResult};
use mongodb::bson::{Bson, Document};
use std::str::FromStr;

/// The collection operation a parsed statement maps to.
#[derive(Debug, Clone, PartialEq)]
pub enum MongoOp {
    Find {
        filter: Document,
        projection: Option<Document>,
        sort: Option<Document>,
        limit: Option<i64>,
        skip: Option<i64>,
        /// `findOne` — caps the result at a single document.
        one: bool,
    },
    Aggregate {
        pipeline: Vec<Document>,
    },
    Count {
        filter: Document,
    },
    Distinct {
        field: String,
        filter: Document,
    },
    InsertOne {
        doc: Document,
    },
    InsertMany {
        docs: Vec<Document>,
    },
    UpdateOne {
        filter: Document,
        update: UpdateSpec,
    },
    UpdateMany {
        filter: Document,
        update: UpdateSpec,
    },
    ReplaceOne {
        filter: Document,
        replacement: Document,
    },
    DeleteOne {
        filter: Document,
    },
    DeleteMany {
        filter: Document,
    },
}

impl MongoOp {
    /// Whether this operation only reads (so the executor fetches a result set
    /// rather than reporting an affected-row count).
    pub fn is_read(&self) -> bool {
        matches!(
            self,
            MongoOp::Find { .. }
                | MongoOp::Aggregate { .. }
                | MongoOp::Count { .. }
                | MongoOp::Distinct { .. }
        )
    }
}

/// A fully parsed `db.collection.method(...)` statement.
#[derive(Debug, Clone, PartialEq)]
pub struct ParsedCommand {
    pub collection: String,
    pub op: MongoOp,
}

/// The `update` argument of `updateOne`/`updateMany`: either a plain
/// modification document (`{ $set: {...} }`, operator expressions only) or an
/// aggregation-pipeline update (`[ { $set: {...} }, … ]`) — valid in native
/// MongoDB since 4.2 and mirrored here as
/// [`mongodb::options::UpdateModifications`]'s two variants, kept as our own
/// plain-BSON type (like [`MongoOp::Aggregate`]'s `Vec<Document>`) so the
/// parser doesn't need to depend on driver option types.
#[derive(Debug, Clone, PartialEq)]
pub enum UpdateSpec {
    Document(Document),
    Pipeline(Vec<Document>),
}

impl From<UpdateSpec> for mongodb::options::UpdateModifications {
    fn from(spec: UpdateSpec) -> Self {
        match spec {
            UpdateSpec::Document(d) => Self::Document(d),
            UpdateSpec::Pipeline(p) => Self::Pipeline(p),
        }
    }
}

/// Parse one `mongosh`-style statement.
pub fn parse(input: &str) -> AppResult<ParsedCommand> {
    let src = input.trim().trim_end_matches(';').trim();
    if !src.starts_with("db.") {
        return Err(AppError::InvalidInput(
            "MongoDB statements must start with `db.` (e.g. db.users.find({}))".into(),
        ));
    }
    let rest = &src[3..];

    // Collection: either getCollection("name") or a dotted identifier up to the
    // first method call `(`. We split at the last `.` that precedes the first
    // `(` so `db.my.coll.find(` → collection `my.coll`, method `find`.
    let paren = rest
        .find('(')
        .ok_or_else(|| AppError::InvalidInput("expected a method call, e.g. .find({})".into()))?;
    let head = &rest[..paren]; // e.g. "users.find" or "getCollection(\"x\").find" won't reach here

    let (collection, method) = if let Some(stripped) = rest.strip_prefix("getCollection(") {
        // db.getCollection("name").method(...)
        let mut p = Parser::new(stripped);
        let name = p.parse_string_literal()?;
        p.skip_ws();
        p.expect(')')?;
        p.skip_ws();
        p.expect('.')?;
        let method = p.parse_ident();
        p.skip_ws();
        p.expect('(')?;
        let args_and_tail = &stripped[p.pos..];
        return finish(name, &method, args_and_tail);
    } else {
        let dot = head
            .rfind('.')
            .ok_or_else(|| AppError::InvalidInput("expected db.<collection>.<method>(…)".into()))?;
        (head[..dot].to_string(), head[dot + 1..].to_string())
    };

    if collection.is_empty() {
        return Err(AppError::InvalidInput("missing collection name".into()));
    }
    finish(collection, &method, &rest[paren + 1..])
}

/// Parse the argument list (starting just after the opening `(` of the primary
/// method) plus any chained cursor modifiers, into a [`ParsedCommand`].
fn finish(collection: String, method: &str, args_and_tail: &str) -> AppResult<ParsedCommand> {
    let mut p = Parser::new(args_and_tail);
    let args = p.parse_arg_list()?; // consumes through the matching ')'

    // Collect chained modifiers: .sort(...) .limit(n) .skip(n) .projection(...)
    let mut sort = None;
    let mut limit = None;
    let mut skip = None;
    let mut projection = None;
    loop {
        p.skip_ws();
        if !p.eat('.') {
            break;
        }
        let m = p.parse_ident();
        p.skip_ws();
        p.expect('(')?;
        let margs = p.parse_arg_list()?;
        match m.as_str() {
            "sort" => sort = Some(first_doc(&margs, "sort")?),
            "limit" => limit = Some(first_int(&margs, "limit")?),
            "skip" => skip = Some(first_int(&margs, "skip")?),
            "projection" | "project" => projection = Some(first_doc(&margs, "projection")?),
            other => {
                return Err(AppError::InvalidInput(format!(
                "unsupported cursor modifier `.{other}()` (allowed: sort, limit, skip, projection)"
            )))
            }
        }
    }

    let op = build_op(method, args, projection, sort, limit, skip)?;
    Ok(ParsedCommand { collection, op })
}

/// Assemble a [`MongoOp`] from the method name and its parsed arguments.
fn build_op(
    method: &str,
    mut args: Vec<Bson>,
    projection: Option<Document>,
    sort: Option<Document>,
    limit: Option<i64>,
    skip: Option<i64>,
) -> AppResult<MongoOp> {
    let take_doc = |args: &mut Vec<Bson>, idx: usize, what: &str| -> AppResult<Document> {
        match args.get(idx) {
            Some(Bson::Document(d)) => Ok(d.clone()),
            Some(_) => Err(AppError::InvalidInput(format!(
                "{what}: argument {} must be a document",
                idx + 1
            ))),
            None => Ok(Document::new()),
        }
    };

    // The `update` argument of updateOne/updateMany: a document
    // (`{$set: {...}}`) or, since MongoDB 4.2, an aggregation pipeline
    // (`[{$set: {...}}, …]`) — see `UpdateSpec`.
    let take_update_spec = |args: &mut Vec<Bson>, what: &str| -> AppResult<UpdateSpec> {
        match args.get(1) {
            Some(Bson::Document(d)) => Ok(UpdateSpec::Document(d.clone())),
            Some(Bson::Array(items)) => items
                .iter()
                .map(|b| match b {
                    Bson::Document(d) => Ok(d.clone()),
                    _ => Err(AppError::InvalidInput(format!(
                        "{what}: pipeline stages must be documents"
                    ))),
                })
                .collect::<AppResult<Vec<_>>>()
                .map(UpdateSpec::Pipeline),
            Some(_) => Err(AppError::InvalidInput(format!(
                "{what}: argument 2 must be a document or an aggregation pipeline array"
            ))),
            None => Ok(UpdateSpec::Document(Document::new())),
        }
    };

    match method {
        "find" | "findOne" => {
            let filter = take_doc(&mut args, 0, method)?;
            // A second positional argument is the projection.
            let inline_proj = match args.get(1) {
                Some(Bson::Document(d)) => Some(d.clone()),
                _ => None,
            };
            Ok(MongoOp::Find {
                filter,
                projection: projection.or(inline_proj),
                sort,
                limit,
                skip,
                one: method == "findOne",
            })
        }
        "aggregate" => {
            let pipeline = match args.into_iter().next() {
                Some(Bson::Array(items)) => items
                    .into_iter()
                    .map(|b| match b {
                        Bson::Document(d) => Ok(d),
                        _ => Err(AppError::InvalidInput(
                            "aggregate: pipeline stages must be documents".into(),
                        )),
                    })
                    .collect::<AppResult<Vec<_>>>()?,
                _ => {
                    return Err(AppError::InvalidInput(
                        "aggregate expects a pipeline array: aggregate([{…}, …])".into(),
                    ))
                }
            };
            Ok(MongoOp::Aggregate { pipeline })
        }
        "countDocuments" | "count" => Ok(MongoOp::Count {
            filter: take_doc(&mut args, 0, method)?,
        }),
        "distinct" => {
            let field = match args.first() {
                Some(Bson::String(s)) => s.clone(),
                _ => {
                    return Err(AppError::InvalidInput(
                        "distinct expects a field name string: distinct(\"field\")".into(),
                    ))
                }
            };
            let filter = take_doc(&mut args, 1, "distinct")?;
            Ok(MongoOp::Distinct { field, filter })
        }
        "insertOne" => Ok(MongoOp::InsertOne {
            doc: take_doc(&mut args, 0, "insertOne")?,
        }),
        "insertMany" => {
            let docs = match args.into_iter().next() {
                Some(Bson::Array(items)) => items
                    .into_iter()
                    .map(|b| match b {
                        Bson::Document(d) => Ok(d),
                        _ => Err(AppError::InvalidInput(
                            "insertMany: every element must be a document".into(),
                        )),
                    })
                    .collect::<AppResult<Vec<_>>>()?,
                _ => {
                    return Err(AppError::InvalidInput(
                        "insertMany expects an array: insertMany([{…}, …])".into(),
                    ))
                }
            };
            Ok(MongoOp::InsertMany { docs })
        }
        "updateOne" | "updateMany" => {
            let filter = take_doc(&mut args, 0, method)?;
            let update = take_update_spec(&mut args, method)?;
            if method == "updateOne" {
                Ok(MongoOp::UpdateOne { filter, update })
            } else {
                Ok(MongoOp::UpdateMany { filter, update })
            }
        }
        "replaceOne" => {
            let filter = take_doc(&mut args, 0, "replaceOne")?;
            let replacement = take_doc(&mut args, 1, "replaceOne")?;
            Ok(MongoOp::ReplaceOne {
                filter,
                replacement,
            })
        }
        "deleteOne" => Ok(MongoOp::DeleteOne {
            filter: take_doc(&mut args, 0, "deleteOne")?,
        }),
        "deleteMany" => Ok(MongoOp::DeleteMany {
            filter: take_doc(&mut args, 0, "deleteMany")?,
        }),
        other => Err(AppError::InvalidInput(format!(
            "unsupported MongoDB method `{other}` (supported: find, findOne, aggregate, \
             countDocuments, distinct, insertOne, insertMany, updateOne, updateMany, \
             replaceOne, deleteOne, deleteMany)"
        ))),
    }
}

fn first_doc(args: &[Bson], what: &str) -> AppResult<Document> {
    match args.first() {
        Some(Bson::Document(d)) => Ok(d.clone()),
        _ => Err(AppError::InvalidInput(format!(
            "{what}() expects a document argument"
        ))),
    }
}

fn first_int(args: &[Bson], what: &str) -> AppResult<i64> {
    match args.first() {
        Some(Bson::Int32(i)) => Ok(*i as i64),
        Some(Bson::Int64(i)) => Ok(*i),
        Some(Bson::Double(f)) => Ok(*f as i64),
        _ => Err(AppError::InvalidInput(format!(
            "{what}() expects an integer argument"
        ))),
    }
}

// ---------------------------------------------------------------------------
// Relaxed-JSON value parser
// ---------------------------------------------------------------------------

/// A small recursive-descent parser over the relaxed-JSON / BSON-constructor
/// grammar used inside argument lists. Tracks a byte position into `src`.
struct Parser<'a> {
    src: &'a [u8],
    chars: &'a str,
    pos: usize,
}

impl<'a> Parser<'a> {
    fn new(s: &'a str) -> Self {
        Parser {
            src: s.as_bytes(),
            chars: s,
            pos: 0,
        }
    }

    fn skip_ws(&mut self) {
        while self.pos < self.src.len() {
            let c = self.src[self.pos];
            if c == b' ' || c == b'\t' || c == b'\n' || c == b'\r' {
                self.pos += 1;
            } else {
                break;
            }
        }
    }

    fn peek(&self) -> Option<u8> {
        self.src.get(self.pos).copied()
    }

    fn eat(&mut self, c: char) -> bool {
        self.skip_ws();
        if self.peek() == Some(c as u8) {
            self.pos += 1;
            true
        } else {
            false
        }
    }

    fn expect(&mut self, c: char) -> AppResult<()> {
        if self.eat(c) {
            Ok(())
        } else {
            Err(AppError::InvalidInput(format!(
                "expected `{c}` at position {} in MongoDB statement",
                self.pos
            )))
        }
    }

    /// Read an identifier ([A-Za-z0-9_$]).
    fn parse_ident(&mut self) -> String {
        self.skip_ws();
        let start = self.pos;
        while self.pos < self.src.len() {
            let c = self.src[self.pos];
            if c.is_ascii_alphanumeric() || c == b'_' || c == b'$' {
                self.pos += 1;
            } else {
                break;
            }
        }
        self.chars[start..self.pos].to_string()
    }

    /// Parse a comma-separated argument list, consuming through the matching
    /// closing `)`. Assumes the opening `(` has already been consumed.
    fn parse_arg_list(&mut self) -> AppResult<Vec<Bson>> {
        let mut out = Vec::new();
        self.skip_ws();
        if self.eat(')') {
            return Ok(out);
        }
        loop {
            let v = self.parse_value()?;
            out.push(v);
            self.skip_ws();
            if self.eat(',') {
                self.skip_ws();
                // Allow a trailing comma before the close paren.
                if self.peek() == Some(b')') {
                    self.pos += 1;
                    break;
                }
                continue;
            }
            self.expect(')')?;
            break;
        }
        Ok(out)
    }

    /// Parse a single relaxed-JSON / BSON value.
    fn parse_value(&mut self) -> AppResult<Bson> {
        self.skip_ws();
        match self.peek() {
            Some(b'{') => self.parse_object(),
            Some(b'[') => self.parse_array(),
            Some(b'"') | Some(b'\'') => Ok(Bson::String(self.parse_string_literal()?)),
            Some(c) if c == b'-' || c.is_ascii_digit() => self.parse_number(),
            Some(c) if c.is_ascii_alphabetic() || c == b'_' || c == b'$' => {
                self.parse_keyword_or_ctor()
            }
            other => Err(AppError::InvalidInput(format!(
                "unexpected character {:?} in MongoDB statement at position {}",
                other.map(|b| b as char),
                self.pos
            ))),
        }
    }

    fn parse_object(&mut self) -> AppResult<Bson> {
        self.expect('{')?;
        let mut doc = Document::new();
        self.skip_ws();
        if self.eat('}') {
            return Ok(Bson::Document(doc));
        }
        loop {
            self.skip_ws();
            // Key: quoted string or bare identifier.
            let key = match self.peek() {
                Some(b'"') | Some(b'\'') => self.parse_string_literal()?,
                _ => {
                    let id = self.parse_ident();
                    if id.is_empty() {
                        return Err(AppError::InvalidInput(
                            "expected an object key in MongoDB statement".into(),
                        ));
                    }
                    id
                }
            };
            self.skip_ws();
            self.expect(':')?;
            let value = self.parse_value()?;
            doc.insert(key, value);
            self.skip_ws();
            if self.eat(',') {
                self.skip_ws();
                if self.peek() == Some(b'}') {
                    self.pos += 1; // trailing comma
                    break;
                }
                continue;
            }
            self.expect('}')?;
            break;
        }
        // Typed values are produced by the constructor grammar (ObjectId(...),
        // ISODate(...), Number*(...)), so a plain object is returned as-is.
        // Literal Extended JSON wrappers (`{$oid: …}`) are uncommon in hand-typed
        // queries — use the constructors instead.
        Ok(Bson::Document(doc))
    }

    fn parse_array(&mut self) -> AppResult<Bson> {
        self.expect('[')?;
        let mut out = Vec::new();
        self.skip_ws();
        if self.eat(']') {
            return Ok(Bson::Array(out));
        }
        loop {
            let v = self.parse_value()?;
            out.push(v);
            self.skip_ws();
            if self.eat(',') {
                self.skip_ws();
                if self.peek() == Some(b']') {
                    self.pos += 1;
                    break;
                }
                continue;
            }
            self.expect(']')?;
            break;
        }
        Ok(Bson::Array(out))
    }

    /// Parse a `"…"` or `'…'` string literal with basic escape handling.
    fn parse_string_literal(&mut self) -> AppResult<String> {
        self.skip_ws();
        let quote = match self.peek() {
            Some(q @ b'"') | Some(q @ b'\'') => q,
            _ => {
                return Err(AppError::InvalidInput(
                    "expected a string literal in MongoDB statement".into(),
                ))
            }
        };
        self.pos += 1;
        let mut s = String::new();
        while self.pos < self.src.len() {
            let c = self.src[self.pos];
            if c == b'\\' {
                self.pos += 1;
                if let Some(esc) = self.src.get(self.pos) {
                    match esc {
                        b'n' => s.push('\n'),
                        b't' => s.push('\t'),
                        b'r' => s.push('\r'),
                        b'\\' => s.push('\\'),
                        b'"' => s.push('"'),
                        b'\'' => s.push('\''),
                        b'/' => s.push('/'),
                        other => s.push(*other as char),
                    }
                    self.pos += 1;
                }
            } else if c == quote {
                self.pos += 1;
                return Ok(s);
            } else {
                // Copy a full UTF-8 char.
                let ch_len = utf8_len(c);
                let end = (self.pos + ch_len).min(self.src.len());
                s.push_str(&self.chars[self.pos..end]);
                self.pos = end;
            }
        }
        Err(AppError::InvalidInput(
            "unterminated string literal in MongoDB statement".into(),
        ))
    }

    fn parse_number(&mut self) -> AppResult<Bson> {
        let start = self.pos;
        if self.peek() == Some(b'-') {
            self.pos += 1;
        }
        let mut is_float = false;
        while self.pos < self.src.len() {
            let c = self.src[self.pos];
            if c.is_ascii_digit() {
                self.pos += 1;
            } else if c == b'.' || c == b'e' || c == b'E' || c == b'+' || c == b'-' {
                is_float = true;
                self.pos += 1;
            } else {
                break;
            }
        }
        let text = &self.chars[start..self.pos];
        if is_float {
            text.parse::<f64>()
                .map(Bson::Double)
                .map_err(|_| AppError::InvalidInput(format!("invalid number `{text}`")))
        } else if let Ok(i) = text.parse::<i32>() {
            Ok(Bson::Int32(i))
        } else if let Ok(i) = text.parse::<i64>() {
            Ok(Bson::Int64(i))
        } else {
            text.parse::<f64>()
                .map(Bson::Double)
                .map_err(|_| AppError::InvalidInput(format!("invalid number `{text}`")))
        }
    }

    /// Parse a bare keyword (`true`/`false`/`null`) or a BSON constructor call
    /// (`ObjectId(...)`, `ISODate(...)`, `new Date(...)`, `NumberLong(...)`, …).
    fn parse_keyword_or_ctor(&mut self) -> AppResult<Bson> {
        // Support the `new` prefix used by `new Date(...)`.
        let mut ident = self.parse_ident();
        if ident == "new" {
            self.skip_ws();
            ident = self.parse_ident();
        }
        self.skip_ws();
        // Plain keyword (no call parens).
        if self.peek() != Some(b'(') {
            return match ident.as_str() {
                "true" => Ok(Bson::Boolean(true)),
                "false" => Ok(Bson::Boolean(false)),
                "null" | "undefined" => Ok(Bson::Null),
                other => Err(AppError::InvalidInput(format!(
                    "unexpected token `{other}` in MongoDB statement (bare identifiers are not \
                     supported; quote strings and use ObjectId(...)/ISODate(...) for typed values)"
                ))),
            };
        }
        // Constructor call: read its single argument.
        self.expect('(')?;
        let inner = self.parse_arg_list()?;
        let first = inner.into_iter().next();
        match ident.as_str() {
            "ObjectId" => {
                let s = bson_as_string(&first)?;
                mongodb::bson::oid::ObjectId::from_str(&s)
                    .map(Bson::ObjectId)
                    .map_err(|_| AppError::InvalidInput(format!("invalid ObjectId(\"{s}\")")))
            }
            "ISODate" | "Date" => {
                let s = bson_as_string(&first)?;
                mongodb::bson::DateTime::parse_rfc3339_str(&s)
                    .map(Bson::DateTime)
                    .map_err(|_| AppError::InvalidInput(format!("invalid date `{s}`")))
            }
            "NumberLong" => num_ctor_i64(first).map(Bson::Int64),
            "NumberInt" => num_ctor_i64(first).map(|i| Bson::Int32(i as i32)),
            "NumberDecimal" => {
                let s = bson_as_string(&first)?;
                mongodb::bson::Decimal128::from_str(&s)
                    .map(Bson::Decimal128)
                    .map_err(|_| AppError::InvalidInput(format!("invalid NumberDecimal(\"{s}\")")))
            }
            "NumberDouble" => {
                let s = bson_as_string(&first)?;
                s.parse::<f64>()
                    .map(Bson::Double)
                    .map_err(|_| AppError::InvalidInput(format!("invalid NumberDouble(\"{s}\")")))
            }
            other => Err(AppError::InvalidInput(format!(
                "unsupported constructor `{other}(...)` (supported: ObjectId, ISODate/Date, \
                 NumberLong, NumberInt, NumberDecimal, NumberDouble)"
            ))),
        }
    }
}

/// Extract a string out of an optional BSON constructor argument.
fn bson_as_string(b: &Option<Bson>) -> AppResult<String> {
    match b {
        Some(Bson::String(s)) => Ok(s.clone()),
        Some(Bson::Int32(i)) => Ok(i.to_string()),
        Some(Bson::Int64(i)) => Ok(i.to_string()),
        _ => Err(AppError::InvalidInput(
            "constructor expects a string argument".into(),
        )),
    }
}

/// Coerce a constructor argument (string or number) to `i64`.
fn num_ctor_i64(b: Option<Bson>) -> AppResult<i64> {
    match b {
        Some(Bson::String(s)) => s
            .parse::<i64>()
            .map_err(|_| AppError::InvalidInput(format!("invalid integer `{s}`"))),
        Some(Bson::Int32(i)) => Ok(i as i64),
        Some(Bson::Int64(i)) => Ok(i),
        Some(Bson::Double(f)) => Ok(f as i64),
        _ => Err(AppError::InvalidInput(
            "NumberLong/NumberInt expect a numeric or string argument".into(),
        )),
    }
}

/// Length in bytes of a UTF-8 character given its lead byte.
fn utf8_len(lead: u8) -> usize {
    if lead < 0x80 {
        1
    } else if lead >> 5 == 0b110 {
        2
    } else if lead >> 4 == 0b1110 {
        3
    } else {
        4
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use mongodb::bson::doc;

    #[test]
    fn parses_find_with_filter() {
        let cmd = parse("db.users.find({age: {$gt: 21}})").unwrap();
        assert_eq!(cmd.collection, "users");
        match cmd.op {
            MongoOp::Find { filter, one, .. } => {
                assert!(!one);
                assert_eq!(filter, doc! {"age": {"$gt": 21}});
            }
            other => panic!("expected Find, got {other:?}"),
        }
    }

    #[test]
    fn parses_chained_cursor_modifiers() {
        let cmd = parse("db.users.find().sort({age: -1}).limit(10).skip(5)").unwrap();
        match cmd.op {
            MongoOp::Find {
                sort, limit, skip, ..
            } => {
                assert_eq!(sort, Some(doc! {"age": -1}));
                assert_eq!(limit, Some(10));
                assert_eq!(skip, Some(5));
            }
            other => panic!("expected Find, got {other:?}"),
        }
    }

    #[test]
    fn parses_objectid_constructor() {
        let cmd = parse("db.users.findOne({_id: ObjectId(\"507f1f77bcf86cd799439011\")})").unwrap();
        match cmd.op {
            MongoOp::Find { filter, one, .. } => {
                assert!(one);
                assert!(matches!(filter.get("_id"), Some(Bson::ObjectId(_))));
            }
            other => panic!("expected Find, got {other:?}"),
        }
    }

    #[test]
    fn parses_aggregate_pipeline() {
        let cmd = parse("db.orders.aggregate([{$match: {status: 'A'}}, {$group: {_id: '$cust'}}])")
            .unwrap();
        match cmd.op {
            MongoOp::Aggregate { pipeline } => assert_eq!(pipeline.len(), 2),
            other => panic!("expected Aggregate, got {other:?}"),
        }
    }

    #[test]
    fn parses_update_one_with_two_docs() {
        let cmd = parse("db.users.updateOne({_id: 1}, {$set: {name: 'y'}})").unwrap();
        match cmd.op {
            MongoOp::UpdateOne { filter, update } => {
                assert_eq!(filter, doc! {"_id": 1});
                assert_eq!(update, UpdateSpec::Document(doc! {"$set": {"name": "y"}}));
            }
            other => panic!("expected UpdateOne, got {other:?}"),
        }
    }

    #[test]
    fn parses_update_many_with_aggregation_pipeline() {
        let cmd =
            parse("db.users.updateMany({active: true}, [{$set: {name: {$toUpper: '$name'}}}])")
                .unwrap();
        match cmd.op {
            MongoOp::UpdateMany { filter, update } => {
                assert_eq!(filter, doc! {"active": true});
                assert_eq!(
                    update,
                    UpdateSpec::Pipeline(vec![doc! {"$set": {"name": {"$toUpper": "$name"}}}])
                );
            }
            other => panic!("expected UpdateMany, got {other:?}"),
        }
    }

    #[test]
    fn dotted_collection_name() {
        let cmd = parse("db.my.coll.find({})").unwrap();
        assert_eq!(cmd.collection, "my.coll");
    }

    #[test]
    fn single_quotes_and_trailing_commas() {
        let cmd = parse("db.t.find({a: 'x', b: 1,})").unwrap();
        match cmd.op {
            MongoOp::Find { filter, .. } => {
                assert_eq!(filter, doc! {"a": "x", "b": 1});
            }
            other => panic!("expected Find, got {other:?}"),
        }
    }

    #[test]
    fn rejects_unknown_method() {
        assert!(parse("db.t.frobnicate({})").is_err());
    }

    #[test]
    fn rejects_non_db_prefix() {
        assert!(parse("show collections").is_err());
    }

    #[test]
    fn get_collection_form() {
        let cmd = parse("db.getCollection(\"weird name\").find({})").unwrap();
        assert_eq!(cmd.collection, "weird name");
    }
}
