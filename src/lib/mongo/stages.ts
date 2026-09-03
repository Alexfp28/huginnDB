/**
 * The aggregation stage catalogue the editor's stage picker offers.
 *
 * Three things live here and nothing else: the operator name, the *snippet*
 * inserted when it is picked from the stage-card header's `Select` (plain
 * text, no tabstops — that path replaces the whole body in one shot, there is
 * no snippet-mode cursor to drive), and the *insertSnippet* offered by the
 * Monaco completion provider (`monacoMongo.ts`) when the operator is typed
 * inline — a Monaco snippet fragment (tabstop syntax, literal `$` escaped)
 * inserted right after the stage body's own `{`, which is why it never
 * repeats that opening brace or the operator's own wrapping — only
 * `"$operator: value"`. Descriptions are not here — they are user-facing
 * prose and belong in the locale files (`aggregation.stageDocs.<operator>`),
 * so a Spanish user reads Spanish.
 *
 * Write stages (`$out`, `$merge`) are deliberately absent. The editor refuses
 * to run them — a debounced preview that overwrites a collection while you type
 * is not a preview (see `reject_write_stages` in the Rust side) — so offering
 * them in the picker would only build a dead end. A hand-typed one still gets a
 * clear error naming the stage.
 *
 * A snippet's `$` needs escaping as `\$` wherever it is a literal character
 * (an operator key, or a field reference like `"$field"`), never a tabstop —
 * Monaco's snippet grammar treats an unescaped `$name` (letters, not digits)
 * as a TextMate variable reference, and an unknown one silently resolves to
 * empty text. Left unescaped, `"$existingField"` would vanish the moment the
 * snippet is inserted. `stages.test.ts` pins this down: stripping every
 * snippet's tabstop syntax back down to plain text must reproduce exactly the
 * `snippet` field it sits next to.
 */

export interface StageSpec {
  /** Operator name, `$` included — this is also the i18n key suffix. */
  operator: string;
  /** Source inserted when the stage is added from the header `Select`,
   *  already shaped as a full stage document (what the backend parses as one
   *  stage). Plain text — no tabstops. */
  snippet: string;
  /** Monaco snippet syntax for `"$operator: value"`, inserted by the inline
   *  completion provider right after the stage body's own `{` — the caller
   *  already supplies the surrounding braces, so this never repeats them. */
  insertSnippet: string;
  /** Rough grouping for the picker. */
  group: "shape" | "filter" | "combine" | "compute" | "output";
}

export const STAGE_CATALOG: StageSpec[] = [
  // Filtering / ordering — the everyday ones, first in the list.
  {
    operator: "$match",
    group: "filter",
    snippet: '{\n  $match: {\n    field: "value"\n  }\n}',
    insertSnippet: '\\$match: {\n    ${1:field}: "${2:value}"\n  }',
  },
  {
    operator: "$sort",
    group: "filter",
    snippet: "{\n  $sort: {\n    field: -1\n  }\n}",
    insertSnippet: "\\$sort: {\n    ${1:field}: ${2:-1}\n  }",
  },
  {
    operator: "$limit",
    group: "filter",
    snippet: "{\n  $limit: 20\n}",
    insertSnippet: "\\$limit: ${1:20}",
  },
  {
    operator: "$skip",
    group: "filter",
    snippet: "{\n  $skip: 0\n}",
    insertSnippet: "\\$skip: ${1:0}",
  },
  {
    operator: "$sample",
    group: "filter",
    snippet: "{\n  $sample: {\n    size: 10\n  }\n}",
    insertSnippet: "\\$sample: {\n    size: ${1:10}\n  }",
  },

  // Reshaping a document.
  {
    operator: "$project",
    group: "shape",
    snippet: "{\n  $project: {\n    _id: 0,\n    field: 1\n  }\n}",
    insertSnippet: "\\$project: {\n    _id: ${1:0},\n    ${2:field}: ${3:1}\n  }",
  },
  {
    operator: "$addFields",
    group: "shape",
    snippet: '{\n  $addFields: {\n    newField: "$existingField"\n  }\n}',
    insertSnippet: '\\$addFields: {\n    ${1:newField}: "\\$${2:existingField}"\n  }',
  },
  {
    operator: "$set",
    group: "shape",
    snippet: '{\n  $set: {\n    newField: "$existingField"\n  }\n}',
    insertSnippet: '\\$set: {\n    ${1:newField}: "\\$${2:existingField}"\n  }',
  },
  {
    operator: "$unset",
    group: "shape",
    snippet: '{\n  $unset: ["field"]\n}',
    insertSnippet: '\\$unset: ["${1:field}"]',
  },
  {
    operator: "$replaceRoot",
    group: "shape",
    snippet: '{\n  $replaceRoot: {\n    newRoot: "$subDocument"\n  }\n}',
    insertSnippet: '\\$replaceRoot: {\n    newRoot: "\\$${1:subDocument}"\n  }',
  },
  {
    operator: "$replaceWith",
    group: "shape",
    snippet: '{\n  $replaceWith: "$subDocument"\n}',
    insertSnippet: '\\$replaceWith: "\\$${1:subDocument}"',
  },
  {
    operator: "$unwind",
    group: "shape",
    snippet: '{\n  $unwind: {\n    path: "$arrayField",\n    preserveNullAndEmptyArrays: false\n  }\n}',
    insertSnippet:
      '\\$unwind: {\n    path: "\\$${1:arrayField}",\n    preserveNullAndEmptyArrays: ${2:false}\n  }',
  },

  // Joining / combining.
  {
    operator: "$lookup",
    group: "combine",
    snippet:
      '{\n  $lookup: {\n    from: "otherCollection",\n    localField: "field",\n    foreignField: "_id",\n    as: "joined"\n  }\n}',
    insertSnippet:
      '\\$lookup: {\n    from: "${1:otherCollection}",\n    localField: "${2:field}",\n    foreignField: "${3:_id}",\n    as: "${4:joined}"\n  }',
  },
  {
    operator: "$graphLookup",
    group: "combine",
    snippet:
      '{\n  $graphLookup: {\n    from: "sameCollection",\n    startWith: "$parentId",\n    connectFromField: "parentId",\n    connectToField: "_id",\n    as: "ancestors"\n  }\n}',
    insertSnippet:
      '\\$graphLookup: {\n    from: "${1:sameCollection}",\n    startWith: "\\$${2:parentId}",\n    connectFromField: "${3:parentId}",\n    connectToField: "${4:_id}",\n    as: "${5:ancestors}"\n  }',
  },
  {
    operator: "$unionWith",
    group: "combine",
    snippet: '{\n  $unionWith: {\n    coll: "otherCollection",\n    pipeline: []\n  }\n}',
    insertSnippet: '\\$unionWith: {\n    coll: "${1:otherCollection}",\n    pipeline: [$2]\n  }',
  },
  {
    operator: "$facet",
    group: "combine",
    snippet: "{\n  $facet: {\n    branchName: [\n      { $match: {} }\n    ]\n  }\n}",
    insertSnippet:
      "\\$facet: {\n    ${1:branchName}: [\n      { \\$match: {$2} }\n    ]\n  }",
  },

  // Grouping / computing.
  {
    operator: "$group",
    group: "compute",
    snippet: '{\n  $group: {\n    _id: "$field",\n    count: { $sum: 1 }\n  }\n}',
    insertSnippet:
      '\\$group: {\n    _id: "\\$${1:field}",\n    ${2:count}: { \\$${3:sum}: ${4:1} }\n  }',
  },
  {
    operator: "$count",
    group: "compute",
    snippet: '{\n  $count: "total"\n}',
    insertSnippet: '\\$count: "${1:total}"',
  },
  {
    operator: "$sortByCount",
    group: "compute",
    snippet: '{\n  $sortByCount: "$field"\n}',
    insertSnippet: '\\$sortByCount: "\\$${1:field}"',
  },
  {
    operator: "$bucket",
    group: "compute",
    snippet:
      '{\n  $bucket: {\n    groupBy: "$field",\n    boundaries: [0, 10, 100],\n    default: "other",\n    output: {\n      count: { $sum: 1 }\n    }\n  }\n}',
    insertSnippet:
      '\\$bucket: {\n    groupBy: "\\$${1:field}",\n    boundaries: [${2:0, 10, 100}],\n    default: "${3:other}",\n    output: {\n      ${4:count}: { \\$${5:sum}: ${6:1} }\n    }\n  }',
  },
  {
    operator: "$bucketAuto",
    group: "compute",
    snippet: '{\n  $bucketAuto: {\n    groupBy: "$field",\n    buckets: 5\n  }\n}',
    insertSnippet: '\\$bucketAuto: {\n    groupBy: "\\$${1:field}",\n    buckets: ${2:5}\n  }',
  },
  {
    operator: "$setWindowFields",
    group: "compute",
    snippet:
      '{\n  $setWindowFields: {\n    partitionBy: "$field",\n    sortBy: { date: 1 },\n    output: {\n      runningTotal: {\n        $sum: "$amount",\n        window: { documents: ["unbounded", "current"] }\n      }\n    }\n  }\n}',
    insertSnippet:
      '\\$setWindowFields: {\n    partitionBy: "\\$${1:field}",\n    sortBy: { ${2:date}: ${3:1} },\n    output: {\n      ${4:runningTotal}: {\n        \\$${5:sum}: "\\$${6:amount}",\n        window: { documents: ["unbounded", "current"] }\n      }\n    }\n  }',
  },
  {
    operator: "$densify",
    group: "compute",
    snippet:
      '{\n  $densify: {\n    field: "date",\n    range: { step: 1, unit: "day", bounds: "full" }\n  }\n}',
    insertSnippet:
      '\\$densify: {\n    field: "${1:date}",\n    range: { step: ${2:1}, unit: "${3:day}", bounds: "${4:full}" }\n  }',
  },
  {
    operator: "$fill",
    group: "compute",
    snippet: '{\n  $fill: {\n    sortBy: { date: 1 },\n    output: {\n      field: { method: "linear" }\n    }\n  }\n}',
    insertSnippet:
      '\\$fill: {\n    sortBy: { ${1:date}: ${2:1} },\n    output: {\n      ${3:field}: { method: "${4:linear}" }\n    }\n  }',
  },

  // Sources / diagnostics that end (or start) a pipeline.
  {
    operator: "$geoNear",
    group: "output",
    snippet:
      '{\n  $geoNear: {\n    near: { type: "Point", coordinates: [0, 0] },\n    distanceField: "distance",\n    spherical: true\n  }\n}',
    insertSnippet:
      '\\$geoNear: {\n    near: { type: "Point", coordinates: [${1:0}, ${2:0}] },\n    distanceField: "${3:distance}",\n    spherical: ${4:true}\n  }',
  },
  {
    operator: "$documents",
    group: "output",
    snippet: "{\n  $documents: [\n    { _id: 1 }\n  ]\n}",
    insertSnippet: "\\$documents: [\n    { _id: ${1:1} }\n  ]",
  },
  {
    operator: "$indexStats",
    group: "output",
    snippet: "{\n  $indexStats: {}\n}",
    insertSnippet: "\\$indexStats: {$1}",
  },
  {
    operator: "$redact",
    group: "output",
    snippet: '{\n  $redact: "$$DESCEND"\n}',
    insertSnippet: '\\$redact: "\\$\\$${1:DESCEND}"',
  },
];

/** Snippet for an operator, or a bare `{ $operator: {} }` for one the catalogue
 *  doesn't know (a newer server stage typed by hand). */
export function snippetFor(operator: string): string {
  const known = STAGE_CATALOG.find((s) => s.operator === operator);
  return known ? known.snippet : `{\n  ${operator}: {\n    \n  }\n}`;
}

