/**
 * The accumulator catalogue offered inside `$group`/`$bucket`/`$bucketAuto`'s
 * output fields (and `$setWindowFields`'s), by the Mongo completion provider
 * (`monacoMongo.ts`) — the one thing an ordinary expression operator list
 * can't answer correctly.
 *
 * An accumulator is never valid bare: `count: $sum: 1` isn't legal syntax,
 * only `count: { $sum: 1 }` is — the operator always sits wrapped in its own
 * object. Sitting `$sum` in the same flat, bare-inserting list as `$concat`
 * (which only makes sense once the caller has already typed the wrapping
 * `{`) reproduces exactly the gap reported against `$group`: picking `$sum`
 * inserted the name and nothing else. So each entry here is a snippet for the
 * *whole* wrapped object, offered only when `monacoMongo.ts` detects the
 * cursor is defining an output field's value inside one of those stages.
 *
 * Same escaping rule as `stages.ts`: a literal `$` (the operator key, or a
 * `"$field"` reference) is written `\$` so Monaco's snippet parser doesn't
 * mistake it for an unresolvable variable reference and silently drop it.
 */

export interface AccumulatorSpec {
  operator: string;
  /** Monaco snippet syntax for the whole `{ $operator: expr }` object. */
  insertSnippet: string;
}

export const ACCUMULATOR_CATALOG: AccumulatorSpec[] = [
  { operator: "$sum", insertSnippet: "{ \\$sum: ${1:1} }" },
  { operator: "$avg", insertSnippet: '{ \\$avg: "\\$${1:field}" }' },
  { operator: "$first", insertSnippet: '{ \\$first: "\\$${1:field}" }' },
  { operator: "$last", insertSnippet: '{ \\$last: "\\$${1:field}" }' },
  { operator: "$max", insertSnippet: '{ \\$max: "\\$${1:field}" }' },
  { operator: "$min", insertSnippet: '{ \\$min: "\\$${1:field}" }' },
  { operator: "$push", insertSnippet: '{ \\$push: "\\$${1:field}" }' },
  { operator: "$addToSet", insertSnippet: '{ \\$addToSet: "\\$${1:field}" }' },
  { operator: "$mergeObjects", insertSnippet: '{ \\$mergeObjects: "\\$${1:field}" }' },
  { operator: "$stdDevPop", insertSnippet: '{ \\$stdDevPop: "\\$${1:field}" }' },
  { operator: "$stdDevSamp", insertSnippet: '{ \\$stdDevSamp: "\\$${1:field}" }' },
];
