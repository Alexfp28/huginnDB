/**
 * Client-side helpers for the aggregation editor's pipeline model.
 *
 * The rule this file lives by: **the frontend never parses a pipeline.** Stage
 * bodies are relaxed JSON with BSON constructors and comments, and exactly one
 * parser for that grammar exists — in Rust (`db/mongo/shell.rs`), reached
 * through `api.formatMongoPipeline`. What is left over here is bookkeeping the
 * UI genuinely owns: stable ids for React keys, which operator a stage *names*
 * (for the card header and the rail), and turning the working model into a
 * snippet the user can paste elsewhere.
 *
 * `operatorOf` is the one place that reads a body, and it deliberately reads
 * only as far as the first key — enough to label a card, never enough to be
 * mistaken for a parser.
 */

import type { PipelineStageInput } from "@/types";
import { snippetFor } from "@/lib/mongo/stages";

/** One stage in the editor's working model. */
export interface PipelineStage {
  /** Stable across reorders and edits — the React key, and what the drag
   *  handler moves. Never derived from the index. */
  id: string;
  body: string;
  /** A disabled stage stays in the document and out of every request. */
  enabled: boolean;
}

let stageSeq = 0;

/** Mint a stage. `operator` seeds the body from the catalogue; omit it for an
 *  empty stage the user fills in. */
export function newStage(operator?: string): PipelineStage {
  stageSeq += 1;
  return {
    id: `stage-${stageSeq}`,
    body: operator ? snippetFor(operator) : "{\n  \n}",
    enabled: true,
  };
}

/** Wrap already-written bodies (a view being opened) as stages. */
export function stagesFromBodies(bodies: string[]): PipelineStage[] {
  return bodies.map((body) => {
    stageSeq += 1;
    return { id: `stage-${stageSeq}`, body, enabled: true };
  });
}

/** The working model in the shape the backend commands take. */
export function toStageInputs(stages: PipelineStage[]): PipelineStageInput[] {
  return stages.map((s) => ({ body: s.body, enabled: s.enabled }));
}

/** Where a stage's first key sits in its source, so it can be read (to label
 *  the card) or replaced (to switch the operator) without touching the body. */
interface KeySpan {
  key: string;
  /** Offsets of the key *including* its quotes, if any. */
  start: number;
  end: number;
}

/**
 * Locate a stage's first key.
 *
 * Scans past whitespace and comments to the opening `{`, then reads one key
 * (bare or quoted). Returns `null` for anything it doesn't recognise, which the
 * UI renders as an unnamed stage rather than guessing; the real error, if there
 * is one, comes back from the backend's parser with a position in it.
 */
function firstKeySpan(body: string): KeySpan | null {
  let i = 0;
  const skip = () => {
    while (i < body.length) {
      const c = body[i];
      if (c === " " || c === "\t" || c === "\n" || c === "\r") {
        i += 1;
      } else if (c === "/" && body[i + 1] === "/") {
        while (i < body.length && body[i] !== "\n") i += 1;
      } else if (c === "/" && body[i + 1] === "*") {
        i += 2;
        while (i < body.length && !(body[i] === "*" && body[i + 1] === "/")) i += 1;
        i += 2;
      } else {
        break;
      }
    }
  };

  skip();
  if (body[i] !== "{") return null;
  i += 1;
  skip();

  const start = i;
  const quote = body[i];
  if (quote === '"' || quote === "'") {
    i += 1;
    let key = "";
    while (i < body.length && body[i] !== quote) {
      if (body[i] === "\\") i += 1;
      key += body[i];
      i += 1;
    }
    if (!key) return null;
    return { key, start, end: i + 1 };
  }

  while (i < body.length && /[A-Za-z0-9_$]/.test(body[i])) i += 1;
  const key = body.slice(start, i);
  return key ? { key, start, end: i } : null;
}

/** The operator a stage names, or `null` when it doesn't name one yet. */
export function operatorOf(body: string): string | null {
  return firstKeySpan(body)?.key ?? null;
}

/**
 * Switch a stage's operator.
 *
 * Two behaviours, because one alone is always wrong somewhere: a body the user
 * hasn't touched (still the catalogue snippet, or empty) is *replaced* with the
 * new operator's snippet — that's the "I picked the wrong stage" case, and
 * keeping a `$match` shape under a `$group` key would be worse than useless.
 * A body with real work in it only has its **key** rewritten, so a mis-click on
 * the picker costs one undo rather than the stage.
 */
export function withOperator(body: string, operator: string): string {
  const span = firstKeySpan(body);
  if (!span) return snippetFor(operator);
  const untouched =
    body.trim() === "" || body.trim() === snippetFor(span.key).trim();
  if (untouched) return snippetFor(operator);
  return body.slice(0, span.start) + operator + body.slice(span.end);
}

/** Formats offered by "Export pipeline". */
export type ExportFormat = "shell" | "json" | "createView";

/**
 * Render the pipeline as a snippet to paste elsewhere.
 *
 * `pipelineText` is the *normalised* array literal the backend produced, so
 * what gets exported is what would actually run — not the user's in-progress
 * text with a disabled stage still in it.
 */
export function exportPipeline(
  format: ExportFormat,
  pipelineText: string,
  source: string,
  viewName?: string,
): string {
  const indented = pipelineText
    .split("\n")
    .map((line, i) => (i === 0 ? line : `  ${line}`))
    .join("\n");
  switch (format) {
    case "shell":
      return `db.getCollection(${JSON.stringify(source)}).aggregate(\n  ${indented}\n)`;
    case "createView":
      return `db.createView(\n  ${JSON.stringify(viewName || "myView")},\n  ${JSON.stringify(
        source,
      )},\n  ${indented}\n)`;
    case "json":
    default:
      return pipelineText;
  }
}
