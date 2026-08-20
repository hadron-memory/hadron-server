import { randomBytes } from 'crypto';
import { Prisma, type PrismaClient } from '../../generated/prisma/index.js';
import { deleteToolConnection } from '../../lib/emailClient.js';
import { deleteSecretsForOwner } from '../../lib/secrets.js';
import { releasePrincipal } from '../../lib/principal/mintPrincipal.js';
import { softDeleteOrganizationCore } from './softDeleteOrganization.js';
import {
  collectAssetKeysForMemories,
  purgeCollectedAssetObjects,
  type CollectedAssetKeys,
} from '../../lib/asset/purge.js';

/**
 * Thrown when account deletion is blocked because the target is the only
 * active OWNER of one or more organizations that still have OTHER active
 * members (issue #662). Carries the blocking orgs so the GraphQL layer can
 * surface them in `extensions` — the portal shows "transfer ownership first".
 */
export class SoleOrgOwnerError extends Error {
  constructor(public readonly organizations: ReadonlyArray<{ id: string; name: string }>) {
    super(
      'Cannot delete this account: it is the only active owner of one or more ' +
        'organizations that still have other members. Transfer ownership first.',
    );
    this.name = 'SoleOrgOwnerError';
  }
}

export interface DeleteUserAccountArgs {
  /** The account being deleted (already resolved + authorized by the caller). */
  targetUserId: string;
  /** The authenticated actor (self, or a platform admin deleting another user). */
  actorUserId: string;
}

/**
 * How many times the SERIALIZABLE transaction is retried on a P2034
 * serialization abort before the error propagates. The transaction body is
 * side-effect-free outside the DB (no enqueues / emails / git writes), so a
 * bounded re-run is safe (conventions:count-then-act-serializable-txn).
 */
const SERIALIZATION_RETRIES = 3;

/**
 * Self-serve account deletion (issue #662; Apple App Store 5.1.1(v) + GDPR
 * erasure posture). One SERIALIZABLE transaction (the org-owner blocking check
 * is count-then-act — conventions:count-then-act-serializable-txn) that:
 *
 * 1. **Org memberships (auto-resolve policy):**
 *    - target is the sole active OWNER of a live org with OTHER active members
 *      and no other active OWNER ⇒ that org BLOCKS deletion; ALL blockers are
 *      collected and thrown as {@link SoleOrgOwnerError} (nothing committed);
 *    - target is the ONLY active member ⇒ the org is soft-deleted via the same
 *      cascade `deleteOrganization` uses ({@link softDeleteOrganizationCore});
 *    - otherwise the membership row is soft-deleted (deletedAt/deletedBy, the
 *      platform-wide OrgMember revocation shape).
 * 2. **Hard-erases owned data** (true erasure): personal/private memories
 *    (`Memory.userId`), user-owned tenant memories/Apps/Agents (spec 047
 *    `ownerUserId`), relying on the DB-level `ON DELETE CASCADE` chains that
 *    every existing hard-delete path (URN reclaim, anonymous-memory janitor)
 *    already uses. `AgentImport.importedAgent` is `ON DELETE RESTRICT`, so
 *    import edges onto the target's agents are removed first; Apps go before
 *    Memories so app-scoped memories fall to the App cascade; Agents go before
 *    Memories so their system memories (owned rows, no FK) delete cleanly.
 *    Asset object-store keys for EVERY doomed memory (app-scoped and
 *    user-owned alike) are collected before the first of those deletes —
 *    a key exists only on its Asset row, so any cascade that fires first
 *    strands the bytes permanently.
 * 3. **Credentials + linked accounts:** UserApiKeys are REVOKED (audit rows
 *    kept, `revokedAt` — auth already rejects revoked keys and deleted users);
 *    Sessions, AuthCodes, AuthHandoffCodes, ExchangeConnections (provider
 *    tokens; their ConnectionGrants cascade), grantor-side ConnectionGrants,
 *    PrincipalGrants, MemoryShares (granted and received), MemoryMembers,
 *    AppMembers, AgentSubscriptions, DashboardWidgets, DashboardWidgetPresets,
 *    PendingSetup, and user-scoped Secrets are deleted.
 * 4. **Scrubs + soft-deletes the User row:** identity/PII fields nulled, the
 *    handle replaced with a fresh non-identifying `deleted-<12 hex>` value (so
 *    the old handle frees up under the case-insensitive unique index), the
 *    pool principal released (#692 tombstone — the old root name stays
 *    reserved, never re-mintable as someone else). The row itself is KEPT
 *    (deletedAt/deletedBy) for FK integrity of retained billing/audit rows
 *    (UsageEvents, NodeRevisions, audit actor columns).
 *
 * Deleted users can no longer authenticate: both credential paths key on
 * `User.deletedAt` (src/middleware/auth.ts) and every key is revoked anyway.
 */
export async function deleteUserAccount(
  db: PrismaClient,
  { targetUserId, actorUserId }: DeleteUserAccountArgs,
): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    try {
      const { toolConnections, assetKeys } = await runDeletionTxn(
        db,
        targetUserId,
        actorUserId,
      );
      // Provider-sidecar teardown AFTER the commit: the tools hold their own
      // copy of the OAuth credential + change subscriptions, so deleting the
      // core ExchangeConnection rows alone would leave those live. Outside
      // the transaction (external I/O must not ride a retried SERIALIZABLE
      // body) and fire-and-forget per the deleteToolConnection contract —
      // the DB effect is already durable, a dead sidecar must log, not fail.
      for (const c of toolConnections) {
        void deleteToolConnection(c.provider, c.toolConnectionId);
      }
      // Same posture for the deleted memories' files: the Asset rows went
      // with the cascade, so these keys are the last record of the bytes.
      // Post-commit and best-effort — a dead object store must not fail an
      // account deletion (src/lib/asset/purge.ts).
      void purgeCollectedAssetObjects(
        assetKeys,
        `deleteUserAccount(${targetUserId})`,
      );
      return;
    } catch (e) {
      const serializationAbort =
        e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2034';
      if (!serializationAbort || attempt > SERIALIZATION_RETRIES) throw e;
    }
  }
}

/**
 * The single SERIALIZABLE deletion transaction {@link deleteUserAccount}
 * retries. Locks the target's User row up front (`FOR UPDATE`) so two
 * concurrent deletions of the same account serialize instead of double-firing
 * the cascades, and re-checks liveness under the lock.
 */
async function runDeletionTxn(
  db: PrismaClient,
  targetUserId: string,
  actorUserId: string,
): Promise<{
  toolConnections: Array<{ provider: string; toolConnectionId: string }>;
  /** Object-store keys of the deleted memories' assets — purged post-commit. */
  assetKeys: CollectedAssetKeys;
}> {
  return db.$transaction(
    async (tx) => {
      const now = new Date();
      // Lock + liveness re-check under the lock (mergeUsers precedent):
      // resolution happened in the GraphQL layer, so a concurrent delete
      // could otherwise slip between resolve and act.
      const locked = await tx.$queryRaw<{ principal_id: string | null }[]>`
        SELECT principal_id FROM users
        WHERE id = ${targetUserId} AND deleted_at IS NULL FOR UPDATE
      `;
      if (locked.length === 0) throw new Error('User not found');

      // ── 1. Org memberships ──────────────────────────────────────────
      const memberships = await tx.orgMember.findMany({
        where: { userId: targetUserId, deletedAt: null },
        select: {
          organizationId: true,
          role: true,
          organization: { select: { id: true, name: true, deletedAt: true } },
        },
      });
      // Memberships in already-soft-deleted orgs never block and never
      // re-delete the org — they just get the membership soft-delete below.
      const liveMemberships = memberships.filter((m) => !m.organization.deletedAt);

      const blockers: { id: string; name: string }[] = [];
      const soleMemberOrgIds: string[] = [];
      for (const m of liveMemberships) {
        const otherMembers = await tx.orgMember.count({
          where: { organizationId: m.organizationId, userId: { not: targetUserId }, deletedAt: null },
        });
        if (otherMembers === 0) {
          // Only active member (any role) — the org dies with the account.
          soleMemberOrgIds.push(m.organizationId);
          continue;
        }
        if (m.role === 'OWNER') {
          const otherOwners = await tx.orgMember.count({
            where: {
              organizationId: m.organizationId,
              userId: { not: targetUserId },
              role: 'OWNER',
              deletedAt: null,
            },
          });
          if (otherOwners === 0) blockers.push({ id: m.organization.id, name: m.organization.name });
        }
      }
      // Collect ALL blockers before throwing so the portal can list every org
      // that needs an ownership transfer in one round trip. The throw rolls
      // the whole transaction back — NOTHING is deleted.
      if (blockers.length > 0) throw new SoleOrgOwnerError(blockers);

      for (const orgId of soleMemberOrgIds) {
        await softDeleteOrganizationCore(tx, orgId, actorUserId);
      }
      // Soft-delete every remaining live membership row (the platform-wide
      // OrgMember revocation shape — removeOrgMember; audit tuple persists).
      await tx.orgMember.updateMany({
        where: { userId: targetUserId, deletedAt: null },
        data: { deletedAt: now, deletedBy: actorUserId },
      });

      // ── 2. Hard-erase owned data (FK-safe order) ────────────────────
      //
      // FIRST, before anything is deleted: collect the object-store keys of
      // every asset about to be cascaded away. A storage key exists ONLY on
      // its Asset row, so once any cascade fires the bytes are unreachable
      // forever — no reverse index, and for encrypted memories no way to
      // recover the plaintext key at all.
      //
      // This must precede the App delete below, not just the Memory delete:
      // `Memory.app` is onDelete: Cascade, so `tx.app.deleteMany` silently
      // takes every app-scoped memory and its assets with it. Collecting
      // after that point missed them entirely (PR #888 review, Codex P1).
      //
      // Both doomed sets, in one pass:
      //   - app-scoped   — Memory.appId in the target's owned Apps
      //   - user-owned   — Memory.userId (personal/private, spec 034) or
      //                    Memory.ownerUserId (tenant memories, spec 047)
      // The keys are purged from the object store after this transaction
      // commits (see deleteUserAccount).
      const doomedMemories = await tx.memory.findMany({
        where: {
          OR: [
            { app: { ownerUserId: targetUserId } },
            { userId: targetUserId },
            { ownerUserId: targetUserId },
          ],
        },
        select: { id: true },
      });
      const assetKeys = await collectAssetKeysForMemories(
        tx as unknown as PrismaClient,
        doomedMemories.map((m) => m.id),
      );

      // AgentImport.importedAgent is ON DELETE RESTRICT — drop import edges
      // onto the target's agents first (the parent-side FK cascades).
      await tx.agentImport.deleteMany({
        where: { importedAgent: { ownerUserId: targetUserId } },
      });
      // User-owned Apps: the App cascade removes app-scoped memories, keys,
      // members, installs, runs, schedules, webhooks, pending setups — and
      // their Worker castings (Worker.appId cascades).
      await tx.app.deleteMany({ where: { ownerUserId: targetUserId } });
      // Worker castings of the target's agents: `Worker.agentId` is ON DELETE
      // RESTRICT (#974), so any surviving casting would fail the agent delete
      // below with P2003 and roll back the whole erasure. In v1 this set is
      // empty by construction — a user-owned agent is strictly PERSONAL, so
      // it can only ever be cast in the owner's OWN Apps, which the App
      // cascade above just took — but the explicit sweep keeps account
      // erasure whole if agent sharing is ever relaxed (PR #978 review,
      // Copilot). Erasure wins over worker-name permanence for the erased
      // user's own castings, deliberately.
      await tx.worker.deleteMany({ where: { agent: { ownerUserId: targetUserId } } });
      // User-owned Agents (before memories: their system memories are owned
      // rows swept by the memory pass — Agent.systemMemoryId carries no FK).
      await tx.agent.deleteMany({ where: { ownerUserId: targetUserId } });
      // Personal/private memories (Memory.userId, strict owner — spec 034
      // free-standing rows included) AND user-owned tenant memories (spec 047
      // Memory.ownerUserId). The memory cascade removes nodes, edges,
      // embeddings, revisions, assets, subscriptions, licenses, log entries,
      // shares and members of these memories. Their asset keys were
      // collected at the top of this section, before any cascade fired.
      await tx.memory.deleteMany({
        where: { OR: [{ userId: targetUserId }, { ownerUserId: targetUserId }] },
      });

      // ── 3. Credentials + linked accounts ────────────────────────────
      // Keys are REVOKED, not deleted (issuance audit trail); revoked keys and
      // deleted users both fail auth identically (src/middleware/auth.ts).
      await tx.userApiKey.updateMany({
        where: { userId: targetUserId, revokedAt: null },
        data: { revokedAt: now },
      });
      // #1050 — RELEASE the names this person held. The FK is ON DELETE SET
      // NULL, but this operation SOFT-deletes the User row, so that action
      // never fires: an unauthenticatable tombstone would go on holding every
      // one of its names forever, and each subsequent binder would be refused
      // WORKER_HELD by an account that cannot release them. Holding is meant to
      // stop a name being taken from someone who is still there, not to strand
      // it behind someone who is gone (PR #1052 review, Codex P2).
      //
      // The castings themselves are untouched — the name stays permanently
      // allocated to them, and their worklog and handoff history stay intact
      // (cor:agt:020:02). Only the hold is cleared.
      await tx.worker.updateMany({
        where: { heldByUserId: targetUserId },
        data: { heldByUserId: null, heldAt: null },
      });
      await tx.session.deleteMany({ where: { userId: targetUserId } });
      await tx.authCode.deleteMany({ where: { userId: targetUserId } });
      await tx.authHandoffCode.deleteMany({ where: { userId: targetUserId } });
      // Provider mailbox/calendar/drive tokens; ConnectionGrants on these
      // connections cascade with them. Collect provider+toolConnectionId
      // first — the caller tears the sidecar copies down post-commit.
      const toolConnections = await tx.exchangeConnection.findMany({
        where: { userId: targetUserId, toolConnectionId: { not: null } },
        select: { provider: true, toolConnectionId: true },
      });
      await tx.exchangeConnection.deleteMany({ where: { userId: targetUserId } });
      // Grants the target issued on connections that survive elsewhere
      // (defensive — connections are owner-keyed, so normally swept above).
      await tx.connectionGrant.deleteMany({ where: { grantedByUserId: targetUserId } });
      await tx.principalGrant.deleteMany({ where: { principalId: targetUserId } });
      // Shares RECEIVED and shares GRANTED (grantor-of) by the target on
      // memories that survive (shares on erased memories already cascaded).
      await tx.memoryShare.deleteMany({
        where: { OR: [{ granteeId: targetUserId }, { grantorId: targetUserId }] },
      });
      await tx.memoryMember.deleteMany({ where: { userId: targetUserId } });
      await tx.appMember.deleteMany({ where: { userId: targetUserId } });
      await tx.agentSubscription.deleteMany({ where: { userId: targetUserId } });
      await tx.dashboardWidget.deleteMany({ where: { userId: targetUserId } });
      await tx.dashboardWidgetPreset.deleteMany({ where: { userId: targetUserId } });
      await tx.pendingSetup.deleteMany({ where: { userId: targetUserId } });
      await deleteSecretsForOwner(tx, 'user', targetUserId);

      // ── 4. Scrub + soft-delete the User row ─────────────────────────
      // Release the #692 pool principal (tombstone — the root name stays
      // reserved so a dead account's handle can't be re-minted by a stranger;
      // same shape updateMyProfile applies on a handle change).
      if (locked[0].principal_id) await releasePrincipal(tx, locked[0].principal_id);
      // The row is KEPT (not hard-deleted) so retained billing/audit rows
      // (UsageEvents, NodeRevision approvals, audit actor columns) keep a
      // valid FK target — but every identifying field is erased. The fresh
      // random handle satisfies the NOT NULL + unique constraints while
      // freeing the old value under users_handle_lower_uniq (mergeUsers'
      // tombstone-handle precedent).
      await tx.user.update({
        where: { id: targetUserId },
        data: {
          handle: `deleted-${randomBytes(6).toString('hex')}`,
          name: null,
          email: null,
          avatarUrl: null,
          githubId: null,
          githubUsername: null,
          googleId: null,
          appleId: null,
          identityProvider: null,
          externalId: null,
          externalAppId: null,
          linkedAt: null,
          policy: Prisma.DbNull,
          // releasePrincipal tombstones the pool row but leaves detaching to
          // the caller — clear the FK so the scrubbed user no longer points
          // at a released principal.
          principalId: null,
          deletedAt: now,
          deletedBy: actorUserId,
          updatedBy: actorUserId,
        },
      });

      return {
        toolConnections: toolConnections as Array<{
          provider: string;
          toolConnectionId: string;
        }>,
        assetKeys,
      };
    },
    {
      isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
      timeout: 60_000,
      maxWait: 15_000,
    },
  );
}
