import { withTestOperationKey } from '../../../test/operationKey.js';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { resolvers, type Context } from './resolvers.js';
import { generateId } from '../../../lib/id.js';
import { generateDataKey, parseDataKey } from '../../../lib/crypto.js';
import { makeKeyVerifier } from '../../../lib/memoryUnlock.js';
import { sessionKeyCache } from '../../../lib/sessionKeyCache.js';
import { computeContentHash } from '../../../lib/contentHash.js';
import { encryptNodeFields, encryptNodeFieldsWithKey, isAuthenticatedStringEnvelope } from '../../../lib/nodeCrypto.js';
import { writeNodeCore } from './resolvers.mutation.node.js';

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

// Exercise encrypted writes as the real session owner with an App selection.
// App credentials carry no platform role; a fabricated ADMIN masked the
// strict-owner gate in these tests before #1492.
async function sessionOwnerCtx(appId: string, sessionId: string, active = true): Promise<Context> {
  const session = await db.session.findUniqueOrThrow({ where: { id: sessionId }, select: { userId: true } });
  if (!session.userId) throw new Error('Expected an identified session owner');
  return appCtx(appId, { userId: session.userId, ...(active ? { sessionId } : {}) });
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
  // 023-app-shape Phase 2b: App→Agent is N:M via AppAgent (App.agentId is gone).
  await db.appAgent.create({ data: { appId: secretApp.id,    agentId: agent.id } });
  await db.appAgent.create({ data: { appId: plaintextApp.id, agentId: agent.id } });
});

// ---------------------------------------------------------------------------
// startAgentSession with request header key
// ---------------------------------------------------------------------------

describe('startAgentSession with encryption', () => {
  it('requires an operation key when the app is in SECRET mode', async () => {
    await expect(
      resolvers.Mutation.startAgentSession(
        {},
        { agentId: agent.id, externalUserId: 'mm-1' },
        appCtx(secretApp.id),
      ),
    ).rejects.toMatchObject({ extensions: { code: 'BAD_UNLOCK_INPUT' } });
  });

  it('rejects an operation key when the app is in USER_ID mode', async () => {
    const key = generateDataKey().raw.toString('base64');
    await expect(
      withTestOperationKey(key, (appCtx(plaintextApp.id)).appId, () => resolvers.Mutation.startAgentSession(
        {},
        { agentId: agent.id, externalUserId: 'mm-1' },
        appCtx(plaintextApp.id),
      )),
    ).rejects.toMatchObject({ extensions: { code: 'BAD_UNLOCK_INPUT' } });
  });

  it('creates an encrypted memory and caches the key', async () => {
    const key = generateDataKey().raw.toString('base64');
    const session = await withTestOperationKey(key, (appCtx(secretApp.id)).appId, () => resolvers.Mutation.startAgentSession(
      {},
      { agentId: agent.id, externalUserId: 'mm-1' },
      appCtx(secretApp.id),
    ));
    const mem = await db.memory.findUnique({ where: { id: session.memoryId! } });
    expect(mem?.isEncrypted).toBe(true);
    expect(mem?.keyVerifier).toMatch(/^enc:v1:/);
    // 041/#516: SECRET-mode memories are born class='private' (the only
    // encryptable class), not 'personal'.
    expect(mem?.class).toBe('private');
    expect(sessionKeyCache.getByMemoryId(session.memoryId!)).not.toBeNull();
  });

  it('provisions plaintext USER_ID memories as class=personal (no key)', async () => {
    const session = await resolvers.Mutation.startAgentSession(
      {},
      { agentId: agent.id, externalUserId: 'mm-plain' },
      appCtx(plaintextApp.id),
    );
    const mem = await db.memory.findUnique({ where: { id: session.memoryId! } });
    expect(mem?.isEncrypted).toBe(false);
    expect(mem?.class).toBe('personal');
  });

  it('requires the key on subsequent sessions for an already-encrypted memory', async () => {
    const key = generateDataKey().raw.toString('base64');
    await withTestOperationKey(key, (appCtx(secretApp.id)).appId, () => resolvers.Mutation.startAgentSession(
      {},
      { agentId: agent.id, externalUserId: 'mm-1' },
      appCtx(secretApp.id),
    ));

    // Second session for the same user without a request header key
    await expect(
      resolvers.Mutation.startAgentSession(
        {},
        { agentId: agent.id, externalUserId: 'mm-1' },
        appCtx(secretApp.id),
      ),
    ).rejects.toMatchObject({ extensions: { code: 'BAD_UNLOCK_INPUT' } });
  });

  it('rejects mismatched keys for concurrent sessions on the same memory', async () => {
    const k1 = generateDataKey().raw.toString('base64');
    const k2 = generateDataKey().raw.toString('base64');
    await withTestOperationKey(k1, (appCtx(secretApp.id)).appId, () => resolvers.Mutation.startAgentSession(
      {},
      { agentId: agent.id, externalUserId: 'mm-1' },
      appCtx(secretApp.id),
    ));
    await expect(
      withTestOperationKey(k2, (appCtx(secretApp.id)).appId, () => resolvers.Mutation.startAgentSession(
        {},
        { agentId: agent.id, externalUserId: 'mm-1' },
        appCtx(secretApp.id),
      )),
    ).rejects.toMatchObject({ extensions: { code: 'WRONG_KEY' } });
  });

  it('rejects the wrong key after the original SECRET session ends', async () => {
    const key = generateDataKey().raw.toString('base64');
    const wrong = generateDataKey().raw.toString('base64');
    const first = await withTestOperationKey(key, (appCtx(secretApp.id)).appId, () => resolvers.Mutation.startAgentSession(
      {}, { agentId: agent.id, externalUserId: 'mm-1' }, appCtx(secretApp.id),
    ));
    await resolvers.Mutation.endAgentSession({}, { sessionId: first.id }, appCtx(secretApp.id));
    await expect(withTestOperationKey(wrong, (appCtx(secretApp.id)).appId, () => resolvers.Mutation.startAgentSession(
      {}, { agentId: agent.id, externalUserId: 'mm-1' }, appCtx(secretApp.id),
    ))).rejects.toMatchObject({ extensions: { code: 'WRONG_KEY' } });
  });

  it('refuses new sessions for a verifier-less encrypted memory before caching either key', async () => {
    const originalKey = generateDataKey().raw.toString('base64');
    const wrongKey = generateDataKey().raw.toString('base64');
    const first = await withTestOperationKey(originalKey, (appCtx(secretApp.id)).appId, () => resolvers.Mutation.startAgentSession(
      {}, { agentId: agent.id, externalUserId: 'legacy-session' },
      appCtx(secretApp.id),
    ));
    await db.memory.update({ where: { id: first.memoryId! }, data: { keyVerifier: null } });
    await resolvers.Mutation.endAgentSession({}, { sessionId: first.id }, appCtx(secretApp.id));
    const sessionCount = await db.session.count({ where: { memoryId: first.memoryId! } });

    for (const dataKey of [originalKey, wrongKey]) {
      await expect(withTestOperationKey(dataKey, (appCtx(secretApp.id)).appId, () => resolvers.Mutation.startAgentSession(
        {}, { agentId: agent.id, externalUserId: 'legacy-session' },
        appCtx(secretApp.id),
      ))).rejects.toMatchObject({ extensions: { code: 'BAD_UNLOCK_INPUT', memoryId: first.memoryId } });
      expect(sessionKeyCache.getByMemoryId(first.memoryId!)).toBeNull();
    }
    expect(await db.session.count({ where: { memoryId: first.memoryId! } })).toBe(sessionCount);
  });

  it('accepts the same key on concurrent sessions (ref count increments)', async () => {
    const key = generateDataKey().raw.toString('base64');
    const s1 = await withTestOperationKey(key, (appCtx(secretApp.id)).appId, () => resolvers.Mutation.startAgentSession(
      {},
      { agentId: agent.id, externalUserId: 'mm-1' },
      appCtx(secretApp.id),
    ));
    const s2 = await withTestOperationKey(key, (appCtx(secretApp.id)).appId, () => resolvers.Mutation.startAgentSession(
      {},
      { agentId: agent.id, externalUserId: 'mm-1' },
      appCtx(secretApp.id),
    ));
    expect(sessionKeyCache.refCount(s1.memoryId!)).toBe(2);
    await resolvers.Mutation.endAgentSession({}, { sessionId: s1.id }, appCtx(secretApp.id));
    expect(sessionKeyCache.refCount(s2.memoryId!)).toBe(1);
    expect(sessionKeyCache.getByMemoryId(s2.memoryId!)).not.toBeNull();
    await resolvers.Mutation.endAgentSession({}, { sessionId: s2.id }, appCtx(secretApp.id));
    expect(sessionKeyCache.getByMemoryId(s2.memoryId!)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// createNode encryption
// ---------------------------------------------------------------------------

describe('createNode with encryption', () => {
  it('stores ciphertext in the DB and returns plaintext to the caller', async () => {
    const key = generateDataKey().raw.toString('base64');
    const session = await withTestOperationKey(key, (appCtx(secretApp.id)).appId, () => resolvers.Mutation.startAgentSession(
      {},
      { agentId: agent.id, externalUserId: 'mm-1' },
      appCtx(secretApp.id),
    ));
    const sessionCtx = await sessionOwnerCtx(secretApp.id, session.id);

    const upserted = await resolvers.Mutation.createNode(
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

  it('issue #366 — updateNodeData decrypts, merges, and re-encrypts `data` at rest', async () => {
    const key = generateDataKey().raw.toString('base64');
    const session = await withTestOperationKey(key, (appCtx(secretApp.id)).appId, () => resolvers.Mutation.startAgentSession(
      {},
      { agentId: agent.id, externalUserId: 'mm-1' },
      appCtx(secretApp.id),
    ));
    const sessionCtx = await sessionOwnerCtx(secretApp.id, session.id);

    const node = await resolvers.Mutation.createNode(
      {},
      {
        input: {
          memoryId: session.memoryId!,
          loc: 'profile',
          name: 'profile',
          data: { age: 42, city: 'Portland' },
        },
      },
      sessionCtx,
    );

    // Merge a patch: overwrites `city`, adds `zip`, preserves `age`.
    const merged = await resolvers.Mutation.updateNodeData(
      {},
      { nodeRef: node.id, data: { city: 'Seattle', zip: '98101' } },
      sessionCtx,
    );
    expect(merged.data).toEqual({ age: 42, city: 'Seattle', zip: '98101' });

    // The DB row is ciphertext, not the plaintext merged object.
    const raw = await db.node.findUnique({ where: { id: node.id } });
    expect(raw?.data).toMatchObject({ __enc: expect.any(String) });
  });

  it('spec 031 — abstract is encrypted at rest and returned plaintext to the caller', async () => {
    const key = generateDataKey().raw.toString('base64');
    const session = await withTestOperationKey(key, (appCtx(secretApp.id)).appId, () => resolvers.Mutation.startAgentSession(
      {},
      { agentId: agent.id, externalUserId: 'mm-1' },
      appCtx(secretApp.id),
    ));
    const sessionCtx = await sessionOwnerCtx(secretApp.id, session.id);

    const ABSTRACT_PLAINTEXT =
      'Paragraph-length summary that would leak ~2000 chars of content if stored plaintext.';

    const upserted = await resolvers.Mutation.createNode(
      {},
      {
        input: {
          memoryId: session.memoryId!,
          loc: 'sensitive',
          name: 'sensitive',
          abstract: ABSTRACT_PLAINTEXT,
          content: 'Body — also encrypted under the same key.',
        },
      },
      sessionCtx,
    );
    // The returned node is plaintext for both fields.
    expect(upserted.abstract).toBe(ABSTRACT_PLAINTEXT);
    expect(upserted.content).toBe('Body — also encrypted under the same key.');

    // The DB row carries ciphertext for both, with the `enc:v1:` marker.
    const raw = await db.node.findUnique({ where: { id: upserted.id } });
    expect(raw?.abstract).not.toBe(ABSTRACT_PLAINTEXT);
    expect(raw?.abstract?.startsWith('enc:v1:')).toBe(true);
    expect(raw?.content?.startsWith('enc:v1:')).toBe(true);

    // Round-trip via a read through nodeById returns plaintext.
    const read = await resolvers.Query.node({}, { ref: upserted.id },
      sessionCtx,
    );
    expect(read?.abstract).toBe(ABSTRACT_PLAINTEXT);
  });

  it('re-affirms against the locked encrypted body after an interleaved edit', async () => {
    const key = generateDataKey().raw.toString('base64');
    const session = await withTestOperationKey(key, (appCtx(secretApp.id)).appId, () => resolvers.Mutation.startAgentSession(
      {}, { agentId: agent.id, externalUserId: 'mm-locked-reaffirm' }, appCtx(secretApp.id),
    ));
    const sessionCtx = await sessionOwnerCtx(secretApp.id, session.id);
    const node = await resolvers.Mutation.createNode({}, {
      input: { memoryId: session.memoryId!, loc: 'locked-reaffirm', name: 'locked-reaffirm',
        abstract: 'Summary', content: 'Original body' },
    }, sessionCtx);

    const findUnique = db.node.findUnique.bind(db.node);
    let changedAfterProbe = false;
    const probe = vi.spyOn(db.node, 'findUnique').mockImplementation((async (args: Parameters<typeof findUnique>[0]) => {
      const result = await findUnique(args);
      if (!changedAfterProbe && 'loc_memoryId' in args.where &&
          args.where.loc_memoryId?.loc === 'locked-reaffirm') {
        changedAfterProbe = true;
        const content = encryptNodeFields(
          { content: 'Revised body' }, { id: session.memoryId!, isEncrypted: true },
        ).content;
        await db.node.update({ where: { id: node.id }, data: { content } });
      }
      return result;
    }) as never);
    try {
      await writeNodeCore({ memoryId: session.memoryId!, loc: 'locked-reaffirm',
        abstract: 'Summary' }, sessionCtx, 'update');
    } finally {
      probe.mockRestore();
    }
    expect(changedAfterProbe).toBe(true);
    const stored = await db.node.findUniqueOrThrow({ where: { id: node.id } });
    expect(stored.abstractOriginHash).toBe(computeContentHash('Revised body'));
    expect(stored.content?.startsWith('enc:v1:')).toBe(true);
  });

  it('throws when writing to an encrypted memory without an active session', async () => {
    const key = generateDataKey().raw.toString('base64');
    const session = await withTestOperationKey(key, (appCtx(secretApp.id)).appId, () => resolvers.Mutation.startAgentSession(
      {},
      { agentId: agent.id, externalUserId: 'mm-1' },
      appCtx(secretApp.id),
    ));
    // End the session — key evicted
    await resolvers.Mutation.endAgentSession({}, { sessionId: session.id }, appCtx(secretApp.id));

    await expect(
      resolvers.Mutation.createNode(
        {},
        {
          input: {
            memoryId: session.memoryId!,
            loc: 'profile',
            name: 'profile',
            content: 'should fail',
          },
        },
        await sessionOwnerCtx(secretApp.id, session.id, false),
      ),
    ).rejects.toThrow(/SESSION_EXPIRED/);
  });

  it('issue #366 — updateNodeData throws SESSION_EXPIRED on an encrypted memory with no active session', async () => {
    const key = generateDataKey().raw.toString('base64');
    const session = await withTestOperationKey(key, (appCtx(secretApp.id)).appId, () => resolvers.Mutation.startAgentSession(
      {},
      { agentId: agent.id, externalUserId: 'mm-1' },
      appCtx(secretApp.id),
    ));
    const sessionCtx = await sessionOwnerCtx(secretApp.id, session.id);
    const node = await resolvers.Mutation.createNode(
      {},
      { input: { memoryId: session.memoryId!, loc: 'profile', name: 'profile', data: { a: 1 } } },
      sessionCtx,
    );
    // End the session — key evicted.
    await resolvers.Mutation.endAgentSession({}, { sessionId: session.id }, appCtx(secretApp.id));

    await expect(
      resolvers.Mutation.updateNodeData(
        {},
        { nodeRef: node.id, data: { b: 2 } },
        await sessionOwnerCtx(secretApp.id, session.id, false),
      ),
    ).rejects.toThrow(/SESSION_EXPIRED/);
  });

  it('#742 — updateNodeProperties merges plaintext `properties` in-session on an encrypted memory', async () => {
    const key = generateDataKey().raw.toString('base64');
    const session = await withTestOperationKey(key, (appCtx(secretApp.id)).appId, () => resolvers.Mutation.startAgentSession(
      {},
      { agentId: agent.id, externalUserId: 'mm-1' },
      appCtx(secretApp.id),
    ));
    const sessionCtx = await sessionOwnerCtx(secretApp.id, session.id);
    const node = await resolvers.Mutation.createNode(
      {},
      { input: { memoryId: session.memoryId!, loc: 'profile', name: 'profile', properties: { a: 1 } } },
      sessionCtx,
    );
    const res = await (resolvers.Mutation as any).updateNodeProperties(
      {},
      { nodeRef: node.id, properties: { b: 2 } },
      sessionCtx,
    );
    // properties is plaintext at rest — merged + returned in the clear.
    expect(res.properties).toEqual({ a: 1, b: 2 });
    const reread = await db.node.findUnique({ where: { id: node.id } });
    expect(reread!.properties).toEqual({ a: 1, b: 2 });
  });

  it('#742 — updateNodeProperties throws SESSION_EXPIRED on an encrypted memory with no active session (the write round-trips the encrypted fields)', async () => {
    const key = generateDataKey().raw.toString('base64');
    const session = await withTestOperationKey(key, (appCtx(secretApp.id)).appId, () => resolvers.Mutation.startAgentSession(
      {},
      { agentId: agent.id, externalUserId: 'mm-1' },
      appCtx(secretApp.id),
    ));
    const sessionCtx = await sessionOwnerCtx(secretApp.id, session.id);
    const node = await resolvers.Mutation.createNode(
      {},
      { input: { memoryId: session.memoryId!, loc: 'profile', name: 'profile', properties: { a: 1 } } },
      sessionCtx,
    );
    // End the session — key evicted.
    await resolvers.Mutation.endAgentSession({}, { sessionId: session.id }, appCtx(secretApp.id));

    await expect(
      (resolvers.Mutation as any).updateNodeProperties(
        {},
        { nodeRef: node.id, properties: { b: 2 } },
        await sessionOwnerCtx(secretApp.id, session.id, false),
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
    const session = await withTestOperationKey(key, (appCtx(secretApp.id)).appId, () => resolvers.Mutation.startAgentSession(
      {},
      { agentId: agent.id, externalUserId: 'mm-1' },
      appCtx(secretApp.id),
    ));
    const sessionCtx = await sessionOwnerCtx(secretApp.id, session.id);
    const written = await resolvers.Mutation.createNode(
      {},
      {
        input: { memoryId: session.memoryId!, loc: 'n1', name: 'n1', content: 'plain' },
      },
      sessionCtx,
    );
    const read = await resolvers.Query.node({}, { ref: written.id },
      sessionCtx,
    );
    expect(read?.content).toBe('plain');
  });

  it('nodeById returns ciphertext when the session is over (no hard failure)', async () => {
    const key = generateDataKey().raw.toString('base64');
    const session = await withTestOperationKey(key, (appCtx(secretApp.id)).appId, () => resolvers.Mutation.startAgentSession(
      {},
      { agentId: agent.id, externalUserId: 'mm-1' },
      appCtx(secretApp.id),
    ));
    const sessionCtx = await sessionOwnerCtx(secretApp.id, session.id);
    const written = await resolvers.Mutation.createNode(
      {},
      {
        input: { memoryId: session.memoryId!, loc: 'n2', name: 'n2', content: 'secret' },
      },
      sessionCtx,
    );
    await resolvers.Mutation.endAgentSession({}, { sessionId: session.id }, appCtx(secretApp.id));

    // Read as the memory's OWNER, outside any active session (no session key) —
    // batch read leaves ciphertext in place rather than hard-failing, so the
    // value comes back as enc:v1:... which the caller can tell is ciphertext.
    // (Owner-only access per spec 034 — a platform admin can't read it.)
    const owned = await db.memory.findUniqueOrThrow({ where: { id: session.memoryId! }, select: { userId: true } });
    const read = await resolvers.Query.node({}, { ref: written.id },
      { db, userId: owned.userId! },
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
    const sessionCtx = await sessionOwnerCtx(plaintextApp.id, session.id);
    await resolvers.Mutation.createNode(
      {},
      { input: { memoryId: session.memoryId!, loc: 'a', name: 'a', content: 'alpha' } },
      sessionCtx,
    );
    await resolvers.Mutation.createNode(
      {},
      { input: { memoryId: session.memoryId!, loc: 'b', name: 'b', content: 'beta', data: { n: 1 } } },
      sessionCtx,
    );

    // 041/#516: only class='private' encrypts. A plaintext private memory is
    // the convert-later target (the SECRET-mode born-encrypted path is separate).
    await db.memory.update({ where: { id: session.memoryId! }, data: { class: 'private' } });

    const key = generateDataKey().raw.toString('base64');
    const encrypted = await resolvers.Mutation.encryptMemory(
      {},
      { memoryId: session.memoryId!, dataKey: key },
      sessionCtx,
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

  it('completes an already-encrypted SECRET memory under its birth key', async () => {
    const key = generateDataKey().raw.toString('base64');
    const session = await withTestOperationKey(key, (appCtx(secretApp.id)).appId, () => resolvers.Mutation.startAgentSession(
      {},
      { agentId: agent.id, externalUserId: 'mm-1' },
      appCtx(secretApp.id),
    ));
    const completed = await resolvers.Mutation.encryptMemory(
      {},
      { memoryId: session.memoryId!, dataKey: key },
      await sessionOwnerCtx(secretApp.id, session.id),
    );
    expect(completed.keyVerifier).toMatch(/^enc:v1:/);
  });

  it('refuses to claim a verifier for an empty legacy encrypted memory', async () => {
    const key = generateDataKey().raw.toString('base64');
    const session = await withTestOperationKey(key, (appCtx(secretApp.id)).appId, () => resolvers.Mutation.startAgentSession(
      {}, { agentId: agent.id, externalUserId: 'empty-legacy' },
      appCtx(secretApp.id),
    ));
    await db.memory.update({ where: { id: session.memoryId! }, data: { keyVerifier: null } });
    await expect(resolvers.Mutation.encryptMemory(
      {}, { memoryId: session.memoryId!, dataKey: key }, await sessionOwnerCtx(secretApp.id, session.id),
    )).rejects.toMatchObject({ extensions: { code: 'BAD_UNLOCK_INPUT' } });
  });

  it('refuses a mixed-key legacy witness without rewriting nodes or history (#1441)', async () => {
    const originalKey = generateDataKey().raw.toString('base64');
    const wrongKey = generateDataKey().raw.toString('base64');
    const first = await withTestOperationKey(originalKey, (appCtx(secretApp.id)).appId, () => resolvers.Mutation.startAgentSession(
      {}, { agentId: agent.id, externalUserId: 'mixed-legacy' },
      appCtx(secretApp.id),
    ));
    const original = await resolvers.Mutation.createNode(
      {}, { input: { memoryId: first.memoryId!, loc: 'original', name: 'original', content: 'original secret' } },
      await sessionOwnerCtx(secretApp.id, first.id),
    );
    await db.memory.update({ where: { id: first.memoryId! }, data: { keyVerifier: null } });
    await resolvers.Mutation.endAgentSession({}, { sessionId: first.id }, appCtx(secretApp.id));
    expect(sessionKeyCache.getByMemoryId(first.memoryId!)).toBeNull();

    // Model a witness written by an older server before the session gate.
    const wrongEnvelope = encryptNodeFieldsWithKey(
      { content: 'wrong-key witness' }, parseDataKey(wrongKey),
    );
    const witness = await db.node.create({
      data: {
        id: generateId(), memoryId: first.memoryId!, loc: 'later', name: 'later',
        content: wrongEnvelope.content,
      },
    });

    const beforeOriginal = await db.node.findUniqueOrThrow({ where: { id: original.id } });
    const beforeWitness = await db.node.findUniqueOrThrow({ where: { id: witness.id } });
    expect(isAuthenticatedStringEnvelope(beforeOriginal.content, parseDataKey(originalKey))).toBe(true);
    expect(isAuthenticatedStringEnvelope(beforeOriginal.content, parseDataKey(wrongKey))).toBe(false);
    expect(isAuthenticatedStringEnvelope(beforeWitness.content, parseDataKey(wrongKey))).toBe(true);
    const tombstone = await db.node.create({
      data: {
        id: generateId(), memoryId: first.memoryId!, loc: 'deleted', name: 'deleted',
        content: 'deleted plaintext', deletedAt: new Date(),
      },
    });
    const legacyRevision = await db.nodeRevision.create({
      data: {
        id: generateId(), nodeId: original.id, memoryId: null,
        loc: 'original', name: 'original', content: 'legacy plaintext',
      },
    });

    await expect(resolvers.Mutation.encryptMemory(
      {}, { memoryId: first.memoryId!, dataKey: wrongKey }, await sessionOwnerCtx(secretApp.id, first.id, false),
    )).rejects.toMatchObject({ extensions: { code: 'BAD_UNLOCK_INPUT', memoryId: first.memoryId } });
    expect((await db.memory.findUniqueOrThrow({ where: { id: first.memoryId! } })).keyVerifier).toBeNull();
    expect((await db.node.findUniqueOrThrow({ where: { id: original.id } })).content).toBe(beforeOriginal.content);
    expect((await db.node.findUniqueOrThrow({ where: { id: witness.id } })).content).toBe(beforeWitness.content);
    expect((await db.node.findUniqueOrThrow({ where: { id: tombstone.id } })).content).toBe('deleted plaintext');
    expect((await db.nodeRevision.findUniqueOrThrow({ where: { id: legacyRevision.id } })).content)
      .toBe('legacy plaintext');
  });

  // 007-entity-id-or-urn: encryptMemory accepts memoryId as ID or URN.
  it('accepts a URN as memoryId input', async () => {
    const session = await resolvers.Mutation.startAgentSession(
      {},
      { agentId: agent.id, externalUserId: 'urn-input-user' },
      appCtx(plaintextApp.id),
    );
    const sessionCtx = await sessionOwnerCtx(plaintextApp.id, session.id);
    await resolvers.Mutation.createNode(
      {},
      { input: { memoryId: session.memoryId!, loc: 'x', name: 'x', content: 'gamma' } },
      sessionCtx,
    );

    // Look up the memory's URN; pass that instead of the ID.
    const memoryRow = await db.memory.findUniqueOrThrow({
      where: { id: session.memoryId! },
      select: { urn: true },
    });

    // 041/#516: only class='private' encrypts.
    await db.memory.update({ where: { id: session.memoryId! }, data: { class: 'private' } });

    const key = generateDataKey().raw.toString('base64');
    const encrypted = await resolvers.Mutation.encryptMemory(
      {},
      { memoryId: memoryRow.urn, dataKey: key },
      sessionCtx,
    );
    expect(encrypted.isEncrypted).toBe(true);
    expect(encrypted.id).toBe(session.memoryId);
  });

  it('rejects an owner encrypting a class=personal memory (#516 grandfather retired)', async () => {
    // A plaintext USER_ID memory is class='personal'. Pre-#516 an App key could
    // grandfather-encrypt it; now 'private' is the only encryptable class.
    const session = await resolvers.Mutation.startAgentSession(
      {},
      { agentId: agent.id, externalUserId: 'mm-personal' },
      appCtx(plaintextApp.id),
    );
    const mem = await db.memory.findUnique({ where: { id: session.memoryId! } });
    expect(mem?.class).toBe('personal');

    const key = generateDataKey().raw.toString('base64');
    await expect(
      resolvers.Mutation.encryptMemory(
        {},
        { memoryId: session.memoryId!, dataKey: key },
        await sessionOwnerCtx(plaintextApp.id, session.id),
      ),
    ).rejects.toMatchObject({ extensions: { code: 'BAD_USER_INPUT' } });
  });
});

// ---------------------------------------------------------------------------
// linkMemoryToUser anon → encrypted
// ---------------------------------------------------------------------------

describe('linkMemoryToUser with encryption', () => {
  it('does not replace a competing promotion key before taking the promotion lock', async () => {
    const anon = await resolvers.Mutation.startAgentSession(
      {}, { agentId: agent.id }, appCtx(plaintextApp.id),
    );
    const node = await db.node.create({
      data: {
        id: generateId(), memoryId: anon.memoryId!, loc: 'note', name: 'note',
        content: 'anonymous draft',
      },
    });
    const rivalKey = generateDataKey().raw.toString('base64');
    const rivalVerifier = makeKeyVerifier(parseDataKey(rivalKey));
    const rivalContent = encryptNodeFieldsWithKey(
      { content: 'competing private draft' }, parseDataKey(rivalKey),
    ).content;
    const transaction = db.$transaction.bind(db) as any;
    let intervened = false;
    const fence = vi.spyOn(db, '$transaction').mockImplementation((async (input: any, options: any) => {
      if (typeof input !== 'function') return transaction(input, options);
      return transaction((tx: any) => input(new Proxy(tx, { get(target, property) {
        if (property !== '$queryRaw') return Reflect.get(target, property);
        return async (strings: TemplateStringsArray, ...values: unknown[]) => {
          // #1346 removes the pre-transaction live-value scan. A rival can
          // still win after preflight and before our deciding Memory lock.
          if (!intervened && strings.join('').includes('FROM memories') && strings.join('').includes('FOR UPDATE')) {
            intervened = true;
            const owner = await db.user.findFirstOrThrow({
              where: { externalAppId: plaintextApp.id, externalId: 'claimant' },
            });
            await db.node.update({ where: { id: node.id }, data: { content: rivalContent } });
            await db.memory.update({
              where: { id: anon.memoryId! },
              data: { isEncrypted: true, keyVerifier: rivalVerifier, class: 'private', userId: owner.id },
            });
          }
          return target.$queryRaw(strings, ...values);
        };
      } })), options);
    }) as typeof db.$transaction);
    try {
      await expect(withTestOperationKey(generateDataKey().raw.toString('base64'), (appCtx(plaintextApp.id)).appId, () => resolvers.Mutation.linkMemoryToUser(
        {}, { memoryId: anon.memoryId!, externalUserId: 'claimant' },
        appCtx(plaintextApp.id),
      ))).rejects.toMatchObject({ extensions: { code: 'MEMORY_WRITE_CONFLICT' } });
    } finally {
      fence.mockRestore();
    }
    expect(intervened).toBe(true);
    expect((await db.memory.findUniqueOrThrow({ where: { id: anon.memoryId! } })).keyVerifier)
      .toBe(rivalVerifier);
    expect((await db.node.findUniqueOrThrow({ where: { id: node.id } })).content)
      .toBe(rivalContent);
  });

  it('encrypts the memory when a dataKey is provided at link time', async () => {
    // Start an anonymous session on a USER_ID app (no dataKey allowed)
    const anonSession = await resolvers.Mutation.startAgentSession(
      {},
      { agentId: agent.id },
      appCtx(plaintextApp.id),
    );
    const sessionCtx = appCtx(plaintextApp.id, { sessionId: anonSession.id, roles: ['ADMIN'] });
    await resolvers.Mutation.createNode(
      {},
      {
        input: { memoryId: anonSession.memoryId!, loc: 'note', name: 'note', content: 'first draft' },
      },
      sessionCtx,
    );
    // Give the node a plaintext abstract (spec 031: abstract is an encrypted
    // field) so we can assert the promotion doesn't leak it.
    await db.node.update({
      where: { loc_memoryId: { loc: 'note', memoryId: anonSession.memoryId! } },
      data: { abstract: 'draft summary' },
    });
    const noteBefore = await db.node.findFirstOrThrow({
      where: { memoryId: anonSession.memoryId!, loc: 'note' },
    });
    const oldRevision = await db.nodeRevision.create({
      data: {
        id: generateId(), nodeId: noteBefore.id, memoryId: anonSession.memoryId!,
        loc: 'note', name: 'note', content: 'earlier private draft',
      },
    });

    // Anonymous memory starts plaintext
    let mem = await db.memory.findUnique({ where: { id: anonSession.memoryId! } });
    expect(mem?.isEncrypted).toBe(false);
    expect(mem?.anonymousExpiresAt).not.toBeNull();

    // Link with a dataKey → memory is promoted to encrypted
    const key = generateDataKey().raw.toString('base64');
    await withTestOperationKey(key, (appCtx(plaintextApp.id)).appId, () => resolvers.Mutation.linkMemoryToUser(
      {},
      { memoryId: anonSession.memoryId!, externalUserId: 'mm-registered' },
      appCtx(plaintextApp.id),
    ));

    mem = await db.memory.findUnique({ where: { id: anonSession.memoryId! } });
    expect(mem?.isEncrypted).toBe(true);
    expect(mem?.keyVerifier).toMatch(/^enc:v1:/);
    expect(mem?.anonymousExpiresAt).toBeNull();
    // 041/#516: an encrypted promotion lands class='private' owned by the
    // registered user (the anon scratch row was class='app', userId NULL).
    expect(mem?.class).toBe('private');
    expect(mem?.userId).toBeTruthy();
    // #697 Stage 3: anon→user promotion re-mints a FLAT single-atom v2 urn; the
    // app-user scope lives in the columns, not the URN path (was `:app-user:`).
    expect(mem?.urn?.split(':')).toHaveLength(2);
    expect(mem?.urn).not.toContain(':anon:');

    // The node content AND abstract are now ciphertext (spec 031 — the
    // promotion must not leave the abstract plaintext).
    const note = await db.node.findFirst({
      where: { memoryId: anonSession.memoryId!, loc: 'note' },
    });
    expect(note?.content?.startsWith('enc:v1:')).toBe(true);
    expect(note?.abstract?.startsWith('enc:v1:')).toBe(true);
    expect((await db.nodeRevision.findUniqueOrThrow({ where: { id: oldRevision.id } })).content)
      .toMatch(/^enc:v1:/);
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
