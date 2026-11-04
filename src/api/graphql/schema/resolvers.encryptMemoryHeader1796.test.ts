/**
 * #1796 (cor:sec:040:04, ruling 0145): `encryptMemory` works with no secret argument. The key or
 * passphrase travels beside the operation, in `x-hadron-memory-keys` for the strict owner and in
 * `x-hadron-operation-key` for the owning App's completion.
 *
 * Over real HTTP, because the header is staged at Apollo's context time, before any resolver.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createServer as createHttpServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { randomBytes } from 'node:crypto';
import { buildSchema } from 'graphql';
import { createServer } from '../../../server.js';
import { db } from '../../../integrations/db/client.js';
import { signJwt } from '../../../auth/jwt.js';
import { cleanDb } from '../../../test/helpers.js';
import { withTestOperationKey } from '../../../test/operationKey.js';
import { hashAppKey } from '../../../middleware/auth.js';
import { isCiphertext, parseDataKey } from '../../../lib/crypto.js';
import {
  deriveDataKeyFromPassphrase,
  makeKeyVerifier,
  parseKdfParams,
  verifyDataKey,
} from '../../../lib/memoryUnlock.js';
import { sessionKeyCache } from '../../../lib/sessionKeyCache.js';
import { generateId } from '../../../lib/id.js';
import { memoryMutations } from './resolvers.mutation.memory.js';
import { resolvers } from './resolvers.js';
import { typeDefs } from './typeDefs.js';

vi.mock('../../../integrations/github/writeNodeToGit.js', () => ({ writeNodeToGit: vi.fn() }));

const dataKey = Buffer.alloc(32, 41).toString('base64');
const wrongKey = Buffer.alloc(32, 42).toString('base64');
const passphrase = 'correct horse battery staple 1796';
const ENCRYPT = 'mutation($id: ID!) { encryptMemory(memoryId: $id) { id isEncrypted } }';
const READ = 'query($ref: ID!) { memory(ref: $ref) { id } }';

let server: Server;
let url: string;
let owner: { id: string };
let stranger: { id: string };
let ownerJwt: string;
let strangerJwt: string;
let memory: { id: string; urn: string };
let other: { id: string; urn: string };

type Reply = { status: number; errors?: Array<{ message: string; extensions?: Record<string, unknown> }>; data?: any };

async function send(
  query: string,
  variables: Record<string, unknown>,
  { bearer = ownerJwt, keys, operationKey, operationName }: { bearer?: string; keys?: unknown; operationKey?: string; operationName?: string } = {},
): Promise<Reply> {
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${bearer}`,
      ...(keys !== undefined ? { 'x-hadron-memory-keys': typeof keys === 'string' ? keys : JSON.stringify(keys) } : {}),
      ...(operationKey !== undefined ? { 'x-hadron-operation-key': operationKey } : {}),
    },
    body: JSON.stringify({ query, variables, ...(operationName ? { operationName } : {}) }),
  });
  const body = await response.json() as Omit<Reply, 'status'>;
  return { status: response.status, ...body };
}
const code = (reply: Reply) => reply.errors?.[0]?.extensions?.code;
/** What a caller can compare between two refusals. */
const face = (reply: Reply) => JSON.stringify({
  status: reply.status,
  data: reply.data ?? null,
  errors: (reply.errors ?? []).map((e) => ({ message: e.message, code: e.extensions?.code })),
});
const row = (id: string) => db.memory.findUniqueOrThrow({ where: { id } });

beforeAll(async () => {
  server = createHttpServer(await createServer());
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/graphql`;
});
afterAll(async () => { await new Promise<void>((resolve) => server.close(() => resolve())); });
afterEach(() => sessionKeyCache.clear());

const newPrivate = async (ownerId: string, suffix: string) => {
  const n = generateId().toLowerCase();
  return db.memory.create({ data: {
    name: `Private ${suffix}`, urn: `enc1796-${n}:${suffix}`, class: 'private',
    userId: ownerId, ownerUserId: ownerId, vectorIndexEnabled: false,
  } });
};

beforeEach(async () => {
  await cleanDb(db);
  sessionKeyCache.clear();
  owner = await db.user.create({ data: { handle: 'owner1796', roles: ['READER'] } });
  stranger = await db.user.create({ data: { handle: 'stranger1796', roles: ['READER'] } });
  ownerJwt = await signJwt({ sub: owner.id, roles: ['READER'] });
  strangerJwt = await signJwt({ sub: stranger.id, roles: ['READER'] });
  memory = await newPrivate(owner.id, 'diary');
  other = await newPrivate(owner.id, 'other');
  await db.node.create({ data: { id: generateId(), memoryId: memory.id, loc: 'entry', name: 'Entry', content: 'plaintext body 1796' } });
});

describe('#1796 acceptance 2: encryptMemory with no secret argument', () => {
  it('first encryption by the strict owner with a passphrase entry stores the salt and parameters, never the key', async () => {
    const reply = await send(ENCRYPT, { id: memory.id }, { keys: [{ memory: memory.id, passphrase }] });
    expect(reply.errors).toBeUndefined();
    expect(reply.data.encryptMemory.isEncrypted).toBe(true);
    const stored = await row(memory.id);
    expect(stored.kdfSalt).toBeTruthy();
    expect(stored.kdfParams).toBeTruthy();
    const derived = await deriveDataKeyFromPassphrase(passphrase, stored.kdfSalt!, parseKdfParams(stored.kdfParams));
    expect(verifyDataKey(stored.keyVerifier!, derived)).toBe(true);
    expect(JSON.stringify(stored)).not.toContain(passphrase);
    expect(JSON.stringify(stored)).not.toContain(derived.raw.toString('base64'));
    const node = await db.node.findFirstOrThrow({ where: { memoryId: memory.id } });
    expect(isCiphertext(node.content)).toBe(true);
  });

  it('first encryption by the strict owner with a dataKey entry stores a verifier and no KDF material', async () => {
    const reply = await send(ENCRYPT, { id: memory.urn }, { keys: [{ memory: memory.urn, dataKey }] });
    expect(reply.errors).toBeUndefined();
    const stored = await row(memory.id);
    expect(stored.isEncrypted).toBe(true);
    expect(stored.kdfSalt).toBeNull();
    expect(verifyDataKey(stored.keyVerifier!, parseDataKey(dataKey))).toBe(true);
    expect(JSON.stringify(stored)).not.toContain(dataKey);
  });

  it('the entry may name the memory differently from the operation (URN and id are the same memory)', async () => {
    const reply = await send(ENCRYPT, { id: memory.id }, { keys: [{ memory: memory.urn, dataKey }] });
    expect(reply.errors).toBeUndefined();
    expect((await row(memory.id)).isEncrypted).toBe(true);
  });

  it('a literal memoryId and a named operation in a multi-operation document work too', async () => {
    const doc = `query Other { __typename } mutation Encrypt { encryptMemory(memoryId: "${memory.id}") { id isEncrypted } }`;
    const reply = await send(doc, {}, { keys: [{ memory: memory.id, dataKey }], operationName: 'Encrypt' });
    expect(reply.errors).toBeUndefined();
    expect((await row(memory.id)).isEncrypted).toBe(true);
  });

  it('completion by the strict owner through x-hadron-memory-keys', async () => {
    await db.memory.update({ where: { id: memory.id }, data: { isEncrypted: true, keyVerifier: makeKeyVerifier(parseDataKey(dataKey)) } });
    const reply = await send(ENCRYPT, { id: memory.id }, { keys: [{ memory: memory.id, dataKey }] });
    expect(reply.errors).toBeUndefined();
    const node = await db.node.findFirstOrThrow({ where: { memoryId: memory.id } });
    expect(isCiphertext(node.content)).toBe(true);
  });

  describe('completion by the owning App key through x-hadron-operation-key', () => {
    let appToken: string;
    let siblingToken: string;
    beforeEach(async () => {
      const org = await db.organization.create({ data: { name: 'Org 1796', urn: 'org1796.test' } });
      const agent = await db.agent.create({ data: { name: 'Agent 1796', urn: 'org1796.test:agent', organizationId: org.id } });
      const app = await db.app.create({ data: { name: 'App 1796', urn: 'org1796.test:app', organizationId: org.id } });
      const sibling = await db.app.create({ data: { name: 'Sibling 1796', urn: 'org1796.test:sibling', organizationId: org.id } });
      const mint = async (appId: string) => {
        const raw = `hdr_app_${randomBytes(32).toString('hex')}`;
        await db.appKey.create({ data: { appId, keyHash: hashAppKey(raw), keyPreview: raw.slice(-4) } });
        return raw;
      };
      appToken = await mint(app.id);
      siblingToken = await mint(sibling.id);
      await db.memory.update({ where: { id: memory.id }, data: {
        appId: app.id, userMemoryOfAgentId: agent.id, isEncrypted: true, keyVerifier: makeKeyVerifier(parseDataKey(dataKey)),
      } });
    });

    it('completes under the existing verifier', async () => {
      const before = await row(memory.id);
      const reply = await send(ENCRYPT, { id: memory.id }, { bearer: appToken, operationKey: dataKey });
      expect(reply.errors).toBeUndefined();
      expect((await row(memory.id)).keyVerifier).toBe(before.keyVerifier);
      const node = await db.node.findFirstOrThrow({ where: { memoryId: memory.id } });
      expect(isCiphertext(node.content)).toBe(true);
    });

    it('a wrong operation key is WRONG_KEY and converts nothing', async () => {
      const reply = await send(ENCRYPT, { id: memory.id }, { bearer: appToken, operationKey: wrongKey });
      expect(code(reply)).toBe('WRONG_KEY');
      const node = await db.node.findFirstOrThrow({ where: { memoryId: memory.id } });
      expect(node.content).toBe('plaintext body 1796');
    });

    it('a sibling App holding the right key is refused and converts nothing', async () => {
      const reply = await send(ENCRYPT, { id: memory.id }, { bearer: siblingToken, operationKey: dataKey });
      expect(reply.errors?.length).toBeGreaterThan(0);
      const node = await db.node.findFirstOrThrow({ where: { memoryId: memory.id } });
      expect(node.content).toBe('plaintext body 1796');
    });

    it('an operation key never first-encrypts: the owning App cannot do it on a plaintext memory', async () => {
      await db.memory.update({ where: { id: memory.id }, data: { isEncrypted: false, keyVerifier: null } });
      const reply = await send(ENCRYPT, { id: memory.id }, { bearer: appToken, operationKey: dataKey });
      expect(reply.errors?.length).toBeGreaterThan(0);
      expect((await row(memory.id)).isEncrypted).toBe(false);
    });
  });

  it("the server's own completion path passes no secret as an argument", async () => {
    const org = await db.organization.create({ data: { name: 'Org link 1796', urn: 'link1796.test' } });
    const agent = await db.agent.create({ data: { name: 'Link agent', urn: 'link1796.test:agent', organizationId: org.id } });
    const app = await db.app.create({ data: { name: 'Link app', urn: 'link1796.test:app', organizationId: org.id, identifyUserMethod: 'SECRET', createUserPermission: 'IMPLICIT' } });
    await db.appAgent.create({ data: { appId: app.id, agentId: agent.id } });
    const anon = await db.memory.create({ data: {
      name: 'Anon', urn: `link1796.test:anon-${generateId().toLowerCase()}`, class: 'app', organizationId: org.id, appId: app.id,
      userMemoryOfAgentId: agent.id, anonymousExpiresAt: new Date(Date.now() + 86_400_000),
    } });
    const completion = vi.spyOn(memoryMutations, 'encryptMemory');
    try {
      await withTestOperationKey(dataKey, app.id, () => resolvers.Mutation.linkMemoryToUser(
        {}, { memoryId: anon.id, externalUserId: 'link-1796' }, { db, appId: app.id, roles: [] },
      ));
      expect(completion).toHaveBeenCalledTimes(1);
      const args = completion.mock.calls[0][1] as Record<string, unknown>;
      expect(Object.keys(args)).toEqual(['memoryId']);
    } finally { completion.mockRestore(); }
    expect((await row(anon.id)).isEncrypted).toBe(true);
  });
});

describe('#1796 acceptance 3: the header refuses as the argument does', () => {
  it.each([
    ['both', { dataKey, passphrase }],
    ['neither', {}],
    ['an empty dataKey and no passphrase', { dataKey: '' }],
    ['a non-string passphrase', { passphrase: 7 }],
    ['a non-string dataKey', { dataKey: { raw: 1 } }],
    ['a malformed dataKey', { dataKey: 'not-a-key' }],
  ])('%s refuses BAD_UNLOCK_INPUT and encrypts nothing', async (_label, secret) => {
    const reply = await send(ENCRYPT, { id: memory.id }, { keys: [{ memory: memory.id, ...secret }] });
    expect(code(reply)).toBe('BAD_UNLOCK_INPUT');
    expect((await row(memory.id)).isEncrypted).toBe(false);
  });

  it('a header entry and an argument together are refused: one secret, one channel', async () => {
    const reply = await send(
      'mutation($id: ID!, $k: String) { encryptMemory(memoryId: $id, dataKey: $k) { id } }',
      { id: memory.id, k: dataKey },
      { keys: [{ memory: memory.id, dataKey }] },
    );
    expect(code(reply)).toBe('BAD_UNLOCK_INPUT');
    expect((await row(memory.id)).isEncrypted).toBe(false);
  });

  it('two entries for the same memory are refused, not last-one-wins', async () => {
    const reply = await send(ENCRYPT, { id: memory.id }, { keys: [{ memory: memory.id, dataKey }, { memory: memory.urn, dataKey: wrongKey }] });
    expect(code(reply)).toBe('BAD_UNLOCK_INPUT');
    expect((await row(memory.id)).isEncrypted).toBe(false);
  });

  it('with no entry and no argument the refusal is unchanged', async () => {
    const reply = await send(ENCRYPT, { id: memory.id });
    expect(code(reply)).toBe('BAD_USER_INPUT');
    expect((await row(memory.id)).isEncrypted).toBe(false);
  });

  it('a non-owner gets the same answer for a plaintext memory, an encrypted memory and a missing one', async () => {
    const encrypted = await newPrivate(owner.id, 'sealed');
    await db.memory.update({ where: { id: encrypted.id }, data: { isEncrypted: true, keyVerifier: makeKeyVerifier(parseDataKey(dataKey)) } });
    const missing = generateId();
    const ask = (id: string) => send(ENCRYPT, { id }, { bearer: strangerJwt, keys: [{ memory: id, dataKey }] });
    const [plain, sealed, absent] = [await ask(memory.id), await ask(encrypted.id), await ask(missing)];
    expect(code(absent)).toBe('NOT_FOUND');
    expect(face(plain)).toBe(face(absent));
    expect(face(sealed)).toBe(face(absent));
    expect((await row(memory.id)).isEncrypted).toBe(false);
  });

  describe('an impersonator', () => {
    let impJwt: string;
    beforeEach(async () => {
      const org = await db.organization.create({ data: { name: 'Imp org', urn: 'imp1796.test' } });
      const admin = await db.user.create({ data: { handle: 'admin1796', roles: ['ADMIN'] } });
      await db.orgMember.createMany({ data: [
        { organizationId: org.id, userId: admin.id, role: 'ADMIN' },
        { organizationId: org.id, userId: owner.id, role: 'CONTRIBUTOR' },
      ] });
      const session = await db.impersonationSession.create({ data: {
        adminUserId: admin.id, targetUserId: owner.id, organizationId: org.id, expiresAt: new Date(Date.now() + 600_000),
      } });
      impJwt = await signJwt({ sub: owner.id, roles: [], imp: { sid: session.id, act: admin.id, org: org.id } });
    });

    it('gets the missing-memory answer on a plaintext memory, an encrypted memory and a missing one, and encrypts nothing', async () => {
      const encrypted = await newPrivate(owner.id, 'sealed');
      await db.memory.update({ where: { id: encrypted.id }, data: { isEncrypted: true, keyVerifier: makeKeyVerifier(parseDataKey(dataKey)) } });
      const missing = generateId();
      const ask = (id: string) => send(ENCRYPT, { id }, { bearer: impJwt, keys: [{ memory: id, dataKey: wrongKey }] });
      const [plain, sealed, absent] = [await ask(memory.id), await ask(encrypted.id), await ask(missing)];
      expect(code(absent)).toBe('NOT_FOUND');
      expect(face(plain)).toBe(face(absent));
      expect(face(sealed)).toBe(face(absent));
      expect((await row(memory.id)).isEncrypted).toBe(false);
    });
  });
});

describe('#1796 acceptance 4: an entry on a plaintext memory, on anything but encryptMemory', () => {
  const notEncrypted = (reply: Reply) => expect(code(reply)).toBe('NOT_ENCRYPTED');

  it('a query', async () => {
    notEncrypted(await send(READ, { ref: memory.id }, { keys: [{ memory: memory.id, dataKey }] }));
  });

  it('another mutation', async () => {
    notEncrypted(await send(
      'mutation($id: ID!) { updateMemory(memoryId: $id, name: "x") { id } }',
      { id: memory.id },
      { keys: [{ memory: memory.id, passphrase }] },
    ));
    expect((await row(memory.id)).name).toBe('Private diary');
  });

  it('encryptMemory aimed at a different memory than the entry names', async () => {
    notEncrypted(await send(ENCRYPT, { id: other.id }, { keys: [{ memory: memory.id, dataKey }] }));
    expect((await row(memory.id)).isEncrypted).toBe(false);
    expect((await row(other.id)).isEncrypted).toBe(false);
  });

  it.each([
    ['beside another root field', (id: string) => `mutation { encryptMemory(memoryId: "${id}") { id } updateMemory(memoryId: "${id}", name: "x") { id } }`],
    ['twice under aliases', (id: string) => `mutation { a: encryptMemory(memoryId: "${id}") { id } b: encryptMemory(memoryId: "${id}") { id } }`],
    ['behind a fragment', (id: string) => `mutation { ...F } fragment F on Mutation { encryptMemory(memoryId: "${id}") { id } }`],
    ['under a directive', (id: string) => `mutation { encryptMemory(memoryId: "${id}") @include(if: true) { id } }`],
  ])('encryptMemory %s', async (_label, doc) => {
    notEncrypted(await send(doc(memory.id), {}, { keys: [{ memory: memory.id, dataKey }] }));
    expect((await row(memory.id)).isEncrypted).toBe(false);
  });

  it('a query document naming encryptMemory in a string is still a query', async () => {
    notEncrypted(await send('query { __type(name: "encryptMemory") { name } }', {}, { keys: [{ memory: memory.id, dataKey }] }));
  });

  it('a query whose root field is spelled encryptMemory is not the mutation', async () => {
    notEncrypted(await send(`query { encryptMemory(memoryId: "${memory.id}") { id } }`, {}, { keys: [{ memory: memory.id, dataKey }] }));
    expect((await row(memory.id)).isEncrypted).toBe(false);
  });

  it('a document that does not parse', async () => {
    notEncrypted(await send('mutation { encryptMemory(', {}, { keys: [{ memory: memory.id, dataKey }] }));
  });
});

describe('#1796 the entry stays with its request', () => {
  it('a first-encryption entry leaves no key behind for the next request', async () => {
    expect((await send(ENCRYPT, { id: memory.id }, { keys: [{ memory: memory.id, dataKey }] })).errors).toBeUndefined();
    expect(sessionKeyCache.getByMemoryId(memory.id)).toBeFalsy();
    const again = await send(ENCRYPT, { id: memory.id });
    expect(code(again)).toBe('BAD_UNLOCK_INPUT');
  });
});

describe('#1796 acceptance 1: the deprecation window', () => {
  it('encryptMemory.dataKey and .passphrase are deprecated while they remain', () => {
    const args = buildSchema(typeDefs).getMutationType()!.getFields().encryptMemory.args;
    for (const name of ['dataKey', 'passphrase']) {
      expect(args.find((a) => a.name === name)?.deprecationReason).toMatch(/x-hadron-memory-keys/);
    }
  });
});
