import { describe, it, expect, beforeEach, vi } from 'vitest';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { getPrimaryAgentId } from '../../../lib/appAgent.js';
import { resolvers, type Context } from './resolvers.js';
import { generateId } from '../../../lib/id.js';
import { cleanupAnonymousMemories } from '../../../jobs/cleanupAnonymousMemories.js';

// Prevent git writes
vi.mock('../../../integrations/github/writeNodeToGit.js', () => ({
  writeNodeToGit: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../../../integrations/github/syncGraphFromGithub.js', () => ({
  syncGraphFromGithub: vi.fn().mockResolvedValue({ error: null }),
}));

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

let orgA: { id: string; urn: string };
let orgB: { id: string; urn: string };
let adminUser: { id: string };
let agent: { id: string; organizationId: string; urn: string };
let app: { id: string };
let app2: { id: string };

function ctx(overrides: Partial<Context> = {}): Context {
  return { db, ...overrides };
}

// Admin context for ADMIN-only mutations
function adminCtx(overrides: Partial<Context> = {}): Context {
  return { db, roles: ['ADMIN'], userId: adminUser.id, ...overrides };
}

// App Key context (no active session)
function appCtx(appId: string, overrides: Partial<Context> = {}): Context {
  return { db, appId, roles: [], organizationId: orgA.id, ...overrides };
}

beforeEach(async () => {
  await cleanDb(db);

  orgA = await db.organization.create({
    data: { id: generateId(), name: 'org-a', urn: 'org-a' },
  });
  orgB = await db.organization.create({
    data: { id: generateId(), name: 'org-b', urn: 'org-b' },
  });

  adminUser = await db.user.create({
    data: { githubId: 9001, githubUsername: 'admin-user', roles: ['ADMIN'] },
  });

  agent = await db.agent.create({
    data: {
      id: generateId(),
      organizationId: orgA.id,
      urn: 'org-a:juno',
      name: 'juno',
      description: 'Test chatbot',
      type: 'CHATBOT',
      surfaces: ['api'],
      visibility: 'ORGANIZATION',
    },
  });

  app = await db.app.create({
    data: {
      id: generateId(),
      organizationId: orgA.id,
      name: 'Test App',
      urn: 'org-a:test-app',
      createUserPermission: 'EXPLICIT',
      identifyUserMethod: 'USER_ID',
      sessionTimeoutSeconds: 900,
      anonymousTtlDays: 7,
    },
  });

  app2 = await db.app.create({
    data: {
      id: generateId(),
      organizationId: orgB.id,
      name: 'Other App',
      urn: 'org-b:other-app',
    },
  });

  // 023-app-shape Phase 2b: Authorize app to operate agent via AppAgent join.
  await db.appAgent.create({ data: { appId: app.id, agentId: agent.id } });
});

// ---------------------------------------------------------------------------
// App CRUD
// ---------------------------------------------------------------------------

describe('App CRUD', () => {
  it('creates an app with defaults', async () => {
    const result = await resolvers.Mutation.createApp(
      {},
      { orgId: orgA.id, agentId: agent.id, name: 'Wizard App' },
      adminCtx(),
    );
    expect(result.name).toBe('Wizard App');
    expect(result.organizationId).toBe(orgA.id);
    expect(result.urn).toBe('org-a:wizard-app');
    expect(result.createUserPermission).toBe('EXPLICIT');
    expect(result.identifyUserMethod).toBe('USER_ID');
    expect(result.sessionTimeoutSeconds).toBe(900);
  });

  it('accepts an explicit URN slug', async () => {
    const result = await resolvers.Mutation.createApp(
      {},
      { orgId: orgA.id, agentId: agent.id, name: 'Custom', urn: 'my-custom-slug' },
      adminCtx(),
    );
    expect(result.urn).toBe('org-a:my-custom-slug');
  });

  it('rejects duplicate URNs', async () => {
    await resolvers.Mutation.createApp(
      {},
      { orgId: orgA.id, agentId: agent.id, name: 'Dup' },
      adminCtx(),
    );
    await expect(
      resolvers.Mutation.createApp(
        {},
        { orgId: orgA.id, agentId: agent.id, name: 'Dup' },
        adminCtx(),
      ),
    ).rejects.toThrow(/already exists/);
  });

  it('requires admin role to create an app', async () => {
    await expect(
      resolvers.Mutation.createApp(
        {},
        { orgId: orgA.id, agentId: agent.id, name: 'Noob App' },
        ctx({ userId: 'random-user' }),
      ),
    ).rejects.toThrow('Forbidden');
  });

  it('generates an App Key with the hdr_app_ prefix', async () => {
    const { rawKey, key } = await resolvers.Mutation.createAppKey(
      {},
      { appId: app.id, label: 'test-key' },
      adminCtx(),
    );
    expect(rawKey).toMatch(/^hdr_app_[0-9a-f]{64}$/);
    expect(key.keyPreview).toContain('hdr_app_');
    // The hash is stored, not the raw key
    const stored = await db.appKey.findUnique({ where: { id: key.id } });
    expect(stored?.keyHash).not.toBe(rawKey);
  });

  it('revokes an App Key', async () => {
    const { key } = await resolvers.Mutation.createAppKey(
      {},
      { appId: app.id },
      adminCtx(),
    );
    await resolvers.Mutation.revokeAppKey({}, { id: key.id }, adminCtx());
    const after = await db.appKey.findUnique({ where: { id: key.id } });
    expect(after?.revokedAt).not.toBeNull();
  });

  it('adds and removes agents from an app', async () => {
    // Remove existing, then re-add
    await resolvers.Mutation.removeAgentFromApp(
      {},
      { appId: app.id, agentId: agent.id },
      adminCtx(),
    );
    // 023-app-shape Phase 2b: App→Agent is N:M via AppAgent; "removed"
    // means the AppAgent row is gone.
    expect(await getPrimaryAgentId(db, app.id)).toBeNull();

    await resolvers.Mutation.addAgentToApp(
      {},
      { appId: app.id, agentId: agent.id },
      adminCtx(),
    );
    expect(await getPrimaryAgentId(db, app.id)).toBe(agent.id);
  });

  it('refuses to add an agent from a different org to an app', async () => {
    const otherAgent = await db.agent.create({
      data: {
        id: generateId(),
        organizationId: orgB.id,
        urn: 'org-b:other',
        name: 'other',
      },
    });
    await expect(
      resolvers.Mutation.addAgentToApp(
        {},
        { appId: app.id, agentId: otherAgent.id },
        adminCtx(),
      ),
    ).rejects.toThrow(/same organization/);
  });
});

// ---------------------------------------------------------------------------
// createAppUser
// ---------------------------------------------------------------------------

describe('createAppUser', () => {
  it('creates a new User with identityProvider=APP', async () => {
    const user = await resolvers.Mutation.createAppUser(
      {},
      { externalId: 'mm-42', handle: 'alice', name: 'Alice' },
      appCtx(app.id),
    );
    expect(user.externalAppId).toBe(app.id);
    expect(user.externalId).toBe('mm-42');
    expect(user.identityProvider).toBe('APP');
    expect(user.handle).toBe('alice');
  });

  it('is idempotent on the same externalId', async () => {
    const u1 = await resolvers.Mutation.createAppUser(
      {},
      { externalId: 'mm-42' },
      appCtx(app.id),
    );
    const u2 = await resolvers.Mutation.createAppUser(
      {},
      { externalId: 'mm-42' },
      appCtx(app.id),
    );
    expect(u1.id).toBe(u2.id);
  });

  it('requires App Key auth', async () => {
    await expect(
      resolvers.Mutation.createAppUser({}, { externalId: 'mm-42' }, ctx()),
    ).rejects.toThrow('Forbidden');
  });

  it('respects createUserPermission=DENY', async () => {
    await db.app.update({
      where: { id: app.id },
      data: { createUserPermission: 'DENY' },
    });
    await expect(
      resolvers.Mutation.createAppUser({}, { externalId: 'mm-42' }, appCtx(app.id)),
    ).rejects.toThrow(/cannot create users/);
  });
});

// ---------------------------------------------------------------------------
// startAgentSession + access filter
// ---------------------------------------------------------------------------

describe('startAgentSession', () => {
  it('lazily provisions a user memory on first session', async () => {
    await resolvers.Mutation.createAppUser(
      {},
      { externalId: 'mm-42' },
      appCtx(app.id),
    );
    const session = await resolvers.Mutation.startAgentSession(
      {},
      { agentId: agent.id, externalUserId: 'mm-42' },
      appCtx(app.id),
    );
    expect(session.appId).toBe(app.id);
    expect(session.agentId).toBe(agent.id);
    expect(session.memoryId).toBeTruthy();
    expect(session.expiresAt).toBeTruthy();

    const mem = await db.memory.findUnique({ where: { id: session.memoryId! } });
    expect(mem?.userMemoryOfAgentId).toBe(agent.id);
    expect(mem?.visibility).toBe('PERSONAL');
    expect(mem?.urn).toContain(':user:');
  });

  it('reuses the same memory on subsequent sessions', async () => {
    await resolvers.Mutation.createAppUser(
      {},
      { externalId: 'mm-42' },
      appCtx(app.id),
    );
    const s1 = await resolvers.Mutation.startAgentSession(
      {},
      { agentId: agent.id, externalUserId: 'mm-42' },
      appCtx(app.id),
    );
    const s2 = await resolvers.Mutation.startAgentSession(
      {},
      { agentId: agent.id, externalUserId: 'mm-42' },
      appCtx(app.id),
    );
    expect(s2.memoryId).toBe(s1.memoryId);
    expect(s2.id).not.toBe(s1.id);
  });

  it('creates an anonymous memory with expiry when no externalUserId', async () => {
    const session = await resolvers.Mutation.startAgentSession(
      {},
      { agentId: agent.id },
      appCtx(app.id),
    );
    const mem = await db.memory.findUnique({ where: { id: session.memoryId! } });
    expect(mem?.anonymousExpiresAt).not.toBeNull();
    expect(mem?.urn).toContain(':anon:');
    // 7 days from now (app default)
    const secondsUntilExpiry = (mem!.anonymousExpiresAt!.getTime() - Date.now()) / 1000;
    expect(secondsUntilExpiry).toBeGreaterThan(6 * 24 * 60 * 60);
  });

  it('rejects unknown externalUserId under EXPLICIT permission', async () => {
    await expect(
      resolvers.Mutation.startAgentSession(
        {},
        { agentId: agent.id, externalUserId: 'unknown-user' },
        appCtx(app.id),
      ),
    ).rejects.toThrow(/createAppUser/);
  });

  it('auto-creates users under IMPLICIT permission', async () => {
    await db.app.update({
      where: { id: app.id },
      data: { createUserPermission: 'IMPLICIT' },
    });
    const session = await resolvers.Mutation.startAgentSession(
      {},
      { agentId: agent.id, externalUserId: 'new-user' },
      appCtx(app.id),
    );
    expect(session.userId).toBeTruthy();
    const user = await db.user.findUnique({ where: { id: session.userId! } });
    expect(user?.externalId).toBe('new-user');
  });

  it('refuses agents not attached to the app', async () => {
    const otherAgent = await db.agent.create({
      data: {
        id: generateId(),
        organizationId: orgA.id,
        urn: 'org-a:other',
        name: 'other',
      },
    });
    await expect(
      resolvers.Mutation.startAgentSession(
        {},
        { agentId: otherAgent.id, externalUserId: 'mm-42' },
        appCtx(app.id),
      ),
    ).rejects.toThrow(/not allowed to operate/);
  });

  it('clamps session timeout to the app ceiling', async () => {
    await resolvers.Mutation.createAppUser(
      {},
      { externalId: 'mm-42' },
      appCtx(app.id),
    );
    const session = await resolvers.Mutation.startAgentSession(
      {},
      {
        agentId: agent.id,
        externalUserId: 'mm-42',
        sessionTimeoutSeconds: 999999, // well above the 900 ceiling
      },
      appCtx(app.id),
    );
    const secondsFromNow = (new Date(session.expiresAt!).getTime() - Date.now()) / 1000;
    expect(secondsFromNow).toBeLessThanOrEqual(901);
  });
});

// ---------------------------------------------------------------------------
// endAgentSession
// ---------------------------------------------------------------------------

describe('endAgentSession', () => {
  it('marks the session ended', async () => {
    await resolvers.Mutation.createAppUser(
      {},
      { externalId: 'mm-42' },
      appCtx(app.id),
    );
    const session = await resolvers.Mutation.startAgentSession(
      {},
      { agentId: agent.id, externalUserId: 'mm-42' },
      appCtx(app.id),
    );
    await resolvers.Mutation.endAgentSession({}, { sessionId: session.id }, appCtx(app.id));
    const after = await db.session.findUnique({ where: { id: session.id } });
    expect(after?.endedAt).not.toBeNull();
  });

  it('is idempotent', async () => {
    await resolvers.Mutation.createAppUser(
      {},
      { externalId: 'mm-42' },
      appCtx(app.id),
    );
    const session = await resolvers.Mutation.startAgentSession(
      {},
      { agentId: agent.id, externalUserId: 'mm-42' },
      appCtx(app.id),
    );
    await resolvers.Mutation.endAgentSession({}, { sessionId: session.id }, appCtx(app.id));
    const second = await resolvers.Mutation.endAgentSession(
      {},
      { sessionId: session.id },
      appCtx(app.id),
    );
    expect(second).toBe(true);
  });

  it('refuses to end a session belonging to a different app', async () => {
    await resolvers.Mutation.createAppUser(
      {},
      { externalId: 'mm-42' },
      appCtx(app.id),
    );
    const session = await resolvers.Mutation.startAgentSession(
      {},
      { agentId: agent.id, externalUserId: 'mm-42' },
      appCtx(app.id),
    );
    await expect(
      resolvers.Mutation.endAgentSession(
        {},
        { sessionId: session.id },
        appCtx(app2.id),
      ),
    ).rejects.toThrow(/not found/);
  });
});

// ---------------------------------------------------------------------------
// linkMemoryToUser
// ---------------------------------------------------------------------------

describe('linkMemoryToUser', () => {
  it('converts an anonymous memory to a user memory', async () => {
    const session = await resolvers.Mutation.startAgentSession(
      {},
      { agentId: agent.id },
      appCtx(app.id),
    );
    const linked = await resolvers.Mutation.linkMemoryToUser(
      {},
      { memoryId: session.memoryId!, externalUserId: 'mm-new' },
      appCtx(app.id),
    );
    expect(linked.anonymousExpiresAt).toBeNull();
    expect(linked.urn).toContain(':user:');
    expect(linked.urn).not.toContain(':anon:');
    const user = await db.user.findFirst({
      where: { externalAppId: app.id, externalId: 'mm-new' },
    });
    expect(user).not.toBeNull();
    expect(linked.createdBy).toBe(user!.id);
  });

  it('refuses to link memories from another org', async () => {
    const foreignAgent = await db.agent.create({
      data: { id: generateId(), organizationId: orgB.id, urn: 'org-b:x', name: 'x' },
    });
    const foreignMem = await db.memory.create({
      data: {
        id: generateId(),
        organizationId: orgB.id,
        urn: 'org-b:x:anon:zzz',
        name: 'foreign',
            class: 'knowledge',
        userMemoryOfAgentId: foreignAgent.id,
        anonymousExpiresAt: new Date(Date.now() + 86400000),
      },
    });
    await expect(
      resolvers.Mutation.linkMemoryToUser(
        {},
        { memoryId: foreignMem.id, externalUserId: 'mm-42' },
        appCtx(app.id),
      ),
    ).rejects.toThrow(/organization/);
  });

  // 007-entity-id-or-urn: linkMemoryToUser accepts memoryId as ID or URN.
  it('accepts a URN as memoryId input', async () => {
    const session = await resolvers.Mutation.startAgentSession(
      {},
      { agentId: agent.id },
      appCtx(app.id),
    );
    // Look up the memory's URN; pass that instead of the ID.
    const memoryRow = await db.memory.findUniqueOrThrow({
      where: { id: session.memoryId! },
      select: { urn: true },
    });
    const linked = await resolvers.Mutation.linkMemoryToUser(
      {},
      { memoryId: memoryRow.urn, externalUserId: 'mm-urn-input' },
      appCtx(app.id),
    );
    expect(linked.id).toBe(session.memoryId);
    expect(linked.anonymousExpiresAt).toBeNull();
    expect(linked.urn).toContain(':user:');
  });
});

// ---------------------------------------------------------------------------
// Access filter — the security-critical part
// ---------------------------------------------------------------------------

describe('memoryAccessFilter (App Key session scoping)', () => {
  it('an App Key session can only see its own memory + agent system memory', async () => {
    // Set up: agent has a system memory, session is in a user memory
    const systemMem = await db.memory.create({
      data: {
        id: generateId(),
        organizationId: orgA.id,
        urn: 'org-a:juno-system',
        name: 'juno-system',
            class: 'knowledge',
        visibility: 'ORGANIZATION',
      },
    });
    await db.agent.update({
      where: { id: agent.id },
      data: { systemMemoryId: systemMem.id },
    });

    // Create another memory in the same org that should NOT be accessible
    const foreignMem = await db.memory.create({
      data: {
        id: generateId(),
        organizationId: orgA.id,
        urn: 'org-a:secret',
        name: 'secret',
            class: 'knowledge',
        visibility: 'ORGANIZATION',
      },
    });
    await db.node.create({
      data: {
        id: generateId(),
        memoryId: foreignMem.id,
        loc: 'secret-node',
        name: 'secret-node',
        content: 'DO NOT READ',
      },
    });

    // Start a session for user mm-42
    await resolvers.Mutation.createAppUser(
      {},
      { externalId: 'mm-42' },
      appCtx(app.id),
    );
    const session = await resolvers.Mutation.startAgentSession(
      {},
      { agentId: agent.id, externalUserId: 'mm-42' },
      appCtx(app.id),
    );

    // Nodes query — the security-critical path
    const sessionCtx = appCtx(app.id, { sessionId: session.id });
    const nodes = await resolvers.Query.nodes(
      {},
      { limit: 1000 },
      sessionCtx,
    );

    // No nodes should leak from foreignMem
    for (const n of nodes) {
      expect(n.memoryId).not.toBe(foreignMem.id);
    }
    // The node from foreignMem definitely should not be there
    expect(nodes.find((n) => n.loc === 'secret-node')).toBeUndefined();
  });

  it('an App Key without a session sees nothing', async () => {
    // Foreign memory with a node
    const foreign = await db.memory.create({
      data: {
        id: generateId(),
        organizationId: orgA.id,
        urn: 'org-a:other',
        name: 'other',
            class: 'knowledge',
      },
    });
    await db.node.create({
      data: {
        id: generateId(),
        memoryId: foreign.id,
        loc: 'should-not-see',
        name: 'x',
      },
    });
    const nodes = await resolvers.Query.nodes({}, { limit: 1000 }, appCtx(app.id));
    expect(nodes.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Anonymous memory cleanup job
// ---------------------------------------------------------------------------

describe('cleanupAnonymousMemories', () => {
  it('deletes memories whose anonymousExpiresAt is in the past', async () => {
    // Expired
    await db.memory.create({
      data: {
        id: generateId(),
        organizationId: orgA.id,
        urn: 'org-a:juno:anon:expired',
        name: 'expired',
            class: 'knowledge',
        userMemoryOfAgentId: agent.id,
        anonymousExpiresAt: new Date(Date.now() - 86400000),
      },
    });
    // Not yet expired
    await db.memory.create({
      data: {
        id: generateId(),
        organizationId: orgA.id,
        urn: 'org-a:juno:anon:fresh',
        name: 'fresh',
            class: 'knowledge',
        userMemoryOfAgentId: agent.id,
        anonymousExpiresAt: new Date(Date.now() + 86400000),
      },
    });
    // Not anonymous at all — a regular org memory
    await db.memory.create({
      data: {
        id: generateId(),
        organizationId: orgA.id,
        urn: 'org-a:regular',
        name: 'regular',
            class: 'knowledge',
      },
    });

    const count = await cleanupAnonymousMemories(db);
    expect(count).toBe(1);
    const remaining = await db.memory.findMany({ where: { deletedAt: null } });
    expect(remaining.find((m) => m.urn === 'org-a:juno:anon:expired')).toBeUndefined();
    expect(remaining.find((m) => m.urn === 'org-a:juno:anon:fresh')).toBeTruthy();
    expect(remaining.find((m) => m.urn === 'org-a:regular')).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// Agent type + surfaces
// ---------------------------------------------------------------------------

describe('Organization memory listing', () => {
  it('excludes user memories from the org memories list', async () => {
    // Create a regular org memory
    await db.memory.create({
      data: {
        id: generateId(),
        organizationId: orgA.id,
        urn: 'org-a:knowledge',
        name: 'knowledge',
            class: 'knowledge',
      },
    });
    // Create a user memory (via startAgentSession)
    await resolvers.Mutation.createAppUser(
      {},
      { externalId: 'mm-42' },
      appCtx(app.id),
    );
    await resolvers.Mutation.startAgentSession(
      {},
      { agentId: agent.id, externalUserId: 'mm-42' },
      appCtx(app.id),
    );

    // Query the organization — should show the regular memory but not the user one
    const org = await resolvers.Query.organization(
      {},
      { id: orgA.id },
      adminCtx(),
    );
    expect(org?.memories.map((m: { urn: string }) => m.urn)).toContain('org-a:knowledge');
    expect(org?.memories.find((m: { urn: string }) => m.urn.includes(':user:'))).toBeUndefined();
  });
});

describe('Agent type + surfaces', () => {
  it('creates an ASSISTANT with mcp surface by default', async () => {
    const created = await resolvers.Mutation.createAgent(
      {},
      { orgId: orgA.id, name: 'assistant-1' },
      adminCtx(),
    );
    expect(created.type).toBe('ASSISTANT');
    expect(created.surfaces).toEqual(['mcp']);
  });

  it('creates a CHATBOT with api surface when systemMemoryId is set', async () => {
    const sysMem = await db.memory.create({
      data: {
        id: generateId(),
        organizationId: orgA.id,
        urn: 'org-a:sys',
        name: 'sys',
            class: 'knowledge',
      },
    });
    const created = await resolvers.Mutation.createAgent(
      {},
      { orgId: orgA.id, name: 'bot-1', systemMemoryId: sysMem.id },
      adminCtx(),
    );
    expect(created.type).toBe('CHATBOT');
    expect(created.surfaces).toEqual(['api']);
  });

  it('honors explicit type and surfaces', async () => {
    const created = await resolvers.Mutation.createAgent(
      {},
      {
        orgId: orgA.id,
        name: 'custom-1',
        type: 'CHATBOT',
        surfaces: ['portal-chat', 'api'],
      },
      adminCtx(),
    );
    expect(created.type).toBe('CHATBOT');
    expect(created.surfaces).toEqual(['portal-chat', 'api']);
  });
});
