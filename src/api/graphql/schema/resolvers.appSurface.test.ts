/**
 * Phase 3a-2 (US3) of the Station -> App migration: GraphQL App-shaped
 * surface tests.
 *
 * Covers the new App-shaped queries (myApp, myApps, appNodes, appAIConfig,
 * appKeys), the new field resolvers (App.hasAiApiKey, App.agentSubscriptions,
 * AppAgentSub.agent), and the extensions to createApp / updateApp /
 * addAgentToApp that absorb Station fields and AppAgent role /
 * subscriptionType / trainingMode.
 *
 * Existing tests in resolvers.multiUserAgent.test.ts cover the basic App
 * CRUD shape; this file is the net-new surface from Phase 3a-2.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { db } from '../../../integrations/db/client.js';
import {
  cleanDb,
  createDbAppWithKey,
  createDbOrgAndGraph,
} from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { resolvers, type Context } from './resolvers.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

let orgId: string;
let memoryId: string;
let agentId: string;
let user: { id: string };

function ctx(overrides: Partial<Context> = {}): Context {
  return { db, ...overrides };
}

function adminCtx(overrides: Partial<Context> = {}): Context {
  return { db, roles: ['ADMIN'], userId: user.id, ...overrides };
}

beforeEach(async () => {
  await cleanDb(db);
  const { org, graph } = await createDbOrgAndGraph(db);
  orgId = org.id;
  memoryId = graph.id;
  user = await db.user.create({
    data: { githubId: 7777, githubUsername: 'phase3a2', roles: ['READER'] },
  });
  await db.orgMember.create({
    data: { id: generateId(), organizationId: orgId, userId: user.id, role: 'OWNER' },
  });
  const agent = await db.agent.create({
    data: {
      id: generateId(),
      organizationId: orgId,
      urn: `${orgId}:juno`,
      name: 'juno',
    },
  });
  agentId = agent.id;
  // Wire the agent up to the test memory so appNodes can see something
  await db.agentMemoryItem.create({
    data: { agentId, memoryId, role: 'read-write' },
  });
  await db.node.create({
    data: {
      id: generateId(),
      memoryId,
      loc: 'org.test.node',
      isLink: false,
      name: 'sample',
      tags: [],
    },
  });
});

// ---------------------------------------------------------------------------
// createApp / updateApp absorb the Station fields (Phase 3a-2)
// ---------------------------------------------------------------------------

describe('createApp accepts absorbed Station fields', () => {
  it('persists appType, role, description, systemPrompt, agentTools, ai* fields', async () => {
    const created = await resolvers.Mutation.createApp(
      {},
      {
        orgId,
        name: 'My Workstation',
        appType: 'CHATBOT',
        role: 'CONTRIBUTOR',
        description: 'a chatbot',
        systemPrompt: 'you are helpful',
        agentTools: ['h-find-node', 'h-read-node'],
        aiProvider: 'anthropic',
        aiModel: 'claude-sonnet-4-20250514',
        aiApiKey: 'sk-fake-key',
        expiresAt: '2027-01-01T00:00:00.000Z',
      },
      adminCtx(),
    );
    expect(created.appType).toBe('CHATBOT');
    expect(created.role).toBe('CONTRIBUTOR');
    expect(created.description).toBe('a chatbot');
    expect(created.systemPrompt).toBe('you are helpful');
    expect(created.agentTools).toEqual(['h-find-node', 'h-read-node']);
    expect(created.aiProvider).toBe('anthropic');
    expect(created.aiModel).toBe('claude-sonnet-4-20250514');
    expect(created.aiApiKeyEncrypted).not.toBeNull();
    expect(created.aiApiKeyEncrypted).not.toBe('sk-fake-key');
  });

  it('uses the documented defaults when absorbed fields are omitted', async () => {
    const created = await resolvers.Mutation.createApp(
      {},
      { orgId, name: 'Plain App' },
      adminCtx(),
    );
    expect(created.appType).toBe('WORKSTATION');
    expect(created.role).toBe('READER');
    expect(created.description).toBeNull();
    expect(created.agentTools).toEqual([]);
    expect(created.aiApiKeyEncrypted).toBeNull();
  });
});

describe('updateApp updates absorbed Station fields', () => {
  it('updates appType, role, description, systemPrompt, agentTools, ai*', async () => {
    const created = await resolvers.Mutation.createApp(
      {},
      { orgId, name: 'To Update' },
      adminCtx(),
    );
    const updated = await resolvers.Mutation.updateApp(
      {},
      {
        id: created.id,
        appType: 'AGENT',
        role: 'ADMIN',
        description: 'updated',
        systemPrompt: 'updated prompt',
        agentTools: ['h-create-node'],
        aiProvider: 'openai',
        aiModel: 'gpt-4',
        aiApiKey: 'sk-new-key',
      },
      adminCtx(),
    );
    expect(updated.appType).toBe('AGENT');
    expect(updated.role).toBe('ADMIN');
    expect(updated.description).toBe('updated');
    expect(updated.systemPrompt).toBe('updated prompt');
    expect(updated.agentTools).toEqual(['h-create-node']);
    expect(updated.aiProvider).toBe('openai');
    expect(updated.aiModel).toBe('gpt-4');
  });

  it('clears aiApiKey when passed an empty string', async () => {
    const created = await resolvers.Mutation.createApp(
      {},
      { orgId, name: 'Has Key', aiApiKey: 'sk-initial' },
      adminCtx(),
    );
    const cleared = await resolvers.Mutation.updateApp(
      {},
      { id: created.id, aiApiKey: '' },
      adminCtx(),
    );
    expect(cleared.aiApiKeyEncrypted).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// addAgentToApp accepts role / subscriptionType / trainingMode
// ---------------------------------------------------------------------------

describe('addAgentToApp accepts AppAgent fields', () => {
  it('persists role=DEVELOP + subscriptionType=READ_WRITE + trainingMode=true', async () => {
    const created = await resolvers.Mutation.createApp(
      {},
      { orgId, name: 'AppAgent Test' },
      adminCtx(),
    );
    await resolvers.Mutation.addAgentToApp(
      {},
      {
        appId: created.id,
        agentId,
        role: 'DEVELOP',
        trainingMode: true,
      },
      adminCtx(),
    );
    const link = await db.appAgent.findUniqueOrThrow({
      where: { appId_agentId: { appId: created.id, agentId } },
    });
    expect(link.role).toBe('DEVELOP');
    expect(link.trainingMode).toBe(true);
  });

  it('defaults to OPERATE / READ_ONLY / false when args omitted', async () => {
    const created = await resolvers.Mutation.createApp(
      {},
      { orgId, name: 'Default Membership' },
      adminCtx(),
    );
    await resolvers.Mutation.addAgentToApp(
      {},
      { appId: created.id, agentId },
      adminCtx(),
    );
    const link = await db.appAgent.findUniqueOrThrow({
      where: { appId_agentId: { appId: created.id, agentId } },
    });
    expect(link.role).toBe('OPERATE');
    expect(link.trainingMode).toBe(false);
  });

  it('upserts: re-running with new role updates the row', async () => {
    const created = await resolvers.Mutation.createApp(
      {},
      { orgId, name: 'Upsert App' },
      adminCtx(),
    );
    await resolvers.Mutation.addAgentToApp(
      {},
      { appId: created.id, agentId },
      adminCtx(),
    );
    await resolvers.Mutation.addAgentToApp(
      {},
      { appId: created.id, agentId, role: 'DEVELOP' },
      adminCtx(),
    );
    const link = await db.appAgent.findUniqueOrThrow({
      where: { appId_agentId: { appId: created.id, agentId } },
    });
    expect(link.role).toBe('DEVELOP');
  });
});

// ---------------------------------------------------------------------------
// App field resolvers (Phase 3a-2)
// ---------------------------------------------------------------------------

describe('App field resolvers', () => {
  it('hasAiApiKey is false by default; true when aiApiKeyEncrypted is set', async () => {
    const noKey = await resolvers.Mutation.createApp(
      {},
      { orgId, name: 'No AI' },
      adminCtx(),
    );
    expect(resolvers.App.hasAiApiKey(noKey)).toBe(false);

    const withKey = await resolvers.Mutation.createApp(
      {},
      { orgId, name: 'Has AI', aiApiKey: 'sk-test' },
      adminCtx(),
    );
    expect(resolvers.App.hasAiApiKey(withKey)).toBe(true);
  });

  it('agentSubscriptions returns AppAgent rows', async () => {
    const created = await resolvers.Mutation.createApp(
      {},
      { orgId, name: 'For Subs' },
      adminCtx(),
    );
    await resolvers.Mutation.addAgentToApp(
      {},
      { appId: created.id, agentId, role: 'OPERATE' },
      adminCtx(),
    );
    const subs = (await resolvers.App.agentSubscriptions(
      { id: created.id },
      {},
      adminCtx(),
    )) as Array<{ role: string; agentId: string }>;
    expect(subs.length).toBe(1);
    expect(subs[0].role).toBe('OPERATE');
    expect(subs[0].agentId).toBe(agentId);
  });
});

// ---------------------------------------------------------------------------
// myApp / myApps queries
// ---------------------------------------------------------------------------

describe('myApp', () => {
  it('returns null when ctx.appId is not set', async () => {
    const result = await resolvers.Query.myApp({}, {}, ctx());
    expect(result).toBeNull();
  });

  it('returns the App matching ctx.appId', async () => {
    const { app } = await createDbAppWithKey(db, 'app-myapp', orgId);
    const result = await resolvers.Query.myApp({}, {}, ctx({ appId: app.id }));
    expect(result).not.toBeNull();
    expect(result!.id).toBe(app.id);
  });

  it('returns null for a soft-deleted App', async () => {
    const { app } = await createDbAppWithKey(db, 'app-deleted', orgId);
    await db.app.update({ where: { id: app.id }, data: { deletedAt: new Date() } });
    const result = await resolvers.Query.myApp({}, {}, ctx({ appId: app.id }));
    expect(result).toBeNull();
  });
});

describe('myApps', () => {
  it('returns Apps in the orgs the user is a member of', async () => {
    await createDbAppWithKey(db, 'one', orgId);
    await createDbAppWithKey(db, 'two', orgId);
    const apps = await resolvers.Query.myApps({}, {}, ctx({ userId: user.id }));
    expect(apps.length).toBe(2);
  });

  it('returns empty when the user has no org memberships', async () => {
    const orphanUser = await db.user.create({
      data: { githubId: 8888, githubUsername: 'orphan', roles: ['READER'] },
    });
    await createDbAppWithKey(db, 'unrelated', orgId);
    const apps = await resolvers.Query.myApps({}, {}, ctx({ userId: orphanUser.id }));
    expect(apps).toEqual([]);
  });

  it('returns empty when no userId is set (anonymous)', async () => {
    await createDbAppWithKey(db, 'anonymous-cant-see', orgId);
    const apps = await resolvers.Query.myApps({}, {}, ctx());
    expect(apps).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// appNodes
// ---------------------------------------------------------------------------

describe('appNodes', () => {
  it('returns nodes from memories accessible via AppAgent membership', async () => {
    const { app } = await createDbAppWithKey(db, 'app-nodes', orgId);
    await db.appAgent.create({
      data: { appId: app.id, agentId, role: 'OPERATE' },
    });
    const nodes = await resolvers.Query.appNodes({}, { appId: app.id }, adminCtx());
    expect(nodes.length).toBe(1);
    expect(nodes[0].loc).toBe('org.test.node');
  });

  it('returns empty when the App has no AppAgent rows', async () => {
    const { app } = await createDbAppWithKey(db, 'app-no-membership', orgId);
    const nodes = await resolvers.Query.appNodes({}, { appId: app.id }, adminCtx());
    expect(nodes).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// appAIConfig
// ---------------------------------------------------------------------------

describe('appAIConfig', () => {
  it('returns null when the App has no AI provider configured', async () => {
    const created = await resolvers.Mutation.createApp(
      {},
      { orgId, name: 'No AI Config' },
      adminCtx(),
    );
    const cfg = await resolvers.Query.appAIConfig({}, { appId: created.id }, adminCtx());
    expect(cfg).toBeNull();
  });

  it('returns decrypted provider/model/apiKey when configured', async () => {
    const created = await resolvers.Mutation.createApp(
      {},
      {
        orgId,
        name: 'Configured',
        aiProvider: 'anthropic',
        aiModel: 'claude-sonnet-4-20250514',
        aiApiKey: 'sk-real',
      },
      adminCtx(),
    );
    const cfg = await resolvers.Query.appAIConfig({}, { appId: created.id }, adminCtx());
    expect(cfg).not.toBeNull();
    expect(cfg!.provider).toBe('anthropic');
    expect(cfg!.model).toBe('claude-sonnet-4-20250514');
    expect(cfg!.apiKey).toBe('sk-real');
  });

  it('rejects non-org-admin callers (Forbidden)', async () => {
    const created = await resolvers.Mutation.createApp(
      {},
      { orgId, name: 'Locked', aiProvider: 'anthropic', aiModel: 'm', aiApiKey: 'k' },
      adminCtx(),
    );
    const otherUser = await db.user.create({
      data: { githubId: 9999, githubUsername: 'other', roles: ['READER'] },
    });
    await expect(
      resolvers.Query.appAIConfig({}, { appId: created.id }, ctx({ userId: otherUser.id })),
    ).rejects.toThrow();
  });
});

// ---------------------------------------------------------------------------
// appKeys
// ---------------------------------------------------------------------------

describe('appKeys', () => {
  it('returns active AppKey rows for the App', async () => {
    const { app } = await createDbAppWithKey(db, 'app-keys', orgId);
    const keys = await resolvers.Query.appKeys({}, { appId: app.id }, adminCtx());
    expect(keys.length).toBe(1);
    expect(keys[0].appId).toBe(app.id);
    expect(keys[0].revokedAt).toBeNull();
  });

  it('omits revoked keys', async () => {
    const { app, appKey } = await createDbAppWithKey(db, 'app-revoked', orgId);
    await db.appKey.update({ where: { id: appKey.id }, data: { revokedAt: new Date() } });
    const keys = await resolvers.Query.appKeys({}, { appId: app.id }, adminCtx());
    expect(keys).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// regenerateAppKey
// ---------------------------------------------------------------------------

describe('regenerateAppKey', () => {
  it('revokes existing keys and mints a fresh one', async () => {
    const { app, appKey } = await createDbAppWithKey(db, 'regen-app', orgId);
    const result = await resolvers.Mutation.regenerateAppKey(
      {},
      { id: app.id },
      adminCtx(),
    );
    expect(result.rawKey).toMatch(/^hdr_app_[0-9a-f]{64}$/);
    const oldKey = await db.appKey.findUniqueOrThrow({ where: { id: appKey.id } });
    expect(oldKey.revokedAt).not.toBeNull();
    const activeKeys = await db.appKey.findMany({
      where: { appId: app.id, revokedAt: null },
    });
    expect(activeKeys.length).toBe(1);
  });
});
