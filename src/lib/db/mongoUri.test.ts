/**
 * The round trip between the MongoDB form and its derived URI.
 *
 * The load-bearing property is not that either function is individually
 * correct: it is that they agree on what the form can hold. An option
 * `buildMongoUri` emits but `parseMongoUri` refuses strands every profile that
 * uses it in raw-edit mode the next time the dialog opens it — the dialog reads
 * a `null` parse as "this URI can't be represented by the form".
 *
 * Since unmodelled options ride along as `extraOptions`, that set is now small
 * and closed: SRV, a multi-host seed list, an embedded password, and a URI that
 * does not parse. The `lost` reasons are the contract, and the fold-confirm
 * dialog is what turns them into a sentence.
 */
import { describe, expect, it } from "vitest";
import {
  buildMongoUri,
  parseMongoUri,
  parseMongoUriLossy,
  type MongoUriFields,
} from "./mongoUri";

const BASE: MongoUriFields = {
  host: "localhost",
  port: 27017,
  database: "shop",
  username: "app",
  authSource: "",
  directConnection: false,
  extraOptions: [],
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

  it("re-emits unmodelled options after the modelled pair", () => {
    expect(
      buildMongoUri({
        ...BASE,
        authSource: "admin",
        extraOptions: [
          ["retryWrites", "true"],
          ["w", "majority"],
        ],
      }),
    ).toBe(
      "mongodb://app@localhost:27017/shop?authSource=admin&retryWrites=true&w=majority",
    );
  });

  it("writes a valueless option without an equals sign", () => {
    expect(buildMongoUri({ ...BASE, extraOptions: [["tls", ""]] })).toBe(
      "mongodb://app@localhost:27017/shop?tls",
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
    expect(
      parseMongoUri(
        "mongodb://app@localhost:27017/shop?authSource=admin&directConnection=true",
      ),
    ).toEqual({
      host: "localhost",
      port: 27017,
      database: "shop",
      username: "app",
      authSource: "admin",
      directConnection: true,
      extraOptions: [],
    });
  });

  it("reads a missing option as off", () => {
    expect(
      parseMongoUri("mongodb://localhost:27017/shop")?.directConnection,
    ).toBe(false);
  });

  it("treats anything but the literal true as off", () => {
    // The driver's option is a boolean: `?directConnection=1` is a malformed
    // URI, not a quieter way of saying yes.
    expect(
      parseMongoUri("mongodb://localhost:27017/shop?directConnection=1")
        ?.directConnection,
    ).toBe(false);
  });

  it("carries an option outside the modelled pair instead of refusing it", () => {
    // The regression this replaces: an Atlas-shaped URI opened in raw-edit mode
    // and could never be folded back into the form.
    expect(
      parseMongoUri("mongodb://localhost:27017/shop?replicaSet=rs0")
        ?.extraOptions,
    ).toEqual([["replicaSet", "rs0"]]);
  });

  it("keeps a repeated modelled key as an opaque extra", () => {
    // One field cannot own two values. The first wins the field and the rest
    // stay in the query string, so the URI still means what it said.
    const parsed = parseMongoUri(
      "mongodb://localhost:27017/shop?authSource=admin&authSource=other",
    );
    expect(parsed?.authSource).toBe("admin");
    expect(parsed?.extraOptions).toEqual([["authSource", "other"]]);
  });

  it("defaults the port when the URI names none", () => {
    expect(parseMongoUri("mongodb://localhost/shop")?.port).toBe(27017);
  });

  it("keeps an IPv6 literal whole", () => {
    const parsed = parseMongoUri("mongodb://[::1]:27018/shop");
    expect(parsed?.host).toBe("[::1]");
    expect(parsed?.port).toBe(27018);
  });

  it("still refuses the four shapes a form cannot hold", () => {
    expect(parseMongoUri("mongodb+srv://cluster.example.net/shop")).toBeNull();
    expect(parseMongoUri("mongodb://a:27017,b:27017/shop")).toBeNull();
    expect(parseMongoUri("mongodb://app:hunter2@localhost:27017/shop")).toBeNull();
    expect(parseMongoUri("postgres://localhost/shop")).toBeNull();
    expect(parseMongoUri("mongodb:///shop")).toBeNull();
  });
});

describe("parseMongoUriLossy", () => {
  it("names every reason at once", () => {
    const { lost } = parseMongoUriLossy(
      "mongodb+srv://app:hunter2@a.example.net,b.example.net/shop",
    );
    expect(lost).toEqual(["srv", "embeddedPassword", "multiHost"]);
  });

  it("still yields the fields it could read", () => {
    // The whole point: the fold-confirm dialog needs something to fold *to*.
    const { fields } = parseMongoUriLossy(
      "mongodb://app:hunter2@a.example.net:27018,b.example.net:27018/shop?replicaSet=rs0",
    );
    expect(fields).toEqual({
      host: "a.example.net",
      port: 27018,
      database: "shop",
      username: "app",
      authSource: "",
      directConnection: false,
      extraOptions: [["replicaSet", "rs0"]],
    });
  });

  it("reports nothing lost for a URI the form owns", () => {
    expect(
      parseMongoUriLossy("mongodb://localhost:27017/shop?retryWrites=true").lost,
    ).toEqual([]);
  });

  it("gives an SRV URI the default port rather than none", () => {
    // SRV carries the port in DNS, so there is nothing in the string to read;
    // a 0 would render as an empty Port field the user has to guess at.
    expect(parseMongoUriLossy("mongodb+srv://cluster.example.net/shop").fields
      .port).toBe(27017);
  });

  it("survives a malformed percent escape instead of throwing", () => {
    expect(parseMongoUriLossy("mongodb://localhost:27017/100%").fields.database)
      .toBe("100%");
  });
});

describe("build -> parse round trip", () => {
  it.each([
    { ...BASE, directConnection: true },
    { ...BASE, authSource: "admin", directConnection: true },
    { ...BASE, authSource: "admin", directConnection: false },
    { ...BASE, extraOptions: [["retryWrites", "true"], ["w", "majority"]] },
    {
      ...BASE,
      authSource: "admin",
      directConnection: true,
      extraOptions: [["replicaSet", "rs0"]],
    },
  ] satisfies MongoUriFields[])("survives %j", (fields) => {
    expect(parseMongoUri(buildMongoUri(fields))).toEqual(fields);
  });
});
