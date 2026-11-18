/**
 * #3082 — a worker session for a test, started the way the CLI starts one: through the GraphQL `startSession` resolver.
 * MCP no longer binds a worker (`hadron_start_session` refuses `workerRef`, MCP_WORKER_BINDING_UNSUPPORTED), so a suite
 * that needs a worker-attributed MCP connection starts the session here and then PRESENTS it, by the `session`
 * argument or the `X-Hadron-Session` header (#1081). Never add a path that binds through the MCP server instead.
 */
import { db } from '../integrations/db/client.js';
import { generateId } from '../lib/id.js';
import { resolvers, type Context } from '../api/graphql/schema/resolvers.js';

export interface StartWorkerSessionOptions {
  /** A worker id or `hrn:worker:…` URN. */
  workerRef: string;
  /** Supersede a live session on the worker (the old MCP tests passed `force: true`). */
  force?: boolean;
  plan?: string;
  tool?: string;
  /** The caller: defaults to a context for `userId` (and `appId` when given). */
  ctx?: Context;
  userId?: string;
  appId?: string;
}

/** Start a worker session through `resolvers.Mutation.startSession` and return its id. */
export async function startWorkerSessionGql(opts: StartWorkerSessionOptions): Promise<string> {
  const ctx = opts.ctx ?? ({ db, userId: opts.userId, appId: opts.appId, roles: ['READER'] } as Context);
  const { workerRef, force, plan, tool } = opts;
  const out = await (resolvers.Mutation as any).startSession(
    {},
    { input: { id: generateId(), tool: tool ?? 'vitest', workerRef, ...(force ? { force } : {}), ...(plan ? { plan } : {}) } },
    ctx,
  );
  return out.id as string;
}
