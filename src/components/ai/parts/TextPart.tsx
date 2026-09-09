/**
 * One text part: prose runs, with fenced code rendered as a block.
 *
 * The split itself is pure and tested (`lib/ai/parts.ts`'s `splitBlocks`); this
 * component only chooses a renderer per run: fenced code becomes a `SqlBlock`
 * (a real Monaco, with a lens onto the query editor), and prose goes through
 * `Prose`, which renders the small markdown subset in `lib/ai/markdown.ts`.
 *
 * Prose started out as plain `whitespace-pre-wrap` text, on the argument that
 * the only construct worth rendering was the code fence. That was wrong in
 * practice and the first real answer showed it: models write `**bold**`
 * headings and numbered lists constantly, and unrendered they arrive as a wall
 * of asterisks and digits. The subset is closed and hand-rolled rather than a
 * dependency — see `markdown.ts` for what it deliberately leaves out.
 */

import {
  fenceLanguage,
  isRunnable,
  splitBlocks,
  stripReasoning,
  type TextBlock,
} from "@/lib/ai/parts";
import { Prose } from "./Prose";
import { SqlBlock } from "./SqlBlock";

export function TextPart({
  text,
  connectionId,
}: {
  text: string;
  connectionId: string | null;
}) {
  // Stripped before splitting, not after: an unterminated `<think>` would
  // otherwise be read as prose and, worse, a ````` inside the reasoning
  // would open a code block that swallowed the real answer.
  const blocks = splitBlocks(stripReasoning(text));
  return (
    <>
      {blocks.map((block, i) => (
        <Block key={i} block={block} connectionId={connectionId} />
      ))}
    </>
  );
}

function Block({
  block,
  connectionId,
}: {
  block: TextBlock;
  connectionId: string | null;
}) {
  if (block.kind === "prose") {
    return <Prose text={block.text} />;
  }
  const language = fenceLanguage(block.lang);
  if (!language) {
    // A fence in a language this app cannot run — a shell snippet, a diff.
    // Shown as preformatted text rather than dropped: the model said it for a
    // reason, and a Monaco with no lens and no colouring would only be a
    // heavier `<pre>`.
    return (
      <pre className="overflow-x-auto rounded-md border border-border bg-muted/20 px-2 py-1.5 font-mono text-2xs leading-relaxed">
        {block.code}
      </pre>
    );
  }
  return (
    <SqlBlock
      code={block.code}
      language={language}
      connectionId={connectionId}
      runnable={isRunnable(block)}
    />
  );
}
