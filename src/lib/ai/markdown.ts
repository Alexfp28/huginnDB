/**
 * The markdown subset the assistant's prose is rendered with.
 *
 * # Why hand-rolled
 *
 * `marked`, `react-markdown` and friends are each a dependency plus a
 * sanitisation question, and `CLAUDE.md` says to ask before adding one. What is
 * actually needed is small and closed: a model answering a database question
 * emits bold, lists, inline code and the occasional heading. That fits in one
 * pure file with a test per construct, and it renders into the app's own
 * elements rather than into a library's opinion of what a `<p>` looks like.
 *
 * # What is deliberately not supported
 *
 * - **Raw HTML.** Never parsed, never rendered; it arrives as text. Model
 *   output is untrusted input, and an HTML pass is the one construct here that
 *   could turn a wrong answer into a security question.
 * - **Nested lists.** Flat only. A model listing four tables does not nest, and
 *   the indent tracking to support it is most of a real parser.
 * - **Tables.** They would be genuinely useful, and they are also the one
 *   construct that needs a column model; worth adding when a task actually
 *   emits one (phase 5's `DocumentRelation` is the candidate).
 * - **Clickable links.** A link is parsed and its text and target are both
 *   shown, but it is not an anchor. A model-authored URL that opens the
 *   system browser on one click is a decision to take deliberately, not one to
 *   inherit from a markdown renderer.
 *
 * Fenced code blocks are *not* handled here — [`splitBlocks`] in `./parts.ts`
 * takes those out first, because they become Monaco editors rather than text.
 */

/** An inline run. `children` is recursive, so `**bold *and* italic**` works. */
export type Inline =
  | { kind: "text"; text: string }
  | { kind: "strong"; children: Inline[] }
  | { kind: "em"; children: Inline[] }
  | { kind: "strike"; children: Inline[] }
  | { kind: "code"; text: string }
  | { kind: "link"; text: string; href: string };

/** A block of prose. */
export type Block =
  | { kind: "paragraph"; content: Inline[] }
  | { kind: "heading"; level: 1 | 2 | 3; content: Inline[] }
  | { kind: "list"; ordered: boolean; start: number; items: Inline[][] }
  | { kind: "quote"; content: Inline[] }
  | { kind: "rule" };

/**
 * Inline delimiters, **in priority order**.
 *
 * Order decides ties at the same position, which is the whole reason it is a
 * list rather than one alternation: `**bold**` matches `strong` and `em` at
 * index 0, and only priority says which one wins. `code` is first because its
 * content is never re-parsed — a backtick span holding `**` is a literal.
 */
const INLINE: Array<{
  re: RegExp;
  node: (m: RegExpExecArray) => Inline;
}> = [
  { re: /`([^`]+)`/, node: (m) => ({ kind: "code", text: m[1] }) },
  {
    re: /\[([^\]\n]+)\]\((\S+?)\)/,
    node: (m) => ({ kind: "link", text: m[1], href: m[2] }),
  },
  {
    re: /\*\*([^\n]+?)\*\*/,
    node: (m) => ({ kind: "strong", children: parseInline(m[1]) }),
  },
  {
    re: /__([^\n]+?)__/,
    node: (m) => ({ kind: "strong", children: parseInline(m[1]) }),
  },
  {
    re: /~~([^\n]+?)~~/,
    node: (m) => ({ kind: "strike", children: parseInline(m[1]) }),
  },
  {
    re: /\*([^*\n]+?)\*/,
    node: (m) => ({ kind: "em", children: parseInline(m[1]) }),
  },
  // `_` only between word boundaries, or `snake_case_names` — which a database
  // assistant emits constantly — would come back italicised.
  {
    re: /(?:^|(?<=[\s(]))_([^_\n]+?)_(?=[\s.,;:!?)]|$)/,
    node: (m) => ({ kind: "em", children: parseInline(m[1]) }),
  },
];

/** Parse one line (or list item) into inline runs. */
export function parseInline(text: string): Inline[] {
  if (!text) return [];
  let best: { at: number; length: number; node: Inline } | null = null;
  for (const { re, node } of INLINE) {
    const m = re.exec(text);
    if (!m) continue;
    // Strictly earlier wins; a tie keeps the earlier *pattern*, which is what
    // makes `strong` beat `em` on `**bold**`.
    if (best && m.index >= best.at) continue;
    best = { at: m.index, length: m[0].length, node: node(m) };
  }
  if (!best) return [{ kind: "text", text }];
  const out: Inline[] = [];
  if (best.at > 0) out.push({ kind: "text", text: text.slice(0, best.at) });
  out.push(best.node);
  out.push(...parseInline(text.slice(best.at + best.length)));
  return out;
}

const HEADING = /^ {0,3}(#{1,6})\s+(.*)$/;
const BULLET = /^ {0,3}[-*+]\s+(.*)$/;
const ORDERED = /^ {0,3}(\d{1,9})[.)]\s+(.*)$/;
const QUOTE = /^ {0,3}>\s?(.*)$/;
const RULE = /^ {0,3}([-*_])(?:\s*\1){2,}\s*$/;

/**
 * Parse a run of prose into blocks.
 *
 * Consecutive non-blank lines join into one paragraph, which is what makes a
 * model's hard-wrapped sentence read as a sentence rather than as a column.
 * Headings deeper than three collapse to three: the panel is 360px wide and a
 * six-level hierarchy in a chat bubble is decoration.
 */
export function parseProse(text: string): Block[] {
  const blocks: Block[] = [];
  const lines = text.split("\n");
  let paragraph: string[] = [];
  let list: { ordered: boolean; start: number; items: string[] } | null = null;

  const flushParagraph = () => {
    if (paragraph.length === 0) return;
    blocks.push({ kind: "paragraph", content: parseInline(paragraph.join(" ")) });
    paragraph = [];
  };
  const flushList = () => {
    if (!list) return;
    blocks.push({
      kind: "list",
      ordered: list.ordered,
      start: list.start,
      items: list.items.map(parseInline),
    });
    list = null;
  };
  const flush = () => {
    flushParagraph();
    flushList();
  };

  for (const line of lines) {
    if (!line.trim()) {
      flush();
      continue;
    }
    if (RULE.test(line)) {
      flush();
      blocks.push({ kind: "rule" });
      continue;
    }
    const heading = HEADING.exec(line);
    if (heading) {
      flush();
      const level = Math.min(3, heading[1].length) as 1 | 2 | 3;
      blocks.push({ kind: "heading", level, content: parseInline(heading[2]) });
      continue;
    }
    const quote = QUOTE.exec(line);
    if (quote) {
      flush();
      blocks.push({ kind: "quote", content: parseInline(quote[1]) });
      continue;
    }
    const ordered = ORDERED.exec(line);
    if (ordered) {
      flushParagraph();
      if (!list || !list.ordered) {
        flushList();
        list = { ordered: true, start: Number(ordered[1]), items: [] };
      }
      list.items.push(ordered[2]);
      continue;
    }
    const bullet = BULLET.exec(line);
    if (bullet) {
      flushParagraph();
      if (!list || list.ordered) {
        flushList();
        list = { ordered: false, start: 1, items: [] };
      }
      list.items.push(bullet[1]);
      continue;
    }
    // A plain line while a list is open is that item's continuation, which is
    // how a model wraps a long bullet.
    if (list && list.items.length > 0) {
      list.items[list.items.length - 1] += ` ${line.trim()}`;
      continue;
    }
    paragraph.push(line.trim());
  }
  flush();
  return blocks;
}
