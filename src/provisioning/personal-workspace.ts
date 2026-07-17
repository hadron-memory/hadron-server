import { createHash, randomBytes } from 'crypto';
import type { PrismaClient } from '../generated/prisma/client.js';
import { APP_KEY_PREFIX } from '../middleware/auth.js';
import { generateId } from '../lib/id.js';
import { normalizeHandleOrNull } from '../lib/userHandle.js';
import { ensureOrgPrincipal } from '../lib/principal/mintPrincipal.js';

interface ProvisionResult {
  orgId: string;
  agentId: string;
  /** App-keyed identity for this workspace. */
  appId: string;
  /** Raw `hdr_app_<…>` API key — shown once, never persisted in plaintext. */
  rawKey: string;
}

/**
 * Provision a personal workspace for a new user.
 *
 * 1. A personal organization (hidden from the user)
 * 2. The user as OWNER of that org
 * 3. A default "My Agent" agent
 * 4. A workstation App with an AppKey (raw key prefixed `hdr_app_`)
 * 5. An AppAgent membership (role=OPERATE) — per-attached-memory write
 *    caps come from AgentMemoryItem.role per spec 005-agent-subscription
 * 6. A PendingSetup record so the raw API key can be shown once
 */
export async function provisionPersonalWorkspace(
  db: PrismaClient,
  userId: string,
  displayName: string,
): Promise<ProvisionResult> {
  // Self-heal (PR-480 review): a REVOKED membership on the user's own
  // personal org must REACTIVATE that workspace, not provision a new one.
  // Personal-org URNs are deterministic (`<handle>-org`, or the
  // `personal-<userId>` fallback), so a second create would either P2002 on
  // the fallback URN (email flow) or read as a concurrent provision (GitHub
  // flow) — neither actually heals the user. hasPersonalWorkspace counts
  // LIVE memberships only, which routes the revoked case here.
  const revoked = await db.orgMember.findFirst({
    where: {
      userId,
      deletedAt: { not: null },
      organization: { isVisible: { not: true }, createdBy: userId, deletedAt: null },
    },
    select: { organizationId: true },
  });
  if (revoked) {
    return reactivatePersonalWorkspace(db, userId, revoked.organizationId);
  }

  // Slug for the personal org. Prefer the user's handle (issue #360) so the
  // org reads as `<handle>-org`; fall back to the guaranteed-unique
  // `personal-<userId>` when the user has no URN-legal handle (email signups,
  // or a GitHub login that wasn't a legal URN atom) OR when `<handle>-org` is
  // already taken — the latter avoids a unique-constraint abort on the signup
  // path. normalizeHandleOrNull re-checks legality so a grandfathered legacy
  // handle can't yield an invalid org URN.
  const userRow = await db.user.findUnique({
    where: { id: userId },
    select: { handle: true },
  });
  const handle = normalizeHandleOrNull(userRow?.handle);
  let urn = `personal-${userId}`;
  if (handle) {
    const candidate = `${handle}-org`;
    const taken = await db.organization.findUnique({
      where: { urn: candidate },
      select: { id: true },
    });
    if (!taken) urn = candidate;
  }

  // 1. Create personal org.
  //
  // The findUnique-then-create above has a TOCTOU window, but we deliberately
  // let a P2002 on `urn` propagate rather than catching it here. Two cases:
  //   - Concurrent provisioning of the SAME user (double signup): both compute
  //     the same slug, one create wins, the other throws P2002. The caller's
  //     idempotency guard absorbs it (GitHub callback: `P2002 → isNew=false`),
  //     same as the pre-existing `personal-<userId>` path (also unique-per-
  //     user). Swallowing it here and retrying would create a SECOND personal
  //     workspace for the user — worse than the abort.
  //   - A different user racing for the same `<handle>-org` is impossible:
  //     `User.handle` is unique, so no two users derive the same candidate.
  // The only unhandled case is a non-personal org squatting `<handle>-org` in
  // the sub-millisecond window after the check — negligible, and it surfaces
  // as the same clean P2002 the caller already tolerates.
  const org = await db.organization.create({
    data: {
      id: generateId(),
      name: displayName,
      urn,
      isVisible: false,
      createdBy: userId,
    },
  });
  // #692: register the personal org in the pool (undotted slug is exempt from
  // the dotted-root rule but still reserves its name). After the create, so the
  // org-urn P2002 stays the personal-workspace race signal the caller tolerates.
  await ensureOrgPrincipal(db, org);

  // 2. Add user as OWNER
  await db.orgMember.create({
    data: {
      id: generateId(),
      organizationId: org.id,
      userId,
      role: 'OWNER',
      canInvite: true,
      createdBy: userId,
    },
  });

  // 3. Create default agent
  const agent = await db.agent.create({
    data: {
      id: generateId(),
      organizationId: org.id,
      urn: `${urn}:my-agent`,
      name: 'My Agent',
      createdBy: userId,
    },
  });

  // 4. Create workstation App + AppKey. The raw key carries the canonical
  //    `hdr_app_` prefix; we store SHA-256 (not bcrypt) because the
  //    resolver looks the key up by hash — bcrypt's per-hash salt would
  //    prevent that. The raw key is 256 bits of randomness, so the SHA-256
  //    image is not vulnerable to dictionary attacks.
  const rawKey = `${APP_KEY_PREFIX}${randomBytes(32).toString('hex')}`;
  const keyHash = createHash('sha256').update(rawKey).digest('hex');
  // 023-app-shape Phase 2b: App↔Agent is N:M via the reintroduced AppAgent
  // join. Create the App with a nested-write AppAgent row in the same
  // statement so the App is never persisted in an orphan state (no
  // installed agents). The AppKey is also created in the same transaction
  // so partial failures roll back cleanly.
  const app = await db.$transaction(async (tx) => {
    const created = await tx.app.create({
      data: {
        id: generateId(),
        name: 'My Workstation',
        urn: `${urn}:my-workstation`,
        organizationId: org.id,
        appType: 'WORKSTATION',
        role: 'READER',
        createdBy: userId,
        appAgents: {
          create: { agentId: agent.id, createdBy: userId },
        },
      },
    });
    await tx.appKey.create({
      data: {
        id: generateId(),
        appId: created.id,
        keyHash,
        keyPreview: rawKey.slice(-4),
        label: 'Initial setup key',
        createdBy: userId,
      },
    });
    return created;
  });

  // 6. Store raw key for the setup page (shown once, then consumed)
  await db.pendingSetup.create({
    data: {
      id: generateId(),
      userId,
      appId: app.id,
      rawKeyEncrypted: rawKey, // TODO: encrypt at rest with app-level key
      createdBy: userId,
    },
  });

  return {
    orgId: org.id,
    agentId: agent.id,
    appId: app.id,
    rawKey,
  };
}

/**
 * Reactivate an existing personal workspace whose OWNER membership was
 * soft-revoked (an invalid state — removeOrgMember's last-owner guard blocks
 * creating it via the API, so this only repairs direct-DB damage). The org,
 * agent, and app are reused; a fresh AppKey is minted and the PendingSetup
 * row is upserted (userId is unique) so the login flow completes exactly like
 * a fresh provision. A workspace shell missing its agent or app is a
 * different corruption — fail loud for operator repair rather than half-
 * provisioning around it.
 */
async function reactivatePersonalWorkspace(
  db: PrismaClient,
  userId: string,
  organizationId: string,
): Promise<ProvisionResult> {
  await db.orgMember.update({
    where: { organizationId_userId: { organizationId, userId } },
    data: {
      deletedAt: null,
      deletedBy: null,
      role: 'OWNER',
      canInvite: true, // the fresh-provision grant for a personal OWNER
      updatedBy: userId,
    },
  });
  const agent = await db.agent.findFirst({
    where: { organizationId, deletedAt: null },
  });
  const app = await db.app.findFirst({
    where: { organizationId, deletedAt: null },
  });
  if (!agent || !app) {
    throw new Error(
      `Personal workspace org ${organizationId} is missing its ${!agent ? 'agent' : 'app'} — manual repair required`,
    );
  }
  const rawKey = `${APP_KEY_PREFIX}${randomBytes(32).toString('hex')}`;
  const keyHash = createHash('sha256').update(rawKey).digest('hex');
  await db.appKey.create({
    data: {
      id: generateId(),
      appId: app.id,
      keyHash,
      keyPreview: rawKey.slice(-4),
      label: 'Workspace reactivation key',
      createdBy: userId,
    },
  });
  await db.pendingSetup.upsert({
    where: { userId },
    create: {
      id: generateId(),
      userId,
      appId: app.id,
      rawKeyEncrypted: rawKey, // TODO: encrypt at rest with app-level key
      createdBy: userId,
    },
    update: { appId: app.id, rawKeyEncrypted: rawKey, consumed: false },
  });
  return { orgId: organizationId, agentId: agent.id, appId: app.id, rawKey };
}

/**
 * Check if a user already has a personal workspace provisioned.
 */
export async function hasPersonalWorkspace(
  db: PrismaClient,
  userId: string,
): Promise<boolean> {
  // deletedAt: null — a revoked personal-org membership (an invalid state;
  // removeOrgMember's last-owner guard blocks creating it) must not count as
  // "has a workspace": every read gate would deny it, so answering true here
  // would strand the user with an inaccessible workspace. Answering false
  // lets provisioning self-heal with a fresh personal org.
  const membership = await db.orgMember.findFirst({
    where: {
      userId,
      deletedAt: null,
      organization: { isVisible: { not: true } },
    },
  });
  return !!membership;
}
