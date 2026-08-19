/**
 * Wires the user JSON Schema library into Monaco's bundled JSON language
 * service.
 *
 * The worker is already shipped (`monaco-setup.ts` imports
 * `monaco-editor/esm/vs/language/json/json.worker`); nothing here adds a
 * dependency. What it adds is configuration, and every rule below was verified
 * against the worker source in `node_modules/monaco-editor@0.52`, not inferred
 * from documentation.
 *
 * # `setDiagnosticsOptions` is a total replacement, and it restarts the worker
 *
 * `configure()` calls `clearExternalSchemas()` and re-registers the whole array,
 * and the mode listens for the change by *stopping* the worker and doing a
 * remove+add of every JSON model (which clears and recomputes all their
 * markers). So the schema array is rebuilt in full from the maps below on every
 * change, and a signature guard keeps it from firing per render or per keystroke.
 * "Accumulate entries" and "clean up on close" are therefore the same operation:
 * the array is derived from `associations`, and the disposer returned by
 * {@link bindSchemaToModel} just removes its entry and rebuilds.
 *
 * # Association is by model URI, so a cell editor needs a stable `path`
 *
 * `fileMatch` is compiled as a glob against the model URI, which means a pattern
 * that is only a file name matches any path ending in it. Monaco's default
 * auto-generated URIs (`inmemory://model/N`) end in none of our suffixes, so
 * every other editor in the app is excluded by construction — which is why the
 * patterns here must stay narrow. Never write `*.json` or `**​/*`.
 *
 * # The draft-07 meta-schema is already in the bundle
 *
 * It ships inside the worker's own schema contributions, complete with
 * localised descriptions, and `clearExternalSchemas()` re-seeds those. So
 * registering it by URI **without** a `schema` body resolves it locally: the
 * schema editor gets `type`/`properties`/`required` completion for free, with no
 * vendored file and no network.
 *
 * # No network, ever
 *
 * `enableSchemaRequest: false` is Monaco's default, but it is passed explicitly
 * because the options object is replaced wholesale. With it, the worker never
 * even constructs its fetch-based request service, so a `$ref` to an https URL
 * cannot phone home from a database client. What it *does* do is worse than a
 * warning and is why {@link collectExternalRefs} exists: an unresolvable `$ref`
 * makes the worker emit one warning and then **skip all further schema
 * validation of that document**, so a schema pasted from SchemaStore appears to
 * simply do nothing.
 */

import type { Monaco } from "@monaco-editor/react";

/** The bundled draft-07 meta-schema's URI, resolved from the worker's own
 *  contributions rather than the network. */
const DRAFT_07_URI = "http://json-schema.org/draft-07/schema#";

/** Suffix that marks a cell-editor model. */
const CELL_SUFFIX = ".hdbcell.json";
/** Suffix that marks a schema-editor model. Distinct from {@link CELL_SUFFIX} so
 *  the meta-schema association and a cell association can never both match one
 *  model — when several match, the worker combines them with `allOf`, which is
 *  the opposite of "the most specific rule wins". */
const SCHEMA_SUFFIX = ".hdbschema.json";

interface Association {
  /** The last path segment, which is what goes in `fileMatch`. */
  fileName: string;
  /** The library URI whose schema should apply. */
  schemaUri: string;
}

/**
 * The three user-facing switches.
 *
 * They are three rather than one because the language service splits them, and
 * because a loose schema is useful for completion long before anyone wants red
 * squiggles.
 *
 * `validation` maps to `schemaValidation`, **not** to `diagnostics`: the latter
 * would also silence plain syntax errors, which nobody asked for. Turning
 * `schemaValidation` off leaves completion and hover working, because the worker
 * consults that flag only when deciding marker severity.
 *
 * `completion` and `hover` map to `setModeConfiguration`, which registers or
 * withholds those providers. That is global to the `json` language, so switching
 * completion off also quietens the schema editor itself — which is what the
 * setting says it does.
 */
export interface JsonSchemaModePrefs {
  validation: boolean;
  completion: boolean;
  hover: boolean;
}

/** A parsed library entry, plus the source it was parsed from. */
export interface PublishedSchema {
  uri: string;
  /** The raw document, used only to tell a real change from a no-op. */
  body: string;
  schema: unknown;
}

let installed: Monaco | null = null;
let library: PublishedSchema[] = [];
const associations = new Map<string, Association>();
let lastSignature = "";
let modePrefs: JsonSchemaModePrefs = {
  validation: true,
  completion: true,
  hover: true,
};

/** Last path segment of a model URI — what `fileMatch` matches on. */
export function fileNameOf(path: string): string {
  const parts = path.split("/");
  return parts[parts.length - 1] ?? path;
}

/**
 * Deterministic model path for one cell-editing session.
 *
 * `surface` is in the path because `@monaco-editor/react` looks a model up by
 * path and creates one only if absent, then disposes it on unmount: two editors
 * sharing a path share a model, and whichever unmounts first destroys it under
 * the other. The modal and the docked side panel can be open at once, so they
 * must never collide.
 *
 * `nonce` is the caller's `editorKey`, so the path and the React `key` change in
 * the same render — "changed path" and "remounted" become one event, which also
 * avoids the wrapper's leak of the previous model on a path change.
 */
export function cellModelPath(surface: "modal" | "side", nonce: string | number): string {
  return `huginndb://cell/${surface}/${nonce}${CELL_SUFFIX}`;
}

/** Deterministic model path for editing a library entry's own body. */
export function schemaModelPath(id: string): string {
  return `huginndb://schema-edit/${id || "draft"}${SCHEMA_SUFFIX}`;
}

/**
 * Install the JSON schema configuration. Idempotent per Monaco instance.
 *
 * Called from `monaco-setup.ts` rather than from an editor's `onMount`, which is
 * the opposite of how the SQL and Mongo `ensure*` helpers are used — and
 * deliberately so. Those register *providers*, which can arrive late. This is
 * configuration that has to be in place before a model exists, because the
 * diagnostics adapter validates on `onDidCreateModel`; arming it at setup time
 * avoids a flash of unschema-ed markers on the first open.
 */
export function ensureJsonSchemas(monaco: Monaco): void {
  if (installed === monaco) return;
  installed = monaco;
  // Clear the guard: it tracks what *this* instance was last told, and a
  // different instance has been told nothing. Without this a second instance
  // would compute an unchanged signature and be left unconfigured.
  lastSignature = "";
  flush();
  applyModeConfiguration();
}

/** Adopt the user's three switches. Cheap and idempotent, so the caller can fire
 *  it on every preferences change. */
export function setModePrefs(next: JsonSchemaModePrefs): void {
  const changed =
    next.validation !== modePrefs.validation ||
    next.completion !== modePrefs.completion ||
    next.hover !== modePrefs.hover;
  if (!changed) return;
  modePrefs = next;
  // `validation` is part of the signature, so `flush` picks the change up on its
  // own; completion and hover live in the mode configuration instead.
  flush();
  applyModeConfiguration();
}

function applyModeConfiguration(): void {
  if (!installed) return;
  installed.languages.json.jsonDefaults.setModeConfiguration({
    documentFormattingEdits: true,
    documentRangeFormattingEdits: true,
    completionItems: modePrefs.completion,
    hovers: modePrefs.hover,
    documentSymbols: true,
    tokens: true,
    colors: true,
    foldingRanges: true,
    // Left on regardless: this governs *all* JSON diagnostics, including plain
    // syntax errors. Schema violations are silenced with `schemaValidation`
    // instead, which is what the user's switch actually means.
    diagnostics: true,
    selectionRanges: true,
  });
}

/**
 * Replace the published library. `entries` must already be parsed — see
 * `stores/jsonSchemas.ts`, which skips any entry whose body is not valid JSON so
 * a half-written draft never validates anybody's cells.
 *
 * Cheap to call with unchanged content: {@link flush} compares the actual bodies,
 * so renaming a schema — or any refetch that returns the same documents — does not
 * reach `setDiagnosticsOptions`, and therefore does not restart the worker.
 */
export function setSchemaLibrary(entries: PublishedSchema[]): void {
  library = entries;
  flush();
}

/**
 * Apply `schemaUri` to the model at `modelPath`.
 *
 * Returns a disposer that removes the association again; call it from the effect
 * cleanup. Binding is per *session*, not per column, because the model is
 * recreated whenever the editor remounts for a new cell.
 */
export function bindSchemaToModel(modelPath: string, schemaUri: string): () => void {
  associations.set(modelPath, { fileName: fileNameOf(modelPath), schemaUri });
  flush();
  return () => {
    associations.delete(modelPath);
    flush();
  };
}

/** Rebuild and push the schema array, unless nothing that matters changed. */
function flush(): void {
  // No Monaco yet: `ensureJsonSchemas` will flush once it arrives, so an early
  // bind is not lost.
  if (!installed) return;

  // The guard compares what the worker actually consumes: which schema documents
  // exist and which models they are attached to. It is deliberately NOT a
  // monotonic revision counter — the store bumps one of those on every save, so a
  // rename would restart the worker on each keystroke. A body comparison is a
  // handful of `memcmp`s and only runs when the library is republished.
  const signature = [
    ...library.map((e) => `${e.uri} ${e.body}`),
    "--",
    ...[...associations.entries()]
      .map(([uri, a]) => `${uri}=>${a.schemaUri}`)
      .sort(),
    `mode:${modePrefs.validation}`,
  ].join("");
  // Every call past here stops the JSON worker and recomputes the markers of
  // every JSON model — fine once per real change, ruinous per keystroke.
  if (signature === lastSignature) return;
  lastSignature = signature;

  const schemas: {
    uri: string;
    fileMatch?: string[];
    schema?: unknown;
  }[] = [
    // The whole library by URI and with no `fileMatch`: registered so a `$ref`
    // from one user schema to another resolves, without applying anywhere by
    // itself.
    ...library.map((e) => ({ uri: e.uri, schema: e.schema })),
    // The bundled meta-schema, with no `schema` body so it resolves from the
    // worker's own contributions rather than the network.
    { uri: DRAFT_07_URI, fileMatch: [`*${SCHEMA_SUFFIX}`] },
    // One entry per live editing session.
    ...[...associations.values()].map((a) => ({
      uri: a.schemaUri,
      fileMatch: [a.fileName],
    })),
  ];

  installed.languages.json.jsonDefaults.setDiagnosticsOptions({
    validate: true,
    // A database cell is strict JSON; the relaxed `mongosh` dialect has its own
    // language (`monacoMongo.ts`) and never reaches this configuration.
    allowComments: false,
    trailingCommas: "error",
    // Never "error": a schema is an aid, not a constraint, and the save path
    // deliberately ignores markers. Warning severity also stops a violation from
    // *looking* like something that blocks saving. "ignore" is the user's switch,
    // and it leaves completion and hover intact.
    schemaValidation: modePrefs.validation ? "warning" : "ignore",
    // Never "ignore". That hides the resolve-error marker without restoring the
    // validation the failure cancelled, turning a visible problem into silence.
    schemaRequest: "warning",
    // Explicit even though it is the default, because the object is replaced
    // wholesale. With this off the worker never builds a request service at all.
    enableSchemaRequest: false,
    schemas,
  });
}

/**
 * Every `$ref` in `schema` that this app cannot resolve offline.
 *
 * Needed because an unresolvable `$ref` does not merely warn: the worker reports
 * it and then skips schema validation of the whole document, so a schema copied
 * from a public registry silently does nothing. The Settings editor and the cell
 * badge both surface this.
 *
 * Local refs (`#/...`) and refs naming a registered library entry
 * (`huginndb://schema/<id>`) are fine; anything else is reported.
 */
export function collectExternalRefs(schema: unknown, knownUris: Set<string>): string[] {
  const found = new Set<string>();
  const walk = (node: unknown) => {
    if (Array.isArray(node)) {
      node.forEach(walk);
      return;
    }
    if (!node || typeof node !== "object") return;
    for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
      if (key === "$ref" && typeof value === "string") {
        const target = value.split("#")[0];
        // An empty target means the ref is purely local (`#/definitions/x`).
        if (target && !knownUris.has(target)) found.add(value);
      } else {
        walk(value);
      }
    }
  };
  walk(schema);
  return [...found].sort();
}

/**
 * Does this document declare its own `$schema`?
 *
 * Worth knowing because the worker checks the document's own `$schema` property
 * **before** consulting `fileMatch` and short-circuits if it finds one — so a
 * configuration blob that already names a schema silently ignores its binding,
 * and offline that also means it is not validated at all. Common enough in the
 * "database as configuration store" case to be the likeliest support question,
 * so the badge says so out loud.
 */
export function declaresOwnSchema(text: string): string | null {
  const trimmed = text.trimStart();
  if (!trimmed.startsWith("{")) return null;
  try {
    const parsed = JSON.parse(trimmed) as Record<string, unknown>;
    const declared = parsed?.$schema;
    return typeof declared === "string" ? declared : null;
  } catch {
    return null;
  }
}
