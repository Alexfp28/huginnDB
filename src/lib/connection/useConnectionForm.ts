/**
 * The connection form's model: every editable field, how a stored profile loads
 * into them, and the few rules that relate one field to another.
 *
 * `ConnectionDialog` was 1760 lines and 41 `useState`s, most of which were
 * *fields* — inert data with no bearing on the dialog's own flow (which profile
 * is being edited, testing, saving, connecting). Separating the two is the point
 * of this hook: the dialog keeps its flow and its layout, and the shape of a
 * connection lives here.
 *
 * **Deliberately not a `useReducer` over one object.** That would trade 28
 * `useState`s for one, at the cost of rewriting ~60 JSX bindings from
 * `value={host}` / `onChange={setHost}` to `fields.host` / `set({ host })` — a
 * wide, hand-verified diff where a mistyped key (`host` for `sshHost`) type-
 * checks and silently edits the wrong field. The count was never the problem;
 * the field state living inside the dialog was.
 *
 * The rules that make this more than a bag of setters, and why each exists:
 *
 * - **`loadFields`** is the single place a stored profile becomes form state,
 *   including MongoDB's form-vs-raw decision: a URI that parses back into the
 *   discrete fields opens in form mode, anything lossy (SRV, multi-host, an
 *   embedded password, extra options) opens in raw-edit showing it verbatim.
 * - **`onDriverChange`** only moves the port when it still holds the previous
 *   driver's default, so a hand-picked port survives switching driver.
 * - **`onToggleMongoUriManual`** folds an edited URI back into the fields when
 *   it is representable and otherwise *stays* in raw-edit, rather than silently
 *   dropping what it cannot express.
 * - **`normalizeServerName`** splits SSMS's single-box `HOST\INSTANCE` on blur.
 *   `splitSqlServerName` is the UI twin of the authoritative Rust
 *   `split_instance` (gotcha #37).
 * - **`isMongoSrv`** disables the SSH tunnel: an SRV URI resolves to several
 *   hosts, which a single-port tunnel cannot serve.
 *
 * `trustedFingerprint` is server state rather than a field, but it lives here
 * because `loadFields` has to clear it: switching profiles must never leave the
 * previous host's fingerprint on screen. Its lookup is gated on `open` so a
 * closed dialog issues no IPC.
 */

import { useEffect, useMemo, useState } from "react";

import { buildMongoUri, parseMongoUri } from "@/lib/db/mongoUri";
import { splitSqlServerName, supportsSshTunnel } from "@/lib/db/driver";
import { DEFAULT_PORTS } from "@/lib/constants";
import { api } from "@/lib/tauri";
import { usePreferences } from "@/stores/preferences/preferences";
import type {
  ConnectionProfile,
  Driver,
  HostKeyPolicy,
  MsSqlAuth,
  SshAuth,
  SshTunnel,
} from "@/types";

export type SshAuthMethod = "password" | "key";

export function useConnectionForm(open: boolean) {
  // General fields ---------------------------------------------------------
  const [name, setName] = useState("");
  const [group, setGroup] = useState("");
  const [driver, setDriver] = useState<Driver>("postgres");
  const [host, setHost] = useState("localhost");
  const [port, setPort] = useState(5432);
  const [database, setDatabase] = useState("");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [ssl, setSsl] = useState(false);
  /** Per-server pool ceiling, as typed. Kept as a string so the field can be
   *  *empty*, which is the meaningful "no override — use the global
   *  preference" state and is not expressible with a number input bound to a
   *  number. Parsed on save; anything unparseable saves as `null`. */
  const [maxConnections, setMaxConnections] = useState("");
  /** MongoDB connection URI. In form mode this is the *raw-edit buffer* used
   *  only when `mongoUriManual` is on; otherwise the URI is derived from the
   *  discrete fields via `buildMongoUri`. */
  const [connectionString, setConnectionString] = useState("");
  /** MongoDB `authSource` form field (e.g. `admin`). */
  const [authSource, setAuthSource] = useState("");
  /** When true, the MongoDB connection string is edited by hand (Compass-style
   *  escape hatch for SRV / replica sets / extra URI options) and the discrete
   *  fields are disabled. */
  const [mongoUriManual, setMongoUriManual] = useState(false);

  // SQL Server fields ------------------------------------------------------
  /** Named instance (`SQLEXPRESS`). Non-empty makes the port irrelevant: the
   *  SQL Browser resolves the instance's own dynamic port. */
  const [mssqlInstance, setMssqlInstance] = useState("");
  /** Accept a self-signed server certificate — required by most on-prem
   *  instances for an encrypted connection to come up at all. */
  const [mssqlTrustCert, setMssqlTrustCert] = useState(true);
  const [mssqlAuth, setMssqlAuth] = useState<MsSqlAuth>("sql");
  // SSH tunnel fields ------------------------------------------------------
  const [sshEnabled, setSshEnabled] = useState(false);
  const [sshHost, setSshHost] = useState("");
  const [sshPort, setSshPort] = useState(22);
  const [sshUsername, setSshUsername] = useState("");
  const [sshAuthMethod, setSshAuthMethod] = useState<SshAuthMethod>("password");
  const [sshKeyPath, setSshKeyPath] = useState("");
  const [sshSecret, setSshSecret] = useState("");
  const [sshLocalPort, setSshLocalPort] = useState(0);
  const [sshHostKeyPolicy, setSshHostKeyPolicy] =
    useState<HostKeyPolicy>("accept-new");
  const [trustedFingerprint, setTrustedFingerprint] = useState<string | null>(
    null,
  );

  /** Load the form fields from `p`, or reset to defaults for a new draft. */
  function loadFields(p: ConnectionProfile | null) {
    if (p) {
      setName(p.name);
      setGroup(p.group ?? "");
      setDriver(p.driver);
      setHost(p.host);
      setPort(p.port);
      setDatabase(p.database);
      setUsername(p.username);
      setSsl(p.ssl);
      setMaxConnections(
        p.max_connections == null ? "" : String(p.max_connections),
      );
      setConnectionString(p.connection_string ?? "");
      setAuthSource(p.auth_source ?? "");
      setPassword("");
      setMssqlInstance(p.mssql?.instance ?? "");
      setMssqlTrustCert(p.mssql?.trust_server_certificate ?? true);
      setMssqlAuth(p.mssql?.auth ?? "sql");

      // MongoDB: decide form vs raw-edit mode. A stored URI we can parse back
      // into the discrete fields opens in form mode (re-populating host / port
      // / db / user / authSource from the URI); anything we can't represent
      // losslessly (SRV, multi-host, embedded password, extra options) opens
      // in raw-edit mode showing the URI verbatim.
      if (p.driver === "mongodb") {
        const cs = (p.connection_string ?? "").trim();
        const parsed = cs ? parseMongoUri(cs) : null;
        if (cs && !parsed) {
          setMongoUriManual(true);
        } else {
          setMongoUriManual(false);
          if (parsed) {
            setHost(parsed.host);
            setPort(parsed.port);
            setDatabase(parsed.database);
            // The legacy 1.1.0 form kept user / authSource as separate fields
            // outside the URI — fall back to those when the URI omits them.
            if (parsed.username) setUsername(parsed.username);
            if (parsed.authSource) setAuthSource(parsed.authSource);
          }
        }
      } else {
        setMongoUriManual(false);
      }

      const tunnel = p.ssh_tunnel;
      if (tunnel) {
        setSshEnabled(true);
        setSshHost(tunnel.host);
        setSshPort(tunnel.port);
        setSshUsername(tunnel.username);
        setSshAuthMethod(tunnel.auth.kind === "key" ? "key" : "password");
        setSshKeyPath(tunnel.auth.kind === "key" ? tunnel.auth.path : "");
        setSshLocalPort(tunnel.local_port);
        setSshHostKeyPolicy(tunnel.host_key_policy);
      } else {
        setSshEnabled(false);
        setSshHost("");
        setSshPort(22);
        setSshUsername("");
        setSshAuthMethod("password");
        setSshKeyPath("");
        setSshLocalPort(0);
        setSshHostKeyPolicy("accept-new");
      }
      setSshSecret("");
      setTrustedFingerprint(null);
    } else {
      // New draft: start from the configured default driver (if any) so a
      // shop that's MySQL-first doesn't have to switch the dropdown every time.
      const def = usePreferences.getState().prefs.ui.defaultDriver ?? "postgres";
      setName("");
      setGroup("");
      setDriver(def);
      setHost("localhost");
      setPort(DEFAULT_PORTS[def]);
      setDatabase("");
      setUsername("");
      setPassword("");
      setSsl(false);
      setMaxConnections("");
      setConnectionString("");
      setAuthSource("");
      setMongoUriManual(false);
      setMssqlInstance("");
      setMssqlTrustCert(true);
      setMssqlAuth("sql");

      setSshEnabled(false);
      setSshHost("");
      setSshPort(22);
      setSshUsername("");
      setSshAuthMethod("password");
      setSshKeyPath("");
      setSshSecret("");
      setSshLocalPort(0);
      setSshHostKeyPolicy("accept-new");
      setTrustedFingerprint(null);
    }
  }

  /** URI derived live from the discrete MongoDB fields (form mode). The
   *  password is intentionally excluded — it travels via the keychain. */
  const builtMongoUri = useMemo(
    () => buildMongoUri({ host, port, database, username, authSource }),
    [host, port, database, username, authSource],
  );

  /** The URI this profile will actually connect with: the hand-edited buffer
   *  in raw-edit mode, otherwise the field-derived one. */
  const effectiveMongoUri = mongoUriManual ? connectionString : builtMongoUri;

  /** A MongoDB SRV URI resolves to multiple hosts — incompatible with the
   *  single-port SSH tunnel, so tunnelling is disabled for it. (Only reachable
   *  in raw-edit mode; the field-built URI is always single-host.) */
  const isMongoSrv =
    driver === "mongodb" &&
    effectiveMongoUri.trim().startsWith("mongodb+srv://");

  function buildSshTunnel(): SshTunnel | null {
    if (!sshEnabled || !supportsSshTunnel(driver) || isMongoSrv) return null;
    const auth: SshAuth =
      sshAuthMethod === "key"
        ? { kind: "key", path: sshKeyPath }
        : { kind: "password" };
    return {
      host: sshHost,
      port: sshPort,
      username: sshUsername,
      auth,
      local_port: sshLocalPort,
      host_key_policy: sshHostKeyPolicy,
    };
  }

  function normalizeServerName() {
    if (driver !== "sqlserver") return;
    const next = splitSqlServerName(host, mssqlInstance);
    if (next.host !== host) setHost(next.host);
    if (next.instance !== mssqlInstance) setMssqlInstance(next.instance);
  }

  function onDriverChange(d: Driver) {
    setDriver(d);
    if (port === DEFAULT_PORTS[driver] || port === 0) {
      setPort(DEFAULT_PORTS[d]);
    }
  }

  /** Toggle the MongoDB raw-edit mode. Entering seeds the buffer from the
   *  field-built URI; leaving folds the (possibly edited) URI back into the
   *  fields when it's representable, otherwise stays in raw-edit so SRV /
   *  multi-host / option-rich URIs aren't silently lost. */
  function onToggleMongoUriManual(next: boolean) {
    if (next) {
      setConnectionString(builtMongoUri);
      setMongoUriManual(true);
      return;
    }
    const parsed = parseMongoUri(connectionString);
    if (parsed) {
      setHost(parsed.host);
      setPort(parsed.port);
      setDatabase(parsed.database);
      setUsername(parsed.username);
      setAuthSource(parsed.authSource);
      setMongoUriManual(false);
    }
    // else: parse failed — keep raw-edit on (the Switch reflects mongoUriManual,
    // so it visibly stays enabled). The amber banner already explains why.
  }

  // Refresh the trusted fingerprint display whenever the SSH host:port
  // identity changes. Failures (no entry, transport error) just clear it.
  useEffect(() => {
    if (!open || !sshEnabled || !sshHost) {
      setTrustedFingerprint(null);
      return;
    }
    let cancelled = false;
    api
      .getHostKey(`${sshHost}:${sshPort}`)
      .then((fp) => {
        if (!cancelled) setTrustedFingerprint(fp);
      })
      .catch(() => {
        if (!cancelled) setTrustedFingerprint(null);
      });
    return () => {
      cancelled = true;
    };
  }, [open, sshEnabled, sshHost, sshPort]);

  return {
    // General
    name, setName,
    group, setGroup,
    driver, onDriverChange,
    host, setHost,
    port, setPort,
    database, setDatabase,
    username, setUsername,
    password, setPassword,
    ssl, setSsl,
    maxConnections, setMaxConnections,
    // MongoDB
    connectionString, setConnectionString,
    authSource, setAuthSource,
    mongoUriManual, onToggleMongoUriManual,
    builtMongoUri,
    effectiveMongoUri,
    isMongoSrv,
    // SQL Server
    mssqlInstance, setMssqlInstance,
    mssqlTrustCert, setMssqlTrustCert,
    mssqlAuth, setMssqlAuth,
    normalizeServerName,
    // SSH tunnel
    sshEnabled, setSshEnabled,
    sshHost, setSshHost,
    sshPort, setSshPort,
    sshUsername, setSshUsername,
    sshAuthMethod, setSshAuthMethod,
    sshKeyPath, setSshKeyPath,
    sshSecret, setSshSecret,
    sshLocalPort, setSshLocalPort,
    sshHostKeyPolicy, setSshHostKeyPolicy,
    trustedFingerprint, setTrustedFingerprint,
    buildSshTunnel,
    // Loading a profile in
    loadFields,
  };
}
