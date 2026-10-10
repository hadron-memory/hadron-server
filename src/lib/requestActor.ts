/**
 * #1610 — the Worker / Agent behind the current request's writes.
 *
 * A request-scoped AsyncLocalStorage holder, the same shape as requestKeys.ts:
 * the HTTP surfaces (`/graphql`, `/mcp`) open an empty holder per request, and
 * `resolveAuthContext` fills it from the VALIDATED session binding — never from
 * anything the client asserts. The headless runner opens one per tool call
 * from its AppRun's agent. Writes read it in exactly two places, so no write
 * site can forget it:
 *
 *   - the Prisma `node` extension in src/integrations/db/client.ts stamps
 *     `createdBy*` / `updatedBy*` on creates and authored-field updates;
 *   - `editorFromAuth` (src/lib/nodeRevisionSnapshot.ts) carries it into every
 *     revision snapshot's `editedBy*`.
 *
 * Outside any holder (system jobs, scripts) the actor is "nobody": both null.
 */

import { AsyncLocalStorage } from 'async_hooks';

export type RequestActor = {
  workerId: string | null;
  agentId: string | null;
  /**
   * #1701 — set when the request's MCP connection carries live bindings for
   * MORE THAN ONE Worker / Agent and nothing in the request said which one is
   * calling: the Hadron session ids of those bindings. The actor is then
   * nobody (both ids null), and the MCP write gate refuses rather than guess.
   * Absent everywhere else.
   */
  ambiguousSessionIds?: readonly string[];
};

export const requestActorStorage = new AsyncLocalStorage<RequestActor>();

const NOBODY: RequestActor = Object.freeze({ workerId: null, agentId: null });

/** A fresh holder for one request; filled later by {@link publishActor}. */
export function emptyActor(): RequestActor {
  return { workerId: null, agentId: null };
}

/** The current request's actor, or nobody outside a request. */
export function currentActor(): RequestActor {
  return requestActorStorage.getStore() ?? NOBODY;
}

/**
 * Record the actor the request authenticated as. A no-op outside a holder
 * (e.g. a test calling resolveAuthContext directly).
 */
export function publishActor(actor: RequestActor): void {
  const holder = requestActorStorage.getStore();
  if (!holder) return;
  holder.workerId = actor.workerId;
  holder.agentId = actor.agentId;
  // A named actor answers the question an ambiguity asked (#1701).
  delete holder.ambiguousSessionIds;
}

/**
 * #1701 — record that the request's connection is bound to several actors and
 * the request named none: its writes attribute to nobody, and the MCP write
 * gate reads {@link currentActorAmbiguity} to refuse instead. A no-op outside
 * a holder.
 */
export function publishAmbiguousActor(sessionIds: readonly string[]): void {
  const holder = requestActorStorage.getStore();
  if (!holder) return;
  holder.workerId = null;
  holder.agentId = null;
  holder.ambiguousSessionIds = [...sessionIds];
}

/** #1701 — the candidate session ids when the current actor is ambiguous, else null. */
export function currentActorAmbiguity(): readonly string[] | null {
  return requestActorStorage.getStore()?.ambiguousSessionIds ?? null;
}

/**
 * Run `fn` as `actor` — a headless run's scope, and tests. Awaited INSIDE the
 * scope on purpose: a PrismaPromise is lazy, so a query returned unawaited
 * would execute (and read the actor) after the scope had already closed.
 */
export function runAsActor<T>(actor: RequestActor, fn: () => T | PromiseLike<T>): Promise<T> {
  return requestActorStorage.run({ ...actor }, async () => await fn());
}

/**
 * #1701 — run `fn` in a holder of its OWN, seeded from the current one, so
 * what `fn` publishes stays inside it. One MCP POST can carry a JSON-RPC batch
 * whose tool calls the SDK dispatches concurrently under the request's single
 * holder; a call naming its session must not re-stamp a sibling's write, nor
 * clear the ambiguity a sibling is about to be refused on. Awaited inside the
 * scope for the same reason as {@link runAsActor}.
 */
export function runInChildActorScope<T>(fn: () => T | PromiseLike<T>): Promise<T> {
  const parent = currentActor();
  const child: RequestActor = { workerId: parent.workerId, agentId: parent.agentId };
  if (parent.ambiguousSessionIds) child.ambiguousSessionIds = [...parent.ambiguousSessionIds];
  return requestActorStorage.run(child, async () => await fn());
}

/**
 * Run `fn` as the system: no Worker or Agent behind its writes, whatever
 * request triggered it. For writes of server-sourced content whose revision
 * editor is a system principal (Git sync, memory scaffolding), so the node and
 * its revision attribute the same edit to the same nobody (#1658 review).
 */
export function runAsSystem<T>(fn: () => T | PromiseLike<T>): Promise<T> {
  return runAsActor({ workerId: null, agentId: null }, fn);
}
