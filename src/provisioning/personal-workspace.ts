import { randomBytes } from 'crypto';
import bcrypt from 'bcrypt';
import type { PrismaClient } from '../generated/prisma/client.js';

interface ProvisionResult {
  orgId: string;
  agentId: string;
  stationId: string;
  rawKey: string;
}

/**
 * Provision a personal workspace for a new user.
 *
 * Creates:
 * 1. A personal organization (hidden from the user)
 * 2. The user as OWNER of that org
 * 3. A default "My Memories" agent
 * 4. A workstation client with an API key
 * 5. An agent subscription (READ_WRITE) for the client
 * 6. A PendingSetup record so the raw API key can be shown once
 */
export async function provisionPersonalWorkspace(
  db: PrismaClient,
  userId: string,
  displayName: string,
): Promise<ProvisionResult> {
  // Generate a unique domain for the personal org
  const domain = `personal-${userId}`;

  // 1. Create personal org
  const org = await db.organization.create({
    data: {
      name: displayName,
      domain,
      isVisible: false,
    },
  });

  // 2. Add user as OWNER
  await db.orgMember.create({
    data: {
      organizationId: org.id,
      userId,
      role: 'OWNER',
      canInvite: true,
    },
  });

  // 3. Create default agent
  const agent = await db.agent.create({
    data: {
      organizationId: org.id,
      name: 'My Memories',
    },
  });

  // 4. Create workstation station with API key
  const rawKey = randomBytes(32).toString('hex');
  const keyHash = await bcrypt.hash(rawKey, 12);
  const station = await db.station.create({
    data: {
      label: 'My Workstation',
      keyHash,
      stationType: 'WORKSTATION',
      role: 'READER',
      organizationId: org.id,
      userId,
    },
  });

  // 5. Subscribe station to default agent
  await db.stationAgentSubscription.create({
    data: {
      stationId: station.id,
      agentId: agent.id,
      subscriptionType: 'READ_WRITE',
    },
  });

  // 6. Store raw key for the setup page (shown once, then consumed)
  await db.pendingSetup.create({
    data: {
      userId,
      stationId: station.id,
      rawKeyEncrypted: rawKey, // TODO: encrypt at rest with app-level key
    },
  });

  return {
    orgId: org.id,
    agentId: agent.id,
    stationId: station.id,
    rawKey,
  };
}

/**
 * Check if a user already has a personal workspace provisioned,
 * or already has any station (e.g. from seed data).
 */
export async function hasPersonalWorkspace(
  db: PrismaClient,
  userId: string,
): Promise<boolean> {
  const [membership, station] = await Promise.all([
    db.orgMember.findFirst({
      where: {
        userId,
        organization: { isVisible: { not: true } },
      },
    }),
    db.station.findFirst({
      where: { userId, deletedAt: null },
    }),
  ]);
  return !!membership || !!station;
}
