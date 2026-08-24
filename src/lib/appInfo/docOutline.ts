/**
 * Section outline for the in-app documentation viewer.
 *
 * The bundled `docs/*.md` files are read whole (`lib/appInfo/docs.ts`'s `?raw`
 * imports) and are the only source of truth — nothing here splits, rewrites or
 * duplicates them on disk, so they keep reading identically on GitHub. This
 * module derives the viewer's navigation from that same text at render time:
 * one page per `##`, its `###`s as scroll targets inside it, and everything
 * before the first `##` as the doc's cover.
 *
 * **One scan produces both the outline and the bodies.** They are returned
 * together by [`parseDoc`] rather than by a heading-lister and a separate
 * splitter, because two passes over the same markdown are two chances to
 * disagree about where a section ends — and a disagreement here is not an error,
 * it is a page that silently loses its last paragraph.
 *
 * Slugs follow GitHub's rule so the anchors already written inside the docs
 * (`[Security](#security)`, `#sharing-the-apps-pools`, …) resolve against the
 * same ids {@link Markdown} emits.
 */

/** Opening fence, matching {@link Markdown}'s own regex exactly. */
const FENCE_OPEN = /^\s*```(\w*)\s*$/;
/** Closing fence. A bare ``` matches this *and* `FENCE_OPEN`, as there. */
const FENCE_CLOSE = /^\s*```\s*$/;
const HEADING_RE = /^(#{1,6})\s+(.*)$/;

/**
 * GitHub's heading-slug rule: lowercase, drop everything that is not a letter,
 * number, space, underscore or hyphen, then spaces to hyphens.
 *
 * Accented letters survive (`\p{L}`), which is what keeps the Spanish twins
 * working. Punctuation is *dropped* rather than replaced, which is the part
 * worth getting right: `Sharing the app's pools` is
 * `sharing-the-apps-pools`, not `sharing-the-app-s-pools`.
 */
export function slugify(text: string): string {
  return plainText(text)
    .toLowerCase()
    .replace(/[^\p{L}\p{N} _-]/gu, "")
    .trim()
    .replace(/\s+/g, "-");
}

/**
 * Strip the inline markdown a heading may carry, for a label rendered as plain
 * text (the sidebar, the cover cards) and as slug input.
 *
 * Only *paired* markers are removed, so a `snake_case` identifier keeps its
 * underscores and a lone asterisk is left alone. `MONGODB.md`'s "The query
 * editor speaks `mongosh`, in a bounded dialect" is the one heading in the
 * shipped docs that needs this.
 */
export function plainText(text: string): string {
  return text
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/\*([^*]+)\*/g, "$1");
}

/** A `###` inside a section: a scroll target, never a page of its own. */
export interface DocSubsection {
  slug: string;
  /** Heading text with inline markers stripped, ready to render as a label. */
  title: string;
}

/** A `##` section — one page in the viewer. */
export interface DocSection {
  slug: string;
  title: string;
  /** The section's raw markdown, its own `##` heading line included. */
  body: string;
  subs: DocSubsection[];
}

export interface ParsedDoc {
  /**
   * Everything before the first `##`: the `#` title and the introductory prose.
   * Rendered as the doc's cover, above the grid of section cards.
   */
  cover: string;
  sections: DocSection[];
}

/**
 * Split a doc into its cover and its `##` sections.
 *
 * Fenced code is skipped, which is not a nicety: `docs/MCP.md` has shell
 * comments at lines 49 and 164 (`# binary at: …`, `# optional:
 * startup_timeout_sec = 20`) that a bare `^#` scan reads as headings and turns
 * into phantom sections — and the section they appear in would lose everything
 * after them.
 */
export function parseDoc(md: string): ParsedDoc {
  const lines = md.replace(/\r\n/g, "\n").split("\n");
  const cover: string[] = [];
  const sections: DocSection[] = [];
  let current: DocSection | null = null;
  let currentLines: string[] = [];
  // `##` slugs are unique across the doc because they are routing keys; `###`
  // slugs are deduplicated per section, which is the scope `Markdown` sees when
  // it renders that one body — so the ids it emits match what we computed.
  const sectionSlugs = new Set<string>();
  let inFence = false;

  const push = (line: string) => {
    if (current) currentLines.push(line);
    else cover.push(line);
  };
  const closeSection = () => {
    if (current) {
      current.body = currentLines.join("\n").replace(/\s+$/, "");
      sections.push(current);
    }
  };

  for (const line of lines) {
    if (inFence) {
      if (FENCE_CLOSE.test(line)) inFence = false;
      push(line);
      continue;
    }
    if (FENCE_OPEN.test(line)) {
      inFence = true;
      push(line);
      continue;
    }

    const heading = HEADING_RE.exec(line);
    const level = heading ? heading[1].length : 0;

    if (level === 2) {
      closeSection();
      const title = plainText(heading![2]);
      current = {
        slug: unique(slugify(heading![2]), sectionSlugs),
        title,
        body: "",
        subs: [],
      };
      currentLines = [line];
      continue;
    }

    // A `###` before any `##` belongs to the cover; no shipped doc does that,
    // but it must not become an orphan navigation entry either.
    if (level === 3 && current) {
      const subSlugs = new Set(current.subs.map((s) => s.slug));
      current.subs.push({
        slug: unique(slugify(heading![2]), subSlugs),
        title: plainText(heading![2]),
      });
    }
    push(line);
  }
  closeSection();

  return { cover: cover.join("\n").replace(/\s+$/, ""), sections };
}

/** GitHub's collision rule: append `-1`, `-2`, … to a slug already taken. */
function unique(slug: string, taken: Set<string>): string {
  let candidate = slug;
  let n = 0;
  while (taken.has(candidate)) candidate = `${slug}-${++n}`;
  taken.add(candidate);
  return candidate;
}

/**
 * Which page holds `slug`, and whether it needs scrolling once there.
 *
 * `null` when nothing in the doc matches — an anchor pointing at a heading that
 * was renamed, which the caller renders as inert rather than navigating
 * somewhere arbitrary.
 */
export function locate(
  doc: ParsedDoc,
  slug: string,
): { section: string | null; anchor: string | null } | null {
  for (const section of doc.sections) {
    if (section.slug === slug) return { section: slug, anchor: null };
    if (section.subs.some((s) => s.slug === slug)) {
      return { section: section.slug, anchor: slug };
    }
  }
  // The `#` title, or any heading in the introductory prose.
  return slug === slugify(firstHeading(doc.cover) ?? "")
    ? { section: null, anchor: null }
    : null;
}

function firstHeading(md: string): string | null {
  for (const line of md.split("\n")) {
    const m = HEADING_RE.exec(line);
    if (m) return m[2];
  }
  return null;
}
