/**
 * Scoring matcher for the command palette (Ctrl/Cmd+K).
 *
 * The palette used to filter with a bare `includes()` over a concatenated
 * haystack, which was fine for ~20 commands and useless past a few hundred:
 * every match ranked identically, so "prefs" surfaced whatever the build order
 * happened to put first rather than "Open preferences". This adds ranking and,
 * just as importantly, the match *ranges* so the row can bold the characters
 * the user actually typed.
 *
 * Deliberately hand-rolled rather than pulling in `fzf`/`fuse.js`: the input
 * sets are small (a few thousand entries at worst, filtered on every keystroke
 * of a modal that is open for a second or two), the repo keeps a small audited
 * dependency tree, and the ranking rules we care about are domain-specific
 * (prefix > word-start > substring > subsequence, with a length tiebreak so
 * `users` beats `users_audit_log`).
 */

/** Inclusive-start / exclusive-end character range inside the matched text. */
export type MatchRange = [number, number];

export interface FuzzyResult {
  /** Higher is better. Only comparable between results for the same needle. */
  score: number;
  /** Ranges of `haystack` that matched, ascending and non-overlapping. */
  ranges: MatchRange[];
}

/** Characters that start a new "word" for boundary bonuses. */
const BOUNDARY = new Set([" ", ".", "_", "-", "/", ":", "·", "(", "[", ",", "→"]);

function isBoundaryStart(hay: string, index: number): boolean {
  if (index === 0) return true;
  const prev = hay[index - 1]!;
  if (BOUNDARY.has(prev)) return true;
  // camelCase / PascalCase transition (`wordWrap` → the `W`).
  return prev === prev.toLowerCase() && hay[index] !== hay[index]!.toLowerCase();
}

/**
 * Match a single whitespace-free token. Returns `null` when the token isn't
 * present even as a subsequence.
 *
 * Tiers, highest first: a prefix match, a word-start substring, any substring,
 * then a scattered subsequence. Within a tier, earlier and denser matches win,
 * and a shorter haystack breaks the remaining ties (see the module note).
 */
function matchToken(token: string, hay: string, hayLower: string): FuzzyResult | null {
  if (!token) return { score: 0, ranges: [] };

  const at = hayLower.indexOf(token);
  if (at !== -1) {
    const end = at + token.length;
    const base = at === 0 ? 1000 : isBoundaryStart(hay, at) ? 820 : 620;
    return {
      score: base - Math.min(at, 40) - hay.length * 0.1,
      ranges: [[at, end]],
    };
  }

  // Subsequence fallback: every needle char must appear in order.
  //
  // Runs are rewarded super-linearly (`8 * runLength` per extra char) because
  // that is what separates a real abbreviation from coincidence — "prefs" hits
  // `pref` as one run inside "Open preferences" but only `pr` inside "Profile
  // refresh", and a flat per-char bonus rates those nearly the same.
  //
  // A single left-to-right greedy pass isn't enough on its own: it takes the
  // *first* occurrence of the first character, so "prefs" would anchor on the
  // `p` of "Open" and then have to scatter the rest. Rather than a full
  // alignment DP, we run the greedy pass once per plausible anchor (each
  // word-start occurrence of the first character, plus the leftmost one) and
  // keep the best. Labels here are short, so this stays a handful of passes.
  const scanFrom = (start: number): FuzzyResult | null => {
    const ranges: MatchRange[] = [];
    let score = 260;
    let cursor = start;
    let prevIndex = -1;
    let runLength = 0;
    for (const ch of token) {
      const found = hayLower.indexOf(ch, cursor);
      if (found === -1) return null;
      // `ranges.length` guards the first character: `prevIndex` starts at -1,
      // so a match at index 0 would otherwise look like a continuation of a run
      // that doesn't exist yet and extend a range that isn't there.
      if (ranges.length > 0 && found === prevIndex + 1) {
        runLength += 1;
        score += 8 * runLength;
        ranges[ranges.length - 1]![1] = found + 1;
      } else {
        runLength = 1;
        score -= Math.min(found - cursor, 12); // gap penalty, bounded
        ranges.push([found, found + 1]);
        // Landing on a word start is meaningful; landing mid-word is not.
        if (isBoundaryStart(hay, found)) score += ranges.length === 1 ? 30 : 10;
      }
      prevIndex = found;
      cursor = found + 1;
    }
    return { score: Math.max(score, 40) - hay.length * 0.1, ranges };
  };

  const anchors: number[] = [];
  const first = token[0]!;
  for (let i = hayLower.indexOf(first); i !== -1; i = hayLower.indexOf(first, i + 1)) {
    if (anchors.length === 0 || isBoundaryStart(hay, i)) anchors.push(i);
    if (anchors.length >= 8) break;
  }

  let best: FuzzyResult | null = null;
  for (const anchor of anchors) {
    const hit = scanFrom(anchor);
    if (hit && (!best || hit.score > best.score)) best = hit;
  }
  return best;
}

/** Merge ascending-but-possibly-overlapping ranges into a clean list. */
function mergeRanges(ranges: MatchRange[]): MatchRange[] {
  if (ranges.length < 2) return ranges;
  const sorted = [...ranges].sort((a, b) => a[0] - b[0]);
  const out: MatchRange[] = [sorted[0]!];
  for (const [start, end] of sorted.slice(1)) {
    const last = out[out.length - 1]!;
    if (start <= last[1]) last[1] = Math.max(last[1], end);
    else out.push([start, end]);
  }
  return out;
}

/**
 * Score `needle` against `haystack`. Whitespace splits the needle into tokens
 * that may match in any order but must *all* match — so "wrap editor" finds
 * "Editor: soft-wrap long lines" the same way "editor wrap" does.
 */
export function fuzzyMatch(needle: string, haystack: string): FuzzyResult | null {
  const tokens = needle.toLowerCase().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return { score: 0, ranges: [] };
  const hayLower = haystack.toLowerCase();

  let total = 0;
  const ranges: MatchRange[] = [];
  for (const token of tokens) {
    const hit = matchToken(token, haystack, hayLower);
    if (!hit) return null;
    total += hit.score;
    ranges.push(...hit.ranges);
  }
  return { score: total / tokens.length, ranges: mergeRanges(ranges) };
}

/**
 * Best match across a primary text (whose ranges are reported, for
 * highlighting) and any number of secondary haystacks (keywords, the group
 * name, a subtitle — matched at a discount so a keyword hit never outranks a
 * real label hit).
 */
export function fuzzyMatchFields(
  needle: string,
  primary: string,
  secondary: string[] = [],
): FuzzyResult | null {
  const direct = fuzzyMatch(needle, primary);
  if (direct) return direct;
  let best = 0;
  for (const field of secondary) {
    const hit = field ? fuzzyMatch(needle, field) : null;
    if (hit) best = Math.max(best, hit.score * 0.45);
  }
  return best > 0 ? { score: best, ranges: [] } : null;
}

/** Split `text` into alternating plain / highlighted chunks for rendering. */
export function highlightChunks(
  text: string,
  ranges: MatchRange[],
): { text: string; match: boolean }[] {
  if (ranges.length === 0) return [{ text, match: false }];
  const out: { text: string; match: boolean }[] = [];
  let cursor = 0;
  for (const [start, end] of ranges) {
    if (start > cursor) out.push({ text: text.slice(cursor, start), match: false });
    out.push({ text: text.slice(start, end), match: true });
    cursor = end;
  }
  if (cursor < text.length) out.push({ text: text.slice(cursor), match: false });
  return out;
}
