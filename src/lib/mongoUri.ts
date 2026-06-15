/**
 * MongoDB connection-string helpers.
 *
 * The MongoDB connection dialog is form-primary (à la Mongo Compass): the
 * user fills discrete fields and the `mongodb://` URI is *derived* from them
 * live. These two pure functions are the bridge:
 *
 * - [`buildMongoUri`] assembles a single-host `mongodb://` URI from the form
 *   fields. The **password is intentionally NOT embedded** — for form-mode
 *   connections the secret travels through the OS keychain (the backend
 *   injects it into the driver credential when the URI carries none), so it
 *   never lands in `profiles.json`. Only `authSource` is appended as a query
 *   option; richer options (replicaSet, TLS, SRV seed lists) require the raw
 *   "edit connection string" escape hatch.
 * - [`parseMongoUri`] best-effort reverses a stored URI back into form fields
 *   so editing a saved profile re-populates the form. It returns `null` for
 *   anything it can't faithfully represent in the form (SRV, multi-host seed
 *   lists, an embedded password, or query options other than `authSource`),
 *   which the dialog treats as the signal to open in raw-edit mode instead.
 */

export interface MongoUriFields {
  host: string;
  port: number;
  database: string;
  username: string;
  authSource: string;
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
  const query = params.length ? `?${params.join("&")}` : "";
  return `mongodb://${userPart}${host}${portPart}${dbPart}${query}`;
}

/** Best-effort parse of a stored URI back into form fields. Returns `null`
 *  when the URI can't be represented losslessly by the form (the caller then
 *  falls back to raw-edit mode). */
export function parseMongoUri(uri: string): MongoUriFields | null {
  const trimmed = uri.trim();
  // SRV (`mongodb+srv://`) resolves to a DNS seed list — not a single host.
  if (!/^mongodb:\/\//i.test(trimmed)) return null;

  let u: URL;
  try {
    u = new URL(trimmed);
  } catch {
    return null;
  }

  // Multi-host seed lists (`host1,host2`) can't be expressed as one host:port.
  if (!u.hostname || u.hostname.includes(",")) return null;
  // An embedded password belongs to the raw URI, not the keychain-backed
  // password field — keep these in raw-edit mode so we never surface it.
  if (u.password) return null;
  // Reject any query option we don't model so it isn't silently dropped.
  for (const key of u.searchParams.keys()) {
    if (key !== "authSource") return null;
  }

  return {
    host: decodeURIComponent(u.hostname),
    port: u.port ? Number(u.port) : 27017,
    database: decodeURIComponent(u.pathname.replace(/^\//, "")),
    username: decodeURIComponent(u.username),
    authSource: u.searchParams.get("authSource") ?? "",
  };
}
