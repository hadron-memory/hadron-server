/**
 * provisionPersonalWorkspace creates an App-keyed workspace
 * (App + AppKey + AppAgent + PendingSetup), and the raw key it returns
 * can be resolved by the auth middleware.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { getPrimaryAgentId } from '../lib/appAgent.js';
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

  it('creates an App with appType=WORKSTATION', async () => {
    const { appId } = await provisionPersonalWorkspace(db, userId, 'Test User');

    const app = await db.app.findUnique({ where: { id: appId } });
    expect(app).toBeDefined();
    expect(app!.appType).toBe('WORKSTATION');
    expect(app!.role).toBe('READER');
    expect(app!.name).toBe('My Workstation');
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

  it('sets App.agent_id to the provisioned Agent (008 — direct FK, no AppAgent)', async () => {
    const { appId, agentId } = await provisionPersonalWorkspace(db, userId, 'Test User');

    const app = await db.app.findUniqueOrThrow({ where: { id: appId } });
    expect((await getPrimaryAgentId(db, app.id))).toBe(agentId);
    expect(app.trainingMode).toBe(false);
  });

  it('writes a PendingSetup record carrying appId', async () => {
    const { appId, rawKey } = await provisionPersonalWorkspace(db, userId, 'Test User');

    const setup = await db.pendingSetup.findUnique({ where: { userId } });
    expect(setup).toBeDefined();
    expect(setup!.appId).toBe(appId);
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

  it('creates the default agent named "My Agent"', async () => {
    const { agentId, orgId } = await provisionPersonalWorkspace(db, userId, 'Test User');

    const agent = await db.agent.findUnique({ where: { id: agentId } });
    expect(agent).toBeDefined();
    expect(agent!.name).toBe('My Agent');
    expect(agent!.organizationId).toBe(orgId);
  });
});

describe('hasPersonalWorkspace', () => {
  it('returns false before any workspace is provisioned', async () => {
    expect(await hasPersonalWorkspace(db, userId)).toBe(false);
  });

  it('returns true after provisioning an App workspace', async () => {
    await provisionPersonalWorkspace(db, userId, 'Test User');
    expect(await hasPersonalWorkspace(db, userId)).toBe(true);
  });
});
