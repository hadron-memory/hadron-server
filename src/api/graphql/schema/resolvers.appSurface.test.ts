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
import { getPrimaryAgentId } from '../../../lib/appAgent.js';
import { resolvers, type Context } from './resolvers.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

let orgId: string;
let memoryId: string;
let agentId: string;
// 023-app-shape: createApp installs `agentId` as the App's first Agent via the
// AppAgent join. Tests that exercise addAgentToApp use this second agent to
// avoid DuplicateAppAgentError on the composite PK.
let secondAgentId: string;
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
  const secondAgent = await db.agent.create({
    data: {
      id: generateId(),
      organizationId: orgId,
      urn: `${orgId}:vega`,
      name: 'vega',
    },
  });
  secondAgentId = secondAgent.id;
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
        agentId,
        name: 'My Workstation',
        appType: 'CHATBOT',
        role: 'CONTRIBUTOR',
        description: 'a chatbot',
        systemPrompt: 'you are helpful',
        agentTools: ['hadron_find_nodes', 'hadron_get_node'],
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
    expect(created.agentTools).toEqual(['hadron_find_nodes', 'hadron_get_node']);
    // 036-ai-service-config: the legacy args land in the App's 'default'
    // registry config (columns dropped).
    const config = await db.aiServiceConfig.findFirstOrThrow({
      where: { appId: created.id, name: 'default' },
    });
    expect(config.provider).toBe('anthropic');
    expect(config.model).toBe('claude-sonnet-4-20250514');
    expect(config.apiKeyEncrypted).not.toBeNull();
    expect(config.apiKeyEncrypted).not.toBe('sk-fake-key');
  });

  it('uses the documented defaults when absorbed fields are omitted', async () => {
    const created = await resolvers.Mutation.createApp(
      {},
      { orgId, agentId, name: 'Plain App' },
      adminCtx(),
    );
    expect(created.appType).toBe('WORKSTATION');
    expect(created.role).toBe('READER');
    expect(created.description).toBeNull();
    expect(created.agentTools).toEqual([]);
    expect(
      await db.aiServiceConfig.findFirst({ where: { appId: created.id, name: 'default' } }),
    ).toBeNull();
  });
});

describe('updateApp updates absorbed Station fields', () => {
  it('updates appType, role, description, systemPrompt, agentTools, ai*', async () => {
    const created = await resolvers.Mutation.createApp(
      {},
      { orgId, agentId, name: 'To Update' },
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
        agentTools: ['hadron_create_node'],
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
    expect(updated.agentTools).toEqual(['hadron_create_node']);
    const config = await db.aiServiceConfig.findFirstOrThrow({
      where: { appId: created.id, name: 'default' },
    });
    expect(config.provider).toBe('openai');
    expect(config.model).toBe('gpt-4');
  });

  it('clears aiApiKey when passed an empty string', async () => {
    // 036-ai-service-config: provider+model are required for a config row
    // to exist; key-only createApp args create no config (legacy quirk
    // dropped with the columns).
    const created = await resolvers.Mutation.createApp(
      {},
      { orgId, agentId, name: 'Has Key', aiProvider: 'anthropic', aiModel: 'claude-opus-4-6', aiApiKey: 'sk-initial' },
      adminCtx(),
    );
    const cleared = await resolvers.Mutation.updateApp(
      {},
      { id: created.id, aiApiKey: '' },
      adminCtx(),
    );
    expect(cleared.id).toBe(created.id);
    const config = await db.aiServiceConfig.findFirstOrThrow({
      where: { appId: created.id, name: 'default' },
    });
    expect(config.apiKeyEncrypted).toBeNull();
    expect(config.apiKeyPreview).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// addAgentToApp accepts role / subscriptionType / trainingMode
// ---------------------------------------------------------------------------

describe('addAgentToApp accepts AppAgent fields', () => {
  // 023-app-shape: createApp installs the first Agent via AppAgent. These
  // tests use `secondAgentId` for the addAgentToApp call to avoid the
  // DuplicateAppAgentError that re-adding the same agent would hit on the
  // composite PK.
  it('persists trainingMode=true alongside the second Agent install', async () => {
    const created = await resolvers.Mutation.createApp(
      {},
      { orgId, agentId, name: 'AppAgent Test' },
      adminCtx(),
    );
    await resolvers.Mutation.addAgentToApp(
      {},
      {
        appId: created.id,
        agentId: secondAgentId,
        trainingMode: true,
      },
      adminCtx(),
    );
    // 023-app-shape FR-001: trainingMode is on App (per-App), not AppAgent.
    // 023-app-shape FR-003: no role column on AppAgent — system memory is
    // universally read-only.
    const updated = await db.app.findUniqueOrThrow({ where: { id: created.id } });
    expect(await getPrimaryAgentId(db, updated.id)).toBe(agentId);
    const secondaryInstalled = await db.appAgent.findUnique({
      where: { appId_agentId: { appId: updated.id, agentId: secondAgentId } },
    });
    expect(secondaryInstalled).not.toBeNull();
    expect(updated.trainingMode).toBe(true);
  });

  it('defaults trainingMode to false when args omitted', async () => {
    const created = await resolvers.Mutation.createApp(
      {},
      { orgId, agentId, name: 'Default Membership' },
      adminCtx(),
    );
    await resolvers.Mutation.addAgentToApp(
      {},
      { appId: created.id, agentId: secondAgentId },
      adminCtx(),
    );
    const updated = await db.app.findUniqueOrThrow({ where: { id: created.id } });
    expect(await getPrimaryAgentId(db, updated.id)).toBe(agentId);
    expect(updated.trainingMode).toBe(false);
  });

  it('addAgentToApp installs a second Agent and propagates trainingMode', async () => {
    // Renamed from the pre-023 "idempotently updates App.agent_id" test —
    // App.agent_id is gone; "idempotency" doesn't apply to a composite-PK
    // join. The behavior worth covering is that adding a second Agent
    // succeeds and trainingMode propagates from the call.
    const created = await resolvers.Mutation.createApp(
      {},
      { orgId, agentId, name: 'Install App' },
      adminCtx(),
    );
    await resolvers.Mutation.addAgentToApp(
      {},
      { appId: created.id, agentId: secondAgentId, trainingMode: true },
      adminCtx(),
    );
    const updated = await db.app.findUniqueOrThrow({ where: { id: created.id } });
    const installedIds = (
      await db.appAgent.findMany({ where: { appId: updated.id }, select: { agentId: true } })
    ).map((r) => r.agentId);
    expect(installedIds).toEqual(expect.arrayContaining([agentId, secondAgentId]));
    expect(updated.trainingMode).toBe(true);
  });

  it('addAgentToApp rejects re-installing the same Agent with DUPLICATE_APP_AGENT', async () => {
    // Pins the composite-PK contract that replaced the pre-023 idempotent
    // upsert. Re-calling with an already-installed agent is a typed error,
    // not a silent no-op — callers detect it via extensions.code.
    const created = await resolvers.Mutation.createApp(
      {},
      { orgId, agentId, name: 'Dup App' },
      adminCtx(),
    );
    await expect(
      resolvers.Mutation.addAgentToApp(
        {},
        { appId: created.id, agentId },
        adminCtx(),
      ),
    ).rejects.toMatchObject({
      extensions: { code: 'DUPLICATE_APP_AGENT' },
    });
  });
});

// ---------------------------------------------------------------------------
// App field resolvers (Phase 3a-2)
// ---------------------------------------------------------------------------

describe('App field resolvers', () => {
  it('hasAiApiKey is false by default; true when a default config has a key', async () => {
    const noKey = await resolvers.Mutation.createApp(
      {},
      { orgId, agentId, name: 'No AI' },
      adminCtx(),
    );
    expect(await resolvers.App.hasAiApiKey(noKey, {}, adminCtx())).toBe(false);

    // 036-ai-service-config: hasAiApiKey reads the App's 'default'
    // registry config; provider+model are required for the row to exist.
    const withKey = await resolvers.Mutation.createApp(
      {},
      { orgId, agentId, name: 'Has AI', aiProvider: 'anthropic', aiModel: 'claude-opus-4-6', aiApiKey: 'sk-test' },
      adminCtx(),
    );
    expect(await resolvers.App.hasAiApiKey(withKey, {}, adminCtx())).toBe(true);
  });

  it('App.agent resolver returns the linked Agent (008 — replaces agentSubscriptions)', async () => {
    const created = await resolvers.Mutation.createApp(
      {},
      { orgId, name: 'For Agent', agentId },
      adminCtx(),
    );
    const agent = await resolvers.App.agent(
      { id: created.id },
      {},
      adminCtx(),
    );
    expect(agent).not.toBeNull();
    expect((agent as { id: string }).id).toBe(agentId);
  });

  it('App.members returns the AppMember rows for the App', async () => {
    const created = await resolvers.Mutation.createApp(
      {},
      { orgId, name: 'For Members', agentId },
      adminCtx(),
    );
    await resolvers.Mutation.ensureAppMember(
      {},
      { appId: created.id, userId: user.id, role: 'owner' },
      adminCtx(),
    );
    const members = await resolvers.App.members({ id: created.id }, {}, adminCtx());
    expect(members.length).toBe(1);
    expect((members as Array<{ userId: string; role: string }>)[0].userId).toBe(user.id);
    expect((members as Array<{ userId: string; role: string }>)[0].role).toBe('owner');

    const count = await resolvers.App.memberCount({ id: created.id }, {}, adminCtx());
    expect(count).toBe(1);
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
  it('returns nodes from memories accessible via App.agent_id', async () => {
    const { app } = await createDbAppWithKey(db, 'app-nodes', orgId);
    await db.appAgent.create({ data: { appId: app.id, agentId } });
    const nodes = await resolvers.Query.appNodes({}, { appId: app.id }, adminCtx());
    expect(nodes.length).toBe(1);
    expect(nodes[0].loc).toBe('org.test.node');
  });

  it('returns empty when the App is orphan (agent_id IS NULL)', async () => {
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
      { orgId, agentId, name: 'No AI Config' },
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
        agentId,
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
      { orgId, agentId, name: 'Locked', aiProvider: 'anthropic', aiModel: 'm', aiApiKey: 'k' },
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

// ---------------------------------------------------------------------------
// 007-entity-id-or-urn — App-keyed ops accept either ID or URN
// ---------------------------------------------------------------------------

describe('007-entity-id-or-urn — App ops accept ID or URN', () => {
  it('Query.app accepts a URN', async () => {
    const created = await resolvers.Mutation.createApp(
      {},
      { orgId, agentId, name: 'urn-app-q' },
      adminCtx(),
    );
    const stored = await db.app.findUniqueOrThrow({
      where: { id: created.id },
      select: { urn: true },
    });
    const byUrn = await resolvers.Query.app({}, { id: stored.urn }, adminCtx());
    expect(byUrn?.id).toBe(created.id);
  });

  it('Query.app accepts a prefixed URN (urn:app:...)', async () => {
    const created = await resolvers.Mutation.createApp(
      {},
      { orgId, agentId, name: 'urn-app-q-prefix' },
      adminCtx(),
    );
    const stored = await db.app.findUniqueOrThrow({
      where: { id: created.id },
      select: { urn: true },
    });
    const byUrn = await resolvers.Query.app({}, { id: `urn:app:${stored.urn}` }, adminCtx());
    expect(byUrn?.id).toBe(created.id);
  });

  it('updateApp accepts a URN as id', async () => {
    const created = await resolvers.Mutation.createApp(
      {},
      { orgId, agentId, name: 'urn-update' },
      adminCtx(),
    );
    const stored = await db.app.findUniqueOrThrow({
      where: { id: created.id },
      select: { urn: true },
    });
    const updated = await resolvers.Mutation.updateApp(
      {},
      { id: stored.urn, description: 'via-urn' },
      adminCtx(),
    );
    expect(updated.description).toBe('via-urn');
  });

  it('deleteApp accepts a URN as id', async () => {
    const created = await resolvers.Mutation.createApp(
      {},
      { orgId, agentId, name: 'urn-delete' },
      adminCtx(),
    );
    const stored = await db.app.findUniqueOrThrow({
      where: { id: created.id },
      select: { urn: true },
    });
    const ok = await resolvers.Mutation.deleteApp({}, { id: stored.urn }, adminCtx());
    expect(ok).toBe(true);
    const after = await db.app.findUnique({ where: { id: created.id } });
    expect(after?.deletedAt).not.toBeNull();
  });

  it('addAgentToApp accepts URNs for both appId and agentId', async () => {
    const created = await resolvers.Mutation.createApp(
      {},
      { orgId, agentId, name: 'urn-add-agent' },
      adminCtx(),
    );
    const appStored = await db.app.findUniqueOrThrow({
      where: { id: created.id },
      select: { urn: true },
    });
    const secondStored = await db.agent.findUniqueOrThrow({
      where: { id: secondAgentId },
      select: { urn: true },
    });
    // Install the *second* agent via URN — createApp already installed `agentId`.
    await resolvers.Mutation.addAgentToApp(
      {},
      { appId: appStored.urn, agentId: secondStored.urn },
      adminCtx(),
    );
    const installed = await db.appAgent.findUnique({
      where: { appId_agentId: { appId: created.id, agentId: secondAgentId } },
    });
    expect(installed).not.toBeNull();
  });

  it('removeAgentFromApp accepts URNs for both appId and agentId', async () => {
    const created = await resolvers.Mutation.createApp(
      {},
      { orgId, agentId, name: 'urn-remove-agent' },
      adminCtx(),
    );
    // Install the second agent so there are 2 AppAgent rows; then remove
    // the first via URN. Final state: only the second agent remains.
    await resolvers.Mutation.addAgentToApp(
      {},
      { appId: created.id, agentId: secondAgentId },
      adminCtx(),
    );
    const appStored = await db.app.findUniqueOrThrow({
      where: { id: created.id },
      select: { urn: true },
    });
    const agentStored = await db.agent.findUniqueOrThrow({
      where: { id: agentId },
      select: { urn: true },
    });
    await resolvers.Mutation.removeAgentFromApp(
      {},
      { appId: appStored.urn, agentId: agentStored.urn },
      adminCtx(),
    );
    const remaining = await db.appAgent.findMany({
      where: { appId: created.id },
      select: { agentId: true },
    });
    expect(remaining.map((r) => r.agentId)).toEqual([secondAgentId]);
  });

  it('createAppKey accepts a URN as appId', async () => {
    const created = await resolvers.Mutation.createApp(
      {},
      { orgId, agentId, name: 'urn-createkey' },
      adminCtx(),
    );
    const stored = await db.app.findUniqueOrThrow({
      where: { id: created.id },
      select: { urn: true },
    });
    const result = await resolvers.Mutation.createAppKey(
      {},
      { appId: stored.urn },
      adminCtx(),
    );
    expect(result.key.appId).toBe(created.id);
    expect(result.rawKey).toMatch(/^hdr_app_[0-9a-f]{64}$/);
  });

  it('regenerateAppKey accepts a URN as id', async () => {
    const { app } = await createDbAppWithKey(db, 'regen-via-urn', orgId);
    const stored = await db.app.findUniqueOrThrow({
      where: { id: app.id },
      select: { urn: true },
    });
    const result = await resolvers.Mutation.regenerateAppKey(
      {},
      { id: stored.urn },
      adminCtx(),
    );
    expect(result.app.id).toBe(app.id);
    expect(result.rawKey).toMatch(/^hdr_app_[0-9a-f]{64}$/);
  });

  it('appNodes / appAIConfig / appKeys accept URN as appId', async () => {
    const created = await resolvers.Mutation.createApp(
      {},
      { orgId, agentId, name: 'urn-reads', aiProvider: 'anthropic', aiModel: 'claude-opus-4-6', aiApiKey: 'sk-test' },
      adminCtx(),
    );
    const stored = await db.app.findUniqueOrThrow({
      where: { id: created.id },
      select: { urn: true },
    });
    // appNodes — empty, but the call should succeed.
    const nodes = await resolvers.Query.appNodes({}, { appId: stored.urn }, adminCtx());
    expect(Array.isArray(nodes)).toBe(true);

    const cfg = await resolvers.Query.appAIConfig({}, { appId: stored.urn }, adminCtx());
    expect(cfg?.provider).toBe('anthropic');
    expect(cfg?.apiKey).toBe('sk-test');

    const keys = await resolvers.Query.appKeys({}, { appId: stored.urn }, adminCtx());
    expect(Array.isArray(keys)).toBe(true);
  });
});
