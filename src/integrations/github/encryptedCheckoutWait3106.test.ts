/** #3106 / cor:sec:040:05: discriminate encrypted-mirror refusal layers with real PostgreSQL waits. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Client } from 'pg';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { db } from '../db/client.js';
import { cleanDb } from '../../test/helpers.js';
import { waitForLockWaitersOfType } from '../../test/lockWait.js';
import { generateDataKey } from '../../lib/crypto.js';
import { resolvers, type Context } from '../../api/graphql/schema/resolvers.js';
import * as locks from './mirrorCheckoutLock.js';
import { withMirrorCheckout } from './gitMirrorCheckout.js';
import { execGit } from './execGit.js';
import { settleMirrorObligations, takeAttemptSeq, type MirrorObligationRef } from './mirrorObligations.js';

const fixture = vi.hoisted(() => ({ root: '' }));
vi.mock('../../config.js', async original => ({ ...await original<typeof import('../../config.js')>(), get GRAPHS_PATH() { return fixture.root; } }));
vi.mock('./execGit.js', () => ({ execGit: vi.fn() }));
vi.mock('./gitBranch.js', () => ({ prepareWriteBranch: vi.fn(async () => {}) }));
vi.mock('./githubApp.js', async original => ({ ...await original<typeof import('./githubApp.js')>(), getInstallationToken: vi.fn(async () => 'synthetic-3106') }));

let memoryId: string;
let nodeId: string;
let ownerId: string;
let localPath: string;
const key = generateDataKey();
const ORIGINAL = 'original repository bytes';
const originalLock = locks.withMirrorCheckoutLock;
const ctx = (): Context => ({ db, userId: ownerId, roles: ['READER'] });
const encrypt = () => resolvers.Mutation.encryptMemory({}, { memoryId, dataKey: key.raw.toString('base64') }, ctx());
const refs = (): MirrorObligationRef[] => [{ nodeId, kind: 'WRITE' }, { nodeId, kind: 'REMOVE', removeLoc: 'old' }];
const mirror = (mutate: Parameters<typeof withMirrorCheckout>[1] = vi.fn(() => {})) => withMirrorCheckout({ memoryId, commitSubject: '3106 probe', logPrefix: '[3106]', obligations: refs() }, mutate);
const flag = async () => (await db.memory.findUniqueOrThrow({ where: { id: memoryId } })).isEncrypted;
const unchanged = () => {
  expect(execGit).not.toHaveBeenCalled(); // Includes remote set-url, fetch, and restore, not just commit/push.
  expect(readFileSync(join(localPath, 'node.md'), 'utf8')).toBe(ORIGINAL);
};

beforeEach(async () => {
  await cleanDb(db);
  vi.mocked(execGit).mockReset();
  vi.mocked(execGit).mockResolvedValue({ stdout: ' M node.md\n', stderr: '' });
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'log').mockImplementation(() => {});
  fixture.root = mkdtempSync(join(tmpdir(), 'andi3106-'));
  const org = await db.organization.create({ data: { name: '3106', urn: 'checkout3106.example', githubInstallationId: 3106 } });
  const owner = await db.user.create({ data: { handle: 'checkout3106-owner', roles: ['READER'] } });
  ownerId = owner.id;
  await db.orgMember.create({ data: { organizationId: org.id, userId: ownerId, role: 'OWNER' } });
  const memory = await db.memory.create({ data: { organizationId: org.id, userId: ownerId, class: 'private', name: 'checkout', urn: `${org.urn}:checkout`, source: 'https://github.com/synthetic/checkout3106' } });
  memoryId = memory.id;
  nodeId = (await db.node.create({ data: { memoryId, loc: 'node', name: 'Node', content: 'synthetic private plaintext', tags: [] } })).id;
  localPath = join(fixture.root, org.urn, 'checkout');
  mkdirSync(join(localPath, '.git'), { recursive: true });
  writeFileSync(join(localPath, 'node.md'), ORIGINAL);
});
afterEach(() => {
  vi.restoreAllMocks();
  if (fixture.root) rmSync(fixture.root, { recursive: true, force: true });
});

/** Keep the real advisory wait; optionally isolate the inner guard by bypassing ONLY the helper's row fence. */
async function queuedFlip(isolateInner = false) {
  const external = new Client({ connectionString: process.env.DATABASE_URL });
  await external.connect();
  let entered = false;
  let fenceError: unknown;
  vi.spyOn(locks, 'withMirrorCheckoutLock').mockImplementation(async (id, work, options) => {
    try {
      return await originalLock(id, async () => { entered = true; return work(); }, isolateInner ? { fenceEncryption: false } : options);
    } catch (error) { fenceError = error; throw error; }
  });
  const mutate = vi.fn(() => {});
  let waiting: ReturnType<typeof mirror> | undefined;
  try {
    await settleMirrorObligations(db, memoryId, refs(), { result: 'failed', errorClass: 'PUSH_FAILED' }, await takeAttemptSeq(db));
    await external.query('SELECT pg_advisory_lock($1::bigint)', [locks.mirrorCheckoutLockKey(memoryId)]);
    waiting = mirror(mutate);
    await waitForLockWaitersOfType(db, 'advisory'); // Precheck was plaintext; the mirror is demonstrably queued.
    expect(entered).toBe(false);
    await encrypt(); // Actual encryptMemory FOR UPDATE + conversion, committed before admission.
    expect(await flag()).toBe(true);
    expect((await db.node.findUniqueOrThrow({ where: { id: nodeId } })).content).toMatch(/^enc:v1:/);
    const newerSeq = await takeAttemptSeq(db);
    await settleMirrorObligations(db, memoryId, [refs()[1]!], { result: 'failed', errorClass: 'PUSH_FAILED' }, newerSeq);
    await external.query('SELECT pg_advisory_unlock($1::bigint)', [locks.mirrorCheckoutLockKey(memoryId)]);
    expect(await waiting).toBe('refused-encrypted');
    expect(mutate).not.toHaveBeenCalled();
    unchanged();
    const rows = await db.gitMirrorObligation.findMany({ where: { memoryId } });
    if (!isolateInner) {
      // Helper refusal settles outside the checkout using the PRE-wait fence: clear old debt, preserve newer debt.
      expect(rows).toEqual([expect.objectContaining({ kind: 'REMOVE', removeLoc: 'old', attemptSeq: newerSeq, errorClass: 'PUSH_FAILED', attempts: 2 })]);
      expect(entered).toBe(false);
      expect(fenceError).toBeInstanceOf(locks.EncryptedMemoryFenceError);
    } else {
      // Test-only helper bypass admits a lock-ordered inner refusal, whose newer attempt clears both older debts.
      expect(rows).toEqual([]);
      expect(entered).toBe(true);
      expect(fenceError).toBeUndefined();
    }
  } finally {
    await external.end(); // Releases the blocker even if any assertion or the conversion failed.
    if (waiting) await waiting;
  }
}

describe('#3106 encrypted checkout boundaries', () => {
  it('precheck refuses an already-encrypted memory before requesting any checkout lock', async () => {
    await encrypt();
    const lock = vi.spyOn(locks, 'withMirrorCheckoutLock');
    expect(await mirror()).toBe('refused-encrypted');
    expect(lock).not.toHaveBeenCalled();
    unchanged();
  }, 20_000);

  it('the real helper refuses encrypted state before invoking its work callback', async () => {
    await encrypt();
    const work = vi.fn(async () => 'entered');
    await expect(originalLock(memoryId, work, { fenceEncryption: true })).rejects.toBeInstanceOf(locks.EncryptedMemoryFenceError);
    expect(work).not.toHaveBeenCalled();
    unchanged();
  }, 20_000);

  it('a real conversion committed during the advisory wait is refused by the helper, with fenced not-mirrored settlement', async () => {
    await queuedFlip();
  }, 20_000);

  it('isolates the inner reread with a TEST-ONLY helper-fence bypass (not a reachable production race)', async () => {
    await queuedFlip(true);
  }, 20_000);

  it('an admitted plaintext mirror holds real encryptMemory behind its row fence through mutation and push', async () => {
    let conversion: ReturnType<typeof encrypt> | undefined;
    const flagsAtPush: boolean[] = [];
    vi.mocked(execGit).mockImplementation(async args => {
      if (args[0] === 'fetch') {
        conversion = encrypt();
        await waitForLockWaitersOfType(db, 'transactionid', 1, 2_000);
        expect(await flag()).toBe(false);
      }
      if (args[0] === 'push') flagsAtPush.push(await flag());
      return { stdout: ' M node.md\n', stderr: '' };
    });
    try {
      expect(await mirror(async () => {
        expect(await flag()).toBe(false);
        writeFileSync(join(localPath, 'node.md'), 'synthetic plaintext control');
      })).toBe('mirrored');
      expect(flagsAtPush).toEqual([false]);
      expect(vi.mocked(execGit).mock.calls.some(([args]) => args[0] === 'remote' && args[1] === 'set-url')).toBe(true);
      expect(readFileSync(join(localPath, 'node.md'), 'utf8')).toBe('synthetic plaintext control');
    } finally {
      if (conversion) await conversion;
    }
    expect(conversion).toBeDefined();
    expect(await flag()).toBe(true);
    expect((await db.node.findUniqueOrThrow({ where: { id: nodeId } })).content).toMatch(/^enc:v1:/);
  }, 20_000);
});
