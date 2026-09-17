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

import { useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { ChevronsDownUp, ChevronsUpDown } from "lucide-react";
import { Spinner } from "@/components/ui/spinner";
import { IconButton } from "@/components/ui/icon-button";
import {
  DocumentListView,
  type ExpandAllSignal,
} from "@/components/grid/DocumentListView";
import {
  usePreferences,
  selectGridPrefs,
} from "@/stores/preferences/preferences";
import { cn } from "@/lib/utils";
import { copyToClipboard } from "@/lib/clipboard";
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
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const grid = usePreferences(selectGridPrefs);

  /**
   * "Unfold every nested object", the same gesture the data grid offers in its
   * footer — held here rather than received as a prop because this surface has
   * no grid around it to own the state. See `ExpandAllSignal` for why the press
   * is an epoch and not a boolean.
   */
  const [expandAll, setExpandAll] = useState<ExpandAllSignal | null>(null);
  function expandAllDocuments(expanded: boolean) {
    setExpandAll((prev) => ({ epoch: (prev?.epoch ?? 0) + 1, expanded }));
  }

  /**
   * Whether anything in the sample nests at all — a `$group` that projects four
   * scalars has nothing to unfold, and a control that cannot do anything is
   * worse than no control.
   *
   * Only the first few documents are inspected: this runs on every preview
   * refresh (a keystroke in the stage body, debounced) and the answer is a
   * yes/no about shape, which a sample settles as well as a scan. A pipeline
   * whose 40th document is the first to carry a sub-document loses the button,
   * which is the cheaper of the two mistakes available here.
   */
  const hasNested = useMemo(() => {
    const rows = result?.rows;
    if (!rows) return false;
    return rows
      .slice(0, 20)
      .some((row) =>
        row.some((v) => v !== null && typeof v === "object"),
      );
  }, [result]);

  if (error) {
    return (
      <div
        className={cn(
          "h-full overflow-auto bg-destructive/5 p-3 font-mono text-2xs leading-relaxed text-destructive",
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
    <div
      className={cn(
        "group/preview relative flex h-full min-h-0 flex-col",
        className,
      )}
    >
      {/* A running refresh dims the stale documents instead of unmounting
          them: a preview that blanks on every keystroke is unreadable. */}
      {/* Floated over the documents rather than given a bar of its own: this
          surface is also a stage card's right-hand pane, where a permanent
          strip would cost preview rows that are the whole point of the pane.
          Revealed on hover for the same reason the cards' own row actions are,
          and anchored clear of the scrollbar. */}
      {hasNested && (
        <div className="absolute right-3 top-1 z-10 flex items-center gap-0.5 rounded-md bg-background/80 opacity-0 backdrop-blur-sm transition-opacity group-hover/preview:opacity-100 focus-within:opacity-100">
          <IconButton
            size="xs"
            icon={ChevronsUpDown}
            label={t("dataGrid.list.expandAllDocuments")}
            onClick={() => expandAllDocuments(true)}
          />
          <IconButton
            size="xs"
            icon={ChevronsDownUp}
            label={t("dataGrid.list.collapseAllDocuments")}
            onClick={() => expandAllDocuments(false)}
          />
        </div>
      )}
      <div
        // The list windows its cards against this element, so it needs a
        // handle on it — see `DocumentListView`'s virtualizer note.
        ref={scrollRef}
        className={cn(
          "min-h-0 flex-1 overflow-auto transition-opacity",
          loading && "opacity-50",
        )}
      >
        <DocumentListView
          scrollRef={scrollRef}
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
          expandAll={expandAll}
          showTypes={grid.listShowTypes}
          lineNumbers={grid.listLineNumbers}
          copyToClipboard={(text) => void copyToClipboard(text)}
          emptyLabel={t("aggregation.noDocuments")}
        />
      </div>
      {truncated && (
        <div className="border-t border-border px-3 py-1 text-3xs uppercase tracking-wider text-muted-foreground">
          {t("aggregation.sampleTruncated", { count: result.rows.length })}
        </div>
      )}
    </div>
  );
}
