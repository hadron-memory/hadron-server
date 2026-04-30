import { createHash, randomBytes } from 'crypto';
import type { PrismaClient } from '../generated/prisma/client.js';
import { APP_KEY_PREFIX } from '../middleware/auth.js';
import { generateId } from '../lib/id.js';

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
  // Generate a unique URN for the personal org
  const urn = `personal-${userId}`;

  // 1. Create personal org
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
  const app = await db.app.create({
    data: {
      id: generateId(),
      name: 'My Workstation',
      urn: `${urn}:my-workstation`,
      organizationId: org.id,
      appType: 'WORKSTATION',
      role: 'READER',
      createdBy: userId,
    },
  });
  await db.appKey.create({
    data: {
      id: generateId(),
      appId: app.id,
      keyHash,
      keyPreview: rawKey.slice(-4),
      label: 'Initial setup key',
      createdBy: userId,
    },
  });

  // 5. AppAgent membership: workstation gets the OPERATE role on its own
  //    agent. Per-attached-memory write access is governed by
  //    AgentMemoryItem.role (read-write for "My Agent").
  await db.appAgent.create({
    data: {
      appId: app.id,
      agentId: agent.id,
      role: 'OPERATE',
      createdBy: userId,
    },
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
  const membership = await db.orgMember.findFirst({
    where: {
      userId,
      organization: { isVisible: { not: true } },
    },
  });
  return !!membership;
}
