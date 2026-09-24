/**
 * Policy panel — read-only. When an organization manages HuginnDB, an
 * administrator installs a policy (HKLM registry, or `managed-policy.json` in
 * the system policy folder) that decides what the AI may reach on each
 * connection, per role. This panel answers "who decided that, and what does it
 * say for me?": where the policy was read from, which account and role this
 * is, and what each connection allows. Nothing here edits the policy — it
 * lives where a standard user cannot write, on purpose.
 *
 * Phase 1 applies the policy to the AI only (`docs/POLICY_ROADMAP.md`); what
 * people may do is shown for reference and labelled as such.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { ChevronDown, ChevronRight, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { SearchField } from "@/components/ui/search-field";
import { Segmented } from "@/components/ui/segmented";
import { TreeRow } from "@/components/ui/tree-row";
import { api } from "@/lib/tauri";
import { cn } from "@/lib/utils";
import type { ConnectionPolicy, PolicyStatus, RulePolicy } from "@/types";

export function PolicySection() {
  const { t } = useTranslation();
  const [status, setStatus] = useState<PolicyStatus | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    api
      .policyStatus()
      .then((s) => {
        setStatus(s);
        setError(null);
      })
      .catch((e) => setError(String(e)));
  }, []);

  useEffect(load, [load]);

  return (
    <div className="space-y-4 text-sm">
      <div className="flex items-start justify-between gap-3">
        <p className="text-[12px] leading-relaxed text-muted-foreground">
          {t("settings.policy.intro")}
        </p>
        <Button variant="outline" size="sm" onClick={load}>
          <RefreshCw className="mr-1.5 h-3.5 w-3.5" />
          {t("settings.policy.refresh")}
        </Button>
      </div>

      {error && (
        <p className="text-2xs text-destructive">
          {t("settings.policy.loadFailed", { error })}
        </p>
      )}

      {status && <Summary status={status} />}

      {status?.state === "active" && <ConnectionList status={status} />}
    </div>
  );
}

function Summary({ status }: { status: PolicyStatus }) {
  const { t } = useTranslation();
  const hint = {
    unmanaged: "settings.policy.unmanagedHint",
    pending: "settings.policy.pendingHint",
    broken: "settings.policy.brokenHint",
    active: null,
  }[status.state];

  return (
    <div className="space-y-2">
      <div className="divide-y divide-border/60 rounded-md border border-border">
        <Field label={t("settings.policy.stateLabel")}>
          <span
            className={cn(
              "rounded-sm px-1.5 py-0.5 text-2xs font-medium",
              status.state === "active" && "bg-brand/15 text-brand",
              status.state === "broken" && "bg-destructive/15 text-destructive",
              status.state === "pending" && "bg-warning/15 text-warning",
              status.state === "unmanaged" && "bg-muted text-muted-foreground",
            )}
          >
            {t(`settings.policy.state.${status.state}`)}
          </span>
        </Field>
        {status.source && (
          <Field label={t("settings.policy.source")}>
            <code className="break-all rounded-sm bg-muted px-1.5 py-0.5 font-mono text-2xs">
              {status.source}
            </code>
          </Field>
        )}
        <Field label={t("settings.policy.user")}>
          <code className="rounded-sm bg-muted px-1.5 py-0.5 font-mono text-2xs">
            {status.user || "?"}
          </code>
        </Field>
        {status.role && (
          <Field label={t("settings.policy.role")}>
            <span className="font-medium">{status.role}</span>
          </Field>
        )}
        {status.unmanagedConnections && (
          <Field label={t("settings.policy.unmanagedConnections")}>
            <span className="text-xs">
              {t(
                status.unmanagedConnections === "allow"
                  ? "settings.policy.unmanagedAllow"
                  : "settings.policy.unmanagedDeny",
              )}
            </span>
          </Field>
        )}
      </div>

      {hint && (
        <p
          className={cn(
            "text-2xs leading-relaxed",
            status.state === "broken"
              ? "text-destructive"
              : "text-muted-foreground",
          )}
        >
          {t(hint)}
        </p>
      )}
      {status.error && (
        <p className="break-words font-mono text-2xs text-destructive">
          {status.error}
        </p>
      )}
      {status.warnings.length > 0 && (
        <div>
          <div className="mb-0.5 text-2xs uppercase tracking-wider text-warning">
            {t("settings.policy.warnings")}
          </div>
          <ul className="list-disc space-y-0.5 pl-4 text-2xs text-warning">
            {status.warnings.map((w) => (
              <li key={w}>{w}</li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex items-center justify-between gap-4 px-3 py-2">
      <span className="shrink-0 text-xs text-muted-foreground">{label}</span>
      <span className="min-w-0 text-right">{children}</span>
    </div>
  );
}

type Filter = "managed" | "unmatched" | "all";

/**
 * The per-connection half. A user with twenty-odd saved connections under a
 * policy that names three of them used to get twenty-odd full-height blocks
 * to scroll past; now the list opens on the connections a rule names, each
 * one line until expanded, with a name filter and the unnamed ones one click
 * away.
 */
function ConnectionList({ status }: { status: PolicyStatus }) {
  const { t } = useTranslation();
  const managedCount = status.connections.filter((c) => !c.unmatched).length;
  const unmatchedCount = status.connections.length - managedCount;
  // Open on what the policy says something about; fall back to everything
  // when it names none of this user's connections, so the list is never
  // empty for a reason the user cannot see.
  const [filter, setFilter] = useState<Filter>(
    managedCount > 0 ? "managed" : "all",
  );
  const [query, setQuery] = useState("");

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return status.connections.filter(
      (c) =>
        (filter === "all" ||
          (filter === "managed" ? !c.unmatched : c.unmatched)) &&
        (q === "" || c.name.toLowerCase().includes(q)),
    );
  }, [status.connections, filter, query]);

  return (
    <div>
      <div className="mb-1 flex items-baseline justify-between gap-3">
        <div className="text-2xs uppercase tracking-wider text-muted-foreground">
          {t("settings.policy.connections")}
        </div>
        <div className="text-2xs text-muted-foreground">
          {t("settings.policy.connectionCounts", {
            total: status.connections.length,
            managed: managedCount,
            unmatched: unmatchedCount,
          })}
        </div>
      </div>

      {status.connections.length === 0 ? (
        <p className="text-2xs text-muted-foreground">
          {t("settings.policy.noConnections")}
        </p>
      ) : (
        <>
          <div className="mb-2 flex items-center gap-2">
            <SearchField
              size="sm"
              className="flex-1"
              value={query}
              onValueChange={setQuery}
              onClear={() => setQuery("")}
              clearLabel={t("settings.policy.clearSearch")}
              placeholder={t("settings.policy.searchPlaceholder")}
              aria-label={t("settings.policy.searchPlaceholder")}
            />
            <Segmented<Filter>
              size="sm"
              value={filter}
              onValueChange={setFilter}
              aria-label={t("settings.policy.filterLabel")}
              options={[
                {
                  value: "managed",
                  label: t("settings.policy.filterManaged", {
                    count: managedCount,
                  }),
                },
                {
                  value: "unmatched",
                  label: t("settings.policy.filterUnmatched", {
                    count: unmatchedCount,
                  }),
                },
                { value: "all", label: t("settings.policy.filterAll") },
              ]}
            />
          </div>
          {visible.length === 0 ? (
            <p className="text-2xs text-muted-foreground">
              {t("settings.policy.noMatches")}
            </p>
          ) : (
            <div className="divide-y divide-border/60 rounded-md border border-border">
              {visible.map((c) => (
                <ConnectionRow
                  key={c.id}
                  connection={c}
                  unmanaged={status.unmanagedConnections}
                />
              ))}
            </div>
          )}
        </>
      )}
      <p className="mt-1 text-2xs text-muted-foreground">
        {t("settings.policy.humanGuardrail")}
      </p>
    </div>
  );
}

function ConnectionRow({
  connection,
  unmanaged,
}: {
  connection: ConnectionPolicy;
  unmanaged: PolicyStatus["unmanagedConnections"];
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);

  if (connection.unmatched) {
    return (
      <div className="flex items-center justify-between gap-3 px-3 py-1.5">
        <span className="min-w-0 truncate text-xs">{connection.name}</span>
        <span
          className={cn(
            "shrink-0 text-2xs",
            unmanaged === "allow" ? "text-muted-foreground" : "text-destructive",
          )}
        >
          {t(
            unmanaged === "allow"
              ? "settings.policy.unmatchedAllowShort"
              : "settings.policy.unmatchedDenyShort",
          )}
        </span>
      </div>
    );
  }

  // One line: what people and the AI get across the connection's rules, and
  // whether any of them leaves free SQL on. The detail is one click away.
  const humanPerms = [...new Set(connection.rules.flatMap((r) => r.human))];
  const aiPerms = [...new Set(connection.rules.flatMap((r) => r.ai))];
  const freeSql = connection.rules.some((r) => r.freeSql);
  const Chevron = open ? ChevronDown : ChevronRight;

  return (
    <div>
      <TreeRow
        className="gap-2 px-3"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        <Chevron className="h-3 w-3 shrink-0 text-muted-foreground" />
        <span className="min-w-0 flex-1 truncate text-left text-xs font-medium">
          {connection.name}
        </span>
        <span className="shrink-0 text-2xs text-muted-foreground">
          {t("settings.policy.rowSummary", {
            human:
              humanPerms.length > 0
                ? humanPerms.join(", ")
                : t("settings.policy.nothing"),
            ai:
              aiPerms.length > 0
                ? aiPerms.join(", ")
                : t("settings.policy.nothing"),
            freeSql: t(
              freeSql
                ? "settings.policy.freeSqlShortOn"
                : "settings.policy.freeSqlShortOff",
            ),
          })}
        </span>
      </TreeRow>
      {open && (
        <div className="space-y-1.5 px-3 pb-2">
          {connection.rules.map((rule, i) => (
            <RuleBlock key={i} rule={rule} />
          ))}
        </div>
      )}
    </div>
  );
}

function RuleBlock({ rule }: { rule: RulePolicy }) {
  const { t } = useTranslation();
  const list = (items: string[] | null, all: string) =>
    items === null ? all : items.join(", ");
  const perms = (items: string[]) =>
    items.length === 0 ? t("settings.policy.nothing") : items.join(", ");

  return (
    <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 rounded-sm bg-muted/40 px-2 py-1.5 text-2xs">
      <dt className="text-muted-foreground">
        {t("settings.policy.databases")}
      </dt>
      <dd className="font-mono">
        {list(rule.databases, t("settings.policy.all"))}
      </dd>
      <dt className="text-muted-foreground">
        {t("settings.policy.relations")}
      </dt>
      <dd className="font-mono">
        {list(rule.allow, t("settings.policy.all"))}
      </dd>
      {rule.deny.length > 0 && (
        <>
          <dt className="text-muted-foreground">{t("settings.policy.never")}</dt>
          <dd className="font-mono">{rule.deny.join(", ")}</dd>
        </>
      )}
      <dt className="text-muted-foreground">{t("settings.policy.ai")}</dt>
      <dd className="font-medium">{perms(rule.ai)}</dd>
      <dt className="text-muted-foreground">{t("settings.policy.human")}</dt>
      <dd>{perms(rule.human)}</dd>
      <dt className="text-muted-foreground">{t("settings.policy.freeSql")}</dt>
      <dd>
        {t(
          rule.freeSql
            ? "settings.policy.freeSqlOn"
            : "settings.policy.freeSqlOff",
        )}
      </dd>
    </dl>
  );
}
