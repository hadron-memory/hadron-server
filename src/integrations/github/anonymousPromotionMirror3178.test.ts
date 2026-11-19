/**
 * #3178 / cor:sec:040:05: pin the SECOND encryption writer's row fence against
 * an admitted Git mirror — `linkMemoryToUser`'s request-key anonymous→registered
 * promotion (the sibling of #3170's `encryptMemory` pin).
 *
 * REACHABILITY (the issue's first ask, verified against current main — the
 * combination is real, not a fabricated race):
 *
 *  1. An anonymous App session provisions a plaintext scratch memory with
 *     `class='app'`, `appId`, `userMemoryOfAgentId` and NO `source`
 *     (`resolvers.mutation.session.ts` — "Anonymous memories are always
 *     plaintext until linkMemoryToUser promotes them").
 *  2. An org ADMIN/OWNER of that App's org can attach a GitHub `source` to it
 *     through the REAL `updateMemory` gate: `requireMemoryManageAccess` →
 *     `requireOwnerOrOrgRole(ADMIN)` for a class='app' row — no anonymous or
 *     class exclusion exists; the only extra refusal is the decision-log one.
 *     The beforeEach drives that real mutation (not a row write) so this leg
 *     is pinned, not assumed.
 *  3. Mirror admission (`withMirrorCheckout`) needs only `source` + an org +
 *     plaintext — no class/anonymous exclusion — and every node write on a
 *     sourced memory reaches it through `writeNodeToGit`, so the anonymous
 *     end-user's own writes are the trigger.
 *  4. The App-key `linkMemoryToUser` call with `x-hadron-operation-key` is the
 *     promotion path; its transaction takes the Memory row `FOR UPDATE` on
 *     entry (resolvers.mutation.memory.ts, the encrypted branch).
 *
 * REDUNDANT-MUTANT DISCLOSURE (the issue's "distinguish the other mirror
 * guards" ask): unlike `encryptMemory`'s flip, THIS writer's flag-flip timing
 * alone does NOT kill the mutant that removes the entry `SELECT … FOR UPDATE`.
 * The promotion's claim UPDATE rewrites `urn` — a key column under its unique
 * index — so the UPDATE itself takes FOR UPDATE strength and equally conflicts
 * with the mirror's `FOR KEY SHARE` fence: the flag still cannot flip mid
 * mirror. Test 3 pins that redundant arm with a TEST-ONLY entry-lock bypass;
 * test 2's node-lock probe (the promotion holds NO node row locks while it
 * waits on the memory fence — #1346/#1776 lock order) is the assertion that
 * actually kills the mutant.
 *
 * Environment: private per-worker test clone, tmpdir checkout root, mocked
 * git/token/branch helpers — no network, no provider credentials, synthetic
 * fixtures only. No ciphertext is exported by the mirror (asserted below).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Client } from 'pg';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { db } from '../db/client.js';
import { cleanDb } from '../../test/helpers.js';
import { generateId } from '../../lib/id.js';
import { waitForLockWaitersOfType } from '../../test/lockWait.js';
import { withTestOperationKey } from '../../test/operationKey.js';
import { parseDataKey } from '../../lib/crypto.js';
import { decryptNodeFieldsWithKey } from '../../lib/nodeCrypto.js';
import { resolvers, type Context } from '../../api/graphql/schema/resolvers.js';
import { memoryMutations } from '../../api/graphql/schema/resolvers.mutation.memory.js';
import * as locks from './mirrorCheckoutLock.js';
import { withMirrorCheckout } from './gitMirrorCheckout.js';
import { execGit } from './execGit.js';
import { settleMirrorObligations, takeAttemptSeq, type MirrorObligationRef } from './mirrorObligations.js';

const fixture = vi.hoisted(() => ({ root: '' }));
vi.mock('../../config.js', async original => ({ ...await original<typeof import('../../config.js')>(), get GRAPHS_PATH() { return fixture.root; } }));
vi.mock('./execGit.js', () => ({ execGit: vi.fn() }));
vi.mock('./gitBranch.js', () => ({ prepareWriteBranch: vi.fn(async () => {}) }));
vi.mock('./githubApp.js', async original => ({ ...await original<typeof import('./githubApp.js')>(), getInstallationToken: vi.fn(async () => 'synthetic-3178') }));

const dataKey = Buffer.alloc(32, 46).toString('base64'); // 32 bytes of '.' — a well-formed base64 data key.
const ORIGINAL = 'anonymous session plaintext';
const PLAINTEXT_CONTROL = 'synthetic plaintext control';
let memoryId: string;
let originalUrn: string;
let nodeId: string;
let ownerId: string;
let localPath: string;
let appContextId: string;
const appCtx = (): Context => ({ db, appId: appContextId, roles: [] });
const userCtx = (): Context => ({ db, userId: ownerId, roles: [] });
const promote = () => withTestOperationKey(dataKey, appContextId, () =>
  resolvers.Mutation.linkMemoryToUser({}, { memoryId, externalUserId: 'promotion-owner-3178' }, appCtx()));
const refs = (): MirrorObligationRef[] => [{ nodeId, kind: 'WRITE' }];
const mirror = (mutate: Parameters<typeof withMirrorCheckout>[1] = vi.fn(() => {})) =>
  withMirrorCheckout({ memoryId, commitSubject: '3178 probe', logPrefix: '[3178]', obligations: refs() }, mutate);
const flag = async () => (await db.memory.findUniqueOrThrow({ where: { id: memoryId } })).isEncrypted;

beforeEach(async () => {
  await cleanDb(db);
  vi.mocked(execGit).mockReset();
  vi.mocked(execGit).mockResolvedValue({ stdout: ' M node.md\n', stderr: '' });
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'log').mockImplementation(() => {});
  fixture.root = mkdtempSync(join(tmpdir(), 'belinda3178-'));
  const org = await db.organization.create({ data: { name: 'Promotion fence', urn: 'promotion3178.test', githubInstallationId: 3178 } });
  const owner = await db.user.create({ data: { handle: 'promotion3178-owner', roles: ['READER'] } });
  ownerId = owner.id;
  await db.orgMember.create({ data: { organizationId: org.id, userId: ownerId, role: 'OWNER' } });
  const app = await db.app.create({ data: { name: 'Promotion', urn: 'promotion3178.test:app', organizationId: org.id } });
  appContextId = app.id;
  const agent = await db.agent.create({ data: { name: 'Promotion', urn: 'promotion3178.test:agent', organizationId: org.id } });
  // Born exactly like real anonymous provisioning: plaintext, class='app',
  // anonymous window open, no source yet.
  const memory = await db.memory.create({ data: {
    organizationId: org.id, urn: 'promotion3178.test:anon3178', name: 'Anonymous session (Promotion)',
    class: 'app', appId: app.id, userMemoryOfAgentId: agent.id,
    anonymousExpiresAt: new Date(Date.now() + 86_400_000),
  } });
  memoryId = memory.id;
  originalUrn = memory.urn;
  nodeId = (await db.node.create({ data: { memoryId, loc: 'note', name: 'Note', content: ORIGINAL, abstract: 'original abstract', data: { value: 'original' }, tags: [] } })).id;
  // REACHABILITY LEG — the real gate path an org OWNER uses to put a source on
  // the anonymous scratch memory. If a future rule closes this, this line goes
  // red and the whole premise must be re-derived, not worked around.
  await memoryMutations.updateMemory({}, { ref: memoryId, source: 'https://github.com/synthetic/promotion3178' }, userCtx());
  expect((await db.memory.findUniqueOrThrow({ where: { id: memoryId } })).source).toBe('https://github.com/synthetic/promotion3178');
  localPath = join(fixture.root, org.urn, 'anon3178');
  mkdirSync(join(localPath, '.git'), { recursive: true });
  writeFileSync(join(localPath, 'node.md'), ORIGINAL);
});
afterEach(() => {
  vi.restoreAllMocks();
  if (fixture.root) rmSync(fixture.root, { recursive: true, force: true });
});

/**
 * While the promotion is blocked on the mirror's memory-row fence, its live
 * node rows must still be freely updatable: the promotion took the MEMORY lock
 * before any NODE lock (#1346/#1776 order). Under the mutant that removes the
 * entry `FOR UPDATE`, the promotion locks every node first and only then blocks
 * at its claim UPDATE — this probe then reports 'blocked', which is test 2's red.
 *
 * `FOR UPDATE NOWAIT` conflicts with EVERY row-lock mode (FOR KEY SHARE
 * included), fires no UPDATE triggers, and in autocommit holds nothing past
 * the statement. The row count is the vacuity guard (BLIND P2): this reads the
 * same per-worker `process.env.DATABASE_URL` the `db` client is built from, and
 * a probe that matched no row — a diverged URL, a missing node — is a HARD
 * ERROR, never a 'free' that test 2 would pass on vacuously.
 */
async function probeNodeLockState(probeId: string = nodeId): Promise<'free' | 'blocked'> {
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  try {
    const r = await client.query('SELECT 1 FROM nodes WHERE id = $1 FOR UPDATE NOWAIT', [probeId]);
    if (r.rowCount !== 1) throw new Error(`probe matched ${r.rowCount} node rows for ${probeId} — wrong database or no row; refusing a vacuous 'free'`);
    return 'free';
  } catch (error) {
    if ((error as { code?: string }).code === '55P03') return 'blocked'; // lock_not_available
    throw error;
  } finally {
    await client.end();
  }
}

/**
 * TEST-ONLY bypass (like #1346's harness): no-op exactly the encrypted branch's
 * entry `SELECT id FROM memories … FOR UPDATE` ($queryRaw), leaving every other
 * statement — including the node locks and the claim UPDATE — real. The
 * interception returns the SAME ROW SHAPE the real statement returns (the
 * caller must not branch on an unexpected empty result), counts every
 * interception, and the caller asserts the count is exactly one — a second,
 * unplanned interception shows as its own red instead of a confusing one.
 */
function bypassPromotionEntryLock() {
  const transaction = db.$transaction.bind(db) as typeof db.$transaction;
  let intercepted = 0;
  const spy = vi.spyOn(db, '$transaction').mockImplementation(((input: unknown, options: unknown) => {
    if (typeof input !== 'function') return transaction(input as never, options as never);
    return transaction((tx: object) => input(new Proxy(tx, {
      get(target: object, property: string | symbol) {
        if (property !== '$queryRaw') return Reflect.get(target, property);
        return async (strings: TemplateStringsArray, ...values: unknown[]) => {
          const sql = strings.join('');
          if (sql.includes('FROM memories') && sql.includes('FOR UPDATE') && !sql.includes('FROM nodes')) {
            intercepted++;
            return [{ id: memoryId }] as unknown[];
          }
          return (target as { $queryRaw: (s: TemplateStringsArray, ...v: unknown[]) => Promise<unknown> }).$queryRaw(strings, ...values);
        };
      },
    })) as never, options as never);
  }) as typeof db.$transaction);
  return { restore: () => { spy.mockRestore(); return intercepted; } };
}

describe('#3178 anonymous promotion vs the Git mirror row fence', () => {
  it('a promotion committed first ends mirroring: the precheck refuses it and clears the debt without any git call', async () => {
    // Non-vacuous debt: one failed WRITE obligation row exists before the refusal.
    await settleMirrorObligations(db, memoryId, refs(), { result: 'failed', errorClass: 'PUSH_FAILED' }, await takeAttemptSeq(db));
    expect(await db.gitMirrorObligation.findMany({ where: { memoryId } })).toHaveLength(1);
    await promote();
    expect(await flag()).toBe(true);
    const lock = vi.spyOn(locks, 'withMirrorCheckoutLock');
    expect(await mirror()).toBe('refused-encrypted');
    expect(lock).not.toHaveBeenCalled();
    expect(execGit).not.toHaveBeenCalled();
    expect(readFileSync(join(localPath, 'node.md'), 'utf8')).toBe(ORIGINAL);
    expect(await db.gitMirrorObligation.findMany({ where: { memoryId } })).toEqual([]);
  }, 20_000);

  it('an admitted mirror fences the real promotion: bytes leave plaintext, the flag flips only after push, and no node lock is held while it waits', async () => {
    // Settled at creation (BLIND P3-5): a rejecting promotion can never surface as an
    // unhandled rejection or mask the mirror's own error; its outcome is asserted below.
    let conversion: Promise<{ ok: boolean; e?: unknown }> | undefined;
    const flagAtFetch: boolean[] = [];
    const flagInMirror: boolean[] = [];
    const flagsAtPush: boolean[] = [];
    // Positive control for test 1's `not.toHaveBeenCalled()` (BLIND P3-6): the same spy,
    // observed firing here, proves the mechanism sees this module's calls.
    const fenceSpy = vi.spyOn(locks, 'withMirrorCheckoutLock');
    vi.mocked(execGit).mockImplementation(async args => {
      if (args[0] === 'fetch' && !conversion) { // Guard (BLIND P3-4): a second fetch never starts a second promotion.
        conversion = promote().then((): { ok: true } => ({ ok: true }), (e: unknown): { ok: false; e: unknown } => ({ ok: false, e }));
        await waitForLockWaitersOfType(db, 'transactionid', 1, 2_000); // The promotion is blocked on the fence-holder's transaction.
        flagAtFetch.push(await flag());
      }
      if (args[0] === 'push') flagsAtPush.push(await flag());
      return { stdout: ' M node.md\n', stderr: '' };
    });
    const bytesAtMirror: string[] = [];
    const probeResults: string[] = [];
    try {
      const outcome = await mirror(async () => {
        // Recorded, asserted after (BLIND P3-3): a red inside the mirror's callback must
        // surface as its own named assertion, not be swallowed by the mirror's failure
        // classification of a thrown expect.
        flagInMirror.push(await flag());
        writeFileSync(join(localPath, 'node.md'), PLAINTEXT_CONTROL);
        bytesAtMirror.push(readFileSync(join(localPath, 'node.md'), 'utf8'));
        // Mutant killer: blocked at the MEMORY fence, the promotion holds no node row lock.
        // Recorded, not asserted here, so the mutant's red is this named assertion and
        // not an indirect TREE_WRITE failure of the mirror around it.
        probeResults.push(await probeNodeLockState());
      });
      expect(probeResults).toEqual(['free']);
      expect(outcome).toBe('mirrored');
    } finally {
      if (conversion) await conversion; // Settled form: never throws, never masks.
    }
    expect(flagAtFetch).toEqual([false]); // Blocked at the fence: still plaintext.
    expect(flagInMirror).toEqual([false]); // Still plaintext inside the admitted mirror.
    expect(fenceSpy).toHaveBeenCalledTimes(1);
    expect(flagsAtPush).toEqual([false]); // Nothing encrypted existed when bytes left the process.
    expect(bytesAtMirror).toEqual([PLAINTEXT_CONTROL]);
    expect(vi.mocked(execGit).mock.calls.some(([args]) => args[0] === 'remote' && args[1] === 'set-url')).toBe(true);
    expect(readFileSync(join(localPath, 'node.md'), 'utf8')).toBe(PLAINTEXT_CONTROL);
    // The promotion then completes for real: ciphertext, class, owner, window closed, urn reminted.
    expect(conversion).toBeDefined();
    expect(await conversion).toEqual({ ok: true });
    const row = await db.memory.findUniqueOrThrow({ where: { id: memoryId } });
    expect(row.isEncrypted).toBe(true);
    expect(row.class).toBe('private');
    expect(row.anonymousExpiresAt).toBeNull();
    expect(row.urn).not.toBe(originalUrn);
    const promotedUser = await db.user.findFirstOrThrow({ where: { externalAppId: appContextId, externalId: 'promotion-owner-3178' } });
    expect(row.userId).toBe(promotedUser.id);
    expect(await db.urnAlias.findFirst({ where: { entityType: 'MEMORY', urn: originalUrn } })).not.toBeNull();
    const stored = await db.node.findUniqueOrThrow({ where: { id: nodeId } });
    expect(stored.content).toMatch(/^enc:v1:/);
    expect(decryptNodeFieldsWithKey({ ...stored }, parseDataKey(dataKey))).toMatchObject({ content: ORIGINAL, abstract: 'original abstract' });
  }, 20_000);

  it('TEST-ONLY entry-lock bypass: the claim UPDATE still fences the flag (the redundant arm), but the node rows are already locked — test 2 is what kills the mutant', async () => {
    const bypass = bypassPromotionEntryLock();
    let conversion: Promise<{ ok: boolean; e?: unknown }> | undefined;
    const flagAtFetch: boolean[] = [];
    const flagInMirror: boolean[] = [];
    const flagsAtPush: boolean[] = [];
    let bypassed = 0;
    try {
      vi.mocked(execGit).mockImplementation(async args => {
        if (args[0] === 'fetch' && !conversion) { // Same guard: one promotion, however often fetch runs.
          conversion = promote().then((): { ok: true } => ({ ok: true }), (e: unknown): { ok: false; e: unknown } => ({ ok: false, e }));
          await waitForLockWaitersOfType(db, 'transactionid', 1, 2_000); // Blocked — but at the claim UPDATE now.
          flagAtFetch.push(await flag());
        }
        if (args[0] === 'push') flagsAtPush.push(await flag());
        return { stdout: ' M node.md\n', stderr: '' };
      });
      const probeResults: string[] = [];
      const outcome = await mirror(async () => {
        flagInMirror.push(await flag()); // The urn-rewriting claim UPDATE (a key column) still conflicts with the KEY SHARE fence.
        writeFileSync(join(localPath, 'node.md'), PLAINTEXT_CONTROL);
        probeResults.push(await probeNodeLockState()); // Node locks were taken BEFORE the memory fence — the mutant's signature.
      });
      expect(probeResults).toEqual(['blocked']);
      expect(outcome).toBe('mirrored');
    } finally {
      if (conversion) await conversion;
      bypassed = bypass.restore();
    }
    // The bypass no-opped exactly the ONE entry statement (BLIND P3-7) — a second,
    // unplanned interception is its own red, not a confusing downstream one.
    expect(bypassed).toBe(1);
    expect(conversion).toBeDefined();
    expect(await conversion).toEqual({ ok: true });
    expect(flagAtFetch).toEqual([false]);
    expect(flagInMirror).toEqual([false]);
    expect(flagsAtPush).toEqual([false]); // Flag-timing alone would NOT kill this mutant; this documents why.
    expect(await flag()).toBe(true);
    expect((await db.node.findUniqueOrThrow({ where: { id: nodeId } })).content).toMatch(/^enc:v1:/);
  }, 20_000);

  // BLIND P2, red first: a probe that touches no row must be a HARD ERROR, never a
  // 'free' that test 2's killer assertion could pass on vacuously (wrong database URL,
  // a deleted node, a fixture drift). On the pre-fix probe this returns 'free'.
  it('the lock probe refuses a vacuous free: a node id that matches no row is a hard error', async () => {
    await expect(probeNodeLockState(generateId())).rejects.toThrow(/matched 0 node rows/);
  });
});
