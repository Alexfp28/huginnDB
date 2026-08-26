/**
 * Match a table/view name against the tree's filter box. HeidiSQL-style: the
 * filter may hold several `;`-separated patterns and a name matches when it
 * contains ANY of them (OR), so `users; orders` surfaces both tables at once.
 * An empty filter (or one that's only separators/whitespace) matches all.
 *
 * **Parsing is separated from matching on purpose.** `matchesFilter` splits,
 * trims and lowercases the needle on every call, which is once per table per
 * render — on a server with tens of thousands of tables that split is the
 * dominant cost of a keystroke, not the `includes` it exists to feed. The tree
 * therefore parses once, in `useTreeSearch.commit`, and passes the resulting
 * `patterns` array down; `matchesFilter` stays for the handful of one-off call
 * sites (and for the tests that pin the semantics).
 */

/** Split a raw filter string into the lowercased patterns it stands for. */
export function parsePatterns(filter: string): string[] {
  return filter
    .split(";")
    .map((p) => p.trim().toLowerCase())
    .filter(Boolean);
}

/**
 * Does `name` match any of `patterns`? An empty list matches everything, which
 * is what makes "no filter" and "a filter of only separators" the same thing.
 *
 * Substring, case-insensitive, no globbing and no accent folding — see
 * `matchesFilter.test.ts`, which pins each of those so a future `*` or a
 * `localeCompare`-style normalisation is a decision rather than an accident.
 */
export function matchesPatterns(name: string, patterns: string[]): boolean {
  if (patterns.length === 0) return true;
  const n = name.toLowerCase();
  return patterns.some((p) => n.includes(p));
}

/** `matchesPatterns` over a raw, unparsed filter string. */
export function matchesFilter(name: string, filter: string): boolean {
  return matchesPatterns(name, parsePatterns(filter));
}
