/**
 * #3450: the header path consumes exactly the four errors `resolveMemoryRef` throws for a caller's ref, at both catches,
 * through one predicate. Everything else leaves for the redacted fault boundary (cor:api:260:01). Each catch keeps its
 * own answer: NOT_ENCRYPTED for the target of `encryptMemory`, NOT_FOUND for an entry (cor:sec:040:04, property 1).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { assertFullyQualifiedUrn, formatCanonicalUrn } from './urn.js';
import { MemoryNotFoundError } from './asset/gate.js';
import { AmbiguousLegacyUrnError } from './entityRef/errors.js';
import { encryptMemoryTargetRef, makeKeyVerifier, type MemoryUnlockError, resolveSuppliedKey, stageRequestMemoryKeys } from './memoryUnlock.js';
import {
  getRequestKey,
  hasRequestFirstEncryption,
  requestFirstEncryptionStorage,
  requestKeyStorage,
  takeRequestFirstEncryption,
} from './requestKeys.js';
import { resolveMemoryRef } from './entityRef/memoryRef.js';
import { parseDataKey } from './crypto.js';

vi.mock('./entityRef/memoryRef.js', () => ({ resolveMemoryRef: vi.fn() }));

const USER = 'owner-3450';
const dataKey = Buffer.alloc(32, 7).toString('base64');
const plaintext = { id: 'plain', isEncrypted: false, userId: USER, kdfSalt: null, kdfParams: null, keyVerifier: null };
const encrypted = { ...plaintext, id: 'sealed', isEncrypted: true, keyVerifier: makeKeyVerifier(parseDataKey(dataKey)) };

const thrownBy = (act: () => unknown): Error => {
  try { act(); } catch (e) { return e as Error; }
  throw new Error('expected a throw');
};
/** Real instances, built by the code that throws them. */
const CONSUMED: Array<[string, () => Error]> = [
  ['MemoryNotFoundError', () => new MemoryNotFoundError('ref')],
  ['AmbiguousLegacyUrnError', () => new AmbiguousLegacyUrnError('ref')],
  ['UrnNotQualifiedError', () => thrownBy(() => assertFullyQualifiedUrn('bare', 'memory'))],
  ['UrnParseError', () => thrownBy(() => formatCanonicalUrn('memory', ''))],
];
class DriverFault extends Error {}
const FAULTS: Array<[string, () => Error]> = [
  ['a driver fault', () => new DriverFault('connect ECONNREFUSED')],
  ['a TypeError', () => new TypeError('bad')],
  ['a plain Error', () => new Error('boom')],
];

const dbWith = (row: unknown) => ({ memory: { findUnique: vi.fn().mockResolvedValue(row) } }) as never;
const inRequest = <T>(act: () => Promise<T>) =>
  requestKeyStorage.run(new Map(), () => requestFirstEncryptionStorage.run(new Map(), act));
const stage = (row: unknown, entries: unknown[], target?: string) => inRequest(() =>
  stageRequestMemoryKeys(dbWith(row), JSON.stringify(entries), USER, { encryptMemoryTarget: () => target ?? null }));
const codeOf = (e: unknown) => (e as MemoryUnlockError).code;

beforeEach(() => {
  vi.mocked(resolveMemoryRef).mockReset();
  vi.mocked(resolveMemoryRef).mockImplementation(async (_db, ref) => ({ id: ref }));
});

describe('#3450 the encryptMemory target catch', () => {
  const failTarget = (error: Error) => vi.mocked(resolveMemoryRef).mockImplementation(async (_db, ref) => {
    if (ref === 'target') throw error;
    return { id: ref };
  });

  it.each(CONSUMED)('%s keeps NOT_ENCRYPTED', async (_name, make) => {
    failTarget(make());
    await expect(stage(plaintext, [{ memory: 'plain', dataKey }], 'target')).rejects.toMatchObject({ code: 'NOT_ENCRYPTED' });
  });

  it.each(FAULTS)('%s leaves as itself, not NOT_ENCRYPTED', async (_name, make) => {
    const fault = make();
    failTarget(fault);
    await expect(stage(plaintext, [{ memory: 'plain', dataKey }], 'target')).rejects.toBe(fault);
  });
});

describe('#3450 the per-entry catch', () => {
  it.each(CONSUMED)('%s keeps NOT_FOUND', async (_name, make) => {
    vi.mocked(resolveMemoryRef).mockRejectedValue(make());
    await expect(stage(plaintext, [{ memory: 'x', dataKey }])).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it.each(FAULTS)('%s from the ref leaves as itself, not NOT_FOUND', async (_name, make) => {
    const fault = make();
    vi.mocked(resolveMemoryRef).mockRejectedValue(fault);
    await expect(stage(plaintext, [{ memory: 'x', dataKey }])).rejects.toBe(fault);
  });

  it('a fault reading the row leaves as itself, not NOT_FOUND', async () => {
    const fault = new DriverFault('connection terminated');
    const db = { memory: { findUnique: vi.fn().mockRejectedValue(fault) } } as never;
    await expect(inRequest(() => stageRequestMemoryKeys(db, JSON.stringify([{ memory: 'x', dataKey }]), USER))).rejects.toBe(fault);
  });

  it.each([
    ['a wrong key', { memory: 'sealed', dataKey: Buffer.alloc(32, 8).toString('base64') }, 'WRONG_KEY'],
    ['both secrets', { memory: 'sealed', dataKey, passphrase: 'p' }, 'BAD_UNLOCK_INPUT'],
  ])('%s still leaves as its typed refusal', async (_name, entry, code) => {
    await expect(stage(encrypted, [entry])).rejects.toMatchObject({ code });
  });
});

/**
 * Node's scrypt puts a number or boolean password in its TypeError, verbatim, and JSON in the header can carry one.
 * This reached NOT_FOUND through the old catch-all. It must keep that answer: as a fault it would be a new refusal for
 * an owner, and a secret in the log (F3).
 */
describe('#3450 a passphrase that is not a string', () => {
  const salted = { ...encrypted, kdfSalt: Buffer.alloc(16, 1).toString('base64'), kdfParams: { alg: 'scrypt', N: 1024, r: 8, p: 1 } };

  it.each([[987654321], [true], [{ a: 1 }], [['x']]])('%j on an owner\'s encrypted memory keeps NOT_FOUND', async passphrase => {
    await expect(stage(salted, [{ memory: 'sealed', passphrase }])).rejects.toMatchObject({ code: 'NOT_FOUND', message: 'Memory not found.' });
  });

  // The refusals resolveSuppliedKey makes before it would derive keep their order and their answer.
  it.each([
    ['falsy', salted, { passphrase: 0 }],
    ['beside a dataKey', salted, { passphrase: 987654321, dataKey }],
    ['on a memory with no verifier', { ...salted, keyVerifier: null }, { passphrase: 987654321 }],
    ['on a memory with no salt', { ...salted, kdfSalt: null }, { passphrase: 987654321 }],
  ])('%s is still BAD_UNLOCK_INPUT', async (_name, row, secret) => {
    await expect(stage(row, [{ memory: 'sealed', ...secret }])).rejects.toMatchObject({ code: 'BAD_UNLOCK_INPUT' });
  });

  it('the guard is the header\'s: the shared resolver is not changed for its typed callers', async () => {
    await expect(resolveSuppliedKey(salted, { passphrase: 987654321 as never })).rejects.toThrow(TypeError);
    await expect(resolveSuppliedKey(salted, { passphrase: 'a real string' })).rejects.toMatchObject({ code: 'WRONG_KEY' });
  });
});

describe('#3450 request isolation under overlap', () => {
  const entriesFor = (id: string, secret: string) => JSON.stringify([{ memory: id, passphrase: secret }]);
  const ownedPlain = (id: string, userId: string) => ({ ...plaintext, id, userId });
  const barrier = (parties: number) => {
    let arrived = 0;
    let open!: () => void;
    const opened = new Promise<void>(resolve => { open = resolve; });
    return () => { if (++arrived === parties) open(); return opened; };
  };

  it('two overlapped requests each hold only their own entry, once', async () => {
    const meet = barrier(2);
    const request = (id: string, peer: string, userId: string, secret: string) => inRequest(async () => {
      await stageRequestMemoryKeys(dbWith(ownedPlain(id, userId)), entriesFor(id, secret), userId, { encryptMemoryTarget: () => id });
      await meet(); // Both are staged and neither has claimed.
      expect(hasRequestFirstEncryption(peer)).toBe(false);
      expect(takeRequestFirstEncryption(peer)).toBeNull();
      const entry = takeRequestFirstEncryption(id);
      await meet();
      return { entry, again: takeRequestFirstEncryption(id), staged: getRequestKey(id) };
    });
    const [a, b] = await Promise.all([request('mem-a', 'mem-b', 'user-a', 'secret-a'), request('mem-b', 'mem-a', 'user-b', 'secret-b')]);
    expect(a).toEqual({ entry: { passphrase: 'secret-a' }, again: null, staged: null });
    expect(b).toEqual({ entry: { passphrase: 'secret-b' }, again: null, staged: null });
  });

  it('an aborted request leaves neither entry to a later request', async () => {
    const meet = barrier(2);
    const staged = (id: string, userId: string, secret: string, abort: boolean) => inRequest(async () => {
      await stageRequestMemoryKeys(dbWith(ownedPlain(id, userId)), entriesFor(id, secret), userId, { encryptMemoryTarget: () => id });
      await meet();
      if (abort) throw new Error('client went away');
    });
    await expect(Promise.all([staged('mem-a', 'user-a', 'secret-a', true), staged('mem-b', 'user-b', 'secret-b', false)])).rejects.toThrow('client went away');
    await inRequest(async () => {
      for (const id of ['mem-a', 'mem-b']) {
        expect(hasRequestFirstEncryption(id)).toBe(false);
        expect(takeRequestFirstEncryption(id)).toBeNull();
      }
    });
  });
});

describe('#3450 a supplied variable that is not a string never takes the default', () => {
  const body = (variables?: unknown) => ({
    query: 'mutation($id: ID = "default-memory") { encryptMemory(memoryId: $id) { id } }',
    ...(variables === undefined ? {} : { variables }),
  });

  it.each([[null], [12345], [{ a: 1 }], [['x']], [true]])('supplied %j is no target', supplied => {
    expect(encryptMemoryTargetRef(body({ id: supplied }))).toBeNull();
  });

  it('control: omitted takes the default', () => {
    expect(encryptMemoryTargetRef(body())).toBe('default-memory');
    expect(encryptMemoryTargetRef(body({}))).toBe('default-memory');
  });

  it('control: a supplied string is the target', () => {
    expect(encryptMemoryTargetRef(body({ id: 'named' }))).toBe('named');
  });
});
