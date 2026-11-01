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

/**
 * Resolve once a backend in this database waits on an advisory lock OR the
 * creator has settled. A mutant that removes the fence lets the creator run
 * straight through; the caller's `settled` assertion then fails, rather than
 * a lock-wait timeout.
 */
async function blockedOrSettled(isSettled: () => boolean, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (isSettled()) return;
    const [{ waiting }] = await db.$queryRaw<Array<{ waiting: number }>>`
      SELECT count(*)::int AS waiting FROM pg_locks
      WHERE locktype = 'advisory' AND NOT granted
        AND pid IN (SELECT pid FROM pg_stat_activity WHERE datname = current_database())`;
    if (waiting >= 1) return;
    if (Date.now() > deadline) return;
    await new Promise((r) => setTimeout(r, 10));
  }
}

/**
 * Pause a REAL writer right after it takes its authority anchors, before its
 * row locks and write. `isWriter` picks the writer's call out of the creator's
 * (the writer's own caller anchor, which the creator never takes).
 */
function pauseRealWriterAfterAnchors(isWriter: (anchors: readonly AuthorityAnchor[]) => boolean) {
  const real = authorityAnchors.lockAuthorityAnchors;
  const calls: Array<{ anchors: AuthorityAnchor[]; mode: string }> = [];
  let release!: () => void, held!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  const ready = new Promise<void>((r) => { held = r; });
  vi.spyOn(authorityAnchors, 'lockAuthorityAnchors').mockImplementation(async (tx, anchors, mode) => {
    await real(tx, anchors, mode);
    if (isWriter(anchors)) { calls.push({ anchors: [...anchors], mode }); held(); await gate; }
  });
  return { calls, ready, release };
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
    const writer = pauseRealWriterAfterAnchors((anchors) => anchors.some((a) => a.kind === 'user' && a.id === owner.id));
    const demotion = outcome(M.updateOrgMember({}, { orgRef: orgA.id, userRef: admin.id, role }, ctx(owner.id)));
    let settled = false;
    let pending: Promise<any> | undefined;
    try {
      await writer.ready;
      // The outer gate reads committed state (still ADMIN) and takes no lock, so
      // the creator reaches withAuthorizedTx and blocks inside it, behind the
      // writer's exclusive anchors: the demotion lands in the in-transaction window.
      pending = outcome(create()).finally(() => { settled = true; });
      await blockedOrSettled(() => settled);
      expect(settled, 'creator must wait for the real demotion writer').toBe(false);
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
    let release!: () => void, held!: () => void;
    const gate = new Promise<void>((r) => { release = r; }), ready = new Promise<void>((r) => { held = r; });
    // Hand-written: no production writer changes App.organizationId (see the audit above).
    const mover = db.$transaction(async (tx) => {
      await lockAuthorityAnchors(tx, [{ kind: 'app', id: app.id }], 'exclusive');
      await tx.app.update({ where: { id: app.id }, data: { organizationId: orgB.id } });
      held(); await gate;
    });
    let settled = false;
    let pending: Promise<any> | undefined;
    try {
      await ready;
      pending = outcome(create()).finally(() => { settled = true; });
      await blockedOrSettled(() => settled);
      expect(settled, 'creator must wait behind the App-anchor writer').toBe(false);
    } finally {
      release();
      await mover;
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
    await noWrites();
  });

  it('uninstalledAt wins the interleaving: the creator waits, then refuses FORBIDDEN with no writes', async () => {
    let release!: () => void, held!: () => void;
    const gate = new Promise<void>((r) => { release = r; }), ready = new Promise<void>((r) => { held = r; });
    // Hand-written: no production writer sets App.uninstalledAt (see the audit above).
    const uninstaller = db.$transaction(async (tx) => {
      await lockAuthorityAnchors(tx, [{ kind: 'app', id: app.id }], 'exclusive');
      await tx.app.update({ where: { id: app.id }, data: { uninstalledAt: new Date() } });
      held(); await gate;
    });
    let settled = false;
    let pending: Promise<any> | undefined;
    try {
      await ready;
      pending = outcome(create()).finally(() => { settled = true; });
      await blockedOrSettled(() => settled);
      expect(settled, 'creator must wait behind the uninstall').toBe(false);
    } finally {
      release();
      await uninstaller;
      await pending;
    }
    expect(await pending).toMatchObject({ error: { message: 'Forbidden', extensions: { code: 'FORBIDDEN' } } });
    await noWrites();
  });

  it('the real deleteApp wins the interleaving: the creator waits, then refuses FORBIDDEN with no writes', async () => {
    const writer = pauseRealWriterAfterAnchors((anchors) => anchors.some((a) => a.kind === 'user' && a.id === owner.id));
    const deletion = outcome(M.deleteApp({}, { ref: app.id }, ctx(owner.id)));
    let settled = false;
    let pending: Promise<any> | undefined;
    try {
      await writer.ready;
      pending = outcome(create()).finally(() => { settled = true; });
      await blockedOrSettled(() => settled);
      expect(settled, 'creator must wait for the real deleteApp').toBe(false);
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
