import { WORKER_SIGNATURE_DEFAULTS } from '../../../lib/workerSignature.js';
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
  createDbAppMember,
  createDbOrgAndGraph,
} from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { getPrimaryAgentId } from '../../../lib/appAgent.js';
import { resolvers, type Context } from './resolvers.js';
import { canReadMemoryRecord } from './resolvers.helpers.js';

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
  it('persists appType, role, description, agentTools, ai* fields', async () => {
    const created = await resolvers.Mutation.createApp(
      {},
      {
        orgRef: orgId,
        agentRef: agentId,
        name: 'My Workstation',
        appType: 'CHATBOT',
        role: 'CONTRIBUTOR',
        description: 'a chatbot',
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
      { orgRef: orgId, agentRef: agentId, name: 'Plain App' },
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
  it('updates appType, role, description, agentTools, ai*', async () => {
    const created = await resolvers.Mutation.createApp(
      {},
      { orgRef: orgId, agentRef: agentId, name: 'To Update' },
      adminCtx(),
    );
    const updated = await resolvers.Mutation.updateApp(
      {},
      {
        ref: created.id,
        appType: 'AGENT',
        role: 'ADMIN',
        description: 'updated',
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
    expect(updated.agentTools).toEqual(['hadron_create_node']);
    const config = await db.aiServiceConfig.findFirstOrThrow({
      where: { appId: created.id, name: 'default' },
    });
    expect(config.provider).toBe('openai');
    expect(config.model).toBe('gpt-4');
  });

  it('refuses to clear aiApiKey: an App config always needs its own key (#1390)', async () => {
    // 036-ai-service-config: provider+model are required for a config row
    // to exist; key-only createApp args create no config (legacy quirk
    // dropped with the columns).
    const created = await resolvers.Mutation.createApp(
      {},
      { orgRef: orgId, agentRef: agentId, name: 'Has Key', aiProvider: 'anthropic', aiModel: 'claude-opus-4-6', aiApiKey: 'sk-initial' },
      adminCtx(),
    );
    // Before #1390 this cleared the key, and the App's runs then spent the
    // platform's credential; now the write is refused and the key is kept.
    const err = await resolvers.Mutation.updateApp({}, { ref: created.id, aiApiKey: '' }, adminCtx()).catch((e: unknown) => e);
    expect((err as { extensions?: { code?: string } }).extensions?.code).toBe('AiConfigValidationError');
    const config = await db.aiServiceConfig.findFirstOrThrow({
      where: { appId: created.id, name: 'default' },
    });
    expect(config.apiKeyEncrypted).not.toBeNull();
    expect(config.apiKeyPreview).not.toBeNull();
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
      { orgRef: orgId, agentRef: agentId, name: 'AppAgent Test' },
      adminCtx(),
    );
    await resolvers.Mutation.addAgentToApp(
      {},
      {
        appRef: created.id,
        agentRef: secondAgentId,
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
      { orgRef: orgId, agentRef: agentId, name: 'Default Membership' },
      adminCtx(),
    );
    await resolvers.Mutation.addAgentToApp(
      {},
      { appRef: created.id, agentRef: secondAgentId },
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
      { orgRef: orgId, agentRef: agentId, name: 'Install App' },
      adminCtx(),
    );
    await resolvers.Mutation.addAgentToApp(
      {},
      { appRef: created.id, agentRef: secondAgentId, trainingMode: true },
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
      { orgRef: orgId, agentRef: agentId, name: 'Dup App' },
      adminCtx(),
    );
    await expect(
      resolvers.Mutation.addAgentToApp(
        {},
        { appRef: created.id, agentRef: agentId },
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
      { orgRef: orgId, agentRef: agentId, name: 'No AI' },
      adminCtx(),
    );
    expect(await resolvers.App.hasAiApiKey(noKey, {}, adminCtx())).toBe(false);

    // 036-ai-service-config: hasAiApiKey reads the App's 'default'
    // registry config; provider+model are required for the row to exist.
    const withKey = await resolvers.Mutation.createApp(
      {},
      { orgRef: orgId, agentRef: agentId, name: 'Has AI', aiProvider: 'anthropic', aiModel: 'claude-opus-4-6', aiApiKey: 'sk-test' },
      adminCtx(),
    );
    expect(await resolvers.App.hasAiApiKey(withKey, {}, adminCtx())).toBe(true);
  });

  it('App.agent resolver returns the linked Agent (008 — replaces agentSubscriptions)', async () => {
    const created = await resolvers.Mutation.createApp(
      {},
      { orgRef: orgId, name: 'For Agent', agentRef: agentId },
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
      { orgRef: orgId, name: 'For Members', agentRef: agentId },
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

describe('apps (the uniform member list, #473)', () => {
  it('returns Apps in the orgs the user is a member of', async () => {
    await createDbAppWithKey(db, 'one', orgId);
    await createDbAppWithKey(db, 'two', orgId);
    const apps = await resolvers.Query.apps({}, {}, ctx({ userId: user.id }));
    expect(apps.items.length).toBe(2);
    expect(apps.total).toBe(2);
  });

  it('returns an empty page when the user has no org memberships', async () => {
    const orphanUser = await db.user.create({
      data: { githubId: 8888, githubUsername: 'orphan', roles: ['READER'] },
    });
    await createDbAppWithKey(db, 'unrelated', orgId);
    const apps = await resolvers.Query.apps({}, {}, ctx({ userId: orphanUser.id }));
    expect(apps).toEqual({ items: [], total: 0 });
  });

  it('returns an empty page when no userId is set (anonymous)', async () => {
    await createDbAppWithKey(db, 'anonymous-cant-see', orgId);
    const apps = await resolvers.Query.apps({}, {}, ctx());
    expect(apps).toEqual({ items: [], total: 0 });
  });

  describe('orgId scope (#463)', () => {
    it('narrows to a member org (accepts id or URN)', async () => {
      // App in the member org, plus a second member org with its own app.
      await createDbAppWithKey(db, 'in-a', orgId);
      const orgB = await db.organization.create({
        data: { id: generateId(), name: 'apps-b', urn: `apps-b-${generateId()}` },
      });
      await db.orgMember.create({ data: { organizationId: orgB.id, userId: user.id, role: 'READER' } });
      await createDbAppWithKey(db, 'in-b', orgB.id);

      // Unscoped: both orgs' apps.
      expect((await resolvers.Query.apps({}, {}, ctx({ userId: user.id }))).items.length).toBe(2);
      // Scoped to org A: only org A's app.
      const scoped = await resolvers.Query.apps({}, { orgId }, ctx({ userId: user.id }));
      expect(scoped.items.length).toBe(1);
      expect(scoped.total).toBe(1);
      expect(scoped.items[0].organizationId).toBe(orgId);
    });

    it('returns an empty page for a non-member org and for an invalid orgId (no disclosure)', async () => {
      await createDbAppWithKey(db, 'in-a2', orgId);
      const stranger = await db.organization.create({
        data: { id: generateId(), name: 'apps-stranger', urn: `apps-stranger-${generateId()}` },
      });
      // Non-member org → empty page.
      expect(await resolvers.Query.apps({}, { orgId: stranger.id }, ctx({ userId: user.id }))).toEqual({ items: [], total: 0 });
      // Unresolvable orgId → empty page (no disclosure).
      expect(await resolvers.Query.apps({}, { orgId: 'no-such-org' }, ctx({ userId: user.id }))).toEqual({ items: [], total: 0 });
    });
  });
});

// ---------------------------------------------------------------------------
// myMemories — App-key orgId gate (#463)
// ---------------------------------------------------------------------------

describe('memories — App-key orgId', () => {
  it('does not list strict-owner metadata through a pure App key', async () => {
    const app = await db.app.create({
      data: { id: generateId(), name: 'owner-app', urn: `u-${user.id}:owner-app`, ownerUserId: user.id },
    });
    const agent = await db.agent.create({
      data: { id: generateId(), name: 'owner-agent', urn: `u-${user.id}:owner-agent`, ownerUserId: user.id },
    });
    await db.appAgent.create({ data: { appId: app.id, agentId: agent.id } });
    const owned = await db.memory.create({
      data: {
        id: generateId(), name: 'owner-only knowledge', urn: `u-${user.id}:owner-only-knowledge`,
        ownerUserId: user.id, class: 'knowledge', visibility: 'PUBLIC',
      },
    });
    const personal = await db.memory.create({
      data: {
        id: generateId(), name: 'personal', urn: `${orgId}:personal-appkey-leak`,
        organizationId: orgId, userId: user.id, class: 'personal',
      },
    });
    await db.agentMemoryItem.createMany({ data: [
      { agentId: agent.id, memoryId: owned.id, role: 'read' },
      { agentId: agent.id, memoryId: personal.id, role: 'read' },
    ] });
    const appContext = ctx({ appId: app.id });
    expect(await canReadMemoryRecord(appContext, owned)).toBe(false);
    expect(await canReadMemoryRecord(appContext, personal)).toBe(false);
    const page = await resolvers.Query.memories({}, {}, appContext);
    expect(page.items.map((m: { id: string }) => m.id)).not.toContain(owned.id);
    expect(page.items.map((m: { id: string }) => m.id)).not.toContain(personal.id);
    const ownerPage = await resolvers.Query.memories({}, {}, ctx({ appId: app.id, userId: user.id }));
    expect(ownerPage.items.map((m: { id: string }) => m.id)).toEqual(
      expect.arrayContaining([owned.id, personal.id]),
    );
  });

  it('does not list a memory linked only through a malformed stored role', async () => {
    const { app } = await createDbAppWithKey(db, 'invalid-role-list', orgId);
    await db.appAgent.create({ data: { appId: app.id, agentId } });
    const invalid = await db.memory.create({
      data: {
        id: generateId(), name: 'invalid link', urn: `${orgId}:invalid-link`,
        organizationId: orgId, class: 'knowledge', visibility: 'ORGANIZATION',
      },
    });
    await db.agentMemoryItem.create({ data: { agentId, memoryId: invalid.id, role: 'bogus' } });
    // #1376: a bare key no longer reaches org memory through an item; an App member (a user behind the key,
    // not an org member) keeps the fold, which is what the malformed-role cap applies to.
    const member = await db.user.create({ data: { githubId: 7781, githubUsername: 'invalid-role-member', roles: ['READER'] } });
    await createDbAppMember(db, app.id, member.id);
    const page = await resolvers.Query.memories(
      {}, { filter: { memoryClasses: ['knowledge'] } }, ctx({ appId: app.id, userId: member.id }),
    );
    const ids = page.items.map((m: { id: string }) => m.id);
    expect(ids).toContain(memoryId);
    expect(ids).not.toContain(invalid.id);
  });

  it('drops a cross-org Agent’s linked memories when its App grant is revoked', async () => {
    const foreignOrg = await db.organization.create({
      data: { id: generateId(), name: 'foreign-publisher', urn: `foreign-${generateId()}` },
    });
    const linked = await db.memory.create({
      data: {
        id: generateId(), name: 'foreign note', urn: `${foreignOrg.urn}:note`,
        organizationId: foreignOrg.id, class: 'knowledge', visibility: 'PUBLIC',
      },
    });
    const foreignAgent = await db.agent.create({
      data: {
        id: generateId(), name: 'foreign agent', urn: `${foreignOrg.urn}:agent`,
        organizationId: foreignOrg.id, visibility: 'PUBLIC',
        memoryItems: { create: { memoryId: linked.id, role: 'read' } },
      },
    });
    const { app } = await createDbAppWithKey(db, 'grant-list-app', orgId);
    await db.appAgent.create({ data: { appId: app.id, agentId: foreignAgent.id } });
    await db.agentOrgGrant.create({
      data: { orgId, agentId: foreignAgent.id, activatedAt: new Date() },
    });
    const list = () => resolvers.Query.memories(
      {}, { filter: { memoryClasses: ['knowledge'] } }, ctx({ appId: app.id }),
    );
    expect((await list()).items.map((m: { id: string }) => m.id)).toContain(linked.id);
    await db.agentOrgGrant.update({
      where: { orgId_agentId: { orgId, agentId: foreignAgent.id } },
      data: { revokedAt: new Date() },
    });
    expect((await list()).items.map((m: { id: string }) => m.id)).not.toContain(linked.id);
  });

  it('lists an App-scoped memory only through its own App when the Agent is shared', async () => {
    const { app: appA } = await createDbAppWithKey(db, 'memory-list-a', orgId);
    const { app: appB } = await createDbAppWithKey(db, 'memory-list-b', orgId);
    await db.appAgent.createMany({ data: [
      { appId: appA.id, agentId }, { appId: appB.id, agentId },
    ] });
    const internal = await db.memory.create({
      data: {
        id: generateId(), organizationId: orgId, appId: appA.id,
        urn: `${orgId}:memory-list-internal`, name: 'A internal',
        class: 'knowledge', visibility: 'PUBLIC', // #1376: PUBLIC is what a bare key keeps through an item
      },
    });
    await db.agentMemoryItem.create({ data: { agentId, memoryId: internal.id, role: 'read' } });

    const a = await resolvers.Query.memories({}, {}, ctx({ appId: appA.id }));
    const b = await resolvers.Query.memories({}, {}, ctx({ appId: appB.id }));
    expect(a.items.map((m: { id: string }) => m.id)).toContain(internal.id);
    expect(b.items.map((m: { id: string }) => m.id)).not.toContain(internal.id);
    // #1376: the org memory the shared Agent's item links is reached through an App member, not a bare key.
    expect(b.items.map((m: { id: string }) => m.id)).not.toContain(memoryId);
    const member = await db.user.create({ data: { githubId: 7782, githubUsername: 'memory-list-member', roles: ['READER'] } });
    await createDbAppMember(db, appB.id, member.id);
    const bm = await resolvers.Query.memories({}, {}, ctx({ appId: appB.id, userId: member.id }));
    expect(bm.items.map((m: { id: string }) => m.id)).not.toContain(internal.id);
    expect(bm.items.map((m: { id: string }) => m.id)).toContain(memoryId);
  });

  it('scopes to the App own org: match → its memories, any other org → empty page', async () => {
    const { app } = await createDbAppWithKey(db, 'mm-appkey', orgId);
    await db.appAgent.create({ data: { appId: app.id, agentId } });
    // #1376: a bare key is not admitted to the org memory the Agent's item links (an App member is); what it
    // still reaches is its own App's scoped memory, so the org gate is proven against that one.
    const own = await db.memory.create({
      data: {
        id: generateId(), organizationId: orgId, appId: app.id,
        urn: `${orgId}:mm-appkey-own`, name: 'own app memory',
        class: 'knowledge', visibility: 'PUBLIC', // #1376: PUBLIC is what a bare key keeps through an item
      },
    });
    await db.agentMemoryItem.create({ data: { agentId, memoryId: own.id, role: 'read' } });
    const member = await db.user.create({ data: { githubId: 7783, githubUsername: 'mm-appkey-member', roles: ['READER'] } });
    await createDbAppMember(db, app.id, member.id);
    const memberAll = await resolvers.Query.memories({}, {}, ctx({ appId: app.id, userId: member.id }));
    expect(memberAll.items.some((m: { id: string }) => m.id === memoryId)).toBe(true);
    const appCtx = ctx({ appId: app.id });

    // No orgId → the App's memories (its own scoped memory; the item's org memory only for a member).
    const all = await resolvers.Query.memories({}, {}, appCtx);
    expect(all.items.some((m: { id: string }) => m.id === own.id)).toBe(true);
    expect(all.items.some((m: { id: string }) => m.id === memoryId)).toBe(false);

    // orgId == the App's own org → same memories (a match-or-empty gate, NOT a
    // per-memory ownership filter — so subscribed-in memories would survive too).
    const scoped = await resolvers.Query.memories({}, { orgId }, appCtx);
    expect(scoped.items.some((m: { id: string }) => m.id === own.id)).toBe(true);

    // A different org → empty page (the App has no other active-org context).
    const other = await db.organization.create({
      data: { id: generateId(), name: 'mm-other', urn: `mm-other-${generateId()}` },
    });
    expect(await resolvers.Query.memories({}, { orgId: other.id }, appCtx)).toEqual({ items: [], total: 0 });
  });
});

// ---------------------------------------------------------------------------
// appNodes
// ---------------------------------------------------------------------------

describe('appNodes', () => {
  it('returns nodes from memories accessible via App.agent_id', async () => {
    const { app } = await createDbAppWithKey(db, 'app-nodes', orgId);
    await db.appAgent.create({ data: { appId: app.id, agentId } });
    const nodes = await resolvers.Query.appNodes({}, { appRef: app.id }, adminCtx());
    expect(nodes.length).toBe(1);
    expect(nodes[0].loc).toBe('org.test.node');
  });

  it('uses live links and valid roles across every installed Agent', async () => {
    const { app } = await createDbAppWithKey(db, 'app-nodes-live-links', orgId);
    await db.appAgent.create({ data: { appId: app.id, agentId } });
    await db.appAgent.create({ data: { appId: app.id, agentId: secondAgentId } });
    const secondMemory = await db.memory.create({
      data: {
        id: generateId(), organizationId: orgId, urn: `${orgId}:second-app-memory`,
        name: 'Second Agent memory', class: 'knowledge', visibility: 'ORGANIZATION',
      },
    });
    const link = await db.agentMemoryItem.create({
      data: { id: generateId(), agentId: secondAgentId, memoryId: secondMemory.id, role: 'read' },
    });
    await db.node.create({
      data: {
        id: generateId(), memoryId: secondMemory.id, loc: 'second.live.node',
        name: 'Second Agent node', isLink: false, tags: [],
      },
    });
    const locs = async () => (await resolvers.Query.appNodes({}, { appRef: app.id }, adminCtx()))
      .map((node: { loc: string }) => node.loc);

    expect(await locs()).toEqual(expect.arrayContaining(['org.test.node', 'second.live.node']));
    await db.agentMemoryItem.update({ where: { id: link.id }, data: { deletedAt: new Date() } });
    expect(await locs()).not.toContain('second.live.node');
    await db.agentMemoryItem.update({ where: { id: link.id }, data: { deletedAt: null, role: 'bogus' } });
    expect(await locs()).not.toContain('second.live.node');
  });

  it('does not enumerate a soft-deleted Agent system memory', async () => {
    const { app } = await createDbAppWithKey(db, 'app-nodes-deleted-system', orgId);
    await db.appAgent.create({ data: { appId: app.id, agentId } });
    const system = await db.memory.create({
      data: {
        id: generateId(), organizationId: orgId, urn: `${orgId}:deleted-agent-system`,
        name: 'Agent system', class: 'system', acceptsUploads: false,
      },
    });
    await db.agent.update({ where: { id: agentId }, data: { systemMemoryId: system.id } });
    await db.node.create({
      data: {
        id: generateId(), memoryId: system.id, loc: 'system.deleted.node',
        name: 'System node', isLink: false, tags: [],
      },
    });
    const locs = async () => (await resolvers.Query.appNodes({}, { appRef: app.id }, adminCtx()))
      .map((node: { loc: string }) => node.loc);
    expect(await locs()).toContain('system.deleted.node');
    await db.memory.update({ where: { id: system.id }, data: { deletedAt: new Date() } });
    expect(await locs()).not.toContain('system.deleted.node');
  });

  it('does not enumerate nodes from a deleted owning organization', async () => {
    const { app } = await createDbAppWithKey(db, 'app-nodes-deleted-org', orgId);
    await db.appAgent.create({ data: { appId: app.id, agentId } });
    expect((await resolvers.Query.appNodes({}, { appRef: app.id }, adminCtx())).length).toBe(1);
    await db.organization.update({ where: { id: orgId }, data: { deletedAt: new Date() } });
    expect(await resolvers.Query.appNodes({}, { appRef: app.id }, adminCtx())).toEqual([]);
  });

  // ── #1031: the App's own TEAM SPACE ──────────────────────────────────────
  //
  // Structurally unreachable through the installed-agent walk (it is keyed by
  // (appId, sharedMemoryOfAgentId), not an entry in any agent's memoryItems),
  // so the App page could see `roles:*` and not the team chat or worklog.
  //
  // The care in the fix is WHO sees it: appNodes gates on org READER+, while
  // the team space's audience is the App PARTICIPANT (cor:agt:020:00 §3). Those
  // differ by exactly one principal shape — the org READER — and both arms are
  // asserted, because a test of only the happy arm would pass on the version
  // that leaks.
  async function withTeamSpace(slug: string) {
    const { app } = await createDbAppWithKey(db, slug, orgId);
    await db.appAgent.create({ data: { appId: app.id, agentId } });
    const teamSpace = await db.memory.create({
      data: {
        id: generateId(),
        organizationId: orgId,
        appId: app.id,
        sharedMemoryOfAgentId: agentId,
        urn: `${orgId}:${slug}-team-space`,
        name: `${slug} team space`,
        class: 'app',
        acceptsUploads: false,
      },
    });
    await db.node.create({
      data: {
        id: generateId(),
        memoryId: teamSpace.id,
        loc: 'chats:team',
        isLink: false,
        name: 'team chat',
        tags: [],
      },
    });
    return { app, teamSpace };
  }

  it('admits an EXTERNAL AppMember — no org role at all (#1070)', async () => {
    // The drift: this resolver gated on org READER+, which does not admit an
    // AppMember with no role in the owning org (the external / B2C shape),
    // while `isAppParticipant` and the MCP access map both do. Same person,
    // same App, FORBIDDEN here and granted there.
    const { app } = await withTeamSpace('app-nodes-external-member');
    const outsider = await db.user.create({
      data: {
        id: generateId(), githubId: 771070,
        githubUsername: `an-external-${Date.now()}`, roles: ['READER'],
      },
    });
    // Deliberately NO orgMember row — that absence is the whole test.
    await db.appMember.create({
      data: { appId: app.id, userId: outsider.id, role: 'member' },
    });
    const ctx = { db, roles: ['READER'], userId: outsider.id } as Context;

    const locs = (await resolvers.Query.appNodes({}, { appRef: app.id }, ctx)).map(
      (n: { loc: string }) => n.loc,
    );
    // The installed agent's memories, as the MCP map already grants them...
    expect(locs).toContain('org.test.node');
    // ...and the team space, because they ARE a participant.
    expect(locs).toContain('chats:team');
  });

  it('AGREES with effectiveAccess for that member — the stated tell for this drift', async () => {
    // #362 names the symptom exactly: READ granted by the authoritative
    // access resolver but Forbidden in a per-kind query means the per-kind
    // gate has drifted. That is what #1070 was. Asserting the two TOGETHER is
    // what stops it drifting back — either surface changing alone reds this.
    const { app, teamSpace } = await withTeamSpace('app-nodes-parity');
    const outsider = await db.user.create({
      data: {
        id: generateId(), githubId: 771072,
        githubUsername: `an-parity-${Date.now()}`, roles: ['READER'],
      },
    });
    await db.appMember.create({
      data: { appId: app.id, userId: outsider.id, role: 'member' },
    });

    // Asserted against the SHARED predicate rather than through
    // effectiveAccess's ref resolver — same question, no dependence on how this
    // fixture's synthetic memory URN happens to parse. `canReadMemoryRecord` is
    // the one that governs a read of an App-scoped memory and admits an
    // AppMember explicitly (#982, the same drift fixed one surface over).
    const outsiderCtx = { db, roles: ['READER'], userId: outsider.id } as Context;
    const space = await db.memory.findUniqueOrThrow({ where: { id: teamSpace.id } });
    expect(await canReadMemoryRecord(outsiderCtx, space)).toBe(true);

    const locs = (await resolvers.Query.appNodes({}, { appRef: app.id }, outsiderCtx)).map(
      (n: { loc: string }) => n.loc,
    );
    expect(locs).toContain('chats:team');
  });

  it('gives the external member the MCP fold, NOT this resolver wider walk (#1093 P1)', async () => {
    // My first version admitted the participant to the resolver's own
    // installed-agent walk, justified by "MCP already grants them this". That
    // was false: the walk reads EVERY installed agent with memoryItems
    // unfiltered, while getAppMemoryAccess reads only the PRIMARY live agent,
    // filters soft-deleted items, and requires a live cross-org grant. A
    // SECOND installed agent is the cheapest way to show the difference.
    const { app } = await withTeamSpace('app-nodes-scope');
    const secondAgent = await db.agent.create({
      data: {
        id: generateId(), organizationId: orgId, name: 'second agent',
        urn: `${orgId}:second-agent-${Date.now()}`, visibility: 'ORGANIZATION',
      },
    });
    const secondMemory = await db.memory.create({
      data: {
        id: generateId(), organizationId: orgId, urn: `${orgId}:second-mem-${Date.now()}`,
        name: 'second agent memory', class: 'knowledge', acceptsUploads: false,
      },
    });
    await db.agentMemoryItem.create({
      data: { id: generateId(), agentId: secondAgent.id, memoryId: secondMemory.id, role: 'read-write' },
    });
    await db.node.create({
      data: {
        id: generateId(), memoryId: secondMemory.id, loc: 'secondary.node',
        isLink: false, name: 'secondary', tags: [],
      },
    });
    await db.appAgent.create({ data: { appId: app.id, agentId: secondAgent.id } });

    const outsider = await db.user.create({
      data: {
        id: generateId(), githubId: 771073,
        githubUsername: `an-scope-${Date.now()}`, roles: ['READER'],
      },
    });
    await db.appMember.create({
      data: { appId: app.id, userId: outsider.id, role: 'member' },
    });

    const locs = (await resolvers.Query.appNodes(
      {}, { appRef: app.id }, { db, roles: ['READER'], userId: outsider.id } as Context,
    )).map((n: { loc: string }) => n.loc);

    // What the platform grants them elsewhere: the primary agent's memory…
    expect(locs).toContain('org.test.node');
    // …and the team space…
    expect(locs).toContain('chats:team');
    // …but NOT the second installed agent, which the MCP fold never grants.
    expect(locs).not.toContain('secondary.node');

    // And an ORG member's scope is untouched — they still see everything the
    // resolver always showed them. Proving the spare, not just the fire.
    const orgLocs = (await resolvers.Query.appNodes({}, { appRef: app.id }, adminCtx())).map(
      (n: { loc: string }) => n.loc,
    );
    expect(orgLocs).toContain('secondary.node');
  });

  it("never serves ANOTHER user's personal memory through the fold (#1093 P1)", async () => {
    // getAppMemoryAccess is the COARSE agent-derived map; MCP's point read
    // adds a personal/private owner check on top. Returning the map's keys
    // directly handed an external member another user's personal nodes — a
    // cross-tenant read, which is never cosmetic here.
    const { app } = await withTeamSpace('app-nodes-personal');
    const victim = await db.user.create({
      data: {
        id: generateId(), githubId: 771074,
        githubUsername: `an-victim-${Date.now()}`, roles: ['READER'],
      },
    });
    const personal = await db.memory.create({
      data: {
        id: generateId(), organizationId: orgId, userId: victim.id,
        userMemoryOfAgentId: agentId, appId: app.id,
        urn: `${orgId}:personal-${Date.now()}`, name: "victim's personal",
        class: 'personal', acceptsUploads: false,
      },
    });
    await db.agentMemoryItem.create({
      data: { id: generateId(), agentId, memoryId: personal.id, role: 'read-write' },
    });
    await db.node.create({
      data: {
        id: generateId(), memoryId: personal.id, loc: 'victim.secret',
        isLink: false, name: 'secret', tags: [],
      },
    });

    const outsider = await db.user.create({
      data: {
        id: generateId(), githubId: 771075,
        githubUsername: `an-peeker-${Date.now()}`, roles: ['READER'],
      },
    });
    await db.appMember.create({
      data: { appId: app.id, userId: outsider.id, role: 'member' },
    });

    const locs = (await resolvers.Query.appNodes(
      {}, { appRef: app.id }, { db, roles: ['READER'], userId: outsider.id } as Context,
    )).map((n: { loc: string }) => n.loc);
    expect(locs).not.toContain('victim.secret');
    // Still a participant for everything they ARE entitled to.
    expect(locs).toContain('chats:team');

    // The owner still reads their own — the spare, so the gate is an owner
    // check and not a blanket exclusion of personal memories. The
    // AgentSubscription is not decoration: `canReadMemory` requires an active
    // one for an agent-scoped personal memory, and its absence is exactly the
    // revocation case Codex named. Its presence here is what makes this a
    // spare rather than a second fire.
    await db.appMember.create({
      data: { appId: app.id, userId: victim.id, role: 'member' },
    });
    await db.agentSubscription.create({
      data: { userId: victim.id, agentId, activatedAt: new Date() },
    });
    const ownLocs = (await resolvers.Query.appNodes(
      {}, { appRef: app.id }, { db, roles: ['READER'], userId: victim.id } as Context,
    )).map((n: { loc: string }) => n.loc);
    expect(ownLocs).toContain('victim.secret');
  });

  it('does not leak the SAME user\'s personal memory ACROSS Apps (#1093 P1)', async () => {
    // Owner-only does not imply per-App. A personal memory is scoped by
    // (app_id, user_id) — spec 008's whole point — and one Agent installed in
    // two Apps carries BOTH Apps' personal memories in one global memoryItems
    // fold. So the userId check alone lets a member read their OWN App-A
    // personal nodes through appNodes(B). Not a cross-user leak; a cross-App
    // one, and it is the isolation the two-layer model hangs on.
    const { app: appB } = await withTeamSpace('app-nodes-cross-app-b');
    const { app: appA } = await createDbAppWithKey(db, 'app-nodes-cross-app-a', orgId);
    await db.appAgent.create({ data: { appId: appA.id, agentId } });

    const user = await db.user.create({
      data: {
        id: generateId(), githubId: 771077,
        githubUsername: `an-two-apps-${Date.now()}`, roles: ['READER'],
      },
    });
    // Personal memory scoped to App A, owned by this user, on the shared agent.
    const personalInA = await db.memory.create({
      data: {
        id: generateId(), organizationId: orgId, userId: user.id,
        userMemoryOfAgentId: agentId, appId: appA.id,
        urn: `${orgId}:personal-a-${Date.now()}`, name: 'personal in A',
        class: 'personal', acceptsUploads: false,
      },
    });
    await db.agentMemoryItem.create({
      data: { id: generateId(), agentId, memoryId: personalInA.id, role: 'read-write' },
    });
    await db.node.create({
      data: {
        id: generateId(), memoryId: personalInA.id, loc: 'a.only',
        isLink: false, name: 'A only', tags: [],
      },
    });

    // The user participates in BOTH Apps — which is the ordinary case, not an
    // exotic one (the seed's Juno fixture is exactly this shape).
    await db.appMember.create({ data: { appId: appA.id, userId: user.id, role: 'member' } });
    await db.appMember.create({ data: { appId: appB.id, userId: user.id, role: 'member' } });
    await db.agentSubscription.create({
      data: { userId: user.id, agentId, activatedAt: new Date() },
    });
    const ctx = { db, roles: ['READER'], userId: user.id } as Context;

    const inB = (await resolvers.Query.appNodes({}, { appRef: appB.id }, ctx)).map(
      (n: { loc: string }) => n.loc,
    );
    expect(inB).not.toContain('a.only');

    // …and reading App A, the same user still gets it. The spare: this is
    // per-App isolation, not a blanket exclusion of personal memories.
    const inA = (await resolvers.Query.appNodes({}, { appRef: appA.id }, ctx)).map(
      (n: { loc: string }) => n.loc,
    );
    expect(inA).toContain('a.only');
  });

  it("does not leak another App's app-scoped memory to an ORG member (#1097)", async () => {
    // The org half of the #1093 P1 bleed. `appNodes` builds an org member's
    // scope from the raw installed-agent walk — every agent's systemMemoryId +
    // memoryItems — and `memoryItems` is global to the AGENT, not per-App. So
    // one Agent installed in Apps A and B carries A's app-scoped memory into
    // the fold for B, and an org READER of B reads A's internal knowledge.
    //
    // The participant arm was scoped on #1093; this path was left because it is
    // pre-existing and wider. It matters exactly where the seed fixtures say it
    // does: two Apps meant to be separate tenancies inside ONE org (Juno @
    // Mentor Co / Juno @ Client Co), where "they are org members anyway" is the
    // wrong answer.
    const { app: appB } = await withTeamSpace('app-nodes-org-cross-b');
    const { app: appA } = await createDbAppWithKey(db, 'app-nodes-org-cross-a', orgId);
    await db.appAgent.create({ data: { appId: appA.id, agentId } });

    // An APP-CLASS memory of App A on the shared agent. Not personal, so the
    // #1093 personal-row rules do not apply — and the ORG branch reaches it
    // through the raw installed-agent walk without consulting the access map
    // at all, which is the leak. (A participant would be refused it by
    // `admissibleFoldRows`; only this path lacked a scope rule.)
    const knowledgeInA = await db.memory.create({
      data: {
        id: generateId(), organizationId: orgId, appId: appA.id,
        urn: `${orgId}:app-knowledge-a-${Date.now()}`, name: 'A internal',
        class: 'app', acceptsUploads: false,
      },
    });
    await db.agentMemoryItem.create({
      data: { id: generateId(), agentId, memoryId: knowledgeInA.id, role: 'read-write' },
    });
    await db.node.create({
      data: {
        id: generateId(), memoryId: knowledgeInA.id, loc: 'a.internal',
        isLink: false, name: 'A internal', tags: [],
      },
    });

    // An ORG member — passes appNodes' org READER+ gate, and is NOT a
    // participant of either App, so this is the org branch specifically.
    const orgReader = await db.user.create({
      data: {
        id: generateId(), githubId: 771099,
        githubUsername: `an-org-cross-${Date.now()}`, roles: ['READER'],
      },
    });
    await db.orgMember.create({
      data: { organizationId: orgId, userId: orgReader.id, role: 'READER' },
    });
    const ctx = { db, roles: ['READER'], userId: orgReader.id } as Context;

    const inB = (await resolvers.Query.appNodes({}, { appRef: appB.id }, ctx)).map(
      (n: { loc: string }) => n.loc,
    );
    expect(inB).not.toContain('a.internal');

    // The spare, and the reason this is per-App scoping rather than a blanket
    // exclusion: reading App A, the same org member still gets it.
    const inA = (await resolvers.Query.appNodes({}, { appRef: appA.id }, ctx)).map(
      (n: { loc: string }) => n.loc,
    );
    expect(inA).toContain('a.internal');
  });

  it("does not leak another App's app-scoped memory to a PARTICIPANT either (#1097)", async () => {
    // WHAT THIS PINS, stated precisely because a mutation showed it is not what
    // I first assumed: the participant path holds this property WITHOUT the
    // scope predicate. Dropping that predicate reds the ORG test above and NOT
    // this one — `getMemoryAccess(auth{appId: B})` never admits App A's
    // app-class memory, so `canReadMemory` refuses it before the scope rule is
    // consulted.
    //
    // So this is a regression test for the ACCESS GATE, not for #1097's
    // resolver fix. Kept anyway: "a participant of two Apps cannot read the
    // other's internals" is a cross-tenant property worth pinning whichever
    // layer enforces it, and if that layer moves, this fails.
    //
    // WHY that layer holds it — I first left this unresolved and @copilot
    // answered it (PR #1132 review): #1102 moved the App-scope rule into
    // `admissibleFoldRows`, the shared predicate behind `getMemoryAccess`, and
    // that docstring calls itself "the enumeration half of #1097". So #1093's
    // claim here — that `canReadMemory` admits an app-class memory of A — was
    // true when written and is now false. The ORG branch leaked because it
    // bypasses that predicate entirely, which is the half this PR fixes.
    const { app: appB } = await withTeamSpace('app-nodes-part-cross-b');
    const { app: appA } = await createDbAppWithKey(db, 'app-nodes-part-cross-a', orgId);
    await db.appAgent.create({ data: { appId: appA.id, agentId } });

    const knowledgeInA = await db.memory.create({
      data: {
        id: generateId(), organizationId: orgId, appId: appA.id,
        urn: `${orgId}:part-knowledge-a-${Date.now()}`, name: 'A internal',
        class: 'app', acceptsUploads: false,
      },
    });
    await db.agentMemoryItem.create({
      data: { id: generateId(), agentId, memoryId: knowledgeInA.id, role: 'read-write' },
    });
    await db.node.create({
      data: {
        id: generateId(), memoryId: knowledgeInA.id, loc: 'a.part.internal',
        isLink: false, name: 'A internal', tags: [],
      },
    });

    // A participant of BOTH Apps who is NOT org-authorized — so this takes the
    // delegated branch rather than the org one.
    const member = await db.user.create({
      data: {
        id: generateId(), githubId: 771088,
        githubUsername: `an-part-cross-${Date.now()}`, roles: ['READER'],
      },
    });
    await db.appMember.create({ data: { appId: appA.id, userId: member.id, role: 'member' } });
    await db.appMember.create({ data: { appId: appB.id, userId: member.id, role: 'member' } });
    await db.agentSubscription.create({
      data: { userId: member.id, agentId, activatedAt: new Date() },
    });
    const ctx = { db, roles: ['READER'], userId: member.id } as Context;

    const inB = (await resolvers.Query.appNodes({}, { appRef: appB.id }, ctx)).map(
      (n: { loc: string }) => n.loc,
    );
    expect(inB).not.toContain('a.part.internal');
  });

  it('honours subscription REVOCATION on a personal memory (#1093 P1, delegated)', async () => {
    // The clause I would have missed a fifth time. `canReadMemory` requires an
    // ACTIVE AgentSubscription for an agent-scoped personal memory, so
    // revoking one removes access everywhere — and a hand-copied filter here
    // would have restored it on this surface alone. This test exists to pin
    // the DELEGATION: it fails the moment anyone reimplements the rule locally
    // and forgets a clause, which is the failure this PR kept having.
    const { app } = await withTeamSpace('app-nodes-revoked');
    const owner = await db.user.create({
      data: {
        id: generateId(), githubId: 771078,
        githubUsername: `an-revoked-${Date.now()}`, roles: ['READER'],
      },
    });
    const personal = await db.memory.create({
      data: {
        id: generateId(), organizationId: orgId, userId: owner.id,
        userMemoryOfAgentId: agentId, appId: app.id,
        urn: `${orgId}:revoked-${Date.now()}`, name: 'personal', class: 'personal',
        acceptsUploads: false,
      },
    });
    await db.agentMemoryItem.create({
      data: { id: generateId(), agentId, memoryId: personal.id, role: 'read-write' },
    });
    await db.node.create({
      data: {
        id: generateId(), memoryId: personal.id, loc: 'mine.private',
        isLink: false, name: 'private', tags: [],
      },
    });
    await db.appMember.create({ data: { appId: app.id, userId: owner.id, role: 'member' } });
    const ctx = { db, roles: ['READER'], userId: owner.id } as Context;

    // Active subscription: their own memory is readable.
    await db.agentSubscription.create({
      data: { userId: owner.id, agentId, activatedAt: new Date() },
    });
    expect(
      (await resolvers.Query.appNodes({}, { appRef: app.id }, ctx)).map(
        (n: { loc: string }) => n.loc,
      ),
    ).toContain('mine.private');

    // Revoked: gone here too, not just everywhere else.
    await db.agentSubscription.update({
      where: { userId_agentId: { userId: owner.id, agentId } },
      data: { revokedAt: new Date() },
    });
    expect(
      (await resolvers.Query.appNodes({}, { appRef: app.id }, ctx)).map(
        (n: { loc: string }) => n.loc,
      ),
    ).not.toContain('mine.private');
  });

  it('does NOT let a retained AppMember row revive a soft-uninstalled App (#1093 P1)', async () => {
    // resolveAppRef resolves a historical row by id deliberately, and an
    // AppMember row survives uninstall — so the participant arm would hand a
    // dead App's retained nodes to a member whose membership every active-App
    // access map already excludes.
    const { app } = await withTeamSpace('app-nodes-uninstalled');
    const member = await db.user.create({
      data: {
        id: generateId(), githubId: 771079,
        githubUsername: `an-uninstalled-${Date.now()}`, roles: ['READER'],
      },
    });
    await db.appMember.create({ data: { appId: app.id, userId: member.id, role: 'member' } });
    const ctx = { db, roles: ['READER'], userId: member.id } as Context;

    // While live, they read it — so the refusal below is the uninstall and
    // not some other denial.
    expect(
      (await resolvers.Query.appNodes({}, { appRef: app.id }, ctx)).map(
        (n: { loc: string }) => n.loc,
      ),
    ).toContain('chats:team');

    await db.app.update({ where: { id: app.id }, data: { uninstalledAt: new Date() } });
    await expect(resolvers.Query.appNodes({}, { appRef: app.id }, ctx)).rejects.toThrow();

    // …and an ORG caller still reads the retired App's retained nodes, which
    // is existing behaviour this arm must not have changed.
    expect(
      (await resolvers.Query.appNodes({}, { appRef: app.id }, adminCtx())).map(
        (n: { loc: string }) => n.loc,
      ),
    ).toContain('chats:team');
  });

  it("does not bleed App A's app-scoped knowledge into appNodes(B) (#1093 P1)", async () => {
    // One Agent installed in two Apps carries BOTH Apps' app-scoped memories
    // in its global memoryItems, so the fold for B contains A's — and
    // canReadMemory enforces appId for personal/private rows only, admitting
    // an app-class KNOWLEDGE memory of A on its non-personal branch.
    const { app: appB } = await withTeamSpace('app-nodes-knowledge-b');
    const { app: appA } = await createDbAppWithKey(db, 'app-nodes-knowledge-a', orgId);
    await db.appAgent.create({ data: { appId: appA.id, agentId } });
    const knowledgeInA = await db.memory.create({
      data: {
        id: generateId(), organizationId: orgId, appId: appA.id,
        urn: `${orgId}:knowledge-a-${Date.now()}`, name: 'A internal',
        class: 'app', acceptsUploads: false,
      },
    });
    await db.agentMemoryItem.create({
      data: { id: generateId(), agentId, memoryId: knowledgeInA.id, role: 'read-write' },
    });
    await db.node.create({
      data: {
        id: generateId(), memoryId: knowledgeInA.id, loc: 'a.internal',
        isLink: false, name: 'A internal', tags: [],
      },
    });

    const memberOfB = await db.user.create({
      data: {
        id: generateId(), githubId: 771080,
        githubUsername: `an-b-only-${Date.now()}`, roles: ['READER'],
      },
    });
    await db.appMember.create({ data: { appId: appB.id, userId: memberOfB.id, role: 'member' } });
    const ctx = { db, roles: ['READER'], userId: memberOfB.id } as Context;

    const locs = (await resolvers.Query.appNodes({}, { appRef: appB.id }, ctx)).map(
      (n: { loc: string }) => n.loc,
    );
    expect(locs).not.toContain('a.internal');
    // Still gets what App B is: its own team space.
    expect(locs).toContain('chats:team');
  });

  it('does NOT admit an impersonated session through the participant arm (#876 class)', async () => {
    // isAppParticipant guards impersonation on its OWNER branch and not on its
    // AppMember branch, so an impersonated session whose TARGET is an
    // AppMember would be admitted here — bypassing the shared-org bound the
    // impersonation session exists to enforce (PR #1093 review, Codex P1).
    const { app } = await withTeamSpace('app-nodes-impersonation');
    const target = await db.user.create({
      data: {
        id: generateId(), githubId: 771076,
        githubUsername: `an-target-${Date.now()}`, roles: ['READER'],
      },
    });
    await db.appMember.create({
      data: { appId: app.id, userId: target.id, role: 'member' },
    });
    // ctx.userId IS the target (that is the shape that fails open), with an
    // impersonation marker naming an unrelated org.
    const ctx = {
      db, roles: ['READER'], userId: target.id,
      impersonation: { orgId: generateId() },
    } as unknown as Context;

    await expect(resolvers.Query.appNodes({}, { appRef: app.id }, ctx)).rejects.toThrow();
  });

  it('still refuses someone who is neither a participant nor an org member', async () => {
    // The spare, not just the fire: the participant arm must not have turned
    // the gate into "any authenticated reader".
    const { app } = await withTeamSpace('app-nodes-stranger');
    const stranger = await db.user.create({
      data: {
        id: generateId(), githubId: 771071,
        githubUsername: `an-stranger-${Date.now()}`, roles: ['READER'],
      },
    });
    const ctx = { db, roles: ['READER'], userId: stranger.id } as Context;
    await expect(
      resolvers.Query.appNodes({}, { appRef: app.id }, ctx),
    ).rejects.toThrow();
  });

  it("includes the App's own team space for a participant", async () => {
    const { app } = await withTeamSpace('app-team-space');
    const nodes = await resolvers.Query.appNodes({}, { appRef: app.id }, adminCtx());
    expect(nodes.map((n: { loc: string }) => n.loc)).toContain('chats:team');
  });

  it('does NOT hand the team space to an org READER, who passes this gate but is not a participant', async () => {
    const { app } = await withTeamSpace('app-team-space-reader');
    const reader = await db.user.create({
      data: { id: generateId(), githubId: 771031, githubUsername: `an-reader-${Date.now()}`, roles: ['READER'] },
    });
    await db.orgMember.create({
      data: { id: generateId(), organizationId: orgId, userId: reader.id, role: 'READER' },
    });
    const ctx = { db, roles: ['READER'], userId: reader.id } as Context;

    const nodes = await resolvers.Query.appNodes({}, { appRef: app.id }, ctx);
    // They still get what they were always entitled to...
    expect(nodes.map((n: { loc: string }) => n.loc)).toContain('org.test.node');
    // ...and NOT the team chat. An org READER is admitted by appNodes' own
    // READER+ gate and is not an App participant (isAppParticipant requires
    // CONTRIBUTOR+ on the org route), so admitting the team space here would
    // publish the team's chat and worklog to every reader in the org.
    expect(nodes.map((n: { loc: string }) => n.loc)).not.toContain('chats:team');
  });

  it('a Worker working memory and a SESSION memory are never the team space', async () => {
    // The other `class='app'` row shapes under the same App
    // (findings:app-class-is-four-row-shapes). Both carry this App's appId and
    // class, so a bare appId+class predicate would pull them in — the session
    // one is the #934/#967 isolation breach.
    //
    // The Worker is ATTACHED, not implied (PR #1066 review, Copilot: the first
    // version of this test named a Worker and created only a session memory,
    // so the authorization-sensitive exclusion it claimed to cover was never
    // exercised). `workerOf` is the discriminator, and it discriminates only if
    // a Worker actually points at the row — which is what production does, in
    // one transaction with the memory create.
    const { app } = await withTeamSpace('app-team-space-shapes');

    // The worker memory is given a LEGACY-SHAPED urn (`…:<agent-slug>:shared`)
    // on purpose. Without it the URN matcher already rejects the row and
    // `workerOf` is never reached — dropping the clause leaves the suite green,
    // which is a guard asserted and not proven
    // (review:a-green-mutation-indicts-the-test). With it, `workerOf` is the
    // ONLY thing standing between a Worker's casting-scoped memory and the team
    // space, which is exactly the collision the clause exists for: a legacy
    // shared row later attached to a Worker looks like both.
    const agentRow = await db.agent.findUniqueOrThrow({ where: { id: agentId } });
    const agentSlug = agentRow.urn.split(':').slice(1).join(':');
    const workerMem = await db.memory.create({
      data: {
        id: generateId(),
        organizationId: orgId,
        appId: app.id,
        urn: `${orgId}:app-team-space-shapes:${agentSlug}:shared`,
        name: 'worker working memory',
        class: 'app',
        acceptsUploads: false,
      },
    });
    await db.worker.create({
      data: { ...WORKER_SIGNATURE_DEFAULTS,
        appId: app.id,
        agentId,
        name: `Iris-${Date.now()}`,
        slug: `iris-${Date.now()}`,
        memoryId: workerMem.id,
      },
    });
    await db.node.create({
      data: {
        id: generateId(),
        memoryId: workerMem.id,
        loc: 'private:worker-note',
        isLink: false,
        name: 'worker note',
        tags: [],
      },
    });

    const sessionMem = await db.memory.create({
      data: {
        id: generateId(),
        organizationId: orgId,
        appId: app.id,
        userMemoryOfAgentId: agentId,
        urn: `${orgId}:app-session-scope`,
        name: 'session scope',
        class: 'app',
        acceptsUploads: false,
      },
    });
    await db.node.create({
      data: {
        id: generateId(),
        memoryId: sessionMem.id,
        loc: 'private:session-note',
        isLink: false,
        name: 'session note',
        tags: [],
      },
    });

    const locs = (await resolvers.Query.appNodes({}, { appRef: app.id }, adminCtx())).map(
      (n: { loc: string }) => n.loc,
    );
    expect(locs).toContain('chats:team');
    expect(locs).not.toContain('private:worker-note');
    expect(locs).not.toContain('private:session-note');
  });

  it('returns empty when the App is orphan (agent_id IS NULL)', async () => {
    const { app } = await createDbAppWithKey(db, 'app-no-membership', orgId);
    const nodes = await resolvers.Query.appNodes({}, { appRef: app.id }, adminCtx());
    expect(nodes).toEqual([]);
  });

  // #524 — the installed agent's system memory (read-only from an App context)
  // must be folded in, so task nodes authored there are visible to appNodes.
  it("includes nodes from the installed agent's system memory", async () => {
    const sysMem = await db.memory.create({
      data: {
        id: generateId(),
        organizationId: orgId,
        urn: `${orgId}:juno-system`,
        name: 'juno System',
        class: 'system',
        acceptsUploads: false,
      },
    });
    await db.agent.update({
      where: { id: agentId },
      data: { systemMemoryId: sysMem.id },
    });
    await db.node.create({
      data: {
        id: generateId(),
        memoryId: sysMem.id,
        loc: 'tasks:distill',
        isLink: false,
        name: 'distill',
        nodeType: 'task',
        isRunnable: true,
        tags: [],
      },
    });

    const { app } = await createDbAppWithKey(db, 'app-sysmem', orgId);
    await db.appAgent.create({ data: { appId: app.id, agentId } });
    const nodes = await resolvers.Query.appNodes({}, { appRef: app.id }, adminCtx());
    const locs = nodes.map((n: { loc: string }) => n.loc);
    // Both the memoryItem node and the system-memory task node are present.
    expect(locs).toContain('org.test.node');
    expect(locs).toContain('tasks:distill');
  });

  // #525 — the optional NodeFilter narrows to runnable task nodes server-side,
  // across the App's memoryItems + the installed agent's system memory.
  it('filter.isRunnable narrows to the runnable task node (incl. system memory)', async () => {
    const sysMem = await db.memory.create({
      data: {
        id: generateId(),
        organizationId: orgId,
        urn: `${orgId}:juno-system`,
        name: 'juno System',
        class: 'system',
        acceptsUploads: false,
      },
    });
    await db.agent.update({ where: { id: agentId }, data: { systemMemoryId: sysMem.id } });
    await db.node.create({
      data: {
        id: generateId(),
        memoryId: sysMem.id,
        loc: 'tasks:distill',
        isLink: false,
        name: 'distill',
        nodeType: 'task',
        isRunnable: true,
        tags: [],
      },
    });
    // A non-runnable node in the same system memory that must be filtered out.
    await db.node.create({
      data: {
        id: generateId(),
        memoryId: sysMem.id,
        loc: 'prompts:hello',
        isLink: false,
        name: 'hello',
        nodeType: 'system',
        tags: [],
      },
    });

    const { app } = await createDbAppWithKey(db, 'app-runnable', orgId);
    await db.appAgent.create({ data: { appId: app.id, agentId } });

    const runnable = await resolvers.Query.appNodes(
      {},
      { appRef: app.id, filter: { isRunnable: true } },
      adminCtx(),
    );
    const locs = runnable.map((n: { loc: string }) => n.loc);
    expect(locs).toEqual(['tasks:distill']);
    // The memoryItem node (org.test.node, not runnable) and the non-runnable
    // system node are both excluded.
    expect(locs).not.toContain('org.test.node');
    expect(locs).not.toContain('prompts:hello');
  });

  it('filter.role uses the same dotted-family boundary as findNodes (#1322)', async () => {
    await db.node.createMany({
      data: [
        { id: generateId(), memoryId, loc: 'roles:spec', name: 'spec', role: 'spec' },
        { id: generateId(), memoryId, loc: 'roles:rule', name: 'rule', role: 'spec.rule' },
        { id: generateId(), memoryId, loc: 'roles:detail', name: 'detail', role: 'spec.rule.detail' },
        { id: generateId(), memoryId, loc: 'roles:near-miss', name: 'near miss', role: 'specification' },
      ],
    });
    const { app } = await createDbAppWithKey(db, 'app-role-filter', orgId);
    await db.appAgent.create({ data: { appId: app.id, agentId } });

    const nodes = await resolvers.Query.appNodes(
      {},
      { appRef: app.id, filter: { role: 'spec.rule' } },
      adminCtx(),
    );
    expect(nodes.map((n: { loc: string }) => n.loc)).toEqual(['roles:detail', 'roles:rule']);
  });

  // #526 review — the App's memory scope is authoritative, so the NodeFilter's
  // memory-scope fields are rejected (fail fast) rather than silently ignored.
  it('rejects filter.memoryIds / filter.memoryClasses with BAD_USER_INPUT', async () => {
    const { app } = await createDbAppWithKey(db, 'app-reject-scope', orgId);
    await db.appAgent.create({ data: { appId: app.id, agentId } });

    await expect(
      resolvers.Query.appNodes({}, { appRef: app.id, filter: { memoryIds: [memoryId] } }, adminCtx()),
    ).rejects.toThrow(/not supported/);
    await expect(
      resolvers.Query.appNodes({}, { appRef: app.id, filter: { memoryClasses: ['system'] } }, adminCtx()),
    ).rejects.toThrow(/not supported/);
  });
});

// ---------------------------------------------------------------------------
// appAIConfig
// ---------------------------------------------------------------------------

describe('appAIConfig', () => {
  it('returns null when the App has no AI provider configured', async () => {
    const created = await resolvers.Mutation.createApp(
      {},
      { orgRef: orgId, agentRef: agentId, name: 'No AI Config' },
      adminCtx(),
    );
    const cfg = await resolvers.Query.appAIConfig({}, { appRef: created.id }, adminCtx());
    expect(cfg).toBeNull();
  });

  it('returns decrypted provider/model/apiKey when configured', async () => {
    const created = await resolvers.Mutation.createApp(
      {},
      {
        orgRef: orgId,
        agentRef: agentId,
        name: 'Configured',
        aiProvider: 'anthropic',
        aiModel: 'claude-sonnet-4-20250514',
        aiApiKey: 'sk-real',
      },
      adminCtx(),
    );
    const cfg = await resolvers.Query.appAIConfig({}, { appRef: created.id }, adminCtx());
    expect(cfg).not.toBeNull();
    expect(cfg!.provider).toBe('anthropic');
    expect(cfg!.model).toBe('claude-sonnet-4-20250514');
    expect(cfg!.apiKey).toBe('sk-real');
  });

  it('rejects non-org-admin callers (Forbidden)', async () => {
    const created = await resolvers.Mutation.createApp(
      {},
      { orgRef: orgId, agentRef: agentId, name: 'Locked', aiProvider: 'anthropic', aiModel: 'm', aiApiKey: 'k' },
      adminCtx(),
    );
    const otherUser = await db.user.create({
      data: { githubId: 9999, githubUsername: 'other', roles: ['READER'] },
    });
    await expect(
      resolvers.Query.appAIConfig({}, { appRef: created.id }, ctx({ userId: otherUser.id })),
    ).rejects.toThrow();
  });
});

// ---------------------------------------------------------------------------
// appKeys
// ---------------------------------------------------------------------------

describe('appKeys', () => {
  it('returns active AppKey rows for the App', async () => {
    const { app } = await createDbAppWithKey(db, 'app-keys', orgId);
    const keys = await resolvers.Query.appKeys({}, { appRef: app.id }, adminCtx());
    expect(keys.length).toBe(1);
    expect(keys[0].appId).toBe(app.id);
    expect(keys[0].revokedAt).toBeNull();
  });

  it('omits revoked keys', async () => {
    const { app, appKey } = await createDbAppWithKey(db, 'app-revoked', orgId);
    await db.appKey.update({ where: { id: appKey.id }, data: { revokedAt: new Date() } });
    const keys = await resolvers.Query.appKeys({}, { appRef: app.id }, adminCtx());
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
      { appRef: app.id },
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
      { orgRef: orgId, agentRef: agentId, name: 'urn-app-q' },
      adminCtx(),
    );
    const stored = await db.app.findUniqueOrThrow({
      where: { id: created.id },
      select: { urn: true },
    });
    const byUrn = await resolvers.Query.app({}, { ref: stored.urn }, adminCtx());
    expect(byUrn?.id).toBe(created.id);
  });

  it('Query.app accepts a prefixed URN (urn:app:...)', async () => {
    const created = await resolvers.Mutation.createApp(
      {},
      { orgRef: orgId, agentRef: agentId, name: 'urn-app-q-prefix' },
      adminCtx(),
    );
    const stored = await db.app.findUniqueOrThrow({
      where: { id: created.id },
      select: { urn: true },
    });
    const byUrn = await resolvers.Query.app({}, { ref: `urn:app:${stored.urn}` }, adminCtx());
    expect(byUrn?.id).toBe(created.id);
  });

  it('updateApp accepts a URN as id', async () => {
    const created = await resolvers.Mutation.createApp(
      {},
      { orgRef: orgId, agentRef: agentId, name: 'urn-update' },
      adminCtx(),
    );
    const stored = await db.app.findUniqueOrThrow({
      where: { id: created.id },
      select: { urn: true },
    });
    const updated = await resolvers.Mutation.updateApp(
      {},
      { ref: stored.urn, description: 'via-urn' },
      adminCtx(),
    );
    expect(updated.description).toBe('via-urn');
  });

  it('deleteApp accepts a URN as id', async () => {
    const created = await resolvers.Mutation.createApp(
      {},
      { orgRef: orgId, agentRef: agentId, name: 'urn-delete' },
      adminCtx(),
    );
    const stored = await db.app.findUniqueOrThrow({
      where: { id: created.id },
      select: { urn: true },
    });
    const ok = await resolvers.Mutation.deleteApp({}, { ref: stored.urn }, adminCtx());
    expect(ok).toBe(true);
    const after = await db.app.findUnique({ where: { id: created.id } });
    expect(after?.deletedAt).not.toBeNull();
  });

  it('addAgentToApp accepts URNs for both appId and agentId', async () => {
    const created = await resolvers.Mutation.createApp(
      {},
      { orgRef: orgId, agentRef: agentId, name: 'urn-add-agent' },
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
      { appRef: appStored.urn, agentRef: secondStored.urn },
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
      { orgRef: orgId, agentRef: agentId, name: 'urn-remove-agent' },
      adminCtx(),
    );
    // Install the second agent so there are 2 AppAgent rows; then remove
    // the first via URN. Final state: only the second agent remains.
    await resolvers.Mutation.addAgentToApp(
      {},
      { appRef: created.id, agentRef: secondAgentId },
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
      { appRef: appStored.urn, agentRef: agentStored.urn },
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
      { orgRef: orgId, agentRef: agentId, name: 'urn-createkey' },
      adminCtx(),
    );
    const stored = await db.app.findUniqueOrThrow({
      where: { id: created.id },
      select: { urn: true },
    });
    const result = await resolvers.Mutation.createAppKey(
      {},
      { appRef: stored.urn },
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
      { appRef: stored.urn },
      adminCtx(),
    );
    expect(result.app.id).toBe(app.id);
    expect(result.rawKey).toMatch(/^hdr_app_[0-9a-f]{64}$/);
  });

  it('appNodes / appAIConfig / appKeys accept URN as appRef', async () => {
    const created = await resolvers.Mutation.createApp(
      {},
      { orgRef: orgId, agentRef: agentId, name: 'urn-reads', aiProvider: 'anthropic', aiModel: 'claude-opus-4-6', aiApiKey: 'sk-test' },
      adminCtx(),
    );
    const stored = await db.app.findUniqueOrThrow({
      where: { id: created.id },
      select: { urn: true },
    });
    // appNodes — empty, but the call should succeed.
    const nodes = await resolvers.Query.appNodes({}, { appRef: stored.urn }, adminCtx());
    expect(Array.isArray(nodes)).toBe(true);

    const cfg = await resolvers.Query.appAIConfig({}, { appRef: stored.urn }, adminCtx());
    expect(cfg?.provider).toBe('anthropic');
    expect(cfg?.apiKey).toBe('sk-test');

    const keys = await resolvers.Query.appKeys({}, { appRef: stored.urn }, adminCtx());
    expect(Array.isArray(keys)).toBe(true);
  });
});
