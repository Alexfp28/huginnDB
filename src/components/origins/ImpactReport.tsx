/**
 * What publishing this draft does to everyone pulling from the origin.
 *
 * Rendered in two places on purpose — the Publish pane, live on a debounce, and
 * inside the confirmation dialog — because a preview the user has to remember
 * from a different screen is a preview they will not read. Everything shown here
 * is computed in Rust (`origin_doc::publish_impact`) against the file as it
 * stands on disk; nothing is derived a second time in TypeScript.
 *
 * The one row that justifies the whole feature is `silentlyDropped`. Past the
 * suspicion threshold in `commands::origins`, a consumer's sync decides the read
 * is broken and clears its own `vanished` list — so a file missing half the
 * roster leaves every consumer with phantom connections and *no notice at all*.
 * There is no other surface in the product where that is discoverable.
 */

import { useTranslation } from "react-i18next";
import {
  AlertTriangle,
  Info,
  KeyRound,
  Minus,
  Plus,
  RefreshCw,
} from "lucide-react";

import { cn } from "@/lib/utils";
import { MICRO_HEADING } from "@/components/ui/styles";
import type { OriginEntityImpact, OriginPublishImpact } from "@/types";

function Row({
  icon: Icon,
  tone = "default",
  children,
}: {
  icon: typeof Plus;
  tone?: "default" | "warning" | "destructive";
  children: React.ReactNode;
}) {
  const toneClass =
    tone === "warning"
      ? "text-amber-600 dark:text-amber-500"
      : tone === "destructive"
        ? "text-destructive"
        : "text-muted-foreground";
  return (
    <div className={cn("flex items-start gap-2 text-2xs", toneClass)}>
      <Icon className="mt-0.5 h-3 w-3 shrink-0" />
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  );
}

/** At most a handful of names, then "+N more": a preview that scrolls is a
 *  preview that gets skimmed. */
function names(entities: { id: string; name: string }[], limit = 6): string {
  const shown = entities.slice(0, limit).map((e) => e.name || e.id);
  const rest = entities.length - shown.length;
  return rest > 0 ? `${shown.join(", ")} +${rest}` : shown.join(", ");
}

function EntitySummary({
  impact,
  labels,
}: {
  impact: OriginEntityImpact;
  labels: {
    added: string;
    refreshed: string;
    vanished: string;
    silent: string;
  };
}) {
  const quiet =
    impact.added.length === 0 &&
    impact.refreshed.length === 0 &&
    impact.vanished.length === 0;
  if (quiet) return null;
  return (
    <div className="space-y-1">
      {impact.added.length > 0 && (
        <Row icon={Plus}>
          {labels.added} · {names(impact.added)}
        </Row>
      )}
      {impact.refreshed.length > 0 && (
        <Row icon={RefreshCw}>
          {labels.refreshed} · {names(impact.refreshed)}
        </Row>
      )}
      {impact.vanished.length > 0 && (
        <Row icon={Minus} tone="destructive">
          {labels.vanished} · {names(impact.vanished)}
        </Row>
      )}
      {impact.silentlyDropped && (
        <Row icon={AlertTriangle} tone="destructive">
          {labels.silent}
        </Row>
      )}
    </div>
  );
}

export function ImpactReport({ impact }: { impact: OriginPublishImpact }) {
  const { t } = useTranslation();
  const nothing =
    impact.connections.added.length === 0 &&
    impact.connections.refreshed.length === 0 &&
    impact.connections.vanished.length === 0 &&
    impact.environments.added.length === 0 &&
    impact.environments.refreshed.length === 0 &&
    impact.environments.vanished.length === 0;

  return (
    <div className="space-y-3">
      <div className="space-y-1">
        <h4 className={MICRO_HEADING}>
          {t("originEditor.impact.forConsumers")}
        </h4>
        {nothing ? (
          <Row icon={Info}>{t("originEditor.impact.nothing")}</Row>
        ) : (
          <>
            <EntitySummary
              impact={impact.connections}
              labels={{
                added: t("originEditor.impact.connectionsAdded", {
                  count: impact.connections.added.length,
                }),
                refreshed: t("originEditor.impact.connectionsRefreshed", {
                  count: impact.connections.refreshed.length,
                }),
                vanished: t("originEditor.impact.connectionsVanished", {
                  count: impact.connections.vanished.length,
                }),
                silent: t("originEditor.impact.silent"),
              }}
            />
            <EntitySummary
              impact={impact.environments}
              labels={{
                added: t("originEditor.impact.environmentsAdded", {
                  count: impact.environments.added.length,
                }),
                refreshed: t("originEditor.impact.environmentsRefreshed", {
                  count: impact.environments.refreshed.length,
                }),
                vanished: t("originEditor.impact.environmentsVanished", {
                  count: impact.environments.vanished.length,
                }),
                silent: t("originEditor.impact.environmentsSilent"),
              }}
            />
          </>
        )}
      </div>

      <div className="space-y-1">
        <h4 className={MICRO_HEADING}>{t("originEditor.impact.cost")}</h4>
        <Row
          icon={KeyRound}
          tone={impact.reencryption.slots > 0 ? "warning" : "default"}
        >
          {impact.reencryption.slots === 0
            ? t("originEditor.impact.noReencryption")
            : t("originEditor.impact.reencryption", {
                count: impact.reencryption.slots,
                rounds: impact.reencryption.pbkdf2Rounds.toLocaleString(),
              })}
          {impact.reencryption.estimated && (
            <> {t("originEditor.impact.estimated")}</>
          )}
        </Row>
        {impact.withoutPassword.length > 0 && (
          <Row icon={AlertTriangle} tone="warning">
            {t("originEditor.impact.withoutPassword", {
              count: impact.withoutPassword.length,
            })}{" "}
            · {names(impact.withoutPassword)}
          </Row>
        )}
        {impact.bindingsUnresolvable > 0 && (
          <Row icon={AlertTriangle} tone="warning">
            {t("originEditor.impact.bindingsDisabled", {
              count: impact.bindingsUnresolvable,
            })}
          </Row>
        )}
        {impact.membership.unassigned.length > 0 && (
          <Row icon={Info}>
            {t("originEditor.impact.unassigned", {
              count: impact.membership.unassigned.length,
            })}
          </Row>
        )}
        {impact.membership.dangling.length > 0 && (
          <Row icon={Info} tone="warning">
            {t("originEditor.impact.dangling", {
              count: impact.membership.dangling.length,
            })}
          </Row>
        )}
      </div>

      <div className="space-y-1">
        <h4 className={MICRO_HEADING}>
          {t("originEditor.impact.freshMachine")}
        </h4>
        <Row icon={Info}>
          {t("originEditor.impact.freshSummary", {
            connections: impact.freshMachine.connections,
            environments: impact.freshMachine.environments,
            schemas: impact.freshMachine.schemas,
          })}
        </Row>
      </div>
    </div>
  );
}
