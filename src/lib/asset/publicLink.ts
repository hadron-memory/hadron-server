/**
 * The per-asset public-link switch (#1667, cor:dmo:060:15).
 *
 * One core serves GraphQL `setAssetPublicLink` and MCP `hadron_set_asset_public_link`,
 * so the manager gate, the authority recheck and the audit row are decided once.
 *
 * Three different questions, kept apart on purpose:
 *   - the STORED opt-in (`Asset.publicLinkEnabled`): policy, never proof of publication;
 *   - WHO MAY SWITCH IT ({@link canManageAssetPublicLink}): the memory's manager, never a
 *     mere writer; strictly the owner in personal/private memory;
 *   - whether the anonymous route WOULD SERVE it: decided in `src/api/assetPublic.ts` (route) and the
 *     Asset.publicUrl field: the stored opt-in AND the deployment gate AND the existing live/CLEAN/
 *     unencrypted checks.
 *
 * The switch is inert, and refused, for session memory and encrypted memory (cor:dmo:060:15
 * Exceptions, Proposed). Worker working memory, system memory and install memory have no
 * management contract in the table, so they answer false rather than inferring one.
 */

import type { Asset, Prisma } from '../../generated/prisma/index.js';
import { generateId } from '../id.js';
import { lockAppKeyManagerMemberships } from '../../api/graphql/schema/appKeyManagement.js';
import {
  requireMemoryManageAccess,
  type Context,
} from '../../api/graphql/schema/resolvers.helpers.js';
import { withAuthorizedMemoryTx } from '../../api/graphql/schema/authorizedTx.js';
import { canReadMemory } from '../../mcp/access-control.js';
import { AssetUploadError } from '../../controller/operations/beginAssetUpload.js';
import { logAssetEvent } from './audit.js';
import { unauthenticatedError } from '../refusals.js';
import type { ActAdmission, ActInstruction } from '../auth/instructedAct.js';
import { admitAppManagement, lockInstructedActRows } from '../../api/graphql/schema/resolvers.instruction.js';
import { lockWorkersForAssignment } from '../agentTasks/workerLock.js';
import { appendCredentialInstructionEvent } from '../agentTasks/events.js';

/** The Memory columns the manager decision reads. */
export type PublicLinkMemory = {
  id: string;
  class: string;
  userId: string | null;
  organizationId: string | null;
  ownerUserId: string | null;
  appId: string | null;
  userMemoryOfAgentId: string | null;
  isInstallMemory: boolean;
  isEncrypted: boolean;
  deletedAt: Date | null;
};

export const PUBLIC_LINK_MEMORY_SELECT = {
  id: true, class: true, userId: true, organizationId: true, ownerUserId: true, appId: true,
  userMemoryOfAgentId: true, isInstallMemory: true, isEncrypted: true, deletedAt: true,
} as const;

/** Is the caller's gate failure a plain "no"? Anything else (a DB fault) must propagate. */
function isDenial(e: unknown): boolean {
  return e instanceof Error && e.message.startsWith('Forbidden');
}

/** The App door's own refusal inside the shared admission: it becomes "does not manage", never an error. */
class AppLinkRefused extends Error {}

/**
 * Who is switching the link, for this memory (cor:dmo:060:15, cor:dmo:050:12; #3322), or null when nobody is
 * allowed to. A person answers as themselves. On an App memory a bound worker session is admitted only on a
 * validated instruction, through #3307's one shared check, and the manager decision runs on the HOLDER
 * (`managesApp`), never on the worker. Every other class keeps its own rule, which reads the caller's user (the
 * holder, for a worker session). Pass a transaction context to decide under held anchors, and the first
 * admission as `expected` to refuse a different principal after its locks were taken.
 */
export async function assetPublicLinkAdmission(
  ctx: Context,
  memory: PublicLinkMemory,
  instruction?: ActInstruction | null,
  expected?: ActAdmission,
): Promise<ActAdmission | null> {
  if (!ctx.userId || ctx.impersonation) return null;
  if (memory.deletedAt || memory.isEncrypted) return null;
  if (memory.class !== 'app') {
    return (await canManageNonAppMemory(ctx, memory)) ? { kind: 'person', userId: ctx.userId } : null;
  }
  // Team space and free-standing App memories only (Proposed): not a session's memory
  // (set userMemoryOfAgentId), not a worker's working memory, not an install memory.
  if (!memory.appId || memory.userMemoryOfAgentId || memory.isInstallMemory) return null;
  const worker = await ctx.db.worker.findFirst({ where: { memoryId: memory.id }, select: { id: true } });
  if (worker) return null;
  const app = await ctx.db.app.findFirst({
    where: { id: memory.appId, deletedAt: null, uninstalledAt: null },
    select: { id: true, organizationId: true, ownerUserId: true },
  });
  if (!app) return null;
  try {
    return await admitAppManagement(ctx, app, () => new AppLinkRefused(), instruction, expected);
  } catch (e) {
    if (e instanceof AppLinkRefused) return null;
    throw e;
  }
}

/**
 * Does the caller currently manage this asset's memory, for the public-link switch?
 * Pass a transaction context to decide under held anchors. Identity-scoped: never under
 * impersonation, never without a user (an App key never manages). With no `instruction` this is the
 * headless answer: a worker session never manages an App memory's link on a read (cor:dmo:050:12).
 */
export async function canManageAssetPublicLink(
  ctx: Context, memory: PublicLinkMemory, instruction?: ActInstruction | null,
): Promise<boolean> {
  return (await assetPublicLinkAdmission(ctx, memory, instruction)) !== null;
}

async function canManageNonAppMemory(ctx: Context, memory: PublicLinkMemory): Promise<boolean> {
  switch (memory.class) {
    case 'personal':
    case 'private':
      // cor:acl:010:02 — strictly the owner; a platform admin never gets it. The owner must also pass
      // the memory read gate's App fold (008 isolation, #1719 R5a): ownership alone must not let a
      // caller pinned to App A publish an asset in its owner's App B memory (Rico's P1 on #2287).
      if (memory.userId !== ctx.userId) return false;
      return canReadMemory(
        ctx.db,
        { userId: ctx.userId, appId: ctx.appId, roles: ctx.roles, organizationId: ctx.organizationId },
        memory.id,
      );
    case 'knowledge':
    case 'group': {
      try {
        await requireMemoryManageAccess(ctx, memory, 'ADMIN');
        return true;
      } catch (e) {
        if (!isDenial(e)) throw e;
      }
      if (memory.class !== 'group') return false;
      const member = await ctx.db.memoryMember.findUnique({
        where: { memoryId_userId: { memoryId: memory.id, userId: ctx.userId! } },
        select: { role: true },
      });
      return member?.role === 'owner';
    }
    default:
      // system, and anything unclassified: no management contract, so no switch.
      return false;
  }
}

/** Lock the rows the manager decision reads, so a revocation queued behind us is seen or waits. */
async function lockDecidingMemberships(txCtx: Context, memory: PublicLinkMemory): Promise<void> {
  const tx = txCtx.db;
  if (!txCtx.userId) return;
  if (memory.organizationId) {
    await tx.$queryRaw`SELECT user_id FROM org_members WHERE organization_id = ${memory.organizationId} AND user_id = ${txCtx.userId} FOR SHARE`;
  }
  if (memory.class === 'group') {
    await tx.$queryRaw`SELECT user_id FROM memory_members WHERE memory_id = ${memory.id} AND user_id = ${txCtx.userId} FOR SHARE`;
  }
  if (memory.class === 'app' && memory.appId) {
    const app = await tx.app.findUnique({
      where: { id: memory.appId }, select: { id: true, organizationId: true, ownerUserId: true },
    });
    if (app) await lockAppKeyManagerMemberships(tx as Prisma.TransactionClient, txCtx, app);
  }
}

/**
 * Switch an asset's public link on or off.
 *
 * Refusals: an asset the caller cannot read (or that is missing, deleted or staged) is
 * `NOT_FOUND`; a readable asset the caller does not manage is `PERMISSION_DENIED`. A refused
 * call changes neither the flag nor the audit. A successful call, including one that leaves
 * the flag unchanged, writes one audit row in the same transaction.
 *
 * #3322 (cor:dmo:050:12): on an App memory a worker session acts only on a validated `instruction`, judged on
 * its holder, and an admitted instructed call that changes the flag also writes one ids-only team event.
 */
export async function setAssetPublicLink(
  ctx: Context, assetRef: string, enabled: boolean, instruction?: ActInstruction | null,
): Promise<Asset> {
  if (!ctx.userId) throw unauthenticatedError();
  const notFound = () => new AssetUploadError('NOT_FOUND', 'asset not found');
  if (ctx.impersonation) throw notFound();

  const seen = await ctx.db.asset.findUnique({ where: { id: assetRef }, select: { id: true, memoryId: true, deletedAt: true } });
  if (!seen || seen.deletedAt || !seen.memoryId) throw notFound();
  const observed = await ctx.db.memory.findUnique({ where: { id: seen.memoryId }, select: PUBLIC_LINK_MEMORY_SELECT });
  if (!observed || observed.deletedAt) throw notFound();
  // A manager who cannot read the memory's content (an org ADMIN over a group they are not in,
  // cor:dmo:060:15's table) still manages it; anyone else who cannot read gets the missing-asset answer.
  const readsMemory = (db: Context['db']) => canReadMemory(
    db,
    { userId: ctx.userId, appId: ctx.appId, roles: ctx.roles, organizationId: ctx.organizationId },
    seen.memoryId!,
  );
  const first = await assetPublicLinkAdmission(ctx, observed, instruction);
  if (!(await readsMemory(ctx.db)) && !first) throw notFound();

  // #3322: who acts, decided once on the transaction and judged again on the locked rows. A refused call
  // (no admission) never reaches a write, so it records nothing either.
  let admission: ActAdmission | null = first;
  const denied = async (txCtx: Context) => {
    // Revoked while we waited: a caller who cannot read either gets the missing-asset answer.
    if (!(await readsMemory(txCtx.db))) return notFound();
    return new AssetUploadError('PERMISSION_DENIED', 'caller does not manage this asset\'s memory');
  };

  const result = await withAuthorizedMemoryTx(
    ctx,
    seen.memoryId,
    observed.appId ? [{ kind: 'app' as const, id: observed.appId }] : [],
    async (txCtx) => {
      const memory = await txCtx.db.memory.findUnique({ where: { id: seen.memoryId! }, select: PUBLIC_LINK_MEMORY_SELECT });
      if (!memory) throw notFound();
      await lockDecidingMemberships(txCtx, memory);
      admission = await assetPublicLinkAdmission(txCtx, memory, instruction, first ?? undefined);
      if (!admission) throw await denied(txCtx);
    },
    async (tx, txCtx) => {
      if (admission?.kind === 'instructed-worker') {
        // The holder's worker and session rows are locked, then judged again: a release or session end that
        // won the race wins. Taken before the asset row, so the asset's lock stays the last the act takes.
        await lockInstructedActRows(tx, [admission.workerId], ctx.sessionId);
        const memory = await txCtx.db.memory.findUnique({ where: { id: seen.memoryId! }, select: PUBLIC_LINK_MEMORY_SELECT });
        if (!memory) throw notFound();
        admission = await assetPublicLinkAdmission(txCtx, memory, instruction, admission);
        if (!admission) throw await denied(txCtx);
      }
      // Recheck the asset itself under its own lock: a delete or move that won the race wins.
      const rows = await tx.$queryRaw<Array<{ memory_id: string | null; deleted_at: Date | null; public_link_enabled: boolean }>>`
        SELECT memory_id, deleted_at, public_link_enabled FROM assets WHERE id = ${seen.id} FOR UPDATE`;
      const row = rows[0];
      if (!row || row.deleted_at || row.memory_id !== seen.memoryId) throw notFound();
      const updated = await tx.asset.update({ where: { id: seen.id }, data: { publicLinkEnabled: enabled } });
      await tx.assetPublicLinkAudit.create({
        data: {
          id: generateId(),
          assetId: seen.id,
          memoryId: seen.memoryId!,
          actorUserId: ctx.userId!,
          enabled,
          previouslyEnabled: row.public_link_enabled,
        },
      });
      // One ids-only record of an admitted instructed toggle that changed the flag; a no-op records none.
      if (admission && observed.appId && row.public_link_enabled !== enabled) {
        await appendCredentialInstructionEvent(tx, { appId: observed.appId, admission, act: 'asset.public-link' });
      }
      return updated;
    },
    {
      afterLock: async (tx) => {
        if (first?.kind === 'instructed-worker') await lockWorkersForAssignment(tx, [first.workerId]);
      },
    },
  );

  logAssetEvent({
    operation: 'public-link-set',
    assetId: result.id,
    memoryId: result.memoryId,
    userId: ctx.userId,
    reason: enabled ? 'public link on' : 'public link off',
  });
  return result;
}
