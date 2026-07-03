import { createHash, randomBytes } from 'crypto';
import type { PrismaClient } from '../generated/prisma/client.js';
import { APP_KEY_PREFIX } from '../middleware/auth.js';
import { generateId } from '../lib/id.js';
import { normalizeHandleOrNull } from '../lib/userHandle.js';

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
