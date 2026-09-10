/**
 * One tool call the assistant made, and its result once it arrives.
 *
 * **This is the trust feature, in miniature.** The roadmap says it of the
 * Console emission in agent mode and it is just as true here: a user who can
 * see which tool ran, with which arguments, and how much came back will believe
 * the metadata-only guarantee; one who cannot, will not. So the card names the
 * tool and shows the arguments verbatim, and its badge reports a *row count* —
 * "42 rows", or "20 of 41,892" when the reply carried the table's real total,
 * because a sample read as a population is a specific way for an answer to be
 * wrong.
 *
 * **Expanded, it also shows what came back.** The Console deliberately never
 * logs a payload — it is a log, and row data written into it would undo the
 * guarantee it exists to make checkable — but this card is the opposite case.
 * The rows are already on this machine, the user asked for them, and the model
 * is about to summarise them, sometimes wrongly, because a model this size
 * hallucinates. Putting the evidence one click under the claim is the
 * difference between trusting an answer and checking it. See
 * `lib/ai/toolResult.ts` for the shaping.
 *
 * Renders as soon as the call exists, with the result folded in when it lands.
 * A card that waited for the result would leave a slow query looking like a
 * hung assistant — which is exactly when someone wants to know what it is
 * doing.
 */

import { useState } from "react";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import {
  ChevronDown,
  ChevronRight,
  SquareArrowOutUpRight,
  TriangleAlert,
  Wrench,
} from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { IconButton } from "@/components/ui/icon-button";
import { cn, formatNumber } from "@/lib/utils";
import type { MessagePart } from "@/lib/ai/parts";
import { asTable, previewJson, statementOf } from "@/lib/ai/toolResult";
import { openQueryTab } from "@/lib/tabs/openQueryTab";

type ToolCall = Extract<MessagePart, { type: "toolCall" }>;
type ToolResult = Extract<MessagePart, { type: "toolResult" }>;

/**
 * A one-line summary for the card's badge.
 *
 * When the reply carried the table's real row count — `browse_table` asks for
 * it — the badge says "20 of 41,892" rather than "20 rows". The distinction is
 * the one a model gets wrong: a sample read as a population is how "the table
 * holds three kinds of record" gets said about the first twenty.
 */
function summarise(result: unknown, t: TFunction): string {
  if (result === null || result === undefined) return t("ai.tool.noResult");
  if (Array.isArray(result)) return t("ai.tool.rowCount", { count: result.length });
  if (typeof result === "object") {
    const rows = (result as { rows?: unknown }).rows;
    if (Array.isArray(rows)) {
      const total = (result as { total?: unknown }).total;
      if (typeof total === "number" && total > rows.length) {
        return t("ai.tool.rowsOfTotal", {
          shown: rows.length,
          // `formatNumber`, not `toLocaleString`: the separators follow the
          // language the user picked in Settings, not the machine's locale.
          total: formatNumber(total),
        });
      }
      const truncated = (result as { truncated?: boolean }).truncated === true;
      const label = t("ai.tool.rowCount", { count: rows.length });
      return truncated ? `${label} ${t("ai.tool.truncated")}` : label;
    }
    return t("ai.tool.objectResult");
  }
  return String(result);
}

export function ToolCallCard({
  call,
  result,
  defaultOpen,
  connectionId,
}: {
  call: ToolCall;
  result?: ToolResult;
  defaultOpen: boolean;
  /** The conversation's connection, for the open-in-editor action. */
  connectionId?: string | null;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(defaultOpen);
  const failed = !!result?.error;
  const args = JSON.stringify(call.args ?? {}, null, 2);
  const statement = statementOf(call.name, call.args);

  return (
    <div
      className={cn(
        "overflow-hidden rounded-md border text-2xs",
        failed ? "border-destructive/40 bg-destructive/5" : "border-border bg-muted/20",
      )}
    >
      <div className="flex items-center">
        {/* `Button variant="ghost"` rather than a bare `<button>`: the hover
            alpha, the focus ring and the disabled treatment are decided once in
            `ui/`, and `uiAdoption.test.ts` counts every new raw one. The
            overrides are the density this card needs (`h-auto`, a 2xs label),
            which the shared sizes do not carry. */}
        <Button
          variant="ghost"
          size="sm"
          onClick={() => setOpen((v) => !v)}
          className="h-auto w-full justify-start gap-1.5 rounded-none px-2 py-1 text-2xs font-normal"
          aria-expanded={open}
        >
          {open ? (
            <ChevronDown className="h-3 w-3 shrink-0 text-muted-foreground" />
          ) : (
            <ChevronRight className="h-3 w-3 shrink-0 text-muted-foreground" />
          )}
          {failed ? (
            <TriangleAlert className="h-3 w-3 shrink-0 text-destructive" />
          ) : (
            <Wrench className="h-3 w-3 shrink-0 text-muted-foreground" />
          )}
          <span className="truncate font-mono">{call.name}</span>
          <span className="ml-auto shrink-0">
            {result ? (
              <Badge tone={failed ? "destructive" : "neutral"} size="xs" mono>
                {failed ? t("ai.tool.refused") : summarise(result.result, t)}
              </Badge>
            ) : (
              <Badge tone="warning" size="xs">
                {t("ai.tool.running")}
              </Badge>
            )}
          </span>
        </Button>
        {/* Outside the toggle, because a button cannot nest inside a button.
            Only for the tool that carries free text: `browse_table`'s page is
            a gesture the schema tree already offers, and inventing a SELECT
            for it here would hand the user a statement the assistant never
            ran. */}
        {statement && connectionId && (
          <IconButton
            icon={SquareArrowOutUpRight}
            label={t("ai.openInEditor")}
            size="xs"
            tone="quiet"
            className="mr-1 shrink-0"
            onClick={() => openQueryTab(connectionId, { sql: statement })}
          />
        )}
      </div>
      {open && (
        <div className="space-y-1 border-t border-border/60 px-2 py-1.5">
          <div>
            <span className="text-muted-foreground">{t("ai.tool.arguments")}</span>
            <pre className="mt-0.5 overflow-x-auto font-mono leading-relaxed">
              {args}
            </pre>
          </div>
          {result?.error && (
            <div>
              <span className="text-muted-foreground">{t("ai.tool.error")}</span>
              <p className="mt-0.5 whitespace-pre-wrap break-words text-destructive">
                {result.error}
              </p>
            </div>
          )}
          {result && !result.error && (
            <div>
              <span className="text-muted-foreground">{t("ai.tool.result")}</span>
              <ResultView result={result.result} />
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * What came back, so the answer above it can be checked rather than trusted.
 *
 * A row-shaped reply renders as a table and everything else as JSON — the
 * shaping is pure and tested in `lib/ai/toolResult.ts`. Both scroll inside
 * their own box: this panel is 360px wide and a wide result must not be what
 * decides its width.
 */
function ResultView({ result }: { result: unknown }) {
  const { t } = useTranslation();
  const table = asTable(result);
  if (!table) {
    return (
      <pre className="mt-0.5 max-h-64 overflow-auto font-mono leading-relaxed">
        {previewJson(result)}
      </pre>
    );
  }
  if (table.rows.length === 0) {
    return <p className="mt-0.5 text-muted-foreground">{t("ai.tool.noRows")}</p>;
  }
  return (
    <div className="mt-0.5 max-h-64 overflow-auto rounded border border-border/60">
      <table className="w-full border-collapse font-mono">
        <thead className="sticky top-0 bg-muted/60">
          <tr>
            {table.columns.map((column) => (
              <th
                key={column}
                className="border-b border-border/60 px-1 py-0.5 text-left font-normal text-muted-foreground"
              >
                {column}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {table.rows.map((row, i) => (
            <tr key={i} className="odd:bg-muted/20">
              {row.map((cell, j) => (
                <td
                  key={j}
                  className="max-w-[16rem] whitespace-pre-wrap break-words border-b border-border/30 px-1 py-0.5 align-top"
                >
                  {cell}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
