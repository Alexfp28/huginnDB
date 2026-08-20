/**
 * The aggregation stage catalogue the editor's stage picker offers.
 *
 * Two things live here and nothing else: the operator name and the *snippet*
 * inserted when it is picked. Descriptions are not here — they are user-facing
 * prose and belong in the locale files (`aggregation.stageDocs.<operator>`), so
 * a Spanish user reads Spanish.
 *
 * Write stages (`$out`, `$merge`) are deliberately absent. The editor refuses
 * to run them — a debounced preview that overwrites a collection while you type
 * is not a preview (see `reject_write_stages` in the Rust side) — so offering
 * them in the picker would only build a dead end. A hand-typed one still gets a
 * clear error naming the stage.
 */

export interface StageSpec {
  /** Operator name, `$` included — this is also the i18n key suffix. */
  operator: string;
  /** Source inserted when the stage is added, already shaped as a full stage
   *  document (what the backend parses as one stage). */
  snippet: string;
  /** Rough grouping for the picker. */
  group: "shape" | "filter" | "combine" | "compute" | "output";
}

export const STAGE_CATALOG: StageSpec[] = [
  // Filtering / ordering — the everyday ones, first in the list.
  { operator: "$match", group: "filter", snippet: '{\n  $match: {\n    field: "value"\n  }\n}' },
  { operator: "$sort", group: "filter", snippet: "{\n  $sort: {\n    field: -1\n  }\n}" },
  { operator: "$limit", group: "filter", snippet: "{\n  $limit: 20\n}" },
  { operator: "$skip", group: "filter", snippet: "{\n  $skip: 0\n}" },
  { operator: "$sample", group: "filter", snippet: "{\n  $sample: {\n    size: 10\n  }\n}" },

  // Reshaping a document.
  {
    operator: "$project",
    group: "shape",
    snippet: "{\n  $project: {\n    _id: 0,\n    field: 1\n  }\n}",
  },
  {
    operator: "$addFields",
    group: "shape",
    snippet: '{\n  $addFields: {\n    newField: "$existingField"\n  }\n}',
  },
  { operator: "$set", group: "shape", snippet: '{\n  $set: {\n    newField: "$existingField"\n  }\n}' },
  { operator: "$unset", group: "shape", snippet: '{\n  $unset: ["field"]\n}' },
  { operator: "$replaceRoot", group: "shape", snippet: '{\n  $replaceRoot: {\n    newRoot: "$subDocument"\n  }\n}' },
  { operator: "$replaceWith", group: "shape", snippet: '{\n  $replaceWith: "$subDocument"\n}' },
  {
    operator: "$unwind",
    group: "shape",
    snippet: '{\n  $unwind: {\n    path: "$arrayField",\n    preserveNullAndEmptyArrays: false\n  }\n}',
  },

  // Joining / combining.
  {
    operator: "$lookup",
    group: "combine",
    snippet:
      '{\n  $lookup: {\n    from: "otherCollection",\n    localField: "field",\n    foreignField: "_id",\n    as: "joined"\n  }\n}',
  },
  {
    operator: "$graphLookup",
    group: "combine",
    snippet:
      '{\n  $graphLookup: {\n    from: "sameCollection",\n    startWith: "$parentId",\n    connectFromField: "parentId",\n    connectToField: "_id",\n    as: "ancestors"\n  }\n}',
  },
  {
    operator: "$unionWith",
    group: "combine",
    snippet: '{\n  $unionWith: {\n    coll: "otherCollection",\n    pipeline: []\n  }\n}',
  },
  {
    operator: "$facet",
    group: "combine",
    snippet: "{\n  $facet: {\n    branchName: [\n      { $match: {} }\n    ]\n  }\n}",
  },

  // Grouping / computing.
  {
    operator: "$group",
    group: "compute",
    snippet: '{\n  $group: {\n    _id: "$field",\n    count: { $sum: 1 }\n  }\n}',
  },
  { operator: "$count", group: "compute", snippet: '{\n  $count: "total"\n}' },
  { operator: "$sortByCount", group: "compute", snippet: '{\n  $sortByCount: "$field"\n}' },
  {
    operator: "$bucket",
    group: "compute",
    snippet:
      '{\n  $bucket: {\n    groupBy: "$field",\n    boundaries: [0, 10, 100],\n    default: "other",\n    output: {\n      count: { $sum: 1 }\n    }\n  }\n}',
  },
  {
    operator: "$bucketAuto",
    group: "compute",
    snippet: '{\n  $bucketAuto: {\n    groupBy: "$field",\n    buckets: 5\n  }\n}',
  },
  {
    operator: "$setWindowFields",
    group: "compute",
    snippet:
      '{\n  $setWindowFields: {\n    partitionBy: "$field",\n    sortBy: { date: 1 },\n    output: {\n      runningTotal: {\n        $sum: "$amount",\n        window: { documents: ["unbounded", "current"] }\n      }\n    }\n  }\n}',
  },
  {
    operator: "$densify",
    group: "compute",
    snippet:
      '{\n  $densify: {\n    field: "date",\n    range: { step: 1, unit: "day", bounds: "full" }\n  }\n}',
  },
  {
    operator: "$fill",
    group: "compute",
    snippet: '{\n  $fill: {\n    sortBy: { date: 1 },\n    output: {\n      field: { method: "linear" }\n    }\n  }\n}',
  },

  // Sources / diagnostics that end (or start) a pipeline.
  {
    operator: "$geoNear",
    group: "output",
    snippet:
      '{\n  $geoNear: {\n    near: { type: "Point", coordinates: [0, 0] },\n    distanceField: "distance",\n    spherical: true\n  }\n}',
  },
  { operator: "$documents", group: "output", snippet: "{\n  $documents: [\n    { _id: 1 }\n  ]\n}" },
  { operator: "$indexStats", group: "output", snippet: "{\n  $indexStats: {}\n}" },
  { operator: "$redact", group: "output", snippet: '{\n  $redact: "$$DESCEND"\n}' },
];

/** Snippet for an operator, or a bare `{ $operator: {} }` for one the catalogue
 *  doesn't know (a newer server stage typed by hand). */
export function snippetFor(operator: string): string {
  const known = STAGE_CATALOG.find((s) => s.operator === operator);
  return known ? known.snippet : `{\n  ${operator}: {\n    \n  }\n}`;
}
