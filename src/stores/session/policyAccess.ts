/**
 * What the managed policy lets the person using the app do, per connection and
 * per relation — the answers `policy_access` / `policy_relation_access` give,
 * cached so a locked control reads a primitive instead of issuing a command on
 * every render. See `lib/policy/access.ts` for the hooks built on it.
 *
 * Advisory, like the commands it caches: every backend command refuses on its
 * own (`commands::guard`), so a stale entry can show a control that then fails
 * but never lets anything through. That is why an entry that has not arrived
 * yet reads as "allowed" rather than "locked": on the ordinary, unmanaged
 * machine a lock flashing on every menu for one round trip would be the wrong
 * way round.
 *
 * Requests are batched: every hook that finds its entry missing queues it, and
 * one microtask later the queue goes out as one call per kind (and, for
 * relations, per connection). A table listing of 200 rows costs one call, not
 * 200. Nothing is asked about relations on a connection the policy does not
 * govern, which is every connection on an unmanaged machine.
 *
 * Invalidated whenever the policy or the profiles change: the reload thread
 * emits `huginndb://policy-changed` when what it read differs from before
 * (`lib/bridges/policy-bridge.ts`), and a profile edit can move a connection
 * onto a different rule (`lib/bridges/connection-sync-bridge.ts`).
 */

import { create } from "zustand";
import { api } from "@/lib/tauri";
import type {
  ConnectionAccess,
  PolicyAccess,
  RelationAccess,
} from "@/types";

export type PolicyStateLabel = PolicyAccess["state"] | "unknown";

interface PolicyAccessState {
  /** `unknown` until the first answer arrives. */
  state: PolicyStateLabel;
  /** Why everything is locked, while the policy is pending or broken. */
  reason: string | null;
  connections: Record<string, ConnectionAccess>;
  /** Keyed by {@link relationKey}. */
  relations: Record<string, RelationAccess>;
  /** Queue a connection (or `[]`, for the state alone) if not cached. */
  request: (ids: string[]) => void;
  /** Queue relations of one connection that are not cached. */
  requestRelations: (
    connectionId: string,
    relations: { schema: string | null; name: string }[],
  ) => void;
  /** Forget every answer and ask again for the connections already asked about. */
  invalidate: () => void;
}

/** Cache key for one relation of one connection. */
export function relationKey(
  connectionId: string,
  schema: string | null | undefined,
  name: string,
): string {
  return `${connectionId}\u0000${schema ?? ""}\u0000${name}`;
}

// Module-level queues: what has been asked for and not answered yet. Kept out
// of the store so queueing never re-renders anybody.
const pendingConnections = new Set<string>();
const pendingRelations = new Map<
  string,
  Map<string, { schema: string | null; name: string }>
>();
let stateRequested = false;
let flushScheduled = false;
/** Bumped by `invalidate`, so an answer to a question asked before it is dropped. */
let generation = 0;

function scheduleFlush() {
  if (flushScheduled) return;
  flushScheduled = true;
  queueMicrotask(flush);
}

function flush() {
  flushScheduled = false;
  const asked = generation;
  const set = usePolicyAccess.setState;

  if (pendingConnections.size > 0 || stateRequested) {
    const ids = [...pendingConnections];
    stateRequested = false;
    // Through a resolved promise, so a missing or throwing wrapper (a test
    // that mocks `api` without it) lands in `.catch` rather than escaping the
    // microtask as an unhandled error.
    Promise.resolve()
      .then(() => api.policyAccess(ids))
      .then((answer) => {
        if (asked !== generation) return;
        ids.forEach((id) => pendingConnections.delete(id));
        set((s) => {
          const connections = { ...s.connections };
          for (const c of answer.connections) connections[c.id] = c;
          return { state: answer.state, reason: answer.reason, connections };
        });
      })
      .catch(() => {
        // Leave them unanswered — which reads as allowed — rather than lock
        // every control over a command that could not be called. Dropping
        // them from the queue lets the next render ask again.
        ids.forEach((id) => pendingConnections.delete(id));
      });
  }

  for (const [connectionId, byKey] of pendingRelations) {
    const entries = [...byKey.entries()];
    pendingRelations.delete(connectionId);
    Promise.resolve()
      .then(() =>
        api.policyRelationAccess(
          connectionId,
          entries.map(([, r]) => r),
        ),
      )
      .then((answers) => {
        if (asked !== generation) return;
        set((s) => {
          const relations = { ...s.relations };
          entries.forEach(([key], i) => {
            const a = answers[i];
            if (a) relations[key] = a;
          });
          return { relations };
        });
      })
      .catch(() => {});
  }
}

export const usePolicyAccess = create<PolicyAccessState>((set, get) => ({
  state: "unknown",
  reason: null,
  connections: {},
  relations: {},

  request: (ids) => {
    const { connections } = get();
    let queued = false;
    if (ids.length === 0 && get().state === "unknown") {
      stateRequested = true;
      queued = true;
    }
    for (const id of ids) {
      if (connections[id] || pendingConnections.has(id)) continue;
      pendingConnections.add(id);
      queued = true;
    }
    if (queued) scheduleFlush();
  },

  requestRelations: (connectionId, relations) => {
    const { state, connections, relations: cached } = get();
    // Nothing a relation could narrow: the machine is unmanaged, or the
    // policy leaves this connection alone.
    if (state === "unmanaged") return;
    const conn = connections[connectionId];
    if (conn && !conn.managed) return;
    let byKey = pendingRelations.get(connectionId);
    let queued = false;
    for (const r of relations) {
      const key = relationKey(connectionId, r.schema, r.name);
      if (cached[key] || byKey?.has(key)) continue;
      if (!byKey) {
        byKey = new Map();
        pendingRelations.set(connectionId, byKey);
      }
      byKey.set(key, { schema: r.schema, name: r.name });
      queued = true;
    }
    if (queued) scheduleFlush();
  },

  invalidate: () => {
    generation += 1;
    const known = Object.keys(get().connections);
    pendingConnections.clear();
    pendingRelations.clear();
    set({ connections: {}, relations: {} });
    // Ask straight away for what was on screen, and for the state (a banner
    // may be showing). Relations are asked again by the hooks that re-render.
    stateRequested = true;
    known.forEach((id) => pendingConnections.add(id));
    scheduleFlush();
  },
}));

/** Test-only: drop every queue and cached answer. */
export function resetPolicyAccessForTests() {
  generation += 1;
  pendingConnections.clear();
  pendingRelations.clear();
  stateRequested = false;
  flushScheduled = false;
  usePolicyAccess.setState({
    state: "unknown",
    reason: null,
    connections: {},
    relations: {},
  });
}
