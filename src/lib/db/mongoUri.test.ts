/**
 * The round trip between the MongoDB form and its derived URI.
 *
 * The load-bearing property is not that either function is individually
 * correct: it is that they agree on the same set of modelled query options. An
 * option `buildMongoUri` emits but `parseMongoUri` refuses strands every
 * profile that uses it in raw-edit mode the next time the dialog opens it — the
 * dialog reads a `null` parse as "this URI can't be represented by the form".
 */
import { describe, expect, it } from "vitest";
import { buildMongoUri, parseMongoUri, type MongoUriFields } from "./mongoUri";

const BASE: MongoUriFields = {
  host: "localhost",
  port: 27017,
  database: "shop",
  username: "app",
  authSource: "",
  directConnection: false,
};

describe("buildMongoUri", () => {
  it("omits directConnection when it is off", () => {
    // `false` is the driver's own default; writing it out would make every URI
    // noisier for no behaviour change.
    expect(buildMongoUri(BASE)).toBe("mongodb://app@localhost:27017/shop");
  });

  it("emits directConnection=true when it is on", () => {
    expect(buildMongoUri({ ...BASE, directConnection: true })).toBe(
      "mongodb://app@localhost:27017/shop?directConnection=true",
    );
  });

  it("keeps a stable option order alongside authSource", () => {
    expect(
      buildMongoUri({ ...BASE, authSource: "admin", directConnection: true }),
    ).toBe(
      "mongodb://app@localhost:27017/shop?authSource=admin&directConnection=true",
    );
  });

  it("still leaves the password out", () => {
    // The secret travels through the keychain; the URI must never carry it,
    // so the userinfo half is a bare username with no `user:pass@` colon.
    const uri = buildMongoUri({ ...BASE, directConnection: true });
    expect(uri.slice("mongodb://".length).split("@")[0]).toBe("app");
  });
});

describe("parseMongoUri", () => {
  it("accepts directConnection rather than falling back to raw-edit", () => {
    const parsed = parseMongoUri(
      "mongodb://app@localhost:27017/shop?authSource=admin&directConnection=true",
    );
    expect(parsed).toEqual({
      host: "localhost",
      port: 27017,
      database: "shop",
      username: "app",
      authSource: "admin",
      directConnection: true,
    });
  });

  it("reads a missing option as off", () => {
    expect(parseMongoUri("mongodb://localhost:27017/shop")?.directConnection).
      toBe(false);
  });

  it("treats anything but the literal true as off", () => {
    // The driver's option is a boolean: `?directConnection=1` is a malformed
    // URI, not a quieter way of saying yes.
    expect(
      parseMongoUri("mongodb://localhost:27017/shop?directConnection=1")
        ?.directConnection,
    ).toBe(false);
  });

  it("still rejects an option outside the modelled pair", () => {
    expect(
      parseMongoUri("mongodb://localhost:27017/shop?replicaSet=rs0"),
    ).toBeNull();
  });
});

describe("build -> parse round trip", () => {
  it.each([
    { ...BASE, directConnection: true },
    { ...BASE, authSource: "admin", directConnection: true },
    { ...BASE, authSource: "admin", directConnection: false },
  ])("survives %j", (fields) => {
    expect(parseMongoUri(buildMongoUri(fields))).toEqual(fields);
  });
});
