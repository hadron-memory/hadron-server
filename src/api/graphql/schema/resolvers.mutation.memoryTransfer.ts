import { GraphQLError } from 'graphql';
import { Prisma, type Memory } from '../../../generated/prisma/index.js';
import { resolveMemoryRef } from '../../../lib/entityRef/memoryRef.js';
import { resolveOrgRef } from '../../../lib/entityRef/orgRef.js';
import { resolveUserRef } from '../../../lib/entityRef/userRef.js';
import { mintLocalSlug } from '../../../lib/mintLocalSlug.js';
import { recordUrnRename } from '../../../lib/urnAlias.js';
import { requireOrgAction } from '../../../lib/auth/orgAction.js';
import { withAuthorizedTx } from './authorizedTx.js';
import {
  type Context,
  concealUnreadableDenial,
  isPlatformAdmin,
  requireOrgRole,
} from './resolvers.helpers.js';
import { forbiddenError } from '../../../lib/refusals.js';

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
  resetGroupMembers?: boolean | null;
  dryRun?: boolean | null;
};
type Dependent = { kind: string; count: number; handling: 'CARRY' | 'REFUSE' | 'REMOVE' | 'CREATE' };
type Blocker = { code: string; message: string };

function refusal(code: string, message: string): GraphQLError {
  return new GraphQLError(message, { extensions: { code } });
}

/** The source gate runs before any dependency or destination detail is returned. */
async function authorizeSource(ctx: Context, memory: Memory, ref: string): Promise<void> {
  await concealUnreadableDenial(ctx, memory.id, ref, async () => {
    if (!ctx.userId || ctx.impersonation) throw forbiddenError();
    // personal/private's strict owner is separate from the tenant owner. An
    // org ADMIN cannot read, edit, or transfer someone else's private content.
    if (memory.userId !== null) {
      if (memory.userId !== ctx.userId) throw forbiddenError();
      return;
    }
    if (isPlatformAdmin(ctx)) return;
    if (memory.ownerUserId !== null) {
      if (memory.ownerUserId !== ctx.userId) throw forbiddenError();
      return;
    }
    if (memory.organizationId !== null) {
      await requireOrgAction(ctx, memory.organizationId, 'memory.delete');
      return;
    }
    throw forbiddenError();
  });
}

/** Resolve a target only after source authorization, preserving the strict-owner transfer boundary. */
async function resolveDestination(ctx: Context, input: TransferInput, source: Memory): Promise<Destination> {
  if ((input.orgRef == null) === (input.userRef == null)) {
    throw refusal('BAD_USER_INPUT', 'Provide exactly one of orgRef or userRef.');
  }
  // cor:acl:010:02: strict-owned content may leave the owner's namespace
  // only for an organization they administer, with an explicit class change.
  // Check before resolving userRef so a target user's existence is not exposed.
  if (source.userId !== null && input.userRef != null) {
    throw refusal('MEMORY_TRANSFER_USER_TARGET_UNSUPPORTED',
      'A personal or private memory can be transferred only to an organization the owner administers.');
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

/** Serialize destination root renames before locking the source Memory. */
async function lockDestinationRoot(tx: TransferDb, destination: Destination): Promise<void> {
  // Both rename paths lock their owner row first, then cascade into Memory
  // rows. Follow that order so a rename cannot finish between root lookup
  // and the transfer's ownership/URN update.
  const rows = destination.kind === 'user'
    ? await tx.$queryRaw<{ id: string }[]>`SELECT id FROM users WHERE id = ${destination.id} FOR UPDATE`
    : await tx.$queryRaw<{ id: string }[]>`SELECT id FROM organizations WHERE id = ${destination.id} FOR UPDATE`;
  if (rows.length === 0) {
    throw refusal('STALE_TRANSFER_PREVIEW', 'The destination changed since the preview; run a new dryRun.');
  }
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
  resetGroupMembers: boolean | null | undefined,
  actorUserId: string | undefined,
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
      blockers.push({
        code: 'MEMORY_TRANSFER_DEPENDENTS',
        message: kind === 'Memory members' && memory.class === 'group'
          ? `Pass resetGroupMembers: true to revoke all ${count} group member(s) as part of the transfer.`
          : `Remove or detach ${kind} (${count}) before transfer.`,
      });
    }
  };
  const id = memory.id;
  add('App scope', memory.appId === null ? 0 : 1, 'REFUSE');
  add('Agent scope', Number(memory.userMemoryOfAgentId !== null) + Number(memory.sharedMemoryOfAgentId !== null), 'REFUSE');
  add('Agent system-memory link', await tx.agent.count({ where: { systemMemoryId: id, deletedAt: null } }), 'REFUSE');
  add('Worker link', await tx.worker.count({ where: { memoryId: id } }), 'REFUSE');
  add('Memory members', await tx.memoryMember.count({ where: { memoryId: id } }),
    memory.class === 'group' && resetGroupMembers === true ? 'REMOVE' : 'REFUSE');
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
  const oldAliases = await tx.urnAlias.findMany({
    where: { entityType: 'MEMORY', entityId: id }, select: { urn: true },
  });
  const entryUrns = [...new Set([memory.urn, memory.legacyUrn, ...oldAliases.map((a) => a.urn)]
    .filter((urn): urn is string => !!urn))];
  const entryPrefixes = entryUrns.flatMap((urn) => [
    `${urn}:`, `hrn:node:${urn}:`, `${urn.replace(':', '::')}::`,
    `hrn:node:${urn.replace(':', '::')}::`,
  ]);
  const entryRef = { OR: entryPrefixes.map((prefix) => ({ entryNodeUrn: { startsWith: prefix } })) };
  // Only the source tenant's triggers are dependents the source owner can
  // manage. Counting foreign tenants' refs would leak their trigger inventory
  // and let one of them block a transfer indefinitely. Historical node URNs
  // continue to resolve through aliases; ordinary run authorization applies.
  const sourceOrgId = memory.organizationId;
  add('Schedules', sourceOrgId ? await tx.agentSchedule.count({ where: { ...entryRef, organizationId: sourceOrgId, deletedAt: null } }) : 0, 'REFUSE');
  add('Webhooks', sourceOrgId ? await tx.agentWebhook.count({ where: { ...entryRef, organizationId: sourceOrgId, deletedAt: null } }) : 0, 'REFUSE');
  add('Active web-fetch polls', sourceOrgId ? await tx.webFetchPollBinding.count({ where: { ...entryRef, organizationId: sourceOrgId, cancelledAt: null } }) : 0, 'REFUSE');
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
  add('Active runs', sourceOrgId ? await tx.appRun.count({ where: {
    organizationId: sourceOrgId,
    status: { in: ['PENDING', 'RUNNING'] },
    OR: [...entryRef.OR, ...entryPrefixes.map((prefix) => ({ curNodeUrn: { startsWith: prefix } }))],
  } }) : 0, 'REFUSE');

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
    add('Receiving group owner', 1, 'CREATE');
    if (!actorUserId) {
      blockers.unshift({ code: 'MEMORY_TRANSFER_GROUP_OWNER_REQUIRED', message: 'A receiving user is required as the first group owner.' });
    }
  }
  if (resetGroupMembers === true && memory.class !== 'group') {
    blockers.unshift({ code: 'MEMORY_TRANSFER_MEMBER_RESET_INVALID', message: 'resetGroupMembers applies only to a group-class source.' });
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
    const destination = await resolveDestination(ctx, input, memory);
    if (input.dryRun === true) return transferPreview(ctx.db as TransferDb, memory, destination, input.targetClass, input.resetGroupMembers, ctx.userId);

    try {
      let current: Memory;
      let currentDestination: Destination;
      return await withAuthorizedTx(
        ctx,
        [
          { kind: 'memory', id },
          ...(memory.organizationId ? [{ kind: 'org' as const, id: memory.organizationId }] : []),
          ...(memory.ownerUserId ? [{ kind: 'user' as const, id: memory.ownerUserId }] : []),
          ...(memory.userId ? [{ kind: 'user' as const, id: memory.userId }] : []),
          destination.kind === 'organization'
            ? { kind: 'org', id: destination.id }
            : { kind: 'user', id: destination.id },
        ],
        async (txCtx) => {
          if (current.organizationId !== memory.organizationId ||
              current.ownerUserId !== memory.ownerUserId || current.userId !== memory.userId) {
            throw refusal('STALE_TRANSFER_PREVIEW', 'Memory ownership changed since the preview; run a new dryRun.');
          }
          await authorizeSource(txCtx, current, input.memoryRef);
          currentDestination = await resolveDestination(txCtx, input, current);
          if (currentDestination.kind !== destination.kind || currentDestination.id !== destination.id) {
            throw refusal('STALE_TRANSFER_PREVIEW', 'The destination changed since the preview; run a new dryRun.');
          }
        },
        async (tx) => {
        const plan = await transferPreview(tx, current, currentDestination, input.targetClass, input.resetGroupMembers, ctx.userId);
        if (plan.blockers.length > 0) throw refusal(plan.blockers[0].code, plan.blockers[0].message);
        if (input.expectedNewUrn != null && input.expectedNewUrn !== plan.newUrn) {
          throw refusal('STALE_TRANSFER_PREVIEW', 'The target URN changed since the preview; run a new dryRun.');
        }
        if (current.class === 'group' && input.resetGroupMembers === true) {
          await tx.memoryMember.deleteMany({ where: { memoryId: id } });
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
            removedGroupMembers: plan.dependents.find((d) => d.kind === 'Memory members' && d.handling === 'REMOVE')?.count ?? 0,
            actorId: ctx.userId ?? ctx.clientId ?? null,
            },
            createdBy: ctx.userId ?? ctx.clientId ?? null,
          },
        });
        return { ...plan, applied: true };
        },
        { lockMode: 'exclusive', timeout: 15_000, afterLock: async (tx) => {
          // Destination root locks precede the Memory row lock, matching the
          // rename cascade. Both row locks follow the authority anchors.
          await lockDestinationRoot(tx, destination);
          await tx.$queryRaw`SELECT id FROM memories WHERE id = ${id} FOR UPDATE`;
          current = await tx.memory.findUniqueOrThrow({ where: { id } });
          if (current.deletedAt) throw refusal('MEMORY_NOT_FOUND', 'Memory not found.');
        } },
      );
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
