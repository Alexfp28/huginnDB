/**
 * Create / edit a connection profile.
 *
 * The dialog re-shapes itself based on the selected driver: SQLite hides
 * the network fields and asks only for a database file path. Passwords
 * are submitted to the backend separately from profile metadata so
 * `api.saveProfile(profile, password, sshSecret)` can route them to the
 * OS keychain — DB password under one account, SSH secret under another.
 *
 * The "SSH tunnel" tab is HeidiSQL-style: a switch enables the section,
 * then host/port/username plus a password or private-key auth method.
 * The tunnel is hidden for SQLite (local file, no tunnel needed).
 */

import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { open as openFileDialog } from "@tauri-apps/plugin-dialog";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { api } from "@/lib/tauri";
import { DEFAULT_PORTS } from "@/lib/constants";
import type {
  ConnectionProfile,
  Driver,
  HostKeyPolicy,
  SshAuth,
  SshTunnel,
} from "@/types";
import { useConnections } from "@/stores/connections";

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  initial?: ConnectionProfile | null;
}

type SshAuthMethod = "password" | "key";

/**
 * Structured status for the Test button. Keeping the kind discrete avoids
 * fragile `.startsWith()` checks against localised strings when picking the
 * status colour.
 */
type TestStatus =
  | { kind: "idle" }
  | { kind: "testing" }
  | { kind: "ok" }
  | { kind: "error"; message: string }
  | { kind: "saveError"; message: string };

export function ConnectionDialog({ open, onOpenChange, initial }: Props) {
  const { t } = useTranslation();
  const save = useConnections((s) => s.save);

  // General fields ---------------------------------------------------------
  const [name, setName] = useState("");
  const [driver, setDriver] = useState<Driver>("postgres");
  const [host, setHost] = useState("localhost");
  const [port, setPort] = useState(5432);
  const [database, setDatabase] = useState("");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [ssl, setSsl] = useState(false);

  // SSH tunnel fields ------------------------------------------------------
  const [sshEnabled, setSshEnabled] = useState(false);
  const [sshHost, setSshHost] = useState("");
  const [sshPort, setSshPort] = useState(22);
  const [sshUsername, setSshUsername] = useState("");
  const [sshAuthMethod, setSshAuthMethod] = useState<SshAuthMethod>("password");
  const [sshKeyPath, setSshKeyPath] = useState("");
  const [sshSecret, setSshSecret] = useState("");
  const [sshLocalPort, setSshLocalPort] = useState(0);
  const [sshHostKeyPolicy, setSshHostKeyPolicy] = useState<HostKeyPolicy>(
    "accept-new",
  );
  const [trustedFingerprint, setTrustedFingerprint] = useState<string | null>(
    null,
  );

  const [testStatus, setTestStatus] = useState<TestStatus>({ kind: "idle" });
  const [saving, setSaving] = useState(false);

  /**
   * Stable id for the profile being edited. For existing profiles this
   * is just `initial.id`; for new ones we pre-mint a UUID the first
   * time the dialog opens so that both Test and Save key keychain
   * entries (DB password + SSH secret) under the same
   * `${id}::…` account. Without this, persisting the SSH secret during
   * Test would either land under `::ssh::<user>` (colliding across
   * draft profiles) or have to skip the keychain entirely on Test.
   */
  const [draftId, setDraftId] = useState<string>("");

  useEffect(() => {
    if (!open) return;
    // Mint / reuse the draft id every time the dialog opens. Existing
    // profiles keep their id; new ones get a fresh UUID so the keychain
    // accounts are stable across Test → Save.
    setDraftId(initial?.id ?? crypto.randomUUID());
    if (initial) {
      setName(initial.name);
      setDriver(initial.driver);
      setHost(initial.host);
      setPort(initial.port);
      setDatabase(initial.database);
      setUsername(initial.username);
      setSsl(initial.ssl);
      setPassword("");

      const tunnel = initial.ssh_tunnel;
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
      setName("");
      setDriver("postgres");
      setHost("localhost");
      setPort(DEFAULT_PORTS.postgres);
      setDatabase("");
      setUsername("");
      setPassword("");
      setSsl(false);

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
    setTestStatus({ kind: "idle" });
  }, [open, initial]);

  function buildSshTunnel(): SshTunnel | null {
    if (!sshEnabled || driver === "sqlite") return null;
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
      // `draftId` is pre-minted on dialog open so Test and Save share
      // the same id — both keychain writes (DB password + SSH secret)
      // land under matching `${id}::…` accounts, and `save_profile`'s
      // own UUID assignment becomes a no-op for our case.
      id: initial?.id ?? draftId,
      name,
      driver,
      host,
      port,
      database,
      username,
      ssl,
      ssh_tunnel: buildSshTunnel(),
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
      await save(buildProfile(), password || undefined, sshSecret || undefined);
      onOpenChange(false);
    } catch (e) {
      setTestStatus({ kind: "saveError", message: String(e) });
    } finally {
      setSaving(false);
    }
  }

  function onDriverChange(d: Driver) {
    setDriver(d);
    if (port === DEFAULT_PORTS[driver] || port === 0) {
      setPort(DEFAULT_PORTS[d]);
    }
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

  const tunnelTabDisabled = driver === "sqlite";

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>
            {initial
              ? t("connectionDialog.titleEdit")
              : t("connectionDialog.titleNew")}
          </DialogTitle>
          <DialogDescription>
            {t("connectionDialog.description")}
          </DialogDescription>
        </DialogHeader>

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
                  </SelectContent>
                </Select>
              </Field>
              {driver !== "sqlite" ? (
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
                        value={port}
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
                        initial
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
                {t("connectionDialog.ssh.unavailableForSqlite")}
              </div>
            ) : (
              <div className="grid gap-3">
                <div className="flex items-center justify-between rounded-md border border-border px-3 py-2">
                  <Label className="text-sm">
                    {t("connectionDialog.ssh.enable")}
                  </Label>
                  <Switch checked={sshEnabled} onCheckedChange={setSshEnabled} />
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
                          value={sshPort}
                          onChange={(e) => setSshPort(Number(e.target.value))}
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
                            initial
                              ? t("connectionDialog.ssh.passphraseKeepHint")
                              : ""
                          }
                        />
                      </Field>
                    ) : (
                      <>
                        <Field label={t("connectionDialog.ssh.privateKeyPath")}>
                          <div className="flex min-w-0 gap-2">
                            <Input
                              className="min-w-0 flex-1"
                              value={sshKeyPath}
                              onChange={(e) => setSshKeyPath(e.target.value)}
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
                              initial
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
                        value={sshLocalPort}
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

        {statusText && (
          <div className={`text-xs ${statusClass}`}>{statusText}</div>
        )}
        <DialogFooter>
          <Button variant="ghost" onClick={onTest}>
            {t("connectionDialog.test")}
          </Button>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            {t("connectionDialog.cancel")}
          </Button>
          <Button onClick={onSave} disabled={saving || !name}>
            {saving ? t("connectionDialog.saving") : t("connectionDialog.save")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  // `min-w-0` lets the field shrink inside flex/grid parents instead of forcing
  // its content's intrinsic width and overflowing the dialog (e.g. a long SSH
  // key path or host pushing the layout past `max-w-md`).
  return (
    <div className="grid min-w-0 gap-1">
      <Label>{label}</Label>
      {children}
    </div>
  );
}
