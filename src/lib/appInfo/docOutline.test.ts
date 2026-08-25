import { describe, expect, it } from "vitest";
import { DOCS, getDocBody } from "./docs";
import { locate, parseDoc, plainText, slugify } from "./docOutline";

describe("slugify", () => {
  it("matches the anchors already written in the shipped docs", () => {
    // These three are load-bearing: the same function generates the heading
    // ids and resolves the `#href`s, so if it drifts, links that work on
    // GitHub break in the app and vice versa.
    expect(slugify("Sharing the app's pools")).toBe("sharing-the-apps-pools");
    expect(slugify("When the client blocks the call, not the connector")).toBe(
      "when-the-client-blocks-the-call-not-the-connector",
    );
    expect(slugify("Compartir los pools de la app")).toBe(
      "compartir-los-pools-de-la-app",
    );
  });

  it("drops punctuation rather than replacing it", () => {
    // `app's` → `apps`, not `app-s`. GitHub's rule, and the reason the anchor
    // above has no double hyphen.
    expect(slugify("MongoDB: targeting a database")).toBe(
      "mongodb-targeting-a-database",
    );
    expect(slugify("Why is my rule not applying?")).toBe(
      "why-is-my-rule-not-applying",
    );
    // An existing hyphen survives.
    expect(slugify("Command-line flags")).toBe("command-line-flags");
  });

  it("keeps accented letters, so the Spanish twins resolve", () => {
    expect(slugify("Huella de conexiones")).toBe("huella-de-conexiones");
    expect(slugify("Configuración avanzada")).toBe("configuración-avanzada");
  });

  it("strips the inline markdown a heading may carry", () => {
    // `MONGODB.md`'s one marked-up heading.
    expect(slugify("The query editor speaks `mongosh`, in a bounded dialect")).toBe(
      "the-query-editor-speaks-mongosh-in-a-bounded-dialect",
    );
  });
});

describe("plainText", () => {
  it("unwraps paired markers only", () => {
    expect(plainText("speaks `mongosh`, loudly")).toBe("speaks mongosh, loudly");
    expect(plainText("**done** and *pending*")).toBe("done and pending");
    expect(plainText("see [the guide](MCP.md)")).toBe("see the guide");
  });

  it("leaves a snake_case identifier alone", () => {
    // An underscore pair would be italics in prose; in a heading it is far more
    // likely part of an identifier, and mangling it would mangle the slug too.
    expect(plainText("the pk_column argument")).toBe("the pk_column argument");
  });
});

describe("parseDoc", () => {
  it("puts everything before the first ## in the cover", () => {
    const doc = parseDoc(
      ["# Title", "", "Intro prose.", "", "## First", "", "Body."].join("\n"),
    );
    expect(doc.cover).toBe("# Title\n\nIntro prose.");
    expect(doc.sections).toHaveLength(1);
    expect(doc.sections[0].title).toBe("First");
    expect(doc.sections[0].body).toBe("## First\n\nBody.");
  });

  it("does not read a shell comment inside a fence as a heading", () => {
    // Regression for docs/MCP.md:49 and :164 — `# binary at: …` and
    // `# optional: startup_timeout_sec = 20` live inside fenced blocks. Read as
    // headings they become phantom sections, *and* the section they sit in
    // loses everything after them.
    const doc = parseDoc(
      [
        "# Title",
        "",
        "## Getting the binary",
        "",
        "```bash",
        "cargo build -p huginndb-mcp --release",
        "# binary at: src-tauri/target/release/huginndb-mcp",
        "```",
        "",
        "Trailing prose that must not be lost.",
        "",
        "## Next",
      ].join("\n"),
    );
    expect(doc.sections.map((s) => s.title)).toEqual([
      "Getting the binary",
      "Next",
    ]);
    expect(doc.sections[0].body).toContain("Trailing prose that must not be lost.");
  });

  it("treats a bare closing fence as closing, not opening", () => {
    const doc = parseDoc(
      ["# T", "", "## S", "```", "## not a heading", "```", "## Real"].join("\n"),
    );
    expect(doc.sections.map((s) => s.title)).toEqual(["S", "Real"]);
  });

  it("hangs each ### off the right ##", () => {
    const doc = parseDoc(
      [
        "# T",
        "",
        "## Configuring a client",
        "### Claude Code (CLI)",
        "### Claude Desktop",
        "## Command-line flags",
        "## Connection footprint",
        "### Sharing the app's pools",
      ].join("\n"),
    );
    expect(doc.sections.map((s) => [s.title, s.subs.map((x) => x.title)])).toEqual([
      ["Configuring a client", ["Claude Code (CLI)", "Claude Desktop"]],
      ["Command-line flags", []],
      ["Connection footprint", ["Sharing the app's pools"]],
    ]);
  });

  it("disambiguates repeated headings the way GitHub does", () => {
    const doc = parseDoc(
      ["# T", "## Notes", "### Detail", "### Detail", "## Notes"].join("\n"),
    );
    expect(doc.sections.map((s) => s.slug)).toEqual(["notes", "notes-1"]);
    expect(doc.sections[0].subs.map((s) => s.slug)).toEqual(["detail", "detail-1"]);
  });

  it("ignores levels deeper than ###", () => {
    const doc = parseDoc(["# T", "## S", "#### Deep"].join("\n"));
    expect(doc.sections[0].subs).toEqual([]);
    expect(doc.sections[0].body).toContain("#### Deep");
  });
});

describe("locate", () => {
  const doc = parseDoc(
    ["# T", "Intro", "## Security", "### When the client blocks"].join("\n"),
  );

  it("finds a section, and a subsection with its scroll target", () => {
    expect(locate(doc, "security")).toEqual({
      section: "security",
      anchor: null,
    });
    expect(locate(doc, "when-the-client-blocks")).toEqual({
      section: "security",
      anchor: "when-the-client-blocks",
    });
  });

  it("resolves the doc title to the cover", () => {
    expect(locate(doc, "t")).toEqual({ section: null, anchor: null });
  });

  it("returns null for a heading that no longer exists", () => {
    // A renamed heading leaves the link inert rather than navigating somewhere
    // arbitrary.
    expect(locate(doc, "gone")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// The real corpus
// ---------------------------------------------------------------------------

const LANGS = ["en", "es"] as const;
const CORPUS = DOCS.flatMap((doc) =>
  LANGS.map((lang) => ({ doc, lang, body: getDocBody(doc, lang) })),
);

describe("the shipped docs", () => {
  it.each(CORPUS)("$doc.id/$lang splits into sections losing nothing", ({ body }) => {
    const parsed = parseDoc(body);
    expect(parsed.sections.length).toBeGreaterThan(0);
    // Round-trip: the cover plus every section body is the whole document
    // again. Compared line by line with blank lines dropped — each body has its
    // trailing whitespace trimmed, so blank-line runs between sections cannot
    // survive, but every line that carries content must. A looser comparison
    // (collapsing all whitespace) would not notice a lost line at all.
    //
    // `\r` goes on both sides because `parseDoc` normalises and this must
    // compare like with like. Without it the suite passed on CI and failed on a
    // Windows checkout — where `core.autocrlf` hands the `?raw` import CRLF —
    // which is the worst way for a test to fail: on the reviewer's machine only.
    // `.gitattributes` now pins the markdown to LF, so this is belt and braces.
    const content = (md: string) =>
      md
        .replace(/\r\n/g, "\n")
        .split("\n")
        .filter((l) => l.trim() !== "");
    expect(
      content([parsed.cover, ...parsed.sections.map((s) => s.body)].join("\n")),
    ).toEqual(content(body));
  });

  it.each(CORPUS)("$doc.id/$lang parses identically from CRLF", ({ body }) => {
    // The contract the round-trip above leans on, asserted rather than assumed:
    // line endings are the checkout's business, never the outline's. A slug
    // carrying a stray `\r` would break every anchor in the document, and
    // silently — a link that goes nowhere is not an error.
    const lf = body.replace(/\r\n/g, "\n");
    expect(parseDoc(lf.replace(/\n/g, "\r\n"))).toEqual(parseDoc(lf));
  });

  it.each(CORPUS)("$doc.id/$lang has unique section slugs", ({ body }) => {
    const slugs = parseDoc(body).sections.map((s) => s.slug);
    expect(new Set(slugs).size).toBe(slugs.length);
  });

  it.each(CORPUS)("$doc.id/$lang resolves every one of its own anchors", ({ body }) => {
    // The high-value invariant. Eight `](#…)` links are written across the
    // shipped docs; before the viewer gained anchor resolution they were inert,
    // so nothing noticed when a heading was renamed out from under one. Now a
    // rename that orphans a link fails here.
    const parsed = parseDoc(body);
    const anchors = [...body.matchAll(/\]\(#([^)]+)\)/g)].map((m) => m[1]);
    const broken = anchors.filter((slug) => locate(parsed, slug) === null);
    expect(broken).toEqual([]);
  });

  it("actually has anchors to check, so the invariant above is not vacuous", () => {
    // If the docs ever stop using `](#…)` links this test fails and someone
    // decides deliberately whether the invariant still has a subject, rather
    // than it quietly passing on an empty set forever.
    const total = CORPUS.reduce(
      (n, { body }) => n + [...body.matchAll(/\]\(#([^)]+)\)/g)].length,
      0,
    );
    expect(total).toBeGreaterThanOrEqual(10);
  });

  it.each(DOCS)("$id keeps the same section structure in both languages", (doc) => {
    // A translation that drops or adds a `##` would make the two sidebars
    // disagree, and a Spanish reader would lose a page.
    const en = parseDoc(getDocBody(doc, "en"));
    const es = parseDoc(getDocBody(doc, "es"));
    expect(es.sections.map((s) => s.subs.length)).toEqual(
      en.sections.map((s) => s.subs.length),
    );
  });
});
