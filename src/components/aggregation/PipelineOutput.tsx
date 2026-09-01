/**
 * The documents side of the aggregation editor — one shared surface used by
 * every preview on the tab: each stage card's own output, and the whole
 * pipeline's output in text mode.
 *
 * It is deliberately the **same** `DocumentListView` the data grid uses in list
 * mode, mounted read-only (no `onFieldSave`/`onFieldDelete`, which is what
 * switches that component out of document-editing mode). A pipeline's output is
 * computed, not stored: there is no `_id` to write back through, so offering an
 * edit affordance here would be a lie. Reusing the component still buys the
 * folding, the type gutter and the per-field copy for free, and means a
 * pipeline result reads exactly like a collection does one tab over.
 */

import { useTranslation } from "react-i18next";
import { Spinner } from "@/components/ui/spinner";
import { DocumentListView } from "@/components/grid/DocumentListView";
import {
  usePreferences,
  selectGridPrefs,
} from "@/stores/preferences/preferences";
import { cn } from "@/lib/utils";
import type { QueryResult } from "@/types";

interface Props {
  result: QueryResult | null;
  loading?: boolean;
  error?: string | null;
  /** Shown when there is no result yet and nothing is running. */
  emptyLabel: string;
  /** The sample hit the preview limit — the real output is larger. */
  truncated?: boolean;
  className?: string;
}

export function PipelineOutput({
  result,
  loading,
  error,
  emptyLabel,
  truncated,
  className,
}: Props) {
  const { t } = useTranslation();
  const grid = usePreferences(selectGridPrefs);

  if (error) {
    return (
      <div
        className={cn(
          "h-full overflow-auto bg-destructive/5 p-3 font-mono text-[11px] leading-relaxed text-destructive",
          className,
        )}
      >
        {error}
      </div>
    );
  }

  if (!result) {
    return (
      <div
        className={cn(
          "flex h-full items-center justify-center gap-2 p-4 text-xs text-muted-foreground",
          className,
        )}
      >
        {loading && <Spinner size="sm" />}
        {loading ? t("aggregation.running") : emptyLabel}
      </div>
    );
  }

  return (
    <div className={cn("relative flex h-full min-h-0 flex-col", className)}>
      {/* A running refresh dims the stale documents instead of unmounting
          them: a preview that blanks on every keystroke is unreadable. */}
      <div
        className={cn(
          "min-h-0 flex-1 overflow-auto transition-opacity",
          loading && "opacity-50",
        )}
      >
        <DocumentListView
          columns={result.columns}
          rows={result.rows}
          rowTypes={result.row_types}
          nullDisplay={grid.nullDisplay}
          zebraStripes={grid.zebraStripes}
          // Same derivation the data grid uses for its cells, so a preview and
          // a collection read at the same size under the grid "zoom" pref.
          fontSize={Math.min(
            22,
            Math.max(10, Math.round(grid.rowHeight * 0.46)),
          )}
          expandNested={grid.listExpandNested}
          showTypes={grid.listShowTypes}
          lineNumbers={grid.listLineNumbers}
          copyToClipboard={(text) => void navigator.clipboard.writeText(text)}
          emptyLabel={t("aggregation.noDocuments")}
        />
      </div>
      {truncated && (
        <div className="border-t border-border px-3 py-1 text-[10px] uppercase tracking-wider text-muted-foreground">
          {t("aggregation.sampleTruncated", { count: result.rows.length })}
        </div>
      )}
    </div>
  );
}
