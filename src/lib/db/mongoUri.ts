/**
 * MongoDB connection-string helpers.
 *
 * The MongoDB connection dialog is form-primary (à la Mongo Compass): the
 * user fills discrete fields and the `mongodb://` URI is *derived* from them
 * live. Three pure functions are the bridge:
 *
 * - [`buildMongoUri`] assembles a single-host `mongodb://` URI from the form
 *   fields. The **password is intentionally NOT embedded** — for form-mode
 *   connections the secret travels through the OS keychain (the backend
 *   injects it into the driver credential when the URI carries none), so it
 *   never lands in `profiles.json`. Two query options are modelled by name —
 *   `authSource` and `directConnection` — and every *other* option the URI
 *   carried rides along verbatim in [`MongoUriFields.extraOptions`].
 * - [`parseMongoUriLossy`] reverses a stored URI back into form fields
 *   *always*, reporting in `lost` whatever it could not represent faithfully.
 * - [`parseMongoUri`] is the strict view of the same parse: the fields when
 *   nothing was lost, `null` otherwise. The dialog reads that `null` as "open
 *   this profile in raw-edit mode instead".
 *
 * The modelled set is load-bearing in both directions: a field that
 * [`buildMongoUri`] can emit but [`parseMongoUri`] does not accept would strand
 * every profile that uses it in raw-edit mode the next time it is opened. That
 * used to be the fate of every URI carrying an option outside the named pair —
 * which is to say every Atlas URI, since `retryWrites` and `w` are on the one
 * the console hands you. Carrying unmodelled options through as opaque pairs
 * rather than refusing them is what keeps those profiles editable: the form
 * owns the fields it models, and hands back the rest of the query string
 * untouched.
 *
 * What is left that genuinely cannot be a form: an SRV seed list, a multi-host
 * seed list, an embedded password, and a URI that will not parse at all. Those
 * are the four `lost` reasons, and they are the only ones.
 *
 * Nothing in Rust needs to know about any of this — `ClientOptions::parse`
 * reads every option straight off the URI, and a MongoDB profile always stores
 * its URI in `connection_string`.
 */

/** A query option the form does not model, kept as it was written. */
export type MongoUriOption = readonly [key: string, value: string];

export interface MongoUriFields {
  host: string;
  port: number;
  database: string;
  username: string;
  authSource: string;
  /**
   * `directConnection=true`: talk to this one host and skip topology
   * discovery. What you want when reaching a single replica-set member
   * directly (through a jump box, or to read from a specific secondary) —
   * without it the driver reads the host's `hello` response, learns the set's
   * real member addresses and tries to reach those instead, which fails when
   * they are not resolvable from here.
   */
  directConnection: boolean;
  /**
   * Every other query option, in the order the URI wrote them.
   *
   * The form neither renders nor understands these; it carries them so that
   * opening a `retryWrites=true&w=majority` profile and changing its port does
   * not quietly publish a URI without them. Re-emitted after the modelled pair
   * by [`buildMongoUri`], so a round trip through the form normalises option
   * *order* but never option *content*.
   */
  extraOptions: MongoUriOption[];
}

/** Why a URI could not be represented by the form. See [`parseMongoUriLossy`]. */
export type MongoUriLoss =
  /** `mongodb+srv://` — a DNS seed list, not a host. */
  | "srv"
  /** `host1,host2` — more hosts than the one the form has a field for. */
  | "multiHost"
  /** `user:pass@` — a secret the form keeps in the keychain, not in the URI. */
  | "embeddedPassword"
  /** Not a MongoDB URI, or malformed past the point of reading. */
  | "unparseable";

/** What [`parseMongoUriLossy`] read, and what it had to drop to get there. */
export interface LossyMongoUri {
  fields: MongoUriFields;
  /**
   * Empty when the URI round-trips through the form unchanged. Non-empty means
   * folding the raw URI back into the fields *discards* something, which is a
   * decision for the user rather than for the parser — see the fold-confirm
   * dialog.
   */
  lost: MongoUriLoss[];
}

/** The port the driver assumes when the URI names none. */
const DEFAULT_MONGO_PORT = 27017;

/** The fields a URI that told us nothing yields. */
function emptyFields(): MongoUriFields {
  return {
    host: "",
    port: DEFAULT_MONGO_PORT,
    database: "",
    username: "",
    authSource: "",
    directConnection: false,
    extraOptions: [],
  };
}

/** Build a single-host `mongodb://` URI from the discrete form fields.
 *  Password is deliberately omitted (see module docs). */
export function buildMongoUri(f: MongoUriFields): string {
  const host = f.host.trim() || "localhost";
  const portPart = f.port && f.port > 0 ? `:${f.port}` : "";
  const db = f.database.trim();
  const dbPart = db ? `/${encodeURIComponent(db)}` : "";
  const user = f.username.trim();
  const userPart = user ? `${encodeURIComponent(user)}@` : "";
  const params: string[] = [];
  const authSource = f.authSource.trim();
  if (authSource) params.push(`authSource=${encodeURIComponent(authSource)}`);
  // Emitted only when on: `directConnection=false` is the driver's own default
  // and writing it out would make every URI noisier for no behaviour change.
  if (f.directConnection) params.push("directConnection=true");
  // Last, and in their original relative order. Putting the modelled pair
  // first keeps the URI a form-mode profile emits stable no matter where the
  // options originally sat, which is what makes two such URIs diff cleanly.
  for (const [key, value] of f.extraOptions) {
    params.push(
      value === ""
        ? encodeURIComponent(key)
        : `${encodeURIComponent(key)}=${encodeURIComponent(value)}`,
    );
  }
  const query = params.length ? `?${params.join("&")}` : "";
  return `mongodb://${userPart}${host}${portPart}${dbPart}${query}`;
}

/**
 * Read a stored URI into form fields, reporting what could not be kept.
 *
 * Never returns `null`: a URI the form cannot hold faithfully still yields the
 * best fields available (the first host of a seed list, the database, the
 * options) alongside the `lost` reasons that say so. The strict
 * [`parseMongoUri`] is this function with a "nothing was lost" gate on it, so
 * the two can never disagree about what the form can represent.
 *
 * Parsed by hand rather than through `URL`, because the shapes that matter
 * most here are the ones `URL` refuses: `mongodb://a:27017,b:27017/db` throws
 * on the comma in what it takes for a port, and losing the whole URI to that
 * is exactly the dead end this function exists to open up.
 */
export function parseMongoUriLossy(uri: string): LossyMongoUri {
  const trimmed = uri.trim();
  const head = /^mongodb(\+srv)?:\/\/([^/?#]*)([^#]*)$/i.exec(trimmed);
  if (!head) return { fields: emptyFields(), lost: ["unparseable"] };

  const lost: MongoUriLoss[] = [];
  const srv = !!head[1];
  if (srv) lost.push("srv");

  // Rightmost `@` splits userinfo from hosts: a password may itself contain a
  // percent-encoded `@`, and the host part never can.
  const authority = head[2];
  const at = authority.lastIndexOf("@");
  const userinfo = at === -1 ? "" : authority.slice(0, at);
  const hostList = at === -1 ? authority : authority.slice(at + 1);

  const colon = userinfo.indexOf(":");
  const username = colon === -1 ? userinfo : userinfo.slice(0, colon);
  if (colon !== -1 && userinfo.slice(colon + 1) !== "") {
    // Never surfaced anywhere: it is dropped here and the user retypes it into
    // the password field, which lands it in the keychain where it belongs.
    lost.push("embeddedPassword");
  }

  const hosts = hostList.split(",").filter((h) => h !== "");
  if (hosts.length > 1) lost.push("multiHost");
  // `mongodb:///shop` names no server at all. The form would render it as an
  // empty Host field and `buildMongoUri` would then invent `localhost` for it,
  // so treat it as unreadable rather than silently retargeting the connection.
  if (hosts.length === 0) lost.push("unparseable");
  const [hostAndPort = ""] = hosts;
  // An IPv6 literal keeps its brackets; only a colon *after* them is a port.
  const portAt = hostAndPort.lastIndexOf(":");
  const bracketAt = hostAndPort.lastIndexOf("]");
  const hasPort = portAt > bracketAt && portAt !== -1;
  const host = hasPort ? hostAndPort.slice(0, portAt) : hostAndPort;
  const portText = hasPort ? hostAndPort.slice(portAt + 1) : "";
  // An SRV URI carries no port by construction; anything else without one gets
  // the driver's default rather than a 0 the form would render as blank.
  const port = /^\d+$/.test(portText) ? Number(portText) : DEFAULT_MONGO_PORT;

  const rest = head[3] ?? "";
  const q = rest.indexOf("?");
  const path = q === -1 ? rest : rest.slice(0, q);
  const query = q === -1 ? "" : rest.slice(q + 1);

  let authSource = "";
  let directConnection = false;
  let sawAuthSource = false;
  let sawDirectConnection = false;
  const extraOptions: MongoUriOption[] = [];
  for (const pair of query.split("&")) {
    if (pair === "") continue;
    const eq = pair.indexOf("=");
    const key = safeDecode(eq === -1 ? pair : pair.slice(0, eq));
    const value = eq === -1 ? "" : safeDecode(pair.slice(eq + 1));
    if (key === "authSource" && !sawAuthSource) {
      sawAuthSource = true;
      authSource = value;
    } else if (key === "directConnection" && !sawDirectConnection) {
      sawDirectConnection = true;
      // Only the literal `true` counts, matching the driver: the option is a
      // boolean and anything else in that slot is a malformed URI, not a "yes".
      directConnection = value === "true";
    } else {
      // Includes a *repeated* modelled key, which the form has one field for
      // and therefore cannot own twice. Carrying the duplicate as an opaque
      // extra keeps the URI's meaning intact without inventing a second field.
      extraOptions.push([key, value]);
    }
  }

  return {
    fields: {
      host: safeDecode(host),
      port,
      database: safeDecode(path.replace(/^\//, "")),
      username: safeDecode(username),
      authSource,
      directConnection,
      extraOptions,
    },
    lost,
  };
}

/** Parse of a stored URI back into form fields, or `null` when the form cannot
 *  hold it faithfully (the caller then falls back to raw-edit mode). */
export function parseMongoUri(uri: string): MongoUriFields | null {
  const { fields, lost } = parseMongoUriLossy(uri);
  return lost.length === 0 ? fields : null;
}

/** `decodeURIComponent` that gives the raw text back instead of throwing on a
 *  stray `%` — a malformed escape is not a reason to lose the whole URI. */
function safeDecode(text: string): string {
  try {
    return decodeURIComponent(text);
  } catch {
    return text;
  }
}
