import { describe, it, expect, beforeEach, vi } from 'vitest';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { resolvers, type Context } from './resolvers.js';
import { generateId } from '../../../lib/id.js';
import { generateDataKey } from '../../../lib/crypto.js';
import { sessionKeyCache } from '../../../lib/sessionKeyCache.js';

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
let agent: { id: string };
let secretApp: { id: string };
let plaintextApp: { id: string };

function appCtx(appId: string, overrides: Partial<Context> = {}): Context {
  return { db, appId, roles: [], organizationId: orgA.id, ...overrides };
}

beforeEach(async () => {
  await cleanDb(db);
  sessionKeyCache.clear();

  orgA = await db.organization.create({
    data: { id: generateId(), name: 'org-a', urn: 'org-a' },
  });

  agent = await db.agent.create({
    data: {
      id: generateId(),
      organizationId: orgA.id,
      urn: 'org-a:juno',
      name: 'juno',
      type: 'CHATBOT',
      surfaces: ['api'],
    },
  });

  secretApp = await db.app.create({
    data: {
      id: generateId(),
      organizationId: orgA.id,
      name: 'SECRET App',
      urn: 'org-a:secret-app',
      createUserPermission: 'IMPLICIT',
      identifyUserMethod: 'SECRET',
    },
  });
  plaintextApp = await db.app.create({
    data: {
      id: generateId(),
      organizationId: orgA.id,
      name: 'USER_ID App',
      urn: 'org-a:user-id-app',
      createUserPermission: 'IMPLICIT',
      identifyUserMethod: 'USER_ID',
    },
  });
  await db.appAgent.create({ data: { appId: secretApp.id, agentId: agent.id } });
  await db.appAgent.create({ data: { appId: plaintextApp.id, agentId: agent.id } });
});

// ---------------------------------------------------------------------------
// startAgentSession with dataKey
// ---------------------------------------------------------------------------

describe('startAgentSession with encryption', () => {
  it('requires a dataKey when the app is in SECRET mode', async () => {
    await expect(
      resolvers.Mutation.startAgentSession(
        {},
        { agentId: agent.id, externalUserId: 'mm-1' },
        appCtx(secretApp.id),
      ),
    ).rejects.toThrow(/dataKey is required/);
  });

  it('rejects a dataKey when the app is in USER_ID mode', async () => {
    const key = generateDataKey().raw.toString('base64');
    await expect(
      resolvers.Mutation.startAgentSession(
        {},
        { agentId: agent.id, externalUserId: 'mm-1', dataKey: key },
        appCtx(plaintextApp.id),
      ),
    ).rejects.toThrow(/only accepted when/);
  });

  it('creates an encrypted memory and caches the key', async () => {
    const key = generateDataKey().raw.toString('base64');
    const session = await resolvers.Mutation.startAgentSession(
      {},
      { agentId: agent.id, externalUserId: 'mm-1', dataKey: key },
      appCtx(secretApp.id),
    );
    const mem = await db.memory.findUnique({ where: { id: session.memoryId! } });
    expect(mem?.isEncrypted).toBe(true);
    expect(sessionKeyCache.getByMemoryId(session.memoryId!)).not.toBeNull();
  });

  it('requires the key on subsequent sessions for an already-encrypted memory', async () => {
    const key = generateDataKey().raw.toString('base64');
    await resolvers.Mutation.startAgentSession(
      {},
      { agentId: agent.id, externalUserId: 'mm-1', dataKey: key },
      appCtx(secretApp.id),
    );

    // Second session for the same user without dataKey
    await expect(
      resolvers.Mutation.startAgentSession(
        {},
        { agentId: agent.id, externalUserId: 'mm-1' },
        appCtx(secretApp.id),
      ),
    ).rejects.toThrow(/dataKey is required/);
  });

  it('rejects mismatched keys for concurrent sessions on the same memory', async () => {
    const k1 = generateDataKey().raw.toString('base64');
    const k2 = generateDataKey().raw.toString('base64');
    await resolvers.Mutation.startAgentSession(
      {},
      { agentId: agent.id, externalUserId: 'mm-1', dataKey: k1 },
      appCtx(secretApp.id),
    );
    await expect(
      resolvers.Mutation.startAgentSession(
        {},
        { agentId: agent.id, externalUserId: 'mm-1', dataKey: k2 },
        appCtx(secretApp.id),
      ),
    ).rejects.toThrow(/conflict/);
  });

  it('accepts the same key on concurrent sessions (ref count increments)', async () => {
    const key = generateDataKey().raw.toString('base64');
    const s1 = await resolvers.Mutation.startAgentSession(
      {},
      { agentId: agent.id, externalUserId: 'mm-1', dataKey: key },
      appCtx(secretApp.id),
    );
    const s2 = await resolvers.Mutation.startAgentSession(
      {},
      { agentId: agent.id, externalUserId: 'mm-1', dataKey: key },
      appCtx(secretApp.id),
    );
    expect(sessionKeyCache.refCount(s1.memoryId!)).toBe(2);
    await resolvers.Mutation.endAgentSession({}, { sessionId: s1.id }, appCtx(secretApp.id));
    expect(sessionKeyCache.refCount(s2.memoryId!)).toBe(1);
    expect(sessionKeyCache.getByMemoryId(s2.memoryId!)).not.toBeNull();
    await resolvers.Mutation.endAgentSession({}, { sessionId: s2.id }, appCtx(secretApp.id));
    expect(sessionKeyCache.getByMemoryId(s2.memoryId!)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// upsertNode encryption
// ---------------------------------------------------------------------------

describe('upsertNode with encryption', () => {
  it('stores ciphertext in the DB and returns plaintext to the caller', async () => {
    const key = generateDataKey().raw.toString('base64');
    const session = await resolvers.Mutation.startAgentSession(
      {},
      { agentId: agent.id, externalUserId: 'mm-1', dataKey: key },
      appCtx(secretApp.id),
    );
    const sessionCtx = appCtx(secretApp.id, { sessionId: session.id, roles: ['ADMIN'] });

    const upserted = await resolvers.Mutation.upsertNode(
      {},
      {
        input: {
          memoryId: session.memoryId!,
          loc: 'profile',
          name: 'profile',
          content: 'My deepest secret',
          data: { age: 42, city: 'Portland' },
        },
      },
      sessionCtx,
    );
    // The returned node is plaintext
    expect(upserted.content).toBe('My deepest secret');
    expect(upserted.data).toEqual({ age: 42, city: 'Portland' });

    // But the DB row is ciphertext
    const raw = await db.node.findUnique({ where: { id: upserted.id } });
    expect(raw?.content).not.toBe('My deepest secret');
    expect(typeof raw?.content).toBe('string');
    expect(raw?.content?.startsWith('enc:v1:')).toBe(true);
    expect(raw?.data).toMatchObject({ __enc: expect.any(String) });
  });

  it('throws when writing to an encrypted memory without an active session', async () => {
    const key = generateDataKey().raw.toString('base64');
    const session = await resolvers.Mutation.startAgentSession(
      {},
      { agentId: agent.id, externalUserId: 'mm-1', dataKey: key },
      appCtx(secretApp.id),
    );
    // End the session — key evicted
    await resolvers.Mutation.endAgentSession({}, { sessionId: session.id }, appCtx(secretApp.id));

    await expect(
      resolvers.Mutation.upsertNode(
        {},
        {
          input: {
            memoryId: session.memoryId!,
            loc: 'profile',
            name: 'profile',
            content: 'should fail',
          },
        },
        appCtx(secretApp.id, { roles: ['ADMIN'] }),
      ),
    ).rejects.toThrow(/SESSION_EXPIRED/);
  });
});

// ---------------------------------------------------------------------------
// Read path decryption
// ---------------------------------------------------------------------------

describe('read path decryption', () => {
  it('nodeById returns plaintext when the session key is active', async () => {
    const key = generateDataKey().raw.toString('base64');
    const session = await resolvers.Mutation.startAgentSession(
      {},
      { agentId: agent.id, externalUserId: 'mm-1', dataKey: key },
      appCtx(secretApp.id),
    );
    const sessionCtx = appCtx(secretApp.id, { sessionId: session.id, roles: ['ADMIN'] });
    const written = await resolvers.Mutation.upsertNode(
      {},
      {
        input: { memoryId: session.memoryId!, loc: 'n1', name: 'n1', content: 'plain' },
      },
      sessionCtx,
    );
    const read = await resolvers.Query.nodeById(
      {},
      { id: written.id },
      sessionCtx,
    );
    expect(read?.content).toBe('plain');
  });

  it('nodeById returns ciphertext when the session is over (no hard failure)', async () => {
    const key = generateDataKey().raw.toString('base64');
    const session = await resolvers.Mutation.startAgentSession(
      {},
      { agentId: agent.id, externalUserId: 'mm-1', dataKey: key },
      appCtx(secretApp.id),
    );
    const sessionCtx = appCtx(secretApp.id, { sessionId: session.id, roles: ['ADMIN'] });
    const written = await resolvers.Mutation.upsertNode(
      {},
      {
        input: { memoryId: session.memoryId!, loc: 'n2', name: 'n2', content: 'secret' },
      },
      sessionCtx,
    );
    await resolvers.Mutation.endAgentSession({}, { sessionId: session.id }, appCtx(secretApp.id));

    // Read from a new admin context (no active session) — batch read leaves
    // ciphertext in place rather than hard-failing, so the value comes back
    // as enc:v1:... which the caller can tell is ciphertext.
    const read = await resolvers.Query.nodeById(
      {},
      { id: written.id },
      { db, roles: ['ADMIN'] },
    );
    expect(read?.content?.startsWith('enc:v1:')).toBe(true);
    expect(read?.content).not.toBe('secret');
  });
});

// ---------------------------------------------------------------------------
// encryptMemory mutation
// ---------------------------------------------------------------------------

describe('encryptMemory', () => {
  it('converts an existing plaintext memory to encrypted', async () => {
    // Create a plaintext memory with a couple of nodes via the USER_ID app
    const session = await resolvers.Mutation.startAgentSession(
      {},
      { agentId: agent.id, externalUserId: 'mm-1' },
      appCtx(plaintextApp.id),
    );
    const sessionCtx = appCtx(plaintextApp.id, { sessionId: session.id, roles: ['ADMIN'] });
    await resolvers.Mutation.upsertNode(
      {},
      { input: { memoryId: session.memoryId!, loc: 'a', name: 'a', content: 'alpha' } },
      sessionCtx,
    );
    await resolvers.Mutation.upsertNode(
      {},
      { input: { memoryId: session.memoryId!, loc: 'b', name: 'b', content: 'beta', data: { n: 1 } } },
      sessionCtx,
    );

    const key = generateDataKey().raw.toString('base64');
    const encrypted = await resolvers.Mutation.encryptMemory(
      {},
      { memoryId: session.memoryId!, dataKey: key },
      appCtx(plaintextApp.id),
    );
    expect(encrypted.isEncrypted).toBe(true);

    // Inspect DB rows — should be ciphertext now
    const rows = await db.node.findMany({
      where: { memoryId: session.memoryId!, loc: { in: ['a', 'b'] } },
      orderBy: { loc: 'asc' },
    });
    expect(rows[0].content?.startsWith('enc:v1:')).toBe(true);
    expect(rows[1].content?.startsWith('enc:v1:')).toBe(true);
    expect(rows[1].data).toMatchObject({ __enc: expect.any(String) });
  });

  it('refuses to encrypt an already-encrypted memory', async () => {
    const key = generateDataKey().raw.toString('base64');
    const session = await resolvers.Mutation.startAgentSession(
      {},
      { agentId: agent.id, externalUserId: 'mm-1', dataKey: key },
      appCtx(secretApp.id),
    );
    await expect(
      resolvers.Mutation.encryptMemory(
        {},
        { memoryId: session.memoryId!, dataKey: key },
        appCtx(secretApp.id),
      ),
    ).rejects.toThrow(/already encrypted/);
  });
});

// ---------------------------------------------------------------------------
// linkMemoryToUser anon → encrypted
// ---------------------------------------------------------------------------

describe('linkMemoryToUser with encryption', () => {
  it('encrypts the memory when a dataKey is provided at link time', async () => {
    // Start an anonymous session on a USER_ID app (no dataKey allowed)
    const anonSession = await resolvers.Mutation.startAgentSession(
      {},
      { agentId: agent.id },
      appCtx(plaintextApp.id),
    );
    const sessionCtx = appCtx(plaintextApp.id, { sessionId: anonSession.id, roles: ['ADMIN'] });
    await resolvers.Mutation.upsertNode(
      {},
      {
        input: { memoryId: anonSession.memoryId!, loc: 'note', name: 'note', content: 'first draft' },
      },
      sessionCtx,
    );

    // Anonymous memory starts plaintext
    let mem = await db.memory.findUnique({ where: { id: anonSession.memoryId! } });
    expect(mem?.isEncrypted).toBe(false);
    expect(mem?.anonymousExpiresAt).not.toBeNull();

    // Link with a dataKey → memory is promoted to encrypted
    const key = generateDataKey().raw.toString('base64');
    await resolvers.Mutation.linkMemoryToUser(
      {},
      {
        memoryId: anonSession.memoryId!,
        externalUserId: 'mm-registered',
        dataKey: key,
      },
      appCtx(plaintextApp.id),
    );

    mem = await db.memory.findUnique({ where: { id: anonSession.memoryId! } });
    expect(mem?.isEncrypted).toBe(true);
    expect(mem?.anonymousExpiresAt).toBeNull();
    expect(mem?.urn).toContain(':user:');

    // The node content is now ciphertext
    const note = await db.node.findFirst({
      where: { memoryId: anonSession.memoryId!, loc: 'note' },
    });
    expect(note?.content?.startsWith('enc:v1:')).toBe(true);
  });

  it('leaves the memory plaintext when no dataKey is provided', async () => {
    const anonSession = await resolvers.Mutation.startAgentSession(
      {},
      { agentId: agent.id },
      appCtx(plaintextApp.id),
    );
    await resolvers.Mutation.linkMemoryToUser(
      {},
      { memoryId: anonSession.memoryId!, externalUserId: 'mm-2' },
      appCtx(plaintextApp.id),
    );
    const mem = await db.memory.findUnique({ where: { id: anonSession.memoryId! } });
    expect(mem?.isEncrypted).toBe(false);
  });
});
