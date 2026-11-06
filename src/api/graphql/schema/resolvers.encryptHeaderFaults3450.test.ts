/**
 * #3450 over real HTTP. `x-hadron-memory-keys` is staged in Apollo's context function, before any resolver, so a fault
 * there leaves through context creation. This proves what a client receives, and what the fault log holds.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createServer as createHttpServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { inspect } from 'node:util';
import { randomBytes } from 'node:crypto';
import { createServer } from '../../../server.js';
import { db } from '../../../integrations/db/client.js';
import { signJwt } from '../../../auth/jwt.js';
import { cleanDb } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { hashAppKey } from '../../../middleware/auth.js';
import { sessionKeyCache } from '../../../lib/sessionKeyCache.js';
import { deriveDataKeyFromPassphrase, parseKdfParams, stageRequestMemoryKeys, verifyDataKey } from '../../../lib/memoryUnlock.js';
import { requestOperationKeyStorage } from '../../../lib/requestOperationKey.js';
import { parseDataKey } from '../../../lib/crypto.js';
import { resolvers } from './resolvers.js';

const inject = vi.hoisted(() => ({
  /** Fails `resolveMemoryRef` for the refs it names. */
  ref: null as ((ref: string) => Error | null) | null,
  /** Runs inside `resolveMemoryRef`, to hold requests overlapped. */
  hold: null as ((ref: string) => Promise<void>) | null,
  /** Fails the passphrase derivation. */
  scrypt: null as Error | null,
}));

vi.mock('../../../lib/entityRef/memoryRef.js', async (original) => {
  const actual = await original<typeof import('../../../lib/entityRef/memoryRef.js')>();
  return {
    ...actual,
    resolveMemoryRef: async (...args: Parameters<typeof actual.resolveMemoryRef>) => {
      await inject.hold?.(args[1]);
      const fault = inject.ref?.(args[1]);
      if (fault) throw fault;
      return actual.resolveMemoryRef(...args);
    },
  };
});
vi.mock('crypto', async (original) => {
  const actual = await original<typeof import('crypto')>();
  return {
    ...actual,
    scrypt: (...args: unknown[]) => {
      if (inject.scrypt) return (args[args.length - 1] as (e: Error) => void)(inject.scrypt);
      return (actual.scrypt as (...a: unknown[]) => void)(...args);
    },
  };
});
vi.mock('../../../integrations/github/writeNodeToGit.js', () => ({ writeNodeToGit: vi.fn() }));

const dataKey = Buffer.alloc(32, 51).toString('base64');
const SENTINEL = 'sentinel-passphrase-3450-do-not-log';
const DRIVER_TEXT = 'connect ECONNREFUSED 10.9.8.7:5432 at db-internal-3450';
const ENCRYPT = 'mutation($id: ID!) { encryptMemory(memoryId: $id) { id isEncrypted } }';
const READ = 'query($ref: ID!) { memory(ref: $ref) { id } }';

let server: Server;
let url: string;
let owner: { id: string };
let ownerJwt: string;
let strangerJwt: string;
let memory: { id: string; urn: string };
let faultLog: { mock: { calls: unknown[][] } };

type Reply = { status: number; raw: string; errors?: Array<{ message: string; extensions?: Record<string, unknown> }>; data?: unknown };

async function send(query: string, variables: Record<string, unknown>, keys?: unknown, bearer: string | null = ownerJwt, extra: Record<string, string> = {}): Promise<Reply> {
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(bearer ? { authorization: `Bearer ${bearer}` } : {}),
      ...(keys !== undefined ? { 'x-hadron-memory-keys': JSON.stringify(keys) } : {}),
      ...extra,
    },
    body: JSON.stringify({ query, variables }),
  });
  const raw = await response.text();
  return { status: response.status, raw, ...JSON.parse(raw) };
}
const code = (reply: Reply) => reply.errors?.[0]?.extensions?.code;
const row = (id: string) => db.memory.findUniqueOrThrow({ where: { id } });
const loggedText = () => faultLog.mock.calls.map(call => inspect(call, { depth: 8 })).join('\n');

const newPrivate = async (ownerId: string, suffix: string) => {
  const n = generateId().toLowerCase();
  return db.memory.create({ data: { name: `Private ${suffix}`, urn: `enc3450-${n}:${suffix}`, class: 'private', userId: ownerId, ownerUserId: ownerId, vectorIndexEnabled: false } });
};

/** The generic internal error, and nothing of the fault, the memory or the ref. */
function expectRedacted(reply: Reply, forbidden: string[]) {
  expect(reply.errors).toHaveLength(1);
  const [error] = reply.errors!;
  expect(error.message).toBe('Internal server error.');
  expect(error.extensions).toEqual({ code: 'INTERNAL_SERVER_ERROR', requestId: expect.any(String) });
  expect(reply.raw).not.toContain('Context creation failed');
  for (const text of [DRIVER_TEXT, ...forbidden]) expect(reply.raw).not.toContain(text);
  expect(['NOT_FOUND', 'NOT_ENCRYPTED']).not.toContain(code(reply));
}

beforeAll(async () => {
  server = createHttpServer(await createServer());
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/graphql`;
});
afterAll(async () => { await new Promise<void>((resolve) => server.close(() => resolve())); });
beforeEach(async () => {
  await cleanDb(db);
  sessionKeyCache.clear();
  inject.ref = inject.hold = inject.scrypt = null;
  faultLog = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  owner = await db.user.create({ data: { handle: 'owner3450', roles: ['READER'] } });
  const stranger = await db.user.create({ data: { handle: 'stranger3450', roles: ['READER'] } });
  ownerJwt = await signJwt({ sub: owner.id, roles: ['READER'] });
  strangerJwt = await signJwt({ sub: stranger.id, roles: ['READER'] });
  memory = await newPrivate(owner.id, 'diary');
});
afterEach(() => { vi.restoreAllMocks(); sessionKeyCache.clear(); });

describe('#3450 an operational failure in the header path, through the real Apollo context stage', () => {
  it('at the entry: the generic internal error, not NOT_FOUND', async () => {
    inject.ref = ref => ref === memory.id ? new Error(`${DRIVER_TEXT} ${memory.id}`) : null;
    const reply = await send(READ, { ref: memory.id }, [{ memory: memory.id, dataKey }]);
    expectRedacted(reply, [memory.id, memory.urn]);
    expect(loggedText()).toContain(DRIVER_TEXT);
  });

  it('at the encryptMemory target: the generic internal error, not NOT_ENCRYPTED', async () => {
    inject.ref = ref => ref === memory.urn ? new Error(`${DRIVER_TEXT} ${memory.urn}`) : null;
    const reply = await send(ENCRYPT, { id: memory.urn }, [{ memory: memory.id, dataKey }]);
    expectRedacted(reply, [memory.id, memory.urn]);
    expect((await row(memory.id)).isEncrypted).toBe(false);
  });
});

describe('#3450 no secret in a routed fault', () => {
  it('a derivation fault keeps the passphrase off the wire and out of the fault log', async () => {
    const m = await newPrivate(owner.id, 'sealed');
    await resolvers.Mutation.encryptMemory({}, { memoryId: m.id, passphrase: 'an-earlier-passphrase' }, { db, userId: owner.id, roles: ['READER'] } as never);
    sessionKeyCache.clear();
    inject.scrypt = Object.assign(new Error('memory limit exceeded'), { code: 'ERR_CRYPTO_OPERATION_FAILED' });
    const reply = await send(READ, { ref: m.id }, [{ memory: m.id, passphrase: SENTINEL }]);
    expectRedacted(reply, [SENTINEL, m.id]);
    expect(loggedText()).toContain('memory limit exceeded');
    expect(loggedText()).not.toContain(SENTINEL);
  });

  it('a numeric passphrase, which Node would echo, keeps NOT_FOUND and logs nothing', async () => {
    const m = await newPrivate(owner.id, 'sealed');
    await resolvers.Mutation.encryptMemory({}, { memoryId: m.id, passphrase: 'an-earlier-passphrase' }, { db, userId: owner.id, roles: ['READER'] } as never);
    sessionKeyCache.clear();
    const reply = await send(READ, { ref: m.id }, [{ memory: m.id, passphrase: 987654321 }]);
    expect(code(reply)).toBe('NOT_FOUND');
    expect(reply.raw).not.toContain('987654321');
    expect(loggedText()).not.toContain('987654321');
  });
});

describe('#3450 a stored row with unusable KDF parameters', () => {
  it('a numeric passphrase keeps the KDF refusal, and nothing is logged', async () => {
    const m = await newPrivate(owner.id, 'sealed');
    await resolvers.Mutation.encryptMemory({}, { memoryId: m.id, passphrase: 'an-earlier-passphrase' }, { db, userId: owner.id, roles: ['READER'] } as never);
    sessionKeyCache.clear();
    await db.memory.update({ where: { id: m.id }, data: { kdfParams: { alg: 'scrypt', N: 3, r: 8, p: 1 } } });
    const reply = await send(READ, { ref: m.id }, [{ memory: m.id, passphrase: 987654321 }]);
    expect(code(reply)).toBe('BAD_UNLOCK_INPUT');
    expect(reply.errors![0].message).toBe('Memory has no usable KDF parameters.');
    expect(reply.raw).not.toContain('987654321');
    expect(faultLog).not.toHaveBeenCalled();
  });
});

describe('#3450 unchanged answers, same code and message', () => {
  const missing = 'hrn:memory:enc3450-nobody::nothing';

  it('unauthenticated header', async () => {
    const reply = await send(READ, { ref: memory.id }, [{ memory: memory.id, dataKey }], null);
    expect(code(reply)).toBe('UNAUTHENTICATED');
    expect(reply.errors![0].message).toBe('x-hadron-memory-keys requires an authenticated user.');
  });

  it.each([
    ['not a URN', 'not-a-urn'],
    ['an empty URN', 'hrn:memory:'],
    ['a NUL in a URN', 'hrn:memory:enc3450\u0000x::y'],
    ['a NUL in a bare ref', 'abc\u0000def'],
    ['a NUL in an id-length ref', `${'a'.repeat(31)}\u0000`],
    ['a lone surrogate', 'hrn:memory:enc3450\ud800x::y'],
    ['a very long URN', `hrn:memory:enc3450::${'y'.repeat(12000)}`],
    ['a missing memory', missing],
  ])('entry ref: %s is NOT_FOUND', async (_name, ref) => {
    const reply = await send(READ, { ref: memory.id }, [{ memory: ref, dataKey }]);
    expect(code(reply)).toBe('NOT_FOUND');
    expect(reply.errors![0].message).toBe('Memory not found.');
    expect(faultLog).not.toHaveBeenCalled();
  });

  it.each([
    ['not a URN', 'not-a-urn'],
    ['a NUL in a URN', 'hrn:memory:enc3450\u0000x::y'],
    ['a lone surrogate', 'hrn:memory:enc3450\ud800x::y'],
    ['a missing memory', missing],
  ])('encryptMemory target: %s is NOT_ENCRYPTED for an entry on a plaintext memory', async (_name, ref) => {
    const reply = await send(ENCRYPT, { id: ref }, [{ memory: memory.id, dataKey }]);
    expect(code(reply)).toBe('NOT_ENCRYPTED');
    expect(faultLog).not.toHaveBeenCalled();
  });

  it('a non-owner gets the missing-memory answer', async () => {
    const reply = await send(READ, { ref: memory.id }, [{ memory: memory.id, dataKey }], strangerJwt);
    expect(code(reply)).toBe('NOT_FOUND');
    expect(reply.errors![0].message).toBe('Memory not found.');
  });

  it('an already-encrypted memory: encryptMemory completes under its verifier with the right key, WRONG_KEY otherwise', async () => {
    expect((await send(ENCRYPT, { id: memory.id }, [{ memory: memory.id, dataKey }])).errors).toBeUndefined();
    sessionKeyCache.clear();
    const right = await send(ENCRYPT, { id: memory.id }, [{ memory: memory.id, dataKey }]);
    expect(right.errors).toBeUndefined();
    sessionKeyCache.clear();
    const wrong = await send(ENCRYPT, { id: memory.id }, [{ memory: memory.id, dataKey: Buffer.alloc(32, 52).toString('base64') }]);
    expect(code(wrong)).toBe('WRONG_KEY');
    expect(verifyDataKey((await row(memory.id)).keyVerifier as string, parseDataKey(dataKey))).toBe(true);
  });
});

describe('#3450 impersonation', () => {
  it('the target owns nothing: the missing-memory answer', async () => {
    await expect(stageRequestMemoryKeys(db, JSON.stringify([{ memory: memory.id, dataKey }]), owner.id, { impersonated: true }))
      .rejects.toMatchObject({ code: 'NOT_FOUND', message: 'Memory not found.' });
  });
});

describe('#3450 overlap over HTTP', () => {
  it('two owners encrypt at once, each under their own secret only', async () => {
    const peer = await db.user.create({ data: { handle: 'peer3450', roles: ['READER'] } });
    const peerJwt = await signJwt({ sub: peer.id, roles: ['READER'] });
    const peerMemory = await newPrivate(peer.id, 'peer');
    let arrived = 0;
    let open!: () => void;
    const opened = new Promise<void>(resolve => { open = resolve; });
    inject.hold = async ref => {
      if (ref !== memory.id && ref !== peerMemory.id) return;
      if (++arrived === 2) open();
      await opened;
    };
    const [a, b] = await Promise.all([
      send(ENCRYPT, { id: memory.id }, [{ memory: memory.id, passphrase: 'owner-secret-3450' }]),
      send(ENCRYPT, { id: peerMemory.id }, [{ memory: peerMemory.id, passphrase: 'peer-secret-3450' }], peerJwt),
    ]);
    expect([a.errors, b.errors]).toEqual([undefined, undefined]);
    const check = async (id: string, secret: string) => {
      const m = await row(id);
      return verifyDataKey(m.keyVerifier as string, await deriveDataKeyFromPassphrase(secret, m.kdfSalt as string, parseKdfParams(m.kdfParams)));
    };
    expect(await check(memory.id, 'owner-secret-3450')).toBe(true);
    expect(await check(memory.id, 'peer-secret-3450')).toBe(false);
    expect(await check(peerMemory.id, 'peer-secret-3450')).toBe(true);
    expect(sessionKeyCache.getByMemoryId(memory.id)).toBeFalsy();
  });
});

/** The stores are per request at the server's own boundary, which a test building its own `run()` can't reach. */
describe('#3450 nothing staged outlives its request', () => {
  it('a verified key: the next request without the header is locked', async () => {
    const create = 'mutation($input: CreateNodeInput!) { createNode(input: $input) { id } }';
    const input = { memoryId: memory.id, loc: 'entry', name: 'Entry', content: 'synthetic 3450' };
    await send(ENCRYPT, { id: memory.id }, [{ memory: memory.id, dataKey }]);
    sessionKeyCache.clear();
    expect((await send(create, { input }, [{ memory: memory.id, dataKey }])).errors).toBeUndefined();
    sessionKeyCache.clear();
    const locked = await send(create, { input: { ...input, loc: 'second' } });
    expect(code(locked)).toBe('SESSION_EXPIRED');
  });

  it('a first-encryption entry never claimed: a later encryptMemory without the header has no secret', async () => {
    const invalid = 'mutation($id: ID!) { encryptMemory(memoryId: $id) { nosuchfield } }';
    const staged = await send(invalid, { id: memory.id }, [{ memory: memory.id, passphrase: 'never-used-3450' }]);
    expect(staged.errors?.length).toBeGreaterThan(0);
    const later = await send(ENCRYPT, { id: memory.id }, undefined);
    expect(later.errors?.[0].message).toContain('Provide exactly one');
    expect((await row(memory.id)).isEncrypted).toBe(false);
  });
});

/** Riana's k16: the operation key is claimed only on the encrypted branch. */
describe('#3450 an operation key on a plaintext memory', () => {
  it('the owning App keeps the refusal: nothing staged, nothing claimed, nothing written', async () => {
    const org = await db.organization.create({ data: { name: 'Org 3450', urn: 'org3450.test' } });
    const agent = await db.agent.create({ data: { name: 'Agent 3450', urn: 'org3450.test:agent', organizationId: org.id } });
    const app = await db.app.create({ data: { name: 'App 3450', urn: 'org3450.test:app', organizationId: org.id } });
    await db.memory.update({ where: { id: memory.id }, data: { appId: app.id, userMemoryOfAgentId: agent.id } });
    await db.node.create({ data: { id: generateId(), memoryId: memory.id, loc: 'entry', name: 'Entry', content: 'plain 3450' } });
    const store = { key: parseDataKey(dataKey) } as { key: ReturnType<typeof parseDataKey>; consumed?: boolean };
    const refused = requestOperationKeyStorage.run(store, () =>
      resolvers.Mutation.encryptMemory({}, { memoryId: memory.id }, { db, appId: app.id, roles: [] } as never));
    await expect(refused).rejects.toThrow();
    expect(store.consumed).toBeUndefined();
    expect(await row(memory.id)).toMatchObject({ isEncrypted: false, keyVerifier: null, kdfSalt: null });
    expect((await db.node.findFirstOrThrow({ where: { memoryId: memory.id } })).content).toBe('plain 3450');

    const raw = `hdr_app_${randomBytes(32).toString('hex')}`;
    await db.appKey.create({ data: { appId: app.id, keyHash: hashAppKey(raw), keyPreview: raw.slice(-4) } });
    const reply = await send(ENCRYPT, { id: memory.id }, undefined, raw, { 'x-hadron-operation-key': dataKey });
    expect(reply.errors?.length).toBeGreaterThan(0);
    expect(reply.raw).not.toContain(dataKey);
    expect((await row(memory.id)).isEncrypted).toBe(false);
  });
});

describe('control: the ordinary first encryption through the header', () => {
  it('encrypts under the supplied passphrase', async () => {
    const reply = await send(ENCRYPT, { id: memory.id }, [{ memory: memory.id, passphrase: 'ordinary-3450' }]);
    expect(reply.errors).toBeUndefined();
    const m = await row(memory.id);
    expect(m.isEncrypted).toBe(true);
    const derived = await deriveDataKeyFromPassphrase('ordinary-3450', m.kdfSalt as string, parseKdfParams(m.kdfParams));
    expect(verifyDataKey(m.keyVerifier as string, derived)).toBe(true);
    expect(faultLog).not.toHaveBeenCalled();
  });
});
