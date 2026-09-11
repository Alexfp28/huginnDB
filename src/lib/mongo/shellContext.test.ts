import { describe, expect, it } from "vitest";
import { shellSlotAt } from "./shellContext";

/**
 * The scanner is what decides whether the query tab offers collections,
 * methods, modifiers or fields, so every case below is a cursor position a
 * user actually types through — `|` marks the caret in the name of each test.
 */

/** Run the scan with the caret where `|` sits, which keeps the fixtures
 *  readable and matches how the provider calls it (offset, never a line). */
function at(source: string, collections: string[] = []) {
  const offset = source.indexOf("|");
  const text = source.replace("|", "");
  return shellSlotAt(text, offset < 0 ? text.length : offset, collections);
}

const COLLECTIONS = ["users", "orders", "logs", "logs.2024"];

describe("shellSlotAt — the chain", () => {
  it("offers `db` at the start of a statement", () => {
    expect(at("|")).toEqual({ kind: "root" });
    expect(at("db|")).toEqual({ kind: "root" });
  });

  it("offers collections right after `db.`", () => {
    expect(at("db.|", COLLECTIONS)).toEqual({ kind: "collection", prefix: "" });
  });

  it("keeps offering collections while one is half typed", () => {
    expect(at("db.us|", COLLECTIONS)).toEqual({
      kind: "collection",
      prefix: "",
    });
  });

  it("offers methods after a complete collection", () => {
    expect(at("db.users.|", COLLECTIONS)).toEqual({
      kind: "method",
      collection: "users",
    });
  });

  it("offers both when the prefix is a collection and the head of a dotted one", () => {
    expect(at("db.logs.|", COLLECTIONS)).toEqual({
      kind: "collectionOrMethod",
      collection: "logs",
      prefix: "logs",
    });
  });

  it("splits a dotted collection at the last dot, like shell.rs", () => {
    expect(at("db.logs.2024.|", COLLECTIONS)).toEqual({
      kind: "method",
      collection: "logs.2024",
    });
  });

  it("falls back to methods for a collection the schema has not seen", () => {
    expect(at("db.brandNew.|", COLLECTIONS)).toEqual({
      kind: "method",
      collection: "brandNew",
    });
  });

  it("offers cursor modifiers after the primary call closes", () => {
    expect(at("db.users.find({}).|", COLLECTIONS)).toEqual({ kind: "modifier" });
    expect(at("db.users.find({}).sort({a:1}).|", COLLECTIONS)).toEqual({
      kind: "modifier",
    });
  });

  it("treats getCollection's own call as the collection, not the method", () => {
    expect(at('db.getCollection("orders").|', COLLECTIONS)).toEqual({
      kind: "method",
      collection: "orders",
    });
    expect(at('db.getCollection("orders").find({}).|', COLLECTIONS)).toEqual({
      kind: "modifier",
    });
  });

  it("says nothing inside a comment", () => {
    expect(at("// db.users.|")).toEqual({ kind: "none" });
    expect(at("/* db.users.| */")).toEqual({ kind: "none" });
  });

  it("says nothing for a chain that does not start at `db`", () => {
    expect(at("show.collections.|")).toEqual({ kind: "none" });
  });
});

describe("shellSlotAt — arguments", () => {
  it("reports the collection and the call inside a filter", () => {
    expect(at("db.users.find({ na| })", COLLECTIONS)).toEqual({
      kind: "argument",
      collection: "users",
      call: "find",
      method: "find",
      argStart: "db.users.find(".length,
    });
  });

  it("keeps the primary method while the cursor is inside a modifier", () => {
    const slot = at("db.users.find({}).sort({ n| })", COLLECTIONS);
    expect(slot).toMatchObject({
      kind: "argument",
      collection: "users",
      call: "sort",
      method: "find",
    });
  });

  it("stays an argument inside an unterminated string — that is where a field goes", () => {
    expect(at('db.users.distinct("ci|', COLLECTIONS)).toMatchObject({
      kind: "argument",
      collection: "users",
      call: "distinct",
    });
  });

  it("resolves the collection through the getCollection form", () => {
    expect(at('db.getCollection("orders").find({ t| })', COLLECTIONS)).toMatchObject(
      { kind: "argument", collection: "orders", method: "find" },
    );
  });

  it("survives a semicolon inside a string without ending the statement", () => {
    expect(at('db.users.find({ note: "a;b", f| })', COLLECTIONS)).toMatchObject({
      kind: "argument",
      collection: "users",
      method: "find",
    });
  });
});

describe("shellSlotAt — statement boundaries", () => {
  it("describes only the statement the cursor is in", () => {
    expect(at("db.users.find({});\ndb.orders.|", COLLECTIONS)).toEqual({
      kind: "method",
      collection: "orders",
    });
  });

  it("starts fresh after a terminating semicolon", () => {
    expect(at("db.users.find({});\n|", COLLECTIONS)).toEqual({ kind: "root" });
  });

  it("ignores a semicolon that sits inside a comment", () => {
    expect(at("// seed; press Ctrl+Enter\ndb.users.|", COLLECTIONS)).toEqual({
      kind: "method",
      collection: "users",
    });
  });
});
