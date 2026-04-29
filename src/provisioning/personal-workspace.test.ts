/**
 * Phase 3a (US3) of the Station -> App migration: provisioning tests.
 *
 * Verifies that provisionPersonalWorkspace creates an App-keyed workspace
 * (App + AppKey + AppAgent + PendingSetup), not a Station, and that the
 * raw key it returns can be resolved by the auth middleware.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { createHash } from 'crypto';
import { db } from '../integrations/db/client.js';
import { cleanDb } from '../test/helpers.js';
import { APP_KEY_PREFIX } from '../middleware/auth.js';
import { generateId } from '../lib/id.js';
import { provisionPersonalWorkspace, hasPersonalWorkspace } from './personal-workspace.js';

let userId: string;

beforeEach(async () => {
  await cleanDb(db);
  // Create a User to provision a workspace for
  const user = await db.user.create({
    data: {
      id: generateId(),
      githubId: 1234,
      githubUsername: 'test-user',
      identityProvider: 'GITHUB',
      name: 'Test User',
      roles: ['READER'],
    },
  });
  userId = user.id;
});

describe('provisionPersonalWorkspace', () => {
  it('returns appId + a hdr_app_-prefixed raw key', async () => {
    const result = await provisionPersonalWorkspace(db, userId, 'Test User');

    expect(result.appId).toBeDefined();
    expect(result.rawKey).toMatch(/^hdr_app_[0-9a-f]{64}$/);
    expect(result.orgId).toBeDefined();
    expect(result.agentId).toBeDefined();
  });

  it('creates an App with appType=WORKSTATION (not a Station)', async () => {
    const { appId } = await provisionPersonalWorkspace(db, userId, 'Test User');

    const app = await db.app.findUnique({ where: { id: appId } });
    expect(app).toBeDefined();
    expect(app!.appType).toBe('WORKSTATION');
    expect(app!.role).toBe('READER');
    expect(app!.name).toBe('My Workstation');

    // No Station should be provisioned for a Phase-3a-or-later signup
    const stations = await db.station.findMany({ where: { userId } });
    expect(stations).toHaveLength(0);
  });

  it('stores the AppKey hash as SHA-256 of the raw key (auth resolver compat)', async () => {
    const { appId, rawKey } = await provisionPersonalWorkspace(db, userId, 'Test User');

    const expectedHash = createHash('sha256').update(rawKey).digest('hex');
    const appKey = await db.appKey.findFirst({ where: { appId } });

    expect(appKey).toBeDefined();
    expect(appKey!.keyHash).toBe(expectedHash);
    expect(appKey!.keyPreview).toBe(rawKey.slice(-4));
    expect(appKey!.label).toBe('Initial setup key');
  });

  it('creates an AppAgent with role=OPERATE and subscriptionType=READ_WRITE', async () => {
    const { appId, agentId } = await provisionPersonalWorkspace(db, userId, 'Test User');

    const appAgent = await db.appAgent.findUnique({
      where: { appId_agentId: { appId, agentId } },
    });
    expect(appAgent).toBeDefined();
    expect(appAgent!.role).toBe('OPERATE');
    expect(appAgent!.subscriptionType).toBe('READ_WRITE');
    expect(appAgent!.trainingMode).toBe(false);
  });

  it('writes a PendingSetup record carrying appId', async () => {
    const { appId, rawKey } = await provisionPersonalWorkspace(db, userId, 'Test User');

    const setup = await db.pendingSetup.findUnique({ where: { userId } });
    expect(setup).toBeDefined();
    expect(setup!.appId).toBe(appId);
    // PendingSetup.stationId was dropped in Phase 3a-1 — the only writer
    // is App-only and rows are ephemeral, so the legacy column had no
    // remaining purpose. (Verified by the type system: the field no
    // longer exists on the row.)
    expect('stationId' in setup!).toBe(false);
    expect(setup!.consumed).toBe(false);
    expect(setup!.rawKeyEncrypted).toBe(rawKey); // TODO: encrypt at rest
  });

  it('creates the personal Org as not-visible, with the user as OWNER', async () => {
    const { orgId } = await provisionPersonalWorkspace(db, userId, 'Test User');

    const org = await db.organization.findUnique({ where: { id: orgId } });
    expect(org!.isVisible).toBe(false);

    const member = await db.orgMember.findFirst({
      where: { organizationId: orgId, userId },
    });
    expect(member).toBeDefined();
    expect(member!.role).toBe('OWNER');
    expect(member!.canInvite).toBe(true);
  });

  it('creates the default agent named "My Memories"', async () => {
    const { agentId, orgId } = await provisionPersonalWorkspace(db, userId, 'Test User');

    const agent = await db.agent.findUnique({ where: { id: agentId } });
    expect(agent).toBeDefined();
    expect(agent!.name).toBe('My Memories');
    expect(agent!.organizationId).toBe(orgId);
  });
});

describe('hasPersonalWorkspace', () => {
  it('returns false before any workspace is provisioned', async () => {
    expect(await hasPersonalWorkspace(db, userId)).toBe(false);
  });

  it('returns true after provisioning a Phase-3a App workspace', async () => {
    await provisionPersonalWorkspace(db, userId, 'Test User');
    expect(await hasPersonalWorkspace(db, userId)).toBe(true);
  });
});
