/**
 * The pipeline rail: every stage as a chip, in order, above the editor.
 *
 * It is a navigator — click a chip, jump to that card — but the reason it earns
 * a permanent row is the number on each chip: **how many documents that stage
 * emitted** in the sampled preview. Read left to right, the rail is where a
 * pipeline's data dies. The `$match` that empties everything downstream, the
 * `$unwind` that multiplies 10 documents into 400 — both are one glance here
 * and several clicks anywhere else.
 *
 * The number is honest about being a sample: `10+` means the preview limit was
 * reached and the real output is larger, a bare `4` means the stage really did
 * emit four. Zero is the case worth flagging, so it takes the `warning` accent;
 * an errored stage takes `destructive`; a disabled one drops out of the flow
 * with a dashed edge, since it contributes nothing to what the next chip shows.
 */

import { useTranslation } from "react-i18next";
import { Plus } from "lucide-react";
import { IconButton } from "@/components/ui/icon-button";
import { operatorOf, type PipelineStage } from "@/lib/mongo/pipeline";
import { cn } from "@/lib/utils";
import type { StagePreview } from "@/types";

interface Props {
  stages: PipelineStage[];
  /** Keyed by stage id, not index — see `AggregationTab`'s note on why. */
  previews: Map<string, StagePreview>;
  onSelect: (index: number) => void;
  onAdd: () => void;
}

export function StageRail({ stages, previews, onSelect, onAdd }: Props) {
  const { t } = useTranslation();

  if (stages.length === 0) return null;

  return (
    <div className="flex items-center gap-1 overflow-x-auto border-b border-border px-2 py-1.5">
      {stages.map((stage, i) => {
        const preview = previews.get(stage.id);
        const operator =
          operatorOf(stage.body) ?? t("aggregation.rail.unnamed");
        const rows = preview?.result?.rows.length;
        const empty = preview?.result != null && rows === 0;
        const errored = !!preview?.error;

        return (
          <div key={stage.id} className="flex shrink-0 items-center">
            {i > 0 && (
              <span className="mx-0.5 h-px w-2 bg-border" aria-hidden />
            )}
            <button
              onClick={() => onSelect(i)}
              title={t("aggregation.rail.goTo", { index: i + 1 })}
              className={cn(
                "rounded-md border px-2 py-0.5 font-mono text-[11px] transition-colors",
                "hover:border-brand/50 hover:bg-brand/10",
                !stage.enabled &&
                  "border-dashed text-muted-foreground opacity-60",
                stage.enabled &&
                  errored &&
                  "border-destructive/50 bg-destructive/10 text-destructive",
                stage.enabled &&
                  !errored &&
                  empty &&
                  "border-warning/50 bg-warning/10 text-warning",
                stage.enabled &&
                  !errored &&
                  !empty &&
                  "border-border bg-muted/40",
              )}
            >
              {operator}
              {stage.enabled && rows != null && (
                <span className="ml-1.5 opacity-70">
                  {rows}
                  {preview?.truncated ? "+" : ""}
                </span>
              )}
            </button>
          </div>
        );
      })}
      <IconButton
        size="xs"
        icon={Plus}
        tone="brand"
        label={t("aggregation.addStage")}
        className="ml-1 shrink-0 border border-dashed border-border hover:border-brand/50"
        onClick={onAdd}
      />
    </div>
  );
}
