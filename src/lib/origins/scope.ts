/**
 * The consumption scope of a shared origin (#171) — which slices of a
 * published document this machine actually pulls.
 *
 * Pure, and deliberately the *only* place that answers two questions:
 *
 * 1. **What does an absent `scope` mean?** All three slices, because the field
 *    describes what an origin was already pulling before it existed. Getting
 *    this wrong in even one call site silently narrows a registered origin, and
 *    the next sync then reports the user's environments as vanished. Every
 *    read goes through `originScope`; nothing reads `origin.scope` directly.
 * 2. **Which combinations deserve a warning?** None are forbidden — each is
 *    legitimate for somebody — but two of them produce something that looks
 *    broken unless it was explained beforehand.
 */

import type { Origin, OriginPeek, OriginScope } from "@/types";

/** Every slice on: the default, and what an origin with no stored scope does. */
export const FULL_SCOPE: OriginScope = {
  connections: true,
  environments: true,
  schemas: true,
};

/**
 * The scope an origin is actually pulling with.
 *
 * `undefined` is not "nothing" — it is an origin registered before the field
 * existed, which the backend deserialises as [`FULL_SCOPE`]. The two must agree
 * or the UI shows a state the sync does not implement.
 */
export function originScope(origin: Pick<Origin, "scope">): OriginScope {
  return origin.scope ?? FULL_SCOPE;
}

/** Is this origin pulling everything its file publishes? */
export function isFullScope(scope: OriginScope): boolean {
  return scope.connections && scope.environments && scope.schemas;
}

/** Nothing at all — a registration that exists but will never do anything. */
export function isEmptyScope(scope: OriginScope): boolean {
  return !scope.connections && !scope.environments && !scope.schemas;
}

/**
 * Which slices a file of this `kind` can contribute at all.
 *
 * A plain profile bundle (`kind` `"profiles"`, or `""` for a file predating the
 * discriminant) carries no environments and no schemas, so offering
 * subscriptions to them is offering a subscription to nothing. `undefined`
 * (the file has not been read yet) means "assume it could carry anything"
 * rather than greying out choices on a guess.
 */
export function slicesAvailable(peek?: OriginPeek | null): OriginScope {
  if (!peek) return FULL_SCOPE;
  const environmentKind = peek.kind === "environment";
  return {
    connections: true,
    environments: environmentKind,
    schemas: environmentKind,
  };
}

/** An i18n key naming something the user should know before saving. */
export type ScopeWarning =
  | "origins.scope.warnEmpty"
  | "origins.scope.warnEnvironmentsWithoutConnections"
  | "origins.scope.warnSchemasWithoutConnections";

/**
 * What to say about a scope, without refusing it.
 *
 * Each of these is a combination somebody legitimately wants — a publisher
 * consuming their own document already has the profiles locally, so pulling
 * only environments is correct for them — which is why none of them is
 * validation. They are warnings because the *result* is indistinguishable from
 * a bug when it arrives unannounced:
 *
 * - environments without connections mirror with a membership list naming ids
 *   this machine does not have, so the environment reads as empty;
 * - schemas without connections land every binding `enabled: false`, because a
 *   binding naming an unknown connection is disabled by design
 *   (`docs/JSON_SCHEMAS.md`);
 * - nothing at all is a registration that will never do anything, which is
 *   worth a word before it is saved rather than a mystery four hours later.
 *
 * `peek` narrows the first two: a file that publishes no environments cannot
 * produce an empty one, so warning about it would be noise.
 */
export function scopeWarnings(
  scope: OriginScope,
  peek?: OriginPeek | null,
): ScopeWarning[] {
  if (isEmptyScope(scope)) return ["origins.scope.warnEmpty"];
  const warnings: ScopeWarning[] = [];
  if (scope.connections) return warnings;
  // Only when the file actually carries the slice. Unknown (no peek yet) counts
  // as "it might", since the warning is cheap and a silently empty environment
  // is not.
  if (scope.environments && (!peek || peek.environments > 0)) {
    warnings.push("origins.scope.warnEnvironmentsWithoutConnections");
  }
  if (scope.schemas && (!peek || peek.bindings > 0)) {
    warnings.push("origins.scope.warnSchemasWithoutConnections");
  }
  return warnings;
}
