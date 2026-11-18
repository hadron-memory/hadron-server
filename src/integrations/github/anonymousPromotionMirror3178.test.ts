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

const dataKey = Buffer.alloc(32, 46).toString('base64');
const ORIGINAL = 'anonymous session plaintext';
const PLAINTEXT_CONTROL = 'synthetic plaintext control';
let memoryId: string;
let originalUrn: string;
let nodeId: string;
let ownerId: string;
let localPath: string;
const appCtx = (): Context => ({ db, appId: appContextId, roles: [] });
let appContextId: string;
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
  await memoryMutations.updateMemory({}, { id: memoryId, source: 'https://github.com/synthetic/promotion3178' }, userCtx());
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
 * at its claim UPDATE — this probe then times out, which is test 2's red.
 */
async function probeNodeLockState(): Promise<'free' | 'blocked'> {
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  try {
    await client.query('BEGIN');
    await client.query("SET LOCAL lock_timeout = '1s'");
    await client.query('UPDATE nodes SET id = id WHERE id = $1', [nodeId]);
    return 'free';
  } catch (error) {
    if ((error as { code?: string }).code === '55P03') return 'blocked'; // lock_not_available
    throw error;
  } finally {
    await client.query('ROLLBACK').catch(() => {});
    await client.end();
  }
}

/**
 * TEST-ONLY bypass (like #1346's harness): no-op exactly the encrypted branch's
 * entry `SELECT id FROM memories … FOR UPDATE` ($queryRaw), leaving every other
 * statement — including the node locks and the claim UPDATE — real.
 */
function bypassPromotionEntryLock() {
  const transaction = db.$transaction.bind(db) as typeof db.$transaction;
  const spy = vi.spyOn(db, '$transaction').mockImplementation(((input: unknown, options: unknown) => {
    if (typeof input !== 'function') return transaction(input as never, options as never);
    return transaction((tx: object) => input(new Proxy(tx, {
      get(target: object, property: string | symbol) {
        if (property !== '$queryRaw') return Reflect.get(target, property);
        return async (strings: TemplateStringsArray, ...values: unknown[]) => {
          const sql = strings.join('');
          if (sql.includes('FROM memories') && sql.includes('FOR UPDATE') && !sql.includes('FROM nodes')) {
            return [] as unknown[];
          }
          return (target as { $queryRaw: (s: TemplateStringsArray, ...v: unknown[]) => Promise<unknown> }).$queryRaw(strings, ...values);
        };
      },
    })) as never, options as never);
  }) as typeof db.$transaction);
  return { restore: () => spy.mockRestore() };
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
    let conversion: ReturnType<typeof promote> | undefined;
    const flagsAtPush: boolean[] = [];
    vi.mocked(execGit).mockImplementation(async args => {
      if (args[0] === 'fetch') {
        conversion = promote();
        await waitForLockWaitersOfType(db, 'transactionid', 1, 2_000); // The promotion is blocked on the fence-holder's transaction.
        expect(await flag()).toBe(false);
      }
      if (args[0] === 'push') flagsAtPush.push(await flag());
      return { stdout: ' M node.md\n', stderr: '' };
    });
    const bytesAtMirror: string[] = [];
    const probeResults: string[] = [];
    try {
      const outcome = await mirror(async () => {
        expect(await flag()).toBe(false); // Still plaintext inside the admitted mirror.
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
      if (conversion) await conversion; // Releases nothing itself; the mirror's commit freed the fence.
    }
    expect(flagsAtPush).toEqual([false]); // Nothing encrypted existed when bytes left the process.
    expect(bytesAtMirror).toEqual([PLAINTEXT_CONTROL]);
    expect(vi.mocked(execGit).mock.calls.some(([args]) => args[0] === 'remote' && args[1] === 'set-url')).toBe(true);
    expect(readFileSync(join(localPath, 'node.md'), 'utf8')).toBe(PLAINTEXT_CONTROL);
    // The promotion then completes for real: ciphertext, class, owner, window closed, urn reminted.
    expect(conversion).toBeDefined();
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
    let conversion: ReturnType<typeof promote> | undefined;
    const flagsAtPush: boolean[] = [];
    try {
      vi.mocked(execGit).mockImplementation(async args => {
        if (args[0] === 'fetch') {
          conversion = promote();
          await waitForLockWaitersOfType(db, 'transactionid', 1, 2_000); // Blocked — but at the claim UPDATE now.
          expect(await flag()).toBe(false);
        }
        if (args[0] === 'push') flagsAtPush.push(await flag());
        return { stdout: ' M node.md\n', stderr: '' };
      });
      const probeResults: string[] = [];
      const outcome = await mirror(async () => {
        expect(await flag()).toBe(false); // The urn-rewriting claim UPDATE (a key column) still conflicts with the KEY SHARE fence.
        writeFileSync(join(localPath, 'node.md'), PLAINTEXT_CONTROL);
        probeResults.push(await probeNodeLockState()); // Node locks were taken BEFORE the memory fence — the mutant's signature.
      });
      expect(probeResults).toEqual(['blocked']);
      expect(outcome).toBe('mirrored');
    } finally {
      if (conversion) await conversion;
      bypass.restore();
    }
    expect(flagsAtPush).toEqual([false]); // Flag-timing alone would NOT kill this mutant; this documents why.
    expect(await flag()).toBe(true);
    expect((await db.node.findUniqueOrThrow({ where: { id: nodeId } })).content).toMatch(/^enc:v1:/);
  }, 20_000);
});
