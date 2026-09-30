import { GraphQLError } from 'graphql';
import { Prisma, type Memory } from '../../../generated/prisma/index.js';
import { resolveMemoryRef } from '../../../lib/entityRef/memoryRef.js';
import { resolveOrgRef } from '../../../lib/entityRef/orgRef.js';
import { resolveUserRef } from '../../../lib/entityRef/userRef.js';
import { mintLocalSlug } from '../../../lib/mintLocalSlug.js';
import { recordUrnRename } from '../../../lib/urnAlias.js';
import {
  type Context,
  concealUnreadableDenial,
  isPlatformAdmin,
  requireOrgRole,
} from './resolvers.helpers.js';

type TransferClass = 'knowledge' | 'group' | 'personal' | 'private';
type TransferDb = Prisma.TransactionClient;
type Destination = {
  kind: 'organization' | 'user';
  id: string;
  root: string;
};
type TransferInput = {
  memoryRef: string;
  orgRef?: string | null;
  userRef?: string | null;
  targetClass?: TransferClass | null;
  expectedNewUrn?: string | null;
  dryRun?: boolean | null;
};
type Dependent = { kind: string; count: number; handling: 'CARRY' | 'REFUSE' };
type Blocker = { code: string; message: string };

function refusal(code: string, message: string): GraphQLError {
  return new GraphQLError(message, { extensions: { code } });
}

/** The source gate runs before any dependency or destination detail is returned. */
async function authorizeSource(ctx: Context, memory: Memory, ref: string): Promise<void> {
  await concealUnreadableDenial(ctx, memory.id, ref, async () => {
    if (isPlatformAdmin(ctx) && !ctx.impersonation) return;
    if (!ctx.userId || ctx.impersonation) throw new Error('Forbidden');
    // personal/private's strict owner is separate from the tenant owner. An
    // org ADMIN cannot read, edit, or transfer someone else's private content.
    if (memory.userId !== null) {
      if (memory.userId !== ctx.userId) throw new Error('Forbidden');
      return;
    }
    if (memory.ownerUserId !== null) {
      if (memory.ownerUserId !== ctx.userId) throw new Error('Forbidden');
      return;
    }
    if (memory.organizationId !== null) {
      await requireOrgRole(ctx, memory.organizationId, 'ADMIN');
      return;
    }
    throw new Error('Forbidden');
  });
}

async function resolveDestination(ctx: Context, input: TransferInput): Promise<Destination> {
  if ((input.orgRef == null) === (input.userRef == null)) {
    throw refusal('BAD_USER_INPUT', 'Provide exactly one of orgRef or userRef.');
  }
  if (input.orgRef != null) {
    const { id } = await resolveOrgRef(ctx.db, input.orgRef);
    await requireOrgRole(ctx, id, 'ADMIN');
    const org = await ctx.db.organization.findUniqueOrThrow({ where: { id }, select: { urn: true } });
    return { kind: 'organization', id, root: org.urn };
  }
  const { id } = await resolveUserRef(ctx.db, input.userRef!);
  if (!isPlatformAdmin(ctx) && (ctx.impersonation || ctx.userId !== id)) {
    throw refusal('FORBIDDEN', 'You may transfer a memory only into your own user namespace.');
  }
  const user = await ctx.db.user.findUniqueOrThrow({ where: { id }, select: { handle: true } });
  if (!user.handle) throw refusal('TARGET_HANDLE_REQUIRED', 'The receiving user needs a handle before transfer.');
  return { kind: 'user', id, root: user.handle };
}

function targetClassOf(memory: Memory, requested: TransferClass | null | undefined): TransferClass {
  const current = memory.class as TransferClass;
  return requested ?? current;
}

async function transferPreview(
  tx: TransferDb,
  memory: Memory,
  destination: Destination,
  requestedClass: TransferClass | null | undefined,
) {
  const oldRoot = memory.urn.slice(0, memory.urn.indexOf(':'));
  const desiredSlug = memory.urn.slice(memory.urn.lastIndexOf(':') + 1);
  const { urn: newUrn } = await mintLocalSlug({
    root: destination.root,
    desiredSlug,
    authorRoot: oldRoot,
    // A tombstone or legacy alias still occupies a published name. Do not
    // reclaim it as part of a transfer; mint a distinct slug instead.
    isTaken: async (urn) => (await tx.memory.count({
      where: { OR: [{ urn }, { legacyUrn: urn }] },
    })) > 0 || (await tx.urnAlias.count({ where: { urn, entityType: 'MEMORY' } })) > 0,
  });
  const targetClass = targetClassOf(memory, requestedClass);
  const blockers: Blocker[] = [];
  const dependents: Dependent[] = [];
  const add = (kind: string, count: number, handling: Dependent['handling']) => {
    dependents.push({ kind, count, handling });
    if (count > 0 && handling === 'REFUSE') {
      blockers.push({ code: 'MEMORY_TRANSFER_DEPENDENTS', message: `Remove or detach ${kind} (${count}) before transfer.` });
    }
  };
  const id = memory.id;
  add('App scope', memory.appId === null ? 0 : 1, 'REFUSE');
  add('Agent scope', Number(memory.userMemoryOfAgentId !== null) + Number(memory.sharedMemoryOfAgentId !== null), 'REFUSE');
  add('Agent system-memory link', await tx.agent.count({ where: { systemMemoryId: id, deletedAt: null } }), 'REFUSE');
  add('Worker link', await tx.worker.count({ where: { memoryId: id } }), 'REFUSE');
  add('Memory members', await tx.memoryMember.count({ where: { memoryId: id } }), 'REFUSE');
  add('Memory shares', await tx.memoryShare.count({ where: { memoryId: id } }), 'REFUSE');
  add('Agent grants', await tx.agentMemoryItem.count({ where: { memoryId: id, deletedAt: null } }), 'REFUSE');
  add('Scope grants', await tx.scopeMemory.count({ where: { memoryId: id } }), 'REFUSE');
  add('Subscriptions', await tx.memorySubscription.count({ where: { memoryId: id, deletedAt: null } }), 'REFUSE');
  add('Licenses', await tx.memoryLicense.count({ where: { memoryId: id, deletedAt: null } }), 'REFUSE');
  add('Channels', await tx.channel.count({ where: { memoryId: id, deletedAt: null } }), 'REFUSE');
  add('Marketplace listing', Number(memory.listedOnMarketplace), 'REFUSE');
  add('Active sessions', await tx.session.count({ where: { memoryId: id, endedAt: null } }), 'REFUSE');
  // Trigger records retain the entry node's URN rather than a Memory FK. A
  // transfer changes their authorization scope, so the owner must detach them.
  const entryUrns = [memory.urn, memory.legacyUrn].filter((urn): urn is string => !!urn);
  const entryRef = { OR: entryUrns.flatMap((urn) => [
    { entryNodeUrn: { startsWith: `${urn}:` } },
    { entryNodeUrn: { startsWith: `hrn:node:${urn}:` } },
    { entryNodeUrn: { startsWith: `${urn.replace(':', '::')}::` } },
  ]) };
  add('Enabled schedules', await tx.agentSchedule.count({ where: { ...entryRef, enabled: true } }), 'REFUSE');
  add('Enabled webhooks', await tx.agentWebhook.count({ where: { ...entryRef, enabled: true } }), 'REFUSE');
  add('Active web-fetch polls', await tx.webFetchPollBinding.count({ where: { ...entryRef, cancelledAt: null } }), 'REFUSE');
  add('MCP selections (reauthorized on read)', await tx.mcpSessionState.count({ where: { memoryId: id } }), 'CARRY');
  add('Git mirror binding', Number(memory.source !== null || memory.sourceTokenEncrypted !== null || memory.sourceTokenExpiresAt !== null || memory.readBranch !== null || memory.writeBranch !== null), 'REFUSE');
  add('Node mirror provenance', await tx.node.count({ where: { memoryId: id, ownerRepo: { not: null } } }), 'REFUSE');
  add('Nodes', await tx.node.count({ where: { memoryId: id } }), 'CARRY');
  add('Node embeddings', await tx.nodeEmbedding.count({ where: { memoryId: id } }), 'CARRY');
  add('Node revisions', await tx.nodeRevision.count({ where: { memoryId: id } }), 'CARRY');
  add('Node validation reports', await tx.nodeContentValidationReport.count({ where: { memoryId: id } }), 'CARRY');
  add('Edges', await tx.edge.count({ where: { memoryId: id } }), 'CARRY');
  add('Assets', await tx.asset.count({ where: { memoryId: id } }), 'CARRY');
  add('Memory configuration', await tx.memoryConfig.count({ where: { memoryId: id } }), 'CARRY');
  add('Log history', await tx.memoryLogEntry.count({ where: { memoryId: id } }), 'CARRY');
  add('Usage history', await tx.usageEvent.count({ where: { memoryId: id } }), 'CARRY');
  add('Server log history', await tx.serverLogEntry.count({ where: { memoryId: id } }), 'CARRY');
  add('App log history', await tx.appLogEntry.count({ where: { memoryId: id } }), 'CARRY');
  add('Active runs', await tx.appRun.count({ where: {
    status: { in: ['PENDING', 'RUNNING'] },
    OR: [...entryRef.OR, ...entryUrns.flatMap((urn) => [
      { curNodeUrn: { startsWith: `${urn}:` } },
      { curNodeUrn: { startsWith: `hrn:node:${urn}:` } },
    ])],
  } }), 'REFUSE');

  if (memory.class === 'system' || memory.class === 'app') {
    blockers.unshift({ code: 'UNSUPPORTED_MEMORY_CLASS', message: `class='${memory.class}' cannot be transferred independently.` });
  }
  if (destination.kind === 'user' && targetClass !== 'personal' && targetClass !== 'private') {
    blockers.unshift({ code: 'MEMORY_TRANSFER_CLASS_REQUIRED', message: 'A user destination requires an explicit personal or private targetClass.' });
  }
  if (destination.kind === 'organization' && targetClass !== 'knowledge' && targetClass !== 'group') {
    blockers.unshift({ code: 'MEMORY_TRANSFER_CLASS_REQUIRED', message: 'An organization destination requires an explicit knowledge or group targetClass.' });
  }
  if (targetClass === 'group' && destination.kind === 'organization') {
    // The receiving administrator becomes the first group owner on apply.
    add('Receiving group owner', 1, 'CARRY');
  }
  if (memory.isEncrypted) {
    blockers.unshift({ code: 'ENCRYPTED_MEMORY_TRANSFER_UNSUPPORTED', message: 'Encrypted memories cannot be transferred until data-key custody is supported.' });
  }
  if (memory.requiresLicense) {
    blockers.push({ code: 'MEMORY_TRANSFER_DEPENDENTS', message: 'Disable the license requirement before transfer.' });
  }
  if ((destination.kind === 'organization' && memory.organizationId === destination.id) ||
      (destination.kind === 'user' && memory.ownerUserId === destination.id)) {
    blockers.unshift({ code: 'MEMORY_TRANSFER_SAME_OWNER', message: 'The memory already belongs to that owner.' });
  }
  return {
    memoryId: id, oldUrn: memory.urn, newUrn,
    fromOwner: memory.organizationId ?? memory.ownerUserId!,
    toOwner: destination.id,
    currentClass: memory.class,
    targetClass,
    dependents, blockers, canApply: blockers.length === 0, applied: false,
  };
}

export const memoryTransferMutations = {
  transferMemoryOwnership: async (_: unknown, input: TransferInput, ctx: Context) => {
    const { id } = await resolveMemoryRef(ctx.db, input.memoryRef);
    const memory = await ctx.db.memory.findUniqueOrThrow({ where: { id } });
    await authorizeSource(ctx, memory, input.memoryRef);
    const destination = await resolveDestination(ctx, input);
    if (input.dryRun === true) return transferPreview(ctx.db as TransferDb, memory, destination, input.targetClass);

    try {
      return await ctx.db.$transaction(async (tx) => {
        // The FK KEY SHARE taken by new dependents conflicts with this row lock;
        // plan and apply from the same locked snapshot.
        await tx.$queryRaw`SELECT id FROM memories WHERE id = ${id} FOR UPDATE`;
        const current = await tx.memory.findUniqueOrThrow({ where: { id } });
        if (current.deletedAt) throw refusal('MEMORY_NOT_FOUND', 'Memory not found.');
        const txCtx = { ...ctx, db: tx } as Context;
        await authorizeSource(txCtx, current, input.memoryRef);
        const currentDestination = await resolveDestination(txCtx, input);
        const plan = await transferPreview(tx, current, currentDestination, input.targetClass);
        if (plan.blockers.length > 0) throw refusal(plan.blockers[0].code, plan.blockers[0].message);
        if (plan.targetClass === 'group' && !ctx.userId) {
          throw refusal('MEMORY_TRANSFER_GROUP_OWNER_REQUIRED', 'A receiving user is required as the first group owner.');
        }
        if (input.expectedNewUrn != null && input.expectedNewUrn !== plan.newUrn) {
          throw refusal('STALE_TRANSFER_PREVIEW', 'The target URN changed since the preview; run a new dryRun.');
        }
        await tx.memory.update({
          where: { id },
          data: {
            organizationId: currentDestination.kind === 'organization' ? currentDestination.id : null,
            ownerUserId: currentDestination.kind === 'user' ? currentDestination.id : null,
            userId: plan.targetClass === 'personal' || plan.targetClass === 'private' ? currentDestination.id : null,
            class: plan.targetClass,
            visibility: plan.targetClass === 'group' ? 'GROUP' : plan.targetClass === 'knowledge'
              ? (current.class === 'knowledge' ? current.visibility : 'ORGANIZATION') : null,
            listedOnMarketplace: false,
            urn: plan.newUrn,
            legacyUrn: current.urn,
            updatedBy: ctx.userId ?? ctx.clientId ?? null,
          },
        });
        if (plan.targetClass === 'group') {
          await tx.memoryMember.create({
            data: { memoryId: id, userId: ctx.userId!, role: 'owner', createdBy: ctx.userId },
          });
        }
        await recordUrnRename(tx, {
          entityType: 'MEMORY', entityId: id,
          oldUrn: current.urn, newUrn: plan.newUrn,
          createdBy: ctx.userId ?? ctx.clientId ?? null,
        });
        if (current.legacyUrn && current.legacyUrn !== current.urn) {
          await recordUrnRename(tx, {
            entityType: 'MEMORY', entityId: id,
            oldUrn: current.legacyUrn, newUrn: plan.newUrn,
            createdBy: ctx.userId ?? ctx.clientId ?? null,
          });
        }
        await tx.memoryLogEntry.create({
          data: {
            memoryId: id, level: 'INFO', eventType: 'OTHER',
            message: `Memory transferred from ${plan.fromOwner} to ${plan.toOwner}.`,
            detail: {
              oldUrn: current.urn, newUrn: plan.newUrn,
              fromOwner: plan.fromOwner, toOwner: plan.toOwner,
              fromClass: current.class, toClass: plan.targetClass,
              actorId: ctx.userId ?? ctx.clientId ?? null,
            },
            createdBy: ctx.userId ?? ctx.clientId ?? null,
          },
        });
        return { ...plan, applied: true };
      }, { timeout: 15_000 });
    } catch (error) {
      // Two source rows can transfer toward the same free destination URN at
      // once. The unique index is the final arbiter; ask the loser to preview
      // again instead of surfacing Prisma's constraint error.
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        throw refusal('STALE_TRANSFER_PREVIEW', 'The target URN was claimed by another transfer; run a new dryRun.');
      }
      throw error;
    }
  },
};
