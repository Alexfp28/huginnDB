/**
 * MCP connector settings.
 *
 * Surfaces the bundled `huginndb-mcp` sidecar's on-disk path and generates
 * a ready-to-paste client config, so wiring up an AI tool doesn't require
 * hunting through the install directory or the source tree (see
 * `docs/MCP.md` and gotcha #20 in `CLAUDE.md`). It never starts the server —
 * that is the AI client's job — but it does write one field: each connection's
 * MCP write policy.
 *
 * The picker is a tree grouped by provenance, mirroring the connection manager's
 * rail (`McpConnectionTree`), because that is the distinction this panel turns on:
 * a connection a shared origin publishes keeps the **same id on every machine**,
 * so a snippet built from shared connections works for the whole team as-is,
 * while one built from a stale local copy works only here. Out of a flat list
 * those two are indistinguishable.
 */

import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { notify } from "@/lib/notify";
import { Copy, Search, X } from "lucide-react";
import { ConfirmDialog } from "@/components/common/ConfirmDialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Segmented } from "@/components/ui/segmented";
import { api } from "@/lib/tauri";
import {
  filterByScope,
  isFromOrigin,
  originIdOf,
  type ProfileScope,
} from "@/lib/connection/origin";
import { buildRailSections } from "@/lib/connection/railSections";
import { useOrigins } from "@/stores/sync/origins";
import { useDocsDialog } from "@/stores/dialogs/docsDialog";
import { useSettingsDialog } from "@/components/settings/useSettingsDialog";
import type {
  ConnectionProfile,
  McpConnectorInfo,
  McpWritePolicy,
} from "@/types";

import { McpConnectionTree } from "./McpConnectionTree";
import { WRITE_LEVELS } from "./McpWritePolicySelect";

function CopyButton({ text }: { text: string }) {
  const { t } = useTranslation();
  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
      className="h-6 gap-1 px-2 text-[11px]"
      onClick={() => {
        void navigator.clipboard.writeText(text);
        notify.success(t("settings.mcp.copied"));
      }}
    >
      <Copy className="h-3 w-3" />
      {t("common.copy")}
    </Button>
  );
}

export function McpSection() {
  const { t } = useTranslation();
  const [info, setInfo] = useState<McpConnectorInfo | null>(null);
  const [profiles, setProfiles] = useState<ConnectionProfile[]>([]);
  const [filter, setFilter] = useState("");
  const [scope, setScope] = useState<ProfileScope>("all");
  /** Pending "set everything to full", which is the one level worth a prompt. */
  const [pendingFull, setPendingFull] = useState(false);
  /**
   * In-flight state for the bulk policy row.
   *
   * Deliberately NOT `useAsyncSubmit`: that hook leaves `submitting` true after a
   * success, on the contract that the success path unmounts the dialog it is
   * driving (gotcha #44). This row lives in a section that stays mounted, so the
   * flag never cleared and the three buttons stayed disabled until the user
   * navigated to another section and back. Clearing in a `finally` is right here
   * for the same reason it is wrong there — nothing unmounts to do it for us,
   * and re-applying the same policy twice is harmless.
   */
  const [applying, setApplying] = useState(false);
  const [bulkError, setBulkError] = useState<string | null>(null);

  useEffect(() => {
    void api
      .getMcpConnectorInfo()
      .then(setInfo)
      .catch(() => setInfo(null));
    void api
      .listProfiles()
      .then(setProfiles)
      .catch(() => setProfiles([]));
  }, []);

  /**
   * The checked set is not local UI state: it *is* `ConnectionProfile.mcp_exposed`,
   * the field the sidecar reads to decide what it may reach at all.
   *
   * It used to be a `useState` that fed nothing but the generated snippet, so
   * this panel could offer the choice without being able to make it — the real
   * decision lived in the client's own config as `--connections <uuid>,<uuid>`,
   * which is why adding a connection meant hand-editing a JSON file per client
   * and restarting each one. Deriving it from the profiles keeps the checkbox
   * honest: what is ticked here is exactly what is reachable, and the sidecar
   * re-reads it per call, so it takes effect without a restart.
   */
  const selected = useMemo(
    () => new Set(profiles.filter((p) => p.mcp_exposed).map((p) => p.id)),
    [profiles],
  );

  const shared = useMemo(() => profiles.filter(isFromOrigin), [profiles]);
  const hasShared = shared.length > 0;

  // Removing the last origin must not leave the panel stuck on an empty
  // "Shared" — same reset the connection rail does.
  useEffect(() => {
    if (!hasShared && scope !== "all") setScope("all");
  }, [hasShared, scope]);

  /** What the list is showing: the provenance scope, then the name filter. */
  const filteredProfiles = useMemo(() => {
    const q = filter.trim().toLowerCase();
    const inScope = filterByScope(profiles, scope);
    if (!q) return inScope;
    return inScope.filter((p) => p.name.toLowerCase().includes(q));
  }, [profiles, filter, scope]);

  // `buildRailSections` is reused rather than reimplemented so this panel and
  // the connection rail cannot drift on labels or ordering. Local and shared are
  // built separately and concatenated, because unlike the rail — which shows one
  // scope at a time — the All view here wants both headers: this is where the
  // difference between a portable id and a local-only one is acted on.
  const originsById = useOrigins((s) => s.byId);
  const sections = useMemo(() => {
    const nameOf = (id: string) => originsById[id]?.name ?? null;
    const labels = {
      shared: (origin: string) => t("connections.sharedSection", { origin }),
      orphaned: t("connections.orphanedSection"),
    };
    return [
      ...buildRailSections(filteredProfiles, "local", nameOf, labels).map(
        (section) => ({
          ...section,
          label: t("settings.mcp.localSection"),
        }),
      ),
      ...buildRailSections(filteredProfiles, "shared", nameOf, labels),
    ];
  }, [filteredProfiles, originsById, t]);

  const sharedTooltip = (p: ConnectionProfile) => {
    const name = originsById[originIdOf(p) ?? ""]?.name;
    return name
      ? t("connections.sharedBadgeTooltip", { origin: name })
      : t("connections.sharedBadgeTooltipUnknown");
  };

  /**
   * Expose or hide one connection. Optimistic, then resynced from disk on
   * failure — the same shape as `setWritePolicy` below and for the same reason:
   * leaving a tick on screen that never landed would tell the user an AI client
   * can reach a database it cannot (or, worse, the reverse).
   */
  async function toggle(id: string) {
    const next = !selected.has(id);
    setProfiles((prev) =>
      prev.map((p) => (p.id === id ? { ...p, mcp_exposed: next } : p)),
    );
    try {
      await api.setMcpExposed([id], next);
    } catch {
      notify.error(t("settings.mcp.exposureSaveError"));
      void api
        .listProfiles()
        .then(setProfiles)
        .catch(() => {});
    }
  }

  /**
   * Persist one connection's MCP write policy. The sidecar re-reads it from
   * `profiles.json` on its next write attempt, so no client restart is needed.
   * On failure we resync from disk rather than leave optimistic state that never
   * actually landed.
   *
   * Goes through `setMcpWritePolicy` rather than `saveProfile`, even for a single
   * row: `save_profile` replaces the whole record, so it can only be called with
   * a complete profile in hand and silently erases anything the caller forgot to
   * carry over. This writes the one field it means to.
   */
  async function setWritePolicy(id: string, level: McpWritePolicy) {
    if (!profiles.some((p) => p.id === id)) return;
    setProfiles((prev) =>
      prev.map((p) => (p.id === id ? { ...p, mcp_write: level } : p)),
    );
    try {
      await api.setMcpWritePolicy([id], level);
    } catch {
      notify.error(t("settings.mcp.writePolicySaveError"));
      void api.listProfiles().then(setProfiles).catch(() => {});
    }
  }

  /**
   * Set every listed connection's policy in one backend write.
   *
   * "Listed" — scope plus name filter — rather than "selected": the selection
   * here means "expose these over MCP", a different question, and overloading it
   * would make one checkbox mean two things. The button carries the count so
   * what it will touch is never implicit.
   *
   * Runs over shared connections too. That is only honest because
   * `merge_profiles_bundle` preserves the policy across a sync; before it did,
   * this would have appeared to work and reverted on the next pull.
   */
  async function applyBulkPolicy(level: McpWritePolicy) {
    const ids = filteredProfiles.map((p) => p.id);
    if (ids.length === 0) return;
    setApplying(true);
    setBulkError(null);
    try {
      const changed = await api.setMcpWritePolicy(ids, level);
      setProfiles((prev) =>
        prev.map((p) => (ids.includes(p.id) ? { ...p, mcp_write: level } : p)),
      );
      setPendingFull(false);
      notify.success(
        changed > 0
          ? t("settings.mcp.bulkPolicyApplied", { count: changed })
          : t("settings.mcp.bulkPolicyNoop"),
      );
    } catch (e) {
      // Stays in the confirm dialog when there is one, and falls back to a toast
      // for the two levels that have none.
      setBulkError(String(e));
      if (!pendingFull) notify.error(String(e));
    } finally {
      setApplying(false);
    }
  }

  const allFilteredSelected =
    filteredProfiles.length > 0 &&
    filteredProfiles.every((p) => selected.has(p.id));

  /** Expose every id in the list, or hide them if all are already exposed.
   *  Drives both the toolbar button (every filtered profile) and each section
   *  header. One backend write for the batch, like the bulk policy row. */
  async function toggleAll(ids: string[]) {
    if (ids.length === 0) return;
    const next = !ids.every((id) => selected.has(id));
    const set = new Set(ids);
    setProfiles((prev) =>
      prev.map((p) => (set.has(p.id) ? { ...p, mcp_exposed: next } : p)),
    );
    try {
      await api.setMcpExposed(ids, next);
    } catch {
      notify.error(t("settings.mcp.exposureSaveError"));
      void api
        .listProfiles()
        .then(setProfiles)
        .catch(() => {});
    }
  }

  const path = info?.binary_path ?? "";
  // No `--connections` and no uuids: the exposed set is the checkboxes above,
  // read from `profiles.json` on every call. That is what makes the snippet
  // paste-once — adding a connection later is a tick here, not an edit of every
  // client's config followed by a restart of each. (The flag still exists for
  // pinning one client to a fixed subset; `docs/MCP.md` covers it.)
  const cliCommand = path
    ? `claude mcp add huginndb -s user -- ${path}`
    : "";
  const jsonSnippet = path
    ? JSON.stringify(
        { mcpServers: { huginndb: { command: path } } },
        null,
        2,
      )
    : "";

  return (
    <div className="space-y-4 text-sm">
      <p className="text-[12px] text-muted-foreground">
        {t("settings.mcp.intro")}
      </p>

      <div className="rounded-md border border-border bg-card/40 p-3">
        <div className="text-[11px] uppercase tracking-wider text-muted-foreground">
          {t("settings.mcp.binaryLabel")}
        </div>
        <div className="mt-1 flex items-center justify-between gap-2">
          <code className="break-all rounded bg-muted px-1.5 py-0.5 font-mono text-[11px]">
            {path || "—"}
          </code>
          {path && <CopyButton text={path} />}
        </div>
        <div className="mt-2 text-[11px]">
          {info?.available ? (
            <span className="text-emerald-600 dark:text-emerald-400">
              {t("settings.mcp.available")}
            </span>
          ) : (
            <span className="text-amber-600 dark:text-amber-400">
              {t("settings.mcp.unavailable")}
            </span>
          )}
        </div>
      </div>

      <div>
        <div className="mb-1 flex items-center justify-between gap-2">
          <span className="text-[11px] uppercase tracking-wider text-muted-foreground">
            {t("settings.mcp.connectionsLabel")}
          </span>
          {profiles.length > 0 && (
            <span className="text-[11px] text-muted-foreground">
              {t("settings.mcp.selectedCount", {
                selected: selected.size,
                total: profiles.length,
              })}
            </span>
          )}
        </div>

        {profiles.length === 0 ? (
          <p className="text-[12px] text-muted-foreground">
            {t("settings.mcp.noConnections")}
          </p>
        ) : (
          <>
            {hasShared && (
              <Segmented
                size="sm"
                variant="underline"
                className="mb-1.5"
                value={scope}
                onValueChange={setScope}
                options={[
                  {
                    value: "all",
                    label: `${t("settings.mcp.scopeAll")} ${profiles.length}`,
                  },
                  {
                    value: "local",
                    label: `${t("connections.scope.local")} ${
                      profiles.length - shared.length
                    }`,
                  },
                  {
                    value: "shared",
                    label: `${t("connections.scope.shared")} ${shared.length}`,
                  },
                ]}
                aria-label={t("connections.scopeLabel")}
              />
            )}
            <div className="mb-1.5 flex items-center gap-1.5">
              <div className="relative flex-1">
                <Search className="pointer-events-none absolute left-2 top-1/2 h-3 w-3 -translate-y-1/2 text-muted-foreground" />
                <Input
                  inputSize="xs"
                  value={filter}
                  onChange={(e) => setFilter(e.target.value)}
                  placeholder={t("settings.mcp.filterPlaceholder")}
                  className="pl-6 pr-6"
                />
                {filter && (
                  <button
                    type="button"
                    onClick={() => setFilter("")}
                    aria-label={t("common.clear")}
                    className="absolute right-1.5 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                  >
                    <X className="h-3 w-3" />
                  </button>
                )}
              </div>
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="h-7 shrink-0 px-2 text-[11px]"
                disabled={filteredProfiles.length === 0}
                onClick={() => void toggleAll(filteredProfiles.map((p) => p.id))}
              >
                {allFilteredSelected
                  ? t("settings.mcp.deselectAll")
                  : t("settings.mcp.selectAll")}
              </Button>
            </div>

            <div className="max-h-72 overflow-y-auto rounded-md border border-border">
              {filteredProfiles.length === 0 ? (
                <p className="px-3 py-2 text-[12px] text-muted-foreground">
                  {t("settings.mcp.noMatches", { query: filter })}
                </p>
              ) : (
                <McpConnectionTree
                  sections={sections}
                  selected={selected}
                  onToggle={(id) => void toggle(id)}
                  onToggleAll={(ids) => void toggleAll(ids)}
                  onSetPolicy={(id, level) => void setWritePolicy(id, level)}
                  sharedTooltip={sharedTooltip}
                  searching={filter.trim().length > 0}
                />
              )}
            </div>

            {/* Bulk policy. Acts on what is listed, not on what is checked —
                the checkboxes answer "expose this over MCP", which is a
                different question. `full` is the only level that can change
                schema, so it is the only one that asks first. */}
            {filteredProfiles.length > 0 && (
              <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                <span className="text-[11px] text-muted-foreground">
                  {t("settings.mcp.bulkPolicyLabel")}
                </span>
                {WRITE_LEVELS.map((lvl) => (
                  <Button
                    key={lvl}
                    type="button"
                    variant="outline"
                    size="sm"
                    disabled={applying}
                    className="h-6 px-2 text-[11px]"
                    onClick={() =>
                      lvl === "full"
                        ? setPendingFull(true)
                        : void applyBulkPolicy(lvl)
                    }
                  >
                    {t(`settings.mcp.level.${lvl}`)}
                  </Button>
                ))}
                <span className="text-[11px] text-muted-foreground/60">
                  ({filteredProfiles.length})
                </span>
              </div>
            )}
            <p className="mt-1.5 text-[11px] leading-relaxed text-muted-foreground">
              {t("settings.mcp.writePolicyHint")}
            </p>
            <p className="mt-1 text-[11px] leading-relaxed text-muted-foreground">
              {t("settings.mcp.sharedIdsHint")}
            </p>
            {/* The snippet below is valid whether or not anything is ticked, so
                nothing else would tell the user their connector will come up
                unable to reach a single database. */}
            {selected.size === 0 && (
              <p className="mt-1 text-[11px] leading-relaxed text-amber-600 dark:text-amber-500">
                {t("settings.mcp.nothingExposedHint")}
              </p>
            )}
          </>
        )}
      </div>

      <div>
        <div className="mb-1 flex items-center justify-between">
          <span className="text-[11px] uppercase tracking-wider text-muted-foreground">
            {t("settings.mcp.claudeCodeLabel")}
          </span>
          {cliCommand && <CopyButton text={cliCommand} />}
        </div>
        <pre className="overflow-x-auto rounded-md border border-border bg-muted/60 p-2 font-mono text-[11px]">
          {cliCommand || t("settings.mcp.noBinaryHint")}
        </pre>
      </div>

      <div>
        <div className="mb-1 flex items-center justify-between">
          <span className="text-[11px] uppercase tracking-wider text-muted-foreground">
            {t("settings.mcp.jsonLabel")}
          </span>
          {jsonSnippet && <CopyButton text={jsonSnippet} />}
        </div>
        <pre className="overflow-x-auto rounded-md border border-border bg-muted/60 p-2 font-mono text-[11px]">
          {jsonSnippet || t("settings.mcp.noBinaryHint")}
        </pre>
      </div>

      <Button
        type="button"
        variant="link"
        size="sm"
        className="h-auto p-0 text-[12px]"
        onClick={() => {
          useSettingsDialog.getState().setOpen(false);
          useDocsDialog.getState().openTo("mcp");
        }}
      >
        {t("settings.mcp.fullGuide")}
      </Button>

      {pendingFull && (
        <ConfirmDialog
          open
          onOpenChange={(next) => {
            if (!next) {
              setPendingFull(false);
              setBulkError(null);
            }
          }}
          title={t("settings.mcp.bulkPolicyFullTitle", {
            count: filteredProfiles.length,
          })}
          description={t("settings.mcp.bulkPolicyFullBody")}
          confirmLabel={t("settings.mcp.bulkPolicyFullConfirm", {
            count: filteredProfiles.length,
          })}
          confirming={applying}
          error={bulkError}
          onConfirm={() => void applyBulkPolicy("full")}
        />
      )}
    </div>
  );
}
