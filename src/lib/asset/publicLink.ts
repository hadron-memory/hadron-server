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
import { currentActor } from '../requestActor.js';
import { managesApp } from '../auth/appManagement.js';
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

/**
 * Does the caller currently manage this asset's memory, for the public-link switch?
 * Pass a transaction context to decide under held anchors. Identity-scoped: never under
 * impersonation, never without a user (an App key never manages).
 */
export async function canManageAssetPublicLink(ctx: Context, memory: PublicLinkMemory): Promise<boolean> {
  if (!ctx.userId || ctx.impersonation) return false;
  if (memory.deletedAt || memory.isEncrypted) return false;
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
        where: { memoryId_userId: { memoryId: memory.id, userId: ctx.userId } },
        select: { role: true },
      });
      return member?.role === 'owner';
    }
    case 'app': {
      // Team space and free-standing App memories only (Proposed): not a session's memory
      // (set userMemoryOfAgentId), not a worker's working memory, not an install memory.
      if (!memory.appId || memory.userMemoryOfAgentId || memory.isInstallMemory) return false;
      const worker = await ctx.db.worker.findFirst({ where: { memoryId: memory.id }, select: { id: true } });
      if (worker) return false;
      // R113: a bound worker session never carries its holder's right to manage the App.
      if (currentActor().workerId) return false;
      const app = await ctx.db.app.findFirst({
        where: { id: memory.appId, deletedAt: null, uninstalledAt: null },
        select: { id: true, organizationId: true, ownerUserId: true },
      });
      return app ? managesApp(ctx, app) : false;
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
 */
export async function setAssetPublicLink(ctx: Context, assetRef: string, enabled: boolean): Promise<Asset> {
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
  if (!(await readsMemory(ctx.db)) && !(await canManageAssetPublicLink(ctx, observed))) throw notFound();

  const result = await withAuthorizedMemoryTx(
    ctx,
    seen.memoryId,
    observed.appId ? [{ kind: 'app' as const, id: observed.appId }] : [],
    async (txCtx) => {
      const memory = await txCtx.db.memory.findUnique({ where: { id: seen.memoryId! }, select: PUBLIC_LINK_MEMORY_SELECT });
      if (!memory) throw notFound();
      await lockDecidingMemberships(txCtx, memory);
      if (!(await canManageAssetPublicLink(txCtx, memory))) {
        // Revoked while we waited: a caller who cannot read either gets the missing-asset answer.
        if (!(await readsMemory(txCtx.db))) throw notFound();
        throw new AssetUploadError('PERMISSION_DENIED', 'caller does not manage this asset\'s memory');
      }
    },
    async (tx) => {
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
      return updated;
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
