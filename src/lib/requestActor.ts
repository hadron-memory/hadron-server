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

export type RequestActor = { workerId: string | null; agentId: string | null };

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
}

/**
 * Run `fn` as `actor` — a headless run's scope, and tests. Awaited INSIDE the
 * scope on purpose: a PrismaPromise is lazy, so a query returned unawaited
 * would execute (and read the actor) after the scope had already closed.
 */
export function runAsActor<T>(actor: RequestActor, fn: () => T | PromiseLike<T>): Promise<T> {
  return requestActorStorage.run({ ...actor }, async () => await fn());
}
