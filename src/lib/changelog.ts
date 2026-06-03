/**
 * Changelog access for the in-app "What's new" panel.
 *
 * Both CHANGELOG.md (English, authoritative + complete) and CHANGELOG.es.md
 * (Spanish, maintained for the recent releases) are bundled at build time via
 * Vite's `?raw` import — no network, no HTTP plugin. The Spanish file may lag
 * behind on older versions; `getReleases("es")` therefore keeps the English
 * version list + order and substitutes the Spanish body only where it exists,
 * falling back to English per-version otherwise.
 *
 * The parser is intentionally small: it understands the Keep a Changelog shape
 * this repo uses (`## [x.y.z] — date`, `### Section`, `- bullet` with wrapped
 * continuation lines) and nothing more. Inline `**bold**` is preserved in the
 * item text and rendered by the component.
 */

// The files live at the repo root, one level above `src`.
import enRaw from "../../CHANGELOG.md?raw";
import esRaw from "../../CHANGELOG.es.md?raw";

export interface ChangelogSection {
  /** "Added", "Changed", "Fixed", … */
  heading: string;
  items: string[];
}

export interface ChangelogRelease {
  /** "Unreleased", "1.0.3", "0.1.0-alpha", … */
  version: string;
  /** ISO date string, or null for the Unreleased section / undated entries. */
  date: string | null;
  /** Free-text paragraph(s) under the heading, before the first `###`. */
  intro: string | null;
  sections: ChangelogSection[];
}

const VERSION_RE = /^##\s+\[([^\]]+)\](?:\s+[—–-]\s+(.+))?\s*$/;
const SECTION_RE = /^###\s+(.+?)\s*$/;
const BULLET_RE = /^\s*-\s+(.*)$/;

/** Parse one Keep-a-Changelog document into an ordered list of releases. */
export function parseChangelog(md: string): ChangelogRelease[] {
  const lines = md.split(/\r?\n/);
  const releases: ChangelogRelease[] = [];

  let release: ChangelogRelease | null = null;
  let section: ChangelogSection | null = null;
  let item: string[] | null = null;
  const introLines: string[] = [];

  const flushItem = () => {
    if (item && section) {
      const text = item.join(" ").trim();
      if (text) section.items.push(text);
    }
    item = null;
  };
  const flushIntro = () => {
    if (release && introLines.length) {
      const text = introLines.join("\n").trim();
      if (text) release.intro = text;
    }
    introLines.length = 0;
  };

  for (const line of lines) {
    const versionMatch = VERSION_RE.exec(line);
    if (versionMatch) {
      flushItem();
      flushIntro();
      section = null;
      release = {
        version: versionMatch[1].trim(),
        date: versionMatch[2]?.trim() ?? null,
        intro: null,
        sections: [],
      };
      releases.push(release);
      continue;
    }
    if (!release) continue; // preamble before the first version heading

    const sectionMatch = SECTION_RE.exec(line);
    if (sectionMatch) {
      flushItem();
      flushIntro();
      section = { heading: sectionMatch[1].trim(), items: [] };
      release.sections.push(section);
      continue;
    }

    const bulletMatch = BULLET_RE.exec(line);
    if (bulletMatch && section) {
      flushItem();
      item = [bulletMatch[1]];
      continue;
    }

    if (line.trim() === "") {
      // Blank line ends the current bullet; intro paragraphs keep the break.
      flushItem();
      if (!section && introLines.length) introLines.push("");
      continue;
    }

    // Continuation line: append to the open bullet, or to the intro.
    if (item) {
      item.push(line.trim());
    } else if (!section) {
      introLines.push(line.trim());
    }
  }
  flushItem();
  flushIntro();

  return releases;
}

let enCache: ChangelogRelease[] | null = null;
let esMergedCache: ChangelogRelease[] | null = null;

/**
 * Releases for the given UI language. English returns the file verbatim;
 * Spanish keeps the English version list/order and swaps in the Spanish body
 * per version where the translation exists.
 */
export function getReleases(lang: string): ChangelogRelease[] {
  enCache ??= parseChangelog(enRaw);
  if (lang !== "es") return enCache;

  if (!esMergedCache) {
    const esByVersion = new Map(
      parseChangelog(esRaw).map((r) => [r.version, r]),
    );
    esMergedCache = enCache.map((r) => esByVersion.get(r.version) ?? r);
  }
  return esMergedCache;
}
