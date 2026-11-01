/**
 * #2729 — createAppMemory against REAL competing writers, and the refusals the
 * #2661 / #2843 suites left as hand-written transactions or bare throws.
 *
 * Ownership-change audit (origin/main, 2026-11-01), why the owner-tuple
 * comparison in createAppMemory is DEFENSIVE:
 *   - No production writer changes `App.organizationId`: there is no App
 *     transfer mutation (`updateApp` takes no org or owner argument), so the
 *     org-to-org race below is driven by a hand-written transaction.
 *   - The one production writer of `App.ownerUserId` is account merge
 *     (`mergeUsers` -> `mergeOwnerNamespacedUrns`). It holds the SOURCE user's
 *     anchor exclusively and tombstones that user in the same transaction, so
 *     the creator (locking the observed owner's user anchor) waits for it and
 *     then fails the user-anchor liveness recheck before the tuple comparison
 *     is reached.
 *   - No production writer sets `App.uninstalledAt`; the uninstalledAt-wins
 *     interleaving below is likewise a hand-written transaction.
 * Do not add a transfer API to make these races "real".
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { resolvers, type Context } from './resolvers.js';
import * as authorityAnchors from '../../../lib/auth/authorityAnchors.js';
import { lockAuthorityAnchors, type AuthorityAnchor } from '../../../lib/auth/authorityAnchors.js';
import type { Prisma } from '../../../generated/prisma/index.js';

const M = resolvers.Mutation as any;
let orgA: any, orgB: any, foreign: any, app: any, agent: any;
let admin: any, owner: any, outsider: any;
const ctx = (u: string): Context => ({ db, userId: u, roles: [] });
const create = (userId = admin.id, args: any = {}) =>
  M.createAppMemory({}, { appRef: app.id, name: 'Race Notes', ...args }, ctx(userId));
const outcome = (p: Promise<unknown>) => p.then((row: unknown) => ({ row }), (error: unknown) => ({ error }));
const caught = async (p: Promise<unknown>) => { try { await p; } catch (e) { return e; } throw new Error('expected a refusal'); };
const noWrites = async () => {
  expect(await db.memory.count()).toBe(0);
  expect(await db.node.count()).toBe(0);
};

type FenceOutcome = 'blocked' | 'settled' | 'timeout';
const backendPid = async (tx: unknown) =>
  (await (tx as Prisma.TransactionClient).$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid() AS pid`)[0]!.pid;

/**
 * Report how the creator met the fence: `blocked` only when the CREATOR's own
 * backend (`creatorPid`, captured by `instrumentAnchors` as it enters its anchor
 * lock) waits on an advisory lock and the PAUSED WRITER's backend (`writerPid`)
 * is among its blockers; `settled` when the creator finished first (the fence
 * was bypassed); `timeout` when neither happened in time. Callers assert
 * `'blocked'`, so a bypass and a stall both fail at the same named assertion,
 * never as a vitest timeout, and no other waiter can satisfy it.
 */
async function fenceOutcome(
  writerPid: number, creatorPid: () => number | undefined, isSettled: () => boolean, timeoutMs = 3000,
): Promise<FenceOutcome> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (isSettled()) return 'settled';
    const pid = creatorPid();
    if (pid !== undefined && pid !== writerPid) {
      const [{ blocked }] = await db.$queryRaw<Array<{ blocked: boolean }>>`
        SELECT EXISTS (
          SELECT 1 FROM pg_locks l
          WHERE l.pid = ${pid}::int AND l.locktype = 'advisory' AND NOT l.granted
            AND ${writerPid}::int = ANY(pg_blocking_pids(l.pid))
        ) AS blocked`;
      if (blocked) return 'blocked';
    }
    if (Date.now() > deadline) return 'timeout';
    await new Promise((r) => setTimeout(r, 10));
  }
}

/**
 * Await a writer's readiness, but fail at once (with the writer's outcome) if
 * it finishes or throws before it pauses, and fail with a diagnostic if it has
 * not paused within `timeoutMs`, instead of hanging to the test timeout.
 */
async function writerPaused(ready: Promise<number>, writer: Promise<unknown>, timeoutMs = 3000): Promise<number> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      ready,
      writer.then(
        (r) => { throw new Error(`competing writer finished before pausing: ${JSON.stringify(r)}`); },
        (e) => { throw e; },
      ),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`competing writer did not pause within ${timeoutMs}ms`)), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/** Hand-written competing leg: take the App anchor exclusively, apply `change`, then hold until released. */
function holdAppAnchor(change: (tx: Prisma.TransactionClient) => Promise<unknown>) {
  let release!: () => void, held!: (pid: number) => void;
  const gate = new Promise<void>((r) => { release = r; });
  const ready = new Promise<number>((r) => { held = r; });
  const done = db.$transaction(async (tx) => {
    await lockAuthorityAnchors(tx, [{ kind: 'app', id: app.id }], 'exclusive');
    await change(tx);
    held(await backendPid(tx)); await gate;
  });
  return { ready, release, done };
}

/**
 * Wrap `lockAuthorityAnchors` for one test.
 * - Pause a REAL writer right after it takes its authority anchors, before its
 *   row locks and write. `isWriter` picks the writer's call out of the creator's
 *   (the writer's own caller anchor, which the creator never takes). `ready`
 *   resolves with the writer's backend pid. The default picks no writer (the
 *   hand-written legs pause themselves).
 * - Once `arm()` is called (just before the creator starts, while the writer is
 *   paused), record the backend pid of the creator's SHARED App-anchor call
 *   BEFORE it locks, so `fenceOutcome` can require that exact backend to wait.
 */
function instrumentAnchors(isWriter: (anchors: readonly AuthorityAnchor[]) => boolean = () => false) {
  const real = authorityAnchors.lockAuthorityAnchors;
  const calls: Array<{ anchors: AuthorityAnchor[]; mode: string }> = [];
  let release!: () => void, held!: (pid: number) => void;
  let armed = false, creatorPid: number | undefined;
  const gate = new Promise<void>((r) => { release = r; });
  const ready = new Promise<number>((r) => { held = r; });
  vi.spyOn(authorityAnchors, 'lockAuthorityAnchors').mockImplementation(async (tx, anchors, mode) => {
    if (armed && creatorPid === undefined && mode === 'shared' && anchors.some((a) => a.kind === 'app' && a.id === app.id)) {
      creatorPid = await backendPid(tx);
    }
    await real(tx, anchors, mode);
    if (isWriter(anchors)) { calls.push({ anchors: [...anchors], mode }); held(await backendPid(tx)); await gate; }
  });
  return { calls, ready, release, arm: () => { armed = true; }, creatorPid: () => creatorPid };
}

beforeEach(async () => {
  await cleanDb(db);
  orgA = await db.organization.create({ data: { name: 'Tenant A', urn: 'a2729.test' } });
  orgB = await db.organization.create({ data: { name: 'Tenant B', urn: 'b2729.test' } });
  foreign = await db.organization.create({ data: { name: 'Agent tenant', urn: 'agent2729.test' } });
  const user = (n: number) => db.user.create({ data: { githubId: 272900 + n, githubUsername: `u2729-${n}`, roles: ['READER'] } });
  [admin, owner, outsider] = await Promise.all([1, 2, 3].map(user));
  await db.orgMember.createMany({ data: [
    { organizationId: orgA.id, userId: admin.id, role: 'ADMIN' },
    { organizationId: orgA.id, userId: owner.id, role: 'OWNER' },
    { organizationId: orgB.id, userId: admin.id, role: 'ADMIN' },
    { organizationId: foreign.id, userId: outsider.id, role: 'ADMIN' },
  ] });
  app = await db.app.create({ data: { name: 'App', urn: `${orgA.urn}:app`, organizationId: orgA.id } });
  agent = await db.agent.create({ data: { name: 'Agent', urn: `${foreign.urn}:agent`, organizationId: foreign.id } });
  await db.appAgent.create({ data: { appId: app.id, agentId: agent.id } });
});
afterEach(() => vi.restoreAllMocks());

describe('#2729 real updateOrgMember demotion wins the race', () => {
  // CONTRIBUTOR is the rung just below the ADMIN gate; READER the floor.
  for (const role of ['CONTRIBUTOR', 'READER']) it(`creator waits for the real demotion to ${role}, then refuses with no Memory`, async () => {
    const writer = instrumentAnchors((anchors) => anchors.some((a) => a.kind === 'user' && a.id === owner.id));
    const demotion = outcome(M.updateOrgMember({}, { orgRef: orgA.id, userRef: admin.id, role }, ctx(owner.id)));
    let settled = false;
    let pending: Promise<any> | undefined;
    try {
      const writerPid = await writerPaused(writer.ready, demotion);
      // The outer gate reads committed state (still ADMIN) and takes no lock, so
      // the creator reaches withAuthorizedTx and blocks inside it, behind the
      // writer's exclusive anchors: the demotion lands in the in-transaction window.
      writer.arm();
      pending = outcome(create()).finally(() => { settled = true; });
      expect(await fenceOutcome(writerPid, writer.creatorPid, () => settled), 'creator must wait for the real demotion writer').toBe('blocked');
      expect(writer.calls).toHaveLength(1);
      expect(writer.calls[0]!.mode).toBe('exclusive');
      expect(writer.calls[0]!.anchors).toEqual(expect.arrayContaining([
        { kind: 'org', id: orgA.id }, { kind: 'user', id: admin.id },
      ]));
    } finally {
      writer.release();
      await demotion;
      await pending;
    }
    expect(await demotion).toMatchObject({ row: { role } });
    expect(await pending).toMatchObject({ error: { message: 'Forbidden', extensions: { code: 'FORBIDDEN' } } });
    await noWrites();
    expect(await db.orgMember.findFirstOrThrow({ where: { organizationId: orgA.id, userId: admin.id } })).toMatchObject({ role });
  });
});

describe('#2729 org-to-org interleave under the App anchor', () => {
  it('an App moved from A to B while the creator waits refuses, though the caller is ADMIN in both', async () => {
    // Hand-written: no production writer changes App.organizationId (see the audit above).
    const probe = instrumentAnchors();
    const mover = holdAppAnchor((tx) => tx.app.update({ where: { id: app.id }, data: { organizationId: orgB.id } }));
    let settled = false;
    let pending: Promise<any> | undefined;
    try {
      const writerPid = await writerPaused(mover.ready, mover.done);
      probe.arm();
      pending = outcome(create()).finally(() => { settled = true; });
      expect(await fenceOutcome(writerPid, probe.creatorPid, () => settled), 'creator must wait behind the App-anchor writer').toBe('blocked');
    } finally {
      mover.release();
      await mover.done;
      await pending;
    }
    // Only the organizationId half of the observed-tuple comparison can refuse:
    // the in-transaction gate admits the caller in B, and ownerUserId is unchanged (null).
    expect(await pending).toMatchObject({ error: { message: 'Forbidden', extensions: { code: 'FORBIDDEN' } } });
    await noWrites();
  });
});

describe('#2729 deleted / uninstalled App: the typed refusal', () => {
  for (const field of ['deletedAt', 'uninstalledAt']) it(`a ${field} App answers exactly as an unknown App, with no writes`, async () => {
    await db.app.update({ where: { id: app.id }, data: { [field]: new Date() } });
    const refused = await caught(create());
    const unknown = await caught(create(admin.id, { appRef: generateId() }));
    expect(refused).toMatchObject({ message: 'Forbidden', extensions: { code: 'FORBIDDEN' } });
    expect(JSON.stringify(refused)).toBe(JSON.stringify(unknown));
    // An invalid root must not reach root validation first (BAD_USER_INPUT would reveal the dead App to its org ADMIN).
    expect(JSON.stringify(await caught(create(admin.id, { name: '../secret' })))).toBe(JSON.stringify(unknown));
    await noWrites();
  });

  it('uninstalledAt wins the interleaving: the creator waits, then refuses FORBIDDEN with no writes', async () => {
    // Hand-written: no production writer sets App.uninstalledAt (see the audit above).
    const probe = instrumentAnchors();
    const uninstaller = holdAppAnchor((tx) => tx.app.update({ where: { id: app.id }, data: { uninstalledAt: new Date() } }));
    let settled = false;
    let pending: Promise<any> | undefined;
    try {
      const writerPid = await writerPaused(uninstaller.ready, uninstaller.done);
      probe.arm();
      pending = outcome(create()).finally(() => { settled = true; });
      expect(await fenceOutcome(writerPid, probe.creatorPid, () => settled), 'creator must wait behind the uninstall').toBe('blocked');
    } finally {
      uninstaller.release();
      await uninstaller.done;
      await pending;
    }
    expect(await pending).toMatchObject({ error: { message: 'Forbidden', extensions: { code: 'FORBIDDEN' } } });
    await noWrites();
  });

  it('the real deleteApp wins the interleaving: the creator waits, then refuses FORBIDDEN with no writes', async () => {
    const writer = instrumentAnchors((anchors) => anchors.some((a) => a.kind === 'user' && a.id === owner.id));
    const deletion = outcome(M.deleteApp({}, { ref: app.id }, ctx(owner.id)));
    let settled = false;
    let pending: Promise<any> | undefined;
    try {
      const writerPid = await writerPaused(writer.ready, deletion);
      writer.arm();
      pending = outcome(create()).finally(() => { settled = true; });
      expect(await fenceOutcome(writerPid, writer.creatorPid, () => settled), 'creator must wait for the real deleteApp').toBe('blocked');
      expect(writer.calls[0]).toMatchObject({ mode: 'exclusive' });
      expect(writer.calls[0]!.anchors).toEqual(expect.arrayContaining([{ kind: 'app', id: app.id }]));
    } finally {
      writer.release();
      await deletion;
      await pending;
    }
    expect(await deletion).not.toHaveProperty('error');
    expect(await pending).toMatchObject({ error: { message: 'Forbidden', extensions: { code: 'FORBIDDEN' } } });
    await noWrites();
  });
});

describe('#2729 org App concealment', () => {
  it('a stranger to an org App and an unknown App get byte-identical refusals, even with an invalid root and no installation', async () => {
    await db.appAgent.deleteMany({ where: { appId: app.id } });
    const stranger = await caught(create(outsider.id, { name: '../secret' }));
    const unknown = await caught(create(outsider.id, { appRef: generateId(), name: '../secret' }));
    expect(stranger).toMatchObject({ message: 'Forbidden', extensions: { code: 'FORBIDDEN' } });
    expect(JSON.stringify(stranger)).toBe(JSON.stringify(unknown));
    await noWrites();
  });
});
