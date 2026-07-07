/**
 * Connections manager — master/detail.
 *
 * Mirrors the preferences dialog layout: a left rail lists every saved
 * connection (with a live "connected" dot) plus a "New connection" entry;
 * the right pane edits the selected profile via the General / SSH-tunnel
 * tabs. The form reshapes itself per driver: SQLite hides the network
 * fields and asks only for a database file path.
 *
 * Passwords are submitted to the backend separately from profile metadata
 * so `api.saveProfile(profile, password, sshSecret)` can route them to the
 * OS keychain — DB password under one account, SSH secret under another.
 *
 * Actions live in the right-pane footer: Test, Connect (save + open the
 * pool), Delete, and Save. `onConnected` lets the caller (the sidebar)
 * focus the connection in the main view once it opens.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { open as openFileDialog } from "@tauri-apps/plugin-dialog";
import {
  AlertCircle,
  Check,
  Copy,
  Database,
  Download,
  Folder,
  Plug,
  Plus,
  Trash2,
  Upload,
} from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { ExportProfilesDialog } from "@/components/ExportProfilesDialog";
import { ImportProfilesDialog } from "@/components/ImportProfilesDialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { DriverBadge } from "@/components/DriverBadge";
import { api } from "@/lib/tauri";
import { buildMongoUri, parseMongoUri } from "@/lib/mongoUri";
import { DEFAULT_PORTS } from "@/lib/constants";
import { confirmDestructive } from "@/lib/confirmDestructive";
import { cn } from "@/lib/utils";
import type {
  ConnectionProfile,
  Driver,
  HostKeyPolicy,
  SshAuth,
  SshTunnel,
} from "@/types";
import { useConnections } from "@/stores/connections";
import { useSchema } from "@/stores/schema";
import { usePreferences } from "@/stores/preferences";
import { driverMismatchHint } from "@/lib/driver";

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Profile to pre-select on open. `null`/absent opens a fresh draft. */
  initial?: ConnectionProfile | null;
  /** Called after a successful Connect so the caller can focus the pool. */
  onConnected?: (id: string) => void;
}

type SshAuthMethod = "password" | "key";

/**
 * Structured status for the action footer. Keeping the kind discrete avoids
 * fragile `.startsWith()` checks against localised strings when picking the
 * status colour.
 */
type TestStatus =
  | { kind: "idle" }
  | { kind: "testing" }
  | { kind: "ok" }
  | { kind: "saved" }
  | { kind: "error"; message: string }
  | { kind: "saveError"; message: string };

export function ConnectionDialog({
  open,
  onOpenChange,
  initial,
  onConnected,
}: Props) {
  const { t } = useTranslation();
  const save = useConnections((s) => s.save);
  const remove = useConnections((s) => s.remove);
  const connect = useConnections((s) => s.connect);
  const profiles = useConnections((s) => s.profiles);
  const active = useConnections((s) => s.active);
  const refreshSchema = useSchema((s) => s.refresh);

  /** Which profile is open in the editor; `null` means a new draft. */
  const [editingId, setEditingId] = useState<string | null>(
    initial?.id ?? null,
  );

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

  const [testStatus, setTestStatus] = useState<TestStatus>({ kind: "idle" });
  /** Transient "copied" feedback on the error-box copy button. */
  const [errorCopied, setErrorCopied] = useState(false);
  const [saving, setSaving] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [exportOpen, setExportOpen] = useState(false);
  const [importOpen, setImportOpen] = useState(false);

  /**
   * Stable id for the profile being edited. For existing profiles this is
   * just the profile id; for new ones we pre-mint a UUID so that both Test
   * and Save key keychain entries (DB password + SSH secret) under the same
   * `${id}::…` account.
   */
  const [draftId, setDraftId] = useState<string>("");

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
      setConnectionString(p.connection_string ?? "");
      setAuthSource(p.auth_source ?? "");
      setPassword("");

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
      setConnectionString("");
      setAuthSource("");
      setMongoUriManual(false);

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

  // When the dialog opens, select whatever the caller asked for.
  useEffect(() => {
    if (!open) return;
    setEditingId(initial?.id ?? null);
  }, [open, initial]);

  // Load the editor whenever the selection changes. We read the profile list
  // imperatively (rather than depending on `profiles`) so that a save/delete
  // that mutates the list does NOT wipe in-progress edits — the form only
  // reloads when the *selection* changes.
  useEffect(() => {
    if (!open) return;
    const list = useConnections.getState().profiles;
    const p = editingId ? list.find((x) => x.id === editingId) ?? null : null;
    setDraftId(p?.id ?? crypto.randomUUID());
    loadFields(p);
    setTestStatus({ kind: "idle" });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, editingId]);

  /** Distinct group names already in use, for the datalist suggestion below
   *  the Group field — a soft nudge toward reusing an existing name instead
   *  of a near-duplicate (free text, so nothing enforces this). */
  const existingGroups = useMemo(() => {
    const names = new Set<string>();
    for (const p of profiles) if (p.group) names.add(p.group);
    return Array.from(names).sort((a, b) => a.localeCompare(b));
  }, [profiles]);

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
    if (!sshEnabled || driver === "sqlite" || isMongoSrv) return null;
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

  function buildProfile(): ConnectionProfile {
    return {
      id: editingId ?? draftId,
      name,
      group: group.trim() || null,
      driver,
      host,
      port,
      database,
      username,
      ssl,
      ssh_tunnel: buildSshTunnel(),
      connection_string:
        driver === "mongodb" ? effectiveMongoUri.trim() || null : null,
      // Persisted explicitly for the URI-less CLI path and form repopulation.
      // In raw-edit mode the authSource lives inside the pasted URI instead.
      auth_source:
        driver === "mongodb" && !mongoUriManual
          ? authSource.trim() || null
          : null,
    };
  }

  async function onTest() {
    setTestStatus({ kind: "testing" });
    try {
      await api.testConnection(
        buildProfile(),
        password || undefined,
        sshSecret || undefined,
      );
      setTestStatus({ kind: "ok" });
    } catch (e) {
      setTestStatus({ kind: "error", message: String(e) });
    }
  }

  async function onSave() {
    setSaving(true);
    try {
      const saved = await save(
        buildProfile(),
        password || undefined,
        sshSecret || undefined,
      );
      // Stay on the saved profile (clears the secret fields via reload when
      // this was a new draft); keep the dialog open so the user can manage
      // other connections.
      setEditingId(saved.id);
      setTestStatus({ kind: "saved" });
    } catch (e) {
      setTestStatus({ kind: "saveError", message: String(e) });
    } finally {
      setSaving(false);
    }
  }

  async function onConnect() {
    setConnecting(true);
    setTestStatus({ kind: "idle" });
    try {
      // Persist any edits + credentials first so the pool opens against the
      // saved profile and the keychain has the secret it needs.
      const saved = await save(
        buildProfile(),
        password || undefined,
        sshSecret || undefined,
      );
      await connect(saved.id, password || undefined);
      await refreshSchema(saved.id);
      setEditingId(saved.id);
      onConnected?.(saved.id);
      onOpenChange(false);
    } catch (e) {
      const err = String(e);
      const hint = driverMismatchHint(err);
      setTestStatus({
        kind: "error",
        message: hint ? `${err} — ${hint}` : err,
      });
    } finally {
      setConnecting(false);
    }
  }

  async function onDelete() {
    if (!editingId) return;
    const target = profiles.find((p) => p.id === editingId);
    if (
      !confirmDestructive(
        t("connections.deleteConfirm", { name: target?.name ?? name }),
      )
    )
      return;
    try {
      await remove(editingId);
      // Fall back to a fresh draft; the load effect repopulates the form.
      setEditingId(null);
    } catch (e) {
      setTestStatus({ kind: "saveError", message: String(e) });
    }
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

  async function onForgetHostKey() {
    if (!sshHost) return;
    const hostPort = `${sshHost}:${sshPort}`;
    if (!confirm(t("connectionDialog.ssh.forgetConfirm", { hostPort }))) return;
    try {
      const removed = await api.forgetHostKey(hostPort);
      alert(
        removed
          ? t("connectionDialog.ssh.forgetDone")
          : t("connectionDialog.ssh.forgetNone"),
      );
      setTrustedFingerprint(null);
    } catch (e) {
      alert(String(e));
    }
  }

  async function onPickKeyFile() {
    try {
      const picked = await openFileDialog({
        multiple: false,
        directory: false,
        title: t("connectionDialog.ssh.privateKeyPath"),
      });
      if (typeof picked === "string" && picked) setSshKeyPath(picked);
    } catch {
      // File dialog cancellation throws — ignore silently.
    }
  }

  const statusText = (() => {
    switch (testStatus.kind) {
      case "testing":
        return t("connectionDialog.testing");
      case "ok":
        return t("connectionDialog.testOk");
      case "saved":
        return t("connectionDialog.saved");
      case "error":
        return t("connectionDialog.testFailed", { message: testStatus.message });
      case "saveError":
        return t("connectionDialog.saveFailed", { message: testStatus.message });
      default:
        return null;
    }
  })();

  const statusClass = (() => {
    switch (testStatus.kind) {
      case "ok":
      case "saved":
        return "text-emerald-400";
      case "testing":
        return "text-muted-foreground";
      case "error":
      case "saveError":
        return "text-destructive";
      default:
        return "";
    }
  })();

  /** `error` and `saveError` carry a (potentially long) backend message that
   *  gets its own wrapping, scrollable box; the short states stay one-line. */
  const isErrorStatus =
    testStatus.kind === "error" || testStatus.kind === "saveError";

  function onCopyError() {
    if (testStatus.kind !== "error" && testStatus.kind !== "saveError") return;
    void navigator.clipboard.writeText(testStatus.message);
    setErrorCopied(true);
    window.setTimeout(() => setErrorCopied(false), 1500);
  }

  const tunnelTabDisabled = driver === "sqlite" || isMongoSrv;
  const busy = saving || connecting;

  return (
    <>
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex h-[82vh] max-w-4xl flex-col gap-0 overflow-hidden p-0">
        <DialogHeader className="border-b border-border px-5 py-3">
          <div className="flex items-center justify-between gap-2">
            <DialogTitle className="flex items-center gap-2 text-base">
              <Database className="h-4 w-4 text-primary" />
              {t("connectionDialog.managerTitle")}
            </DialogTitle>
            {/* `mr-8` clears the dialog's absolute close button (right-4 top-4)
                so the import/export actions don't sit under the X. */}
            <div className="mr-8 flex items-center gap-1">
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-6 w-6"
                    onClick={() => setImportOpen(true)}
                  >
                    <Upload className="h-3.5 w-3.5" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent side="bottom">
                  {t("transfer.import.tooltip")}
                </TooltipContent>
              </Tooltip>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-6 w-6"
                    onClick={() => setExportOpen(true)}
                  >
                    <Download className="h-3.5 w-3.5" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent side="bottom">
                  {t("transfer.export.tooltip")}
                </TooltipContent>
              </Tooltip>
            </div>
          </div>
          <DialogDescription className="text-[11px]">
            {t("connectionDialog.managerDescription")}
          </DialogDescription>
        </DialogHeader>

        <div className="grid flex-1 grid-cols-[240px_1fr] overflow-hidden">
          {/* Left rail — saved connections + new */}
          <aside className="flex min-h-0 flex-col border-r border-border bg-card/40">
            <div className="px-2 pt-2">
              <Button
                variant="outline"
                size="sm"
                className="w-full justify-start gap-2"
                onClick={() => setEditingId(null)}
              >
                <Plus className="h-3.5 w-3.5" />
                {t("connectionDialog.newConnection")}
              </Button>
            </div>
            <div className="mt-1 px-3 py-1 text-[10px] uppercase tracking-wider text-muted-foreground">
              {t("connectionDialog.listTitle")}
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto pb-2">
              {profiles.length === 0 && (
                <div className="px-3 py-3 text-[11px] text-muted-foreground">
                  {t("connectionDialog.emptyList")}
                </div>
              )}
              {profiles.map((p) => {
                const isActive = active.has(p.id);
                const selected = editingId === p.id;
                return (
                  <button
                    key={p.id}
                    onClick={() => setEditingId(p.id)}
                    className={cn(
                      "flex w-full items-center gap-2 border-l-2 px-3 py-2 text-left transition-colors",
                      selected
                        ? "border-primary bg-accent/40"
                        : "border-transparent hover:bg-accent/30",
                    )}
                  >
                    <span
                      className={cn(
                        "h-1.5 w-1.5 shrink-0 rounded-full",
                        isActive
                          ? "bg-emerald-400"
                          : "bg-muted-foreground/40",
                      )}
                      title={
                        isActive
                          ? t("connections.disconnectTooltip")
                          : undefined
                      }
                    />
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-1.5">
                        <span className="truncate text-sm font-medium">
                          {p.name}
                        </span>
                        <DriverBadge driver={p.driver} />
                      </div>
                      <div className="truncate text-[11px] text-muted-foreground">
                        {p.driver === "sqlite"
                          ? p.database.split(/[/\\]/).pop() ?? p.database
                          : p.driver === "mongodb"
                            ? p.connection_string || `${p.host}:${p.port}`
                            : `${p.host}:${p.port}/${p.database}`}
                      </div>
                    </div>
                  </button>
                );
              })}
            </div>
          </aside>

          {/* Right pane — editor */}
          <main className="flex min-h-0 flex-col">
            <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
              <Tabs defaultValue="general" className="w-full">
                <TabsList className="w-full">
                  <TabsTrigger value="general" className="flex-1">
                    {t("connectionDialog.tabs.general")}
                  </TabsTrigger>
                  <TabsTrigger
                    value="ssh"
                    className="flex-1"
                    disabled={tunnelTabDisabled}
                  >
                    {t("connectionDialog.tabs.ssh")}
                  </TabsTrigger>
                </TabsList>

                <TabsContent value="general" className="pt-3">
                  <div className="grid gap-3">
                    <Field label={t("connectionDialog.fields.name")}>
                      <Input
                        value={name}
                        onChange={(e) => setName(e.target.value)}
                        placeholder={t("connectionDialog.fields.namePlaceholder")}
                      />
                    </Field>
                    <Field label={t("connectionDialog.fields.group")}>
                      <GroupCombobox
                        value={group}
                        onChange={setGroup}
                        suggestions={existingGroups}
                        placeholder={t("connectionDialog.fields.groupPlaceholder")}
                      />
                    </Field>
                    <Field label={t("connectionDialog.fields.driver")}>
                      <Select
                        value={driver}
                        onValueChange={(v) => onDriverChange(v as Driver)}
                      >
                        <SelectTrigger>
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="postgres">PostgreSQL</SelectItem>
                          <SelectItem value="mysql">MySQL</SelectItem>
                          <SelectItem value="sqlite">SQLite</SelectItem>
                          <SelectItem value="mongodb">MongoDB</SelectItem>
                        </SelectContent>
                      </Select>
                    </Field>
                    {driver === "mongodb" ? (
                      <>
                        {/* Form-primary fields (Compass-style). Disabled while
                            the connection string is hand-edited below. */}
                        <div className="grid grid-cols-3 gap-2">
                          <div className="col-span-2">
                            <Field label={t("connectionDialog.fields.host")}>
                              <Input
                                value={host}
                                disabled={mongoUriManual}
                                onChange={(e) => setHost(e.target.value)}
                              />
                            </Field>
                          </div>
                          <Field label={t("connectionDialog.fields.port")}>
                            <Input
                              type="number"
                              value={port || ""}
                              disabled={mongoUriManual}
                              onChange={(e) => setPort(Number(e.target.value))}
                            />
                          </Field>
                        </div>
                        <Field label={t("connectionDialog.fields.database")}>
                          <Input
                            value={database}
                            disabled={mongoUriManual}
                            onChange={(e) => setDatabase(e.target.value)}
                          />
                        </Field>
                        <Field label={t("connectionDialog.fields.username")}>
                          <Input
                            value={username}
                            disabled={mongoUriManual}
                            onChange={(e) => setUsername(e.target.value)}
                          />
                        </Field>
                        <Field label={t("connectionDialog.fields.password")}>
                          <Input
                            type="password"
                            value={password}
                            onChange={(e) => setPassword(e.target.value)}
                            placeholder={
                              editingId
                                ? t("connectionDialog.fields.passwordKeepHint")
                                : ""
                            }
                          />
                        </Field>
                        <Field label={t("connectionDialog.fields.authSource")}>
                          <Input
                            value={authSource}
                            disabled={mongoUriManual}
                            onChange={(e) => setAuthSource(e.target.value)}
                            placeholder={t(
                              "connectionDialog.fields.authSourcePlaceholder",
                            )}
                          />
                        </Field>

                        {/* Derived connection string + raw-edit escape hatch. */}
                        <div className="flex items-center justify-between rounded-md border border-border px-3 py-2">
                          <Label className="text-sm">
                            {t("connectionDialog.fields.editConnectionString")}
                          </Label>
                          <Switch
                            checked={mongoUriManual}
                            onCheckedChange={onToggleMongoUriManual}
                          />
                        </div>
                        <Field
                          label={t("connectionDialog.fields.connectionString")}
                        >
                          <Input
                            value={effectiveMongoUri}
                            readOnly={!mongoUriManual}
                            onChange={(e) =>
                              setConnectionString(e.target.value)
                            }
                            placeholder={t(
                              "connectionDialog.fields.connectionStringPlaceholder",
                            )}
                            className={
                              mongoUriManual ? undefined : "text-muted-foreground"
                            }
                          />
                        </Field>
                        {mongoUriManual ? (
                          <p className="-mt-1 rounded border border-amber-500/40 bg-amber-500/10 px-2 py-1.5 text-[11px] text-amber-500">
                            {t("connectionDialog.fields.connectionStringWarning")}
                          </p>
                        ) : (
                          <p className="-mt-1 text-[11px] text-muted-foreground">
                            {t("connectionDialog.fields.connectionStringHint")}
                          </p>
                        )}
                      </>
                    ) : driver !== "sqlite" ? (
                      <>
                        <div className="grid grid-cols-3 gap-2">
                          <div className="col-span-2">
                            <Field label={t("connectionDialog.fields.host")}>
                              <Input
                                value={host}
                                onChange={(e) => setHost(e.target.value)}
                              />
                            </Field>
                          </div>
                          <Field label={t("connectionDialog.fields.port")}>
                            <Input
                              type="number"
                              value={port || ""}
                              onChange={(e) => setPort(Number(e.target.value))}
                            />
                          </Field>
                        </div>
                        <Field label={t("connectionDialog.fields.database")}>
                          <Input
                            value={database}
                            onChange={(e) => setDatabase(e.target.value)}
                          />
                        </Field>
                        <Field label={t("connectionDialog.fields.username")}>
                          <Input
                            value={username}
                            onChange={(e) => setUsername(e.target.value)}
                          />
                        </Field>
                        <Field label={t("connectionDialog.fields.password")}>
                          <Input
                            type="password"
                            value={password}
                            onChange={(e) => setPassword(e.target.value)}
                            placeholder={
                              editingId
                                ? t("connectionDialog.fields.passwordKeepHint")
                                : ""
                            }
                          />
                        </Field>
                        <div className="flex items-center justify-between rounded-md border border-border px-3 py-2">
                          <Label className="text-sm">
                            {t("connectionDialog.fields.ssl")}
                          </Label>
                          <Switch checked={ssl} onCheckedChange={setSsl} />
                        </div>
                      </>
                    ) : (
                      <Field label={t("connectionDialog.fields.sqlitePath")}>
                        <Input
                          value={database}
                          onChange={(e) => setDatabase(e.target.value)}
                          placeholder={t(
                            "connectionDialog.fields.sqlitePathPlaceholder",
                          )}
                        />
                      </Field>
                    )}
                  </div>
                </TabsContent>

                <TabsContent value="ssh" className="pt-3">
                  {tunnelTabDisabled ? (
                    <div className="px-1 py-3 text-xs text-muted-foreground">
                      {isMongoSrv
                        ? t("connectionDialog.ssh.unavailableForSrv")
                        : t("connectionDialog.ssh.unavailableForSqlite")}
                    </div>
                  ) : (
                    <div className="grid gap-3">
                      <div className="flex items-center justify-between rounded-md border border-border px-3 py-2">
                        <Label className="text-sm">
                          {t("connectionDialog.ssh.enable")}
                        </Label>
                        <Switch
                          checked={sshEnabled}
                          onCheckedChange={setSshEnabled}
                        />
                      </div>
                      {sshEnabled && (
                        <>
                          <div className="grid grid-cols-3 gap-2">
                            <div className="col-span-2 min-w-0">
                              <Field label={t("connectionDialog.ssh.host")}>
                                <Input
                                  value={sshHost}
                                  onChange={(e) => setSshHost(e.target.value)}
                                />
                              </Field>
                            </div>
                            <Field label={t("connectionDialog.ssh.port")}>
                              <Input
                                type="number"
                                value={sshPort || ""}
                                onChange={(e) =>
                                  setSshPort(Number(e.target.value))
                                }
                              />
                            </Field>
                          </div>
                          <Field label={t("connectionDialog.ssh.username")}>
                            <Input
                              value={sshUsername}
                              onChange={(e) => setSshUsername(e.target.value)}
                            />
                          </Field>
                          <Field label={t("connectionDialog.ssh.authMethod")}>
                            <Select
                              value={sshAuthMethod}
                              onValueChange={(v) =>
                                setSshAuthMethod(v as SshAuthMethod)
                              }
                            >
                              <SelectTrigger>
                                <SelectValue />
                              </SelectTrigger>
                              <SelectContent>
                                <SelectItem value="password">
                                  {t("connectionDialog.ssh.authPassword")}
                                </SelectItem>
                                <SelectItem value="key">
                                  {t("connectionDialog.ssh.authKey")}
                                </SelectItem>
                              </SelectContent>
                            </Select>
                          </Field>

                          {sshAuthMethod === "password" ? (
                            <Field label={t("connectionDialog.ssh.sshPassword")}>
                              <Input
                                type="password"
                                value={sshSecret}
                                onChange={(e) => setSshSecret(e.target.value)}
                                placeholder={
                                  editingId
                                    ? t("connectionDialog.ssh.passphraseKeepHint")
                                    : ""
                                }
                              />
                            </Field>
                          ) : (
                            <>
                              <Field
                                label={t("connectionDialog.ssh.privateKeyPath")}
                              >
                                <div className="flex min-w-0 gap-2">
                                  <Input
                                    className="min-w-0 flex-1"
                                    value={sshKeyPath}
                                    onChange={(e) =>
                                      setSshKeyPath(e.target.value)
                                    }
                                    placeholder={t(
                                      "connectionDialog.ssh.privateKeyPathPlaceholder",
                                    )}
                                  />
                                  <Button
                                    type="button"
                                    variant="outline"
                                    className="shrink-0"
                                    onClick={onPickKeyFile}
                                  >
                                    {t("connectionDialog.ssh.browse")}
                                  </Button>
                                </div>
                              </Field>
                              <Field label={t("connectionDialog.ssh.passphrase")}>
                                <Input
                                  type="password"
                                  value={sshSecret}
                                  onChange={(e) => setSshSecret(e.target.value)}
                                  placeholder={
                                    editingId
                                      ? t("connectionDialog.ssh.passphraseKeepHint")
                                      : ""
                                  }
                                />
                              </Field>
                            </>
                          )}

                          <Field label={t("connectionDialog.ssh.localPort")}>
                            <Input
                              type="number"
                              value={sshLocalPort || ""}
                              onChange={(e) =>
                                setSshLocalPort(Number(e.target.value))
                              }
                              placeholder={t("connectionDialog.ssh.localPortAuto")}
                            />
                          </Field>
                          <p className="-mt-1 text-[11px] text-muted-foreground">
                            {t("connectionDialog.ssh.localPortHint")}
                          </p>

                          <Field label={t("connectionDialog.ssh.hostKeyPolicy")}>
                            <Select
                              value={sshHostKeyPolicy}
                              onValueChange={(v) =>
                                setSshHostKeyPolicy(v as HostKeyPolicy)
                              }
                            >
                              <SelectTrigger>
                                <SelectValue />
                              </SelectTrigger>
                              <SelectContent>
                                <SelectItem value="accept-new">
                                  {t("connectionDialog.ssh.policyAcceptNew")}
                                </SelectItem>
                                <SelectItem value="strict">
                                  {t("connectionDialog.ssh.policyStrict")}
                                </SelectItem>
                                <SelectItem value="accept-any">
                                  {t("connectionDialog.ssh.policyAcceptAny")}
                                </SelectItem>
                              </SelectContent>
                            </Select>
                          </Field>
                          <p className="-mt-1 text-[11px] text-muted-foreground">
                            {t("connectionDialog.ssh.hostKeyPolicyHint")}
                          </p>

                          {sshHost && (
                            <div className="rounded-md border border-border px-3 py-2 text-[11px]">
                              <div className="mb-1 font-medium text-muted-foreground">
                                {t("connectionDialog.ssh.trustedFingerprint")}
                              </div>
                              {trustedFingerprint ? (
                                <div className="flex items-center gap-2">
                                  <code className="flex-1 truncate font-mono text-[10px]">
                                    {trustedFingerprint}
                                  </code>
                                  <Button
                                    type="button"
                                    variant="outline"
                                    size="sm"
                                    onClick={onForgetHostKey}
                                  >
                                    {t("connectionDialog.ssh.forgetHostKey")}
                                  </Button>
                                </div>
                              ) : (
                                <div className="text-muted-foreground">
                                  {t("connectionDialog.ssh.noTrustedFingerprint")}
                                </div>
                              )}
                            </div>
                          )}
                        </>
                      )}
                    </div>
                  )}
                </TabsContent>
              </Tabs>
            </div>

            {/* Action footer */}
            <div className="border-t border-border px-5 py-3">
              {statusText &&
                (isErrorStatus ? (
                  // Long DB errors used to truncate at the dialog edge. Give
                  // them a bounded, wrapping, scrollable box with a copy
                  // affordance instead of a single clipped line.
                  <div className="mb-2 flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2">
                    <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-destructive" />
                    <p className="max-h-24 min-w-0 flex-1 overflow-y-auto whitespace-pre-wrap break-words text-xs leading-relaxed text-destructive">
                      {statusText}
                    </p>
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-6 w-6 shrink-0 text-destructive hover:text-destructive"
                          onClick={onCopyError}
                        >
                          {errorCopied ? (
                            <Check className="h-3.5 w-3.5" />
                          ) : (
                            <Copy className="h-3.5 w-3.5" />
                          )}
                        </Button>
                      </TooltipTrigger>
                      <TooltipContent side="left">
                        {t("connectionDialog.copyError")}
                      </TooltipContent>
                    </Tooltip>
                  </div>
                ) : (
                  <div className={`mb-2 truncate text-xs ${statusClass}`}>
                    {statusText}
                  </div>
                ))}
              <div className="flex items-center gap-2">
                <Button variant="ghost" onClick={onTest} disabled={busy || !name}>
                  {t("connectionDialog.test")}
                </Button>
                {editingId && (
                  <Button
                    variant="ghost"
                    className="text-destructive hover:text-destructive"
                    onClick={onDelete}
                    disabled={busy}
                  >
                    <Trash2 className="mr-1 h-3.5 w-3.5" />
                    {t("connectionDialog.delete")}
                  </Button>
                )}
                <div className="ml-auto flex items-center gap-2">
                  <Button
                    variant="outline"
                    onClick={onConnect}
                    disabled={busy || !name}
                  >
                    <Plug className="mr-1 h-3.5 w-3.5" />
                    {connecting
                      ? t("connectionDialog.connecting")
                      : t("connectionDialog.connect")}
                  </Button>
                  <Button onClick={onSave} disabled={busy || !name}>
                    {saving
                      ? t("connectionDialog.saving")
                      : t("connectionDialog.save")}
                  </Button>
                </div>
              </div>
            </div>
          </main>
        </div>
      </DialogContent>
    </Dialog>

      <ExportProfilesDialog open={exportOpen} onOpenChange={setExportOpen} />
      <ImportProfilesDialog open={importOpen} onOpenChange={setImportOpen} />
    </>
  );
}

function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  // `min-w-0` lets the field shrink inside flex/grid parents instead of forcing
  // its content's intrinsic width and overflowing (e.g. a long SSH key path).
  return (
    <div className="grid min-w-0 gap-1">
      <Label>{label}</Label>
      {children}
    </div>
  );
}

/**
 * Free-text "creatable" combobox for the Group field. Replaces the native
 * `<datalist>` (issue #21), whose suggestion popup is drawn by the OS/webview
 * and ignores the app theme. This is a themed popover anchored under the
 * input: it lists matching existing group names but never constrains the
 * value — typing a brand-new name still creates a new group on save.
 */
function GroupCombobox({
  value,
  onChange,
  suggestions,
  placeholder,
}: {
  value: string;
  onChange: (value: string) => void;
  suggestions: string[];
  placeholder?: string;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  // Show every other group when the field is empty, else substring-filter —
  // and never suggest the exact value already typed (nothing to pick).
  const matches = useMemo(() => {
    const term = value.trim().toLowerCase();
    return suggestions.filter(
      (g) => g.toLowerCase() !== term && (!term || g.toLowerCase().includes(term)),
    );
  }, [suggestions, value]);

  // Close on any click outside the combobox subtree.
  useEffect(() => {
    if (!open) return;
    function onDown(e: MouseEvent) {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  return (
    <div ref={rootRef} className="relative">
      <Input
        value={value}
        autoComplete="off"
        placeholder={placeholder}
        onChange={(e) => {
          onChange(e.target.value);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        onKeyDown={(e) => {
          if (e.key === "Escape") setOpen(false);
        }}
      />
      {open && matches.length > 0 && (
        <div
          className="absolute left-0 right-0 top-full z-50 mt-1 max-h-48 overflow-y-auto rounded-md border border-border bg-popover py-1 text-popover-foreground shadow-md"
          // Keep the input focused when a suggestion is clicked so the click
          // resolves before the outside-click handler can fire.
          onMouseDown={(e) => e.preventDefault()}
        >
          {matches.map((g) => (
            <button
              key={g}
              type="button"
              onClick={() => {
                onChange(g);
                setOpen(false);
              }}
              className="flex w-full items-center gap-2 px-2 py-1 text-left text-xs hover:bg-accent hover:text-accent-foreground"
            >
              <Folder className="h-3 w-3 shrink-0 opacity-60" />
              <span className="truncate">{g}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
