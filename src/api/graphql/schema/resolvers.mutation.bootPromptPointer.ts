/**
 * #2045 (S8 step 8b, cor:agt:040:07, R23/R24) — the three direct pointer
 * setters: `setAgentBootPrompt`, `setAppAgentBootPrompt`, `setWorkerBootPrompt`.
 * GraphQL only (R24: no MCP pointer write; the CLI and portal call these).
 *
 * One order for all three, in one transaction (6259771731):
 *
 *  1. resolve the OWNER through its existing read gate; an owner the caller
 *     cannot read answers its usual not-found;
 *  2. the authority gate on the owner alone (R23), before the target ref is
 *     looked at;
 *  3. the target checks, only for a caller who passed the gate;
 *  4. the write.
 *
 * `nodeRef` must be PRESENT: an explicit null clears, and an omitted one is
 * refused rather than read as a clear. A clear runs 1, 2 and 4.
 *
 * The transaction holds the owner's authority anchors SHARED (the anchors a
 * demotion, removal, transfer or deletion takes exclusively) and the caller's
 * AppMember row FOR SHARE (leaveApp deletes it unanchored), and decides on the
 * transaction context, so a demotion that commits first is seen and one that
 * comes later waits for this write (the #1713 pattern).
 */
import { GraphQLError } from 'graphql';
import type { Prisma } from '../../../generated/prisma/index.js';
import { resolveAgentRef } from '../../../lib/entityRef/agentRef.js';
import { resolveAppRef } from '../../../lib/entityRef/appRef.js';
import { AgentNotFoundError, AppNotFoundError } from '../../../lib/entityRef/errors.js';
import type { AuthorityAnchor } from '../../../lib/auth/authorityAnchors.js';
import {
  loadBootPromptPointerOwner,
  setBootPromptPointer,
  type BootPromptPointerOwner,
  type BootPromptPointerTarget,
} from '../../../lib/bootPromptPointer.js';
import { withAuthorizedTx } from './authorizedTx.js';
import { isAppParticipant, isMemoryReadableFresh, resolveReadableAgentRef, type Context } from './resolvers.helpers.js';
import { resolveReadableWorkerRef, workerNotFound } from './resolvers.worker.js';

type NodeRefArg = { nodeRef?: string | null };

/** Presence, not truthiness: null clears, absent is refused (never an accidental clear). */
function requiredNodeRef(args: NodeRefArg): string | null {
  if (!('nodeRef' in args) || args.nodeRef === undefined) {
    throw new GraphQLError('nodeRef is required: pass a compiled boot-prompt node ref to set the pointer, or null to clear it.', {
      extensions: { code: 'BAD_USER_INPUT' },
    });
  }
  return args.nodeRef;
}

const ownerAnchors = (owner: { organizationId: string | null; ownerUserId: string | null }): AuthorityAnchor[] => [
  ...(owner.organizationId ? [{ kind: 'org' as const, id: owner.organizationId }] : []),
  ...(owner.ownerUserId ? [{ kind: 'user' as const, id: owner.ownerUserId }] : []),
];

function ownerTenant(owner: BootPromptPointerOwner): { organizationId: string | null; ownerUserId: string | null } {
  return owner.field === 'AGENT' ? owner.agent : owner.app;
}

class OwnerTenantChanged extends Error {}

/**
 * Steps 2–4 under the owner's anchors. The anchors are chosen from the owner's
 * tenancy as read before the transaction; if a transfer moved the owner before
 * the locks arrived, those anchors guard the wrong tenant, so the attempt is
 * discarded and retried with the new ones (the withAuthorizedMemoryTx shape),
 * never decided against an unanchored owner.
 */
async function writePointer(
  ctx: Context,
  target: BootPromptPointerTarget,
  nodeRef: string | null,
  notFound: () => Error,
): Promise<void> {
  const base: AuthorityAnchor = target.field === 'AGENT'
    ? { kind: 'agent', id: target.agentId }
    : { kind: 'app', id: target.field === 'APP_AGENT' ? target.appId : (await workerAppId(ctx, target.workerId)) };
  const appId = base.kind === 'app' ? base.id : null;
  for (let attempt = 0; attempt < 3; attempt++) {
    const before = await loadBootPromptPointerOwner(ctx.db, target);
    if (!before) throw notFound();
    const expected = ownerTenant(before);
    try {
      await withAuthorizedTx(
        ctx,
        [base, ...ownerAnchors(expected)],
        async () => {},
        async (tx: Prisma.TransactionClient, txCtx: Context) => {
          const owner = await loadBootPromptPointerOwner(tx, target, { lockForWrite: true });
          if (!owner) throw notFound();
          const tenant = ownerTenant(owner);
          if (tenant.organizationId !== expected.organizationId || tenant.ownerUserId !== expected.ownerUserId) {
            throw new OwnerTenantChanged();
          }
          await setBootPromptPointer(tx, txCtx, owner, nodeRef, (memoryId) => isMemoryReadableFresh(txCtx, memoryId, tx));
        },
        {
          // Gene's #2219 BLIND P2: the AGENT pointer UPDATEs its own anchor row, so two saves holding it shared would
          // each wait for the other to upgrade (40P01). Exclusive serializes them first, the inTaskWriteTx precedent.
          // APP_AGENT and WORKER update child rows of their App anchor, so they keep the shared hold.
          lockMode: target.field === 'AGENT' ? 'exclusive' : 'shared',
          afterLock: async (tx) => {
            if (appId && ctx.userId) {
              await tx.$queryRaw`SELECT 1 FROM app_members WHERE app_id = ${appId} AND user_id = ${ctx.userId} FOR SHARE`;
            }
          },
        },
      );
      return;
    } catch (e) {
      if (e instanceof OwnerTenantChanged) continue;
      throw e;
    }
  }
  throw new Error('The owner of this boot-prompt pointer changed repeatedly; retry the operation');
}

async function workerAppId(ctx: Context, workerId: string): Promise<string> {
  return (await ctx.db.worker.findUniqueOrThrow({ where: { id: workerId }, select: { appId: true } })).appId;
}

export const bootPromptPointerMutations = {
  /** Set or clear `Agent.bootPromptRef`: the Agent's manager, as themselves (R23). */
  setAgentBootPrompt: async (_: unknown, args: { agentRef: string } & NodeRefArg, ctx: Context) => {
    const nodeRef = requiredNodeRef(args);
    const agent = await resolveReadableAgentRef(ctx, args.agentRef);
    await writePointer(ctx, { field: 'AGENT', agentId: agent.id }, nodeRef, () => new AgentNotFoundError(args.agentRef));
    return ctx.db.agent.findUniqueOrThrow({ where: { id: agent.id } });
  },

  /** Set or clear `AppAgent.bootPromptRef`: the App's manager, as themselves (R23). */
  setAppAgentBootPrompt: async (_: unknown, args: { appRef: string; agentRef: string } & NodeRefArg, ctx: Context) => {
    const nodeRef = requiredNodeRef(args);
    const { id: appId } = await resolveAppRef(ctx.db, args.appRef);
    const app = await ctx.db.app.findFirst({
      where: { id: appId, deletedAt: null, uninstalledAt: null },
      select: { id: true, organizationId: true, ownerUserId: true },
    });
    if (!app || !(await isAppParticipant(ctx, app))) throw new AppNotFoundError(args.appRef);
    // An Agent that does not exist and one this App has not installed answer alike.
    const agentId = await resolveAgentRef(ctx.db, args.agentRef).then((a) => a.id, (e) => {
      if (e instanceof AgentNotFoundError) return null;
      throw e;
    });
    const notInstalled = () => new AgentNotFoundError(args.agentRef);
    if (!agentId) throw notInstalled();
    await writePointer(ctx, { field: 'APP_AGENT', appId: app.id, agentId }, nodeRef, notInstalled);
    return ctx.db.appAgent.findUniqueOrThrow({ where: { appId_agentId: { appId: app.id, agentId } } });
  },

  /** Set or clear `Worker.bootPromptRef`: the worker's App's manager, as themselves (R23). */
  setWorkerBootPrompt: async (_: unknown, args: { workerRef: string } & NodeRefArg, ctx: Context) => {
    const nodeRef = requiredNodeRef(args);
    const { worker } = await resolveReadableWorkerRef(ctx, args.workerRef);
    await writePointer(ctx, { field: 'WORKER', workerId: worker.id }, nodeRef, () => workerNotFound(args.workerRef));
    return ctx.db.worker.findUniqueOrThrow({ where: { id: worker.id } });
  },
};
