import { randomBytes } from 'crypto';
import bcrypt from 'bcrypt';
import type { PrismaClient } from '../generated/prisma/client.js';

interface ProvisionResult {
  orgId: string;
  bundleId: string;
  clientId: string;
  rawKey: string;
}

/**
 * Provision a personal workspace for a new user.
 *
 * Creates:
 * 1. A personal organization (hidden from the user)
 * 2. The user as OWNER of that org
 * 3. A default "My Memories" bundle
 * 4. A workstation client with an API key
 * 5. A bundle subscription (READ_WRITE) for the client
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
      isPersonal: true,
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

  // 3. Create default bundle
  const bundle = await db.memoryBundle.create({
    data: {
      organizationId: org.id,
      name: 'My Memories',
    },
  });

  // 4. Create workstation client with API key
  const rawKey = randomBytes(32).toString('hex');
  const keyHash = await bcrypt.hash(rawKey, 12);
  const client = await db.client.create({
    data: {
      label: 'My Workstation',
      keyHash,
      clientType: 'WORKSTATION',
      role: 'READER',
      organizationId: org.id,
      userId,
    },
  });

  // 5. Subscribe client to default bundle
  await db.clientBundleSubscription.create({
    data: {
      clientId: client.id,
      bundleId: bundle.id,
      subscriptionType: 'READ_WRITE',
    },
  });

  // 6. Store raw key for the setup page (shown once, then consumed)
  await db.pendingSetup.create({
    data: {
      userId,
      clientId: client.id,
      rawKeyEncrypted: rawKey, // TODO: encrypt at rest with app-level key
    },
  });

  return {
    orgId: org.id,
    bundleId: bundle.id,
    clientId: client.id,
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
      organization: { isPersonal: true },
    },
  });
  return !!membership;
}
