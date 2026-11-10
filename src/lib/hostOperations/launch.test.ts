import { WORKER_SIGNATURE_DEFAULTS } from '../workerSignature.js';
/**
 * #1709 (T6 slice 2) — starting a worker through its host. Holger's rulings via
 * Vera: the credential is A (#10761; Rook's conditions #10734), the six launch
 * points (#10773), a manager's start without a task (#10774), and a bind refused
 * when anything changed between issue and redemption (#10775), each pinned here.
 * Scenarios of cor:agt:070:05 and :08.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { GraphQLError } from 'graphql';
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { db } from '../../integrations/db/client.js';
import { cleanDb } from '../../test/helpers.js';
import { serveEveryAgent } from '../../test/servedBootPrompt.js';
import { generateId } from '../id.js';
import { runAsActor } from '../requestActor.js';
import { APP_KEY_PREFIX, hashAppKey, validateSessionBinding, type AuthContext } from '../../middleware/auth.js';
import { resolvers, type Context } from '../../api/graphql/schema/resolvers.js';
import { ownsSession } from '../sessionOwnership.js';
import { hashLaunchGrant, LAUNCH_GRANT_PREFIX, LAUNCH_GRANT_TTL_MS } from './launch.js';

vi.mock('../../integrations/github/writeNodeToGit.js', () => ({ writeNodeToGit: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../bus/index.js', () => ({ getBusClient: vi.fn(async () => null) }));

const M = resolvers.Mutation as any;
const ctx = (userId?: string): Context => ({ db, userId, roles: ['READER'] }) as Context;
async function code(p: Promise<unknown>): Promise<string | undefined> {
  try {
    await p;
  } catch (e) {
    expect(e).toBeInstanceOf(GraphQLError);
    return (e as GraphQLError).extensions?.code as string;
  }
  return undefined;
}

let org: { id: string; urn: string };
let app: { id: string };
let agentId: string;
let manager: { id: string };
let holder: { id: string };
let other: { id: string };
let kit: { id: string };
let ada: { id: string };
let orca1: { id: string };
let plainKey: { id: string };

async function mkKey(label: string) {
  const raw = `${APP_KEY_PREFIX}${randomBytes(32).toString('hex')}`;
  return db.appKey.create({ data: { id: generateId(), appId: app.id, keyHash: hashAppKey(raw), keyPreview: raw.slice(-4), label }, select: { id: true } });
}
const keyCtx = (k: { id: string }): Context => ({ db, appId: app.id, appKeyId: k.id, organizationId: org.id, roles: [] }) as Context;
const asWorker = <T>(w: { id: string }, fn: () => Promise<T>): Promise<T> => runAsActor({ workerId: w.id, agentId }, fn);

const START = { worktree: 'hadron-server/kit', family: 'claude' };
const issueStart = (args: Record<string, unknown> = START, c = ctx(manager.id), worker = kit.id) =>
  M.issueHostOperation({}, { input: { appRef: app.id, hostId: 'orca1', worker, type: 'worker.start', args } }, c);
const collect = async (): Promise<Array<{ id: string; type: string; launchGrant: string | null }>> =>
  M.collectHostOperations({}, { appRef: app.id }, keyCtx(orca1));
const redeem = (userId: string | undefined, launchGrant: string, extra: Record<string, unknown> = {}) =>
  M.startSession({}, { input: { id: generateId(), tool: 'vitest', launchGrant, ...extra } }, ctx(userId));
const report = (id: string, input: Record<string, unknown>) =>
  M.reportHostOperation({}, { input: { appRef: app.id, id, ...input } }, keyCtx(orca1));
const opOf = (id: string) => db.hostOperation.findUniqueOrThrow({ where: { id } });

/** Issue and collect a manager's start of Kit; returns the operation id and its grant. */
async function collectedStart(args: Record<string, unknown> = START) {
  const op = await issueStart(args);
  const [got] = (await collect()).filter((o) => o.id === op.id);
  return { opId: op.id as string, grant: got!.launchGrant as string };
}

beforeEach(async () => {
  await cleanDb(db);
  const n = Math.floor(Math.random() * 1_000_000);
  org = await db.organization.create({ data: { name: 'Launch', urn: `launch-${n}.example` }, select: { id: true, urn: true } });
  const u = (k: number, name: string) =>
    db.user.create({ data: { githubId: k * 1_000_000 + n, githubUsername: `la-${name}-${n}`, roles: ['READER'] }, select: { id: true } });
  manager = await u(51, 'manager');
  holder = await u(52, 'holder');
  other = await u(53, 'other');
  await db.orgMember.create({ data: { organizationId: org.id, userId: manager.id, role: 'ADMIN' } });
  const agent = await M.createAgent({}, { orgId: org.id, name: 'Team Agent' }, ctx(manager.id));
  agentId = agent.id;
  app = await db.app.create({ data: { organizationId: org.id, name: 'Team', urn: `${org.urn}:team` }, select: { id: true } });
  for (const id of [holder.id, other.id]) await db.appMember.create({ data: { appId: app.id, userId: id, role: 'member' } });
  ada = await db.worker.create({ data: { ...WORKER_SIGNATURE_DEFAULTS, appId: app.id, agentId, name: 'Ada', slug: 'ada', heldByUserId: other.id }, select: { id: true } });
  kit = await db.worker.create({ data: { ...WORKER_SIGNATURE_DEFAULTS, appId: app.id, agentId, name: 'Kit', slug: 'kit', heldByUserId: holder.id, heldAt: new Date(), reportsToWorkerId: ada.id }, select: { id: true } });
  orca1 = await mkKey('orca1');
  plainKey = await mkKey('plain');
  await M.grantAppKeyScope({}, { id: orca1.id, scope: 'host:operate', hostId: 'orca1' }, ctx(manager.id));
  await M.registerHost({}, {
    input: { appRef: app.id, label: 'Orca', pollIntervalSeconds: 600, workers: [{ worker: kit.id, family: 'claude', worktrees: ['hadron-server/kit'] }] },
  }, keyCtx(orca1));
  await serveEveryAgent(db); // #2712: binds are served the Agent's boot prompt
});

describe('the invariants file', () => {
  it('the migration carries a byte-identical copy and post-push includes it', () => {
    const source = readFileSync(new URL('../../../prisma/host-launch-invariants.sql', import.meta.url), 'utf8');
    const migration = readFileSync(new URL('../../../prisma/migrations/20261014030000_host_launch/migration.sql', import.meta.url), 'utf8');
    expect(migration.endsWith(`\n${source}`)).toBe(true);
    expect(readFileSync(new URL('../../../prisma/post-push.sql', import.meta.url), 'utf8')).toContain('\\ir host-launch-invariants.sql');
  });
});

describe('a manager starts a held worker (cor:agt:070:05; Holger #10774: with or without a task)', () => {
  it('issue, collect (a fresh grant), redeem with the holder\'s token: a session on the holder\'s behalf, recorded as launched; the hold unchanged', async () => {
    const { opId, grant } = await collectedStart();
    expect(grant.startsWith(LAUNCH_GRANT_PREFIX)).toBe(true);
    const before = await db.worker.findUniqueOrThrow({ where: { id: kit.id }, select: { heldByUserId: true, heldAt: true } });
    const s = await redeem(holder.id, grant);
    expect(s).toMatchObject({
      workerId: kit.id, userId: holder.id, appId: app.id,
      launchHostId: 'orca1', launchOperationId: opId, launchTaskId: null, launchIssuedBy: 'manager',
      expiresAt: null,
    });
    expect(await db.worker.findUniqueOrThrow({ where: { id: kit.id }, select: { heldByUserId: true, heldAt: true } })).toEqual(before);
    const g = await db.launchGrant.findFirstOrThrow({ where: { operationId: opId } });
    expect(g).toMatchObject({ holderUserId: holder.id, workerId: kit.id, hostId: 'orca1', sessionId: s.id });
    expect(g.consumedAt).not.toBeNull();
    // The host's report is checked against the binding, and records the session.
    expect(await report(opId, { outcome: 'SUCCEEDED' })).toMatchObject({ status: 'succeeded', result: { sessionId: s.id } });
  });

  it('a start is not done until its session is bound: SUCCEEDED before that is refused', async () => {
    const { opId } = await collectedStart();
    expect(await code(report(opId, { outcome: 'SUCCEEDED' }))).toBe('HOST_OPERATION_NOT_DONE');
    expect((await opOf(opId)).status).toBe('collected');
  });

  it('with a task, the session records it', async () => {
    const t = await db.agentTask.create({ data: { appId: app.id, title: 'T', ownerUserId: manager.id, assigneeWorkerId: kit.id, assignedAt: new Date(), closeSessionWhenDone: false }, select: { id: true } });
    const { opId, grant } = await collectedStart({ ...START, taskId: t.id });
    expect((await redeem(holder.id, grant)).launchTaskId).toBe(t.id);
    expect((await opOf(opId)).args).toMatchObject({ taskId: t.id });
  });

  it('S4 (070:05): only whoever manages the App starts a worker; the start needs a held, idle worker in a registered worktree', async () => {
    expect(await code(issueStart(START, ctx(holder.id)))).toBe('HOST_OPERATION_NOT_PERMITTED');
    expect(await code(asWorker(ada, () => issueStart(START, ctx(other.id))))).toBe('HOST_OPERATION_NOT_PERMITTED');
    expect(await code(issueStart({ worktree: 'hadron-server/elsewhere', family: 'claude' }))).toBe('BAD_HOST_OPERATION_ARGS');
    expect(await code(issueStart({ worktree: 'hadron-server/kit', family: 'codex' }))).toBe('BAD_HOST_OPERATION_ARGS');
    expect(await code(issueStart({ ...START, taskId: 'nosuchtask' }))).toBe('BAD_HOST_OPERATION_ARGS');
    expect(await code(issueStart(START, ctx(manager.id), ada.id))).toBe('HOST_NOT_FOUND');
    await issueStart();
    expect(await code(issueStart())).toBe('WORKER_START_PENDING');
    expect(await db.hostOperation.count()).toBe(1);
  });

  it('S2 (070:08): a worker nobody holds is never started', async () => {
    await db.worker.update({ where: { id: kit.id }, data: { heldByUserId: null, heldAt: null } });
    expect(await code(issueStart())).toBe('WORKER_NOT_HELD');
  });

  it('a worker with a live session is not started again', async () => {
    await db.session.create({ data: { id: generateId(), appId: app.id, workerId: kit.id, userId: holder.id, startedAt: new Date(), updatedAt: new Date() } });
    expect(await code(issueStart())).toBe('WORKER_LIVE');
  });

  it('a lapsed host starts nothing', async () => {
    await db.hostRegistration.updateMany({ data: { refreshedAt: new Date(Date.now() - 24 * 3_600_000) } });
    expect(await code(issueStart())).toBe('HOST_NOT_FOUND');
  });
});

describe('the grant (Holger\'s ruling A, Rook #10734)', () => {
  it('is single-use: a second redemption is refused and binds nothing more', async () => {
    const { grant } = await collectedStart();
    const s = await redeem(holder.id, grant);
    await db.session.update({ where: { id: s.id }, data: { endedAt: new Date() } });
    expect(await code(redeem(holder.id, grant))).toBe('LAUNCH_GRANT_INVALID');
    expect(await db.session.count({ where: { workerId: kit.id } })).toBe(1);
  });

  it('is consumed atomically: of two concurrent redemptions exactly one binds, and the start is not failed', async () => {
    const { opId, grant } = await collectedStart();
    const results = await Promise.allSettled([redeem(holder.id, grant), redeem(holder.id, grant)]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const lost = results.find((r) => r.status === 'rejected') as PromiseRejectedResult;
    expect((lost.reason as GraphQLError).extensions?.code).toBe('LAUNCH_GRANT_INVALID');
    expect(await db.session.count({ where: { launchOperationId: opId } })).toBe(1);
    expect((await opOf(opId)).status).toBe('collected');
  });

  it('is short-lived: past its TTL it is refused, and the start is untouched', async () => {
    const { opId, grant } = await collectedStart();
    const g = await db.launchGrant.findFirstOrThrow({ where: { operationId: opId } });
    expect(g.expiresAt.getTime() - g.issuedAt.getTime()).toBe(LAUNCH_GRANT_TTL_MS);
    await db.launchGrant.update({ where: { id: g.id }, data: { expiresAt: new Date(Date.now() - 1000), issuedAt: new Date(Date.now() - 2000) } });
    expect(await code(redeem(holder.id, grant))).toBe('LAUNCH_GRANT_INVALID');
    expect((await opOf(opId)).status).toBe('collected');
  });

  it('is redeemable only by the holder it was minted for, judged by the caller\'s token: never another person, never an App key', async () => {
    const { opId, grant } = await collectedStart();
    expect(await code(redeem(other.id, grant))).toBe('LAUNCH_GRANT_INVALID');
    expect(await code(redeem(manager.id, grant))).toBe('LAUNCH_GRANT_INVALID');
    expect(await code(M.startSession({}, { input: { id: generateId(), launchGrant: grant } }, keyCtx(orca1)))).toBe('LAUNCH_GRANT_INVALID');
    expect(await code(M.startSession({}, { input: { id: generateId(), launchGrant: grant } }, keyCtx(plainKey)))).toBe('LAUNCH_GRANT_INVALID');
    // None of these failed the start or spent the grant: the holder still binds with it.
    expect((await opOf(opId)).status).toBe('collected');
    expect((await redeem(holder.id, grant)).launchOperationId).toBe(opId);
  });

  it('binds only the worker it names; it cannot be forced', async () => {
    const { opId, grant } = await collectedStart();
    expect(await code(redeem(holder.id, grant, { workerRef: ada.id }))).toBe('LAUNCH_GRANT_INVALID');
    expect(await code(redeem(holder.id, grant, { force: true }))).toBe('BAD_USER_INPUT');
    // The caller's mistakes fail nothing: the start stands and the holder still binds.
    expect((await opOf(opId)).status).toBe('collected');
    expect((await redeem(holder.id, grant)).workerId).toBe(kit.id);
  });

  it('#1937: a grant holder naming a worker of an App they cannot read learns nothing: the absent envelope, and the start stands', async () => {
    const { opId, grant } = await collectedStart();
    const elsewhereOrg = await db.organization.create({ data: { name: 'Elsewhere', urn: `${org.urn}-else` }, select: { id: true } });
    const elsewhere = await db.app.create({ data: { organizationId: elsewhereOrg.id, name: 'Else', urn: `${org.urn}-else:else` }, select: { id: true } });
    const foreign = await db.worker.create({ data: { ...WORKER_SIGNATURE_DEFAULTS, appId: elsewhere.id, agentId, name: 'Zed', slug: 'zed' }, select: { id: true } });
    const env = async (ref: string) => {
      try {
        await redeem(holder.id, grant, { workerRef: ref });
      } catch (e) {
        return JSON.stringify({ m: (e as GraphQLError).message, x: (e as GraphQLError).extensions });
      }
      throw new Error('expected a refusal');
    };
    const real = await env(foreign.id);
    expect(real).toBe(JSON.stringify({ m: `Worker not found: ${foreign.id}`, x: { code: 'WORKER_NOT_FOUND' } }));
    await db.worker.delete({ where: { id: foreign.id } });
    expect(await env(foreign.id)).toBe(real);
    // A caller's mistake fails nothing: the start stands and the holder still binds the grant's worker.
    expect((await opOf(opId)).status).toBe('collected');
    expect((await redeem(holder.id, grant)).workerId).toBe(kit.id);
  });

  it('#1928: a re-collection while the grant is live leaves the start out, and the grant stays redeemable', async () => {
    const { opId, grant } = await collectedStart();
    const other = await M.issueHostOperation({}, { input: { appRef: app.id, hostId: 'orca1', worker: kit.id, type: 'worktree.create', args: { repo: 'hadron-server', baseBranch: 'main', branchName: 'kit-2', label: 'kit-2' } } }, ctx(manager.id));
    const again = await collect();
    expect(again.map((o) => o.id)).not.toContain(opId);
    // No starvation: the host's other unreported operations are still delivered on every collect.
    expect(again.map((o) => o.id)).toContain(other.id);
    expect((await collect()).map((o) => o.id)).toContain(other.id);
    expect(await db.launchGrant.count({ where: { operationId: opId } })).toBe(1);
    expect((await redeem(holder.id, grant)).launchOperationId).toBe(opId);
  });

  it('#1928 (Diego P2): a withheld start never takes a page slot: with first:1 the later operation is delivered on every collect', async () => {
    const { opId, grant } = await collectedStart();
    const later = await M.issueHostOperation({}, { input: { appRef: app.id, hostId: 'orca1', worker: kit.id, type: 'worktree.create', args: { repo: 'hadron-server', baseBranch: 'main', branchName: 'kit-3', label: 'kit-3' } } }, ctx(manager.id));
    const one = () => M.collectHostOperations({}, { appRef: app.id, first: 1 }, keyCtx(orca1)) as Promise<Array<{ id: string }>>;
    for (let i = 0; i < 3; i += 1) expect((await one()).map((o) => o.id)).toEqual([later.id]);
    expect((await redeem(holder.id, grant)).launchOperationId).toBe(opId);
  });

  it('#1928: once the grant has expired, a re-collection delivers the start with a fresh grant and the old one is revoked', async () => {
    const { opId, grant: first } = await collectedStart();
    await db.launchGrant.updateMany({ where: { operationId: opId }, data: { expiresAt: new Date(Date.now() - 1000), issuedAt: new Date(Date.now() - 2000) } });
    const [again] = (await collect()).filter((o) => o.id === opId);
    expect(again!.launchGrant).toBeTruthy();
    expect(again!.launchGrant).not.toBe(first);
    expect((await db.launchGrant.findFirstOrThrow({ where: { operationId: opId, revokedAt: { not: null } } })).consumedAt).toBeNull();
    expect(await code(redeem(holder.id, first))).toBe('LAUNCH_GRANT_INVALID');
    expect((await redeem(holder.id, again!.launchGrant!)).launchOperationId).toBe(opId);
  });

  it('#1928: once the grant is consumed (the session bound), a re-collection mints nothing and delivers the start without a grant, so a restarted host can report it', async () => {
    const { opId, grant } = await collectedStart();
    const session = await redeem(holder.id, grant);
    const [again] = (await collect()).filter((o) => o.id === opId);
    expect(again).toBeTruthy();
    expect(again!.launchGrant).toBeNull();
    expect(await db.launchGrant.count({ where: { operationId: opId } })).toBe(1);
    await report(opId, { outcome: 'SUCCEEDED' });
    expect(await opOf(opId)).toMatchObject({ status: 'succeeded', result: { sessionId: session.id } });
  });

  it('is kept only as a hash, and no operation, grant or report carries a credential (cor:sec:050:01, #10777)', async () => {
    const { opId, grant } = await collectedStart();
    const g = await db.launchGrant.findFirstOrThrow({ where: { operationId: opId } });
    expect(g.tokenHash).toBe(hashLaunchGrant(grant));
    expect(JSON.stringify(g)).not.toContain(grant);
    expect(Object.keys((await opOf(opId)).args as object).sort()).toEqual(['family', 'workerId', 'worktree']);
    const listed = await (resolvers.Query as any).hostOperations({}, { appRef: app.id }, ctx(manager.id));
    expect(JSON.stringify(listed)).not.toContain(grant);
  });

  it('the launched session is the holder\'s alone: no App key binds it, attributes to it or owns it (the host\'s own key included)', async () => {
    const { grant } = await collectedStart();
    const s = await redeem(holder.id, grant);
    for (const k of [orca1, plainKey]) {
      const principal = { appId: app.id, appKeyId: k.id } as AuthContext;
      expect(await validateSessionBinding(db, principal, s.id)).toBeNull();
      expect(ownsSession(principal, { userId: holder.id, appId: app.id, launchOperationId: s.launchOperationId })).toBe(false);
    }
    // The holder binds it as usual.
    expect(await validateSessionBinding(db, { userId: holder.id } as AuthContext, s.id)).not.toBeNull();
    // A key still owns an ordinary person-less session of its App (unchanged).
    expect(ownsSession({ appId: app.id }, { userId: null, appId: app.id, launchOperationId: null })).toBe(true);
  });
});

describe('Holger #10775: anything that changed between issue and redemption refuses the bind and fails the start', () => {
  async function expectRefused(opId: string, grant: string, reasonCode: string) {
    try {
      await redeem(holder.id, grant);
      expect.fail('expected LAUNCH_REFUSED');
    } catch (e) {
      expect((e as GraphQLError).extensions).toMatchObject({ code: 'LAUNCH_REFUSED', reason: reasonCode, operationId: opId });
    }
    const op = await opOf(opId);
    expect(op.status).toBe('failed');
    expect(op.failureReason).toBeTruthy();
    expect(await db.session.count({ where: { workerId: kit.id, launchOperationId: opId } })).toBe(0);
    expect(await db.agentTeamEvent.count({ where: { type: 'host.operation.failed' } })).toBe(1);
    // The grant is spent with it: it cannot be retried into a bind.
    expect(await code(redeem(holder.id, grant))).toBe('LAUNCH_GRANT_INVALID');
  }

  it('the hold was released', async () => {
    const { opId, grant } = await collectedStart();
    await db.worker.update({ where: { id: kit.id }, data: { heldByUserId: null, heldAt: null } });
    await expectRefused(opId, grant, 'LAUNCH_REFUSED');
    expect((await db.worker.findUniqueOrThrow({ where: { id: kit.id } })).heldByUserId).toBeNull();
  });

  it('the hold moved to someone else', async () => {
    const { opId, grant } = await collectedStart();
    await db.worker.update({ where: { id: kit.id }, data: { heldByUserId: other.id } });
    await expectRefused(opId, grant, 'WORKER_HELD');
  });

  it('the holder may no longer hold the worker (left the App)', async () => {
    const { opId, grant } = await collectedStart();
    await db.appMember.delete({ where: { appId_userId: { appId: app.id, userId: holder.id } } });
    await expectRefused(opId, grant, 'FORBIDDEN');
  });

  it('the worker already has a live session (the holder started it by hand)', async () => {
    const { opId, grant } = await collectedStart();
    await db.session.create({ data: { id: generateId(), appId: app.id, workerId: kit.id, userId: holder.id, startedAt: new Date(), updatedAt: new Date() } });
    await expectRefused(opId, grant, 'WORKER_TAKEN');
  });

  it('released before collection: the start fails at collection and no grant is minted', async () => {
    const op = await issueStart();
    await db.worker.update({ where: { id: kit.id }, data: { heldByUserId: null, heldAt: null } });
    expect(await collect()).toEqual([]);
    expect(await opOf(op.id)).toMatchObject({ status: 'failed' });
    expect(await db.launchGrant.count()).toBe(0);
  });
});

describe('#1883 review (Diego): the start is fenced from issue to bind', () => {
  function holdOpen(work: (tx: Parameters<Parameters<typeof db.$transaction>[0]>[0]) => Promise<void>) {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    let ready!: () => void;
    const locked = new Promise<void>((r) => { ready = r; });
    const done = db.$transaction(async (tx) => { await work(tx); ready(); await gate; });
    return { locked, release, done };
  }
  async function against<T>(hold: ReturnType<typeof holdOpen>, run: () => Promise<T>): Promise<T> {
    await hold.locked;
    let settled = false;
    const p = run().finally(() => { settled = true; });
    await new Promise((res) => setTimeout(res, 400));
    expect(settled).toBe(false);
    hold.release();
    await hold.done;
    return p;
  }
  const reHold = (userId: string) =>
    db.worker.update({ where: { id: kit.id }, data: { heldByUserId: userId, heldAt: new Date(Date.now() + Math.floor(Math.random() * 100_000)) } });
  const dropKitFromOrca1 = async (tx: any) => {
    const [reg] = await tx.$queryRaw`SELECT id FROM host_registrations WHERE app_id = ${app.id} AND host_id = 'orca1' FOR UPDATE`;
    await tx.hostRegistrationWorker.deleteMany({ where: { registrationId: reg.id } });
  };

  it('P2-1: the start records the hold it was issued under', async () => {
    const op = await issueStart();
    const w = await db.worker.findUniqueOrThrow({ where: { id: kit.id }, select: { heldByUserId: true, heldAt: true } });
    expect(await opOf(op.id)).toMatchObject({ holdUserId: w.heldByUserId, holdAt: w.heldAt });
  });

  it('P2-1: a hold moved BEFORE the first collection fails the start there; the new holder gets nothing', async () => {
    const op = await issueStart();
    await reHold(other.id);
    expect(await collect()).toEqual([]);
    expect(await opOf(op.id)).toMatchObject({ status: 'failed', failureReason: 'The hold changed after this start was issued.' });
    expect(await db.launchGrant.count()).toBe(0);
  });

  it('P2-1: a release and re-hold by the SAME holder is a changed hold, before collection and between re-collections', async () => {
    const op = await issueStart();
    await reHold(holder.id);
    expect(await collect()).toEqual([]);
    expect((await opOf(op.id)).status).toBe('failed');
    // Between re-collections: the first grant is minted, then the name is released and re-held.
    const again = await issueStart();
    const [first] = await collect();
    expect(first!.launchGrant).toBeTruthy();
    await reHold(holder.id);
    expect(await collect()).toEqual([]);
    expect((await opOf(again.id)).status).toBe('failed');
    expect(await code(redeem(holder.id, first!.launchGrant!))).toBe('LAUNCH_GRANT_INVALID');
    expect(await db.session.count({ where: { workerId: kit.id } })).toBe(0);
  });

  it('P2-1: a re-hold after collection refuses the bind and fails the start', async () => {
    const { opId, grant } = await collectedStart();
    await reHold(holder.id);
    await expect(redeem(holder.id, grant)).rejects.toMatchObject({ extensions: { code: 'LAUNCH_REFUSED', reason: 'LAUNCH_REFUSED' } });
    expect(await opOf(opId)).toMatchObject({ status: 'failed' });
    expect(await db.session.count({ where: { launchOperationId: opId } })).toBe(0);
  });

  it('P2-2: a refresh dropping the worker, in flight, is waited for: the manager\'s start is refused, nothing queued', async () => {
    const hold = holdOpen(dropKitFromOrca1);
    expect(await against(hold, () => code(issueStart()))).toBe('HOST_NOT_FOUND');
    expect(await db.hostOperation.count()).toBe(0);
  });

  it('P2-2: a lapse count lowered in flight is waited for: the platform starts nothing, and the assignment stands', async () => {
    await db.hostRegistration.updateMany({ data: { refreshedAt: new Date(Date.now() - 25 * 60_000) } });
    const t = await db.agentTask.create({ data: { appId: app.id, title: 'T', ownerUserId: manager.id, closeSessionWhenDone: false }, select: { id: true } });
    const hold = holdOpen(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${'host-lapse:' + app.id}))`;
      await tx.agentTaskStallSchedule.upsert({ where: { appId: app.id }, create: { appId: app.id, hostLapseCheckIns: 2 }, update: { hostLapseCheckIns: 2 } });
    });
    await against(hold, () => M.assignAgentTask({}, { taskId: t.id, assignee: { worker: kit.id } }, ctx(manager.id)));
    expect(await db.hostOperation.count()).toBe(0);
    expect((await db.agentTask.findUniqueOrThrow({ where: { id: t.id } })).assigneeWorkerId).toBe(kit.id);
  });

  it('P2-2: the platform\'s start also waits for a refresh dropping the worker', async () => {
    const t = await db.agentTask.create({ data: { appId: app.id, title: 'T', ownerUserId: manager.id, closeSessionWhenDone: false }, select: { id: true } });
    const hold = holdOpen(dropKitFromOrca1);
    await against(hold, () => M.assignAgentTask({}, { taskId: t.id, assignee: { worker: kit.id } }, ctx(manager.id)));
    expect(await db.hostOperation.count()).toBe(0);
  });

  it('P2-3: the holder removed from the App while the bind waits: the bind is refused and the start fails', async () => {
    const { opId, grant } = await collectedStart();
    const hold = holdOpen(async (tx) => {
      await tx.appMember.delete({ where: { appId_userId: { appId: app.id, userId: holder.id } } });
    });
    const err = await against<GraphQLError | null>(hold, () => redeem(holder.id, grant).then(() => null, (e: GraphQLError) => e));
    expect(err?.extensions).toMatchObject({ code: 'LAUNCH_REFUSED', reason: 'FORBIDDEN' });
    expect(await opOf(opId)).toMatchObject({ status: 'failed' });
    expect(await db.session.count({ where: { launchOperationId: opId } })).toBe(0);
    expect(await db.agentTeamEvent.count({ where: { type: 'host.operation.failed' } })).toBe(1);
  });
});

describe('#1883 review (Riana P2): the bind and the host\'s report serialize on the operation', () => {
  it('a FAILED report in flight is waited for: the bind then refuses, so no session sits beside a failed start', async () => {
    const { opId, grant } = await collectedStart();
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    let ready!: () => void;
    const locked = new Promise<void>((r) => { ready = r; });
    // The report's first write, held open: the operation locked and marked failed, the grant not yet revoked.
    const report = db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM host_operations WHERE id = ${opId} FOR UPDATE`;
      await tx.hostOperation.update({ where: { id: opId }, data: { status: 'failed', finishedAt: new Date(), failureReason: 'terminal died' } });
      ready();
      await gate;
    });
    await locked;
    let settled = false;
    const bind = redeem(holder.id, grant).then(() => null, (e: GraphQLError) => e).finally(() => { settled = true; });
    await new Promise((r) => setTimeout(r, 400));
    expect(settled).toBe(false);
    release();
    await report;
    expect((await bind)?.extensions?.code).toBe('LAUNCH_GRANT_INVALID');
    expect(await db.session.count({ where: { launchOperationId: opId } })).toBe(0);
    expect((await opOf(opId)).status).toBe('failed');
  });

  it('a report after the bind finds its session: a FAILED report is recorded as the success it is', async () => {
    const { opId, grant } = await collectedStart();
    const s = await redeem(holder.id, grant);
    expect(await report(opId, { outcome: 'FAILED', failureReason: 'thought it died' })).toMatchObject({ status: 'succeeded', result: { sessionId: s.id } });
  });
});

describe('#1883 review (Diego delta P2): the holder\'s standing is re-read live at the bind', () => {
  it('a holder admitted only by a platform role, demoted while the bind waits: refused, the start fails, no session', async () => {
    // Kit's holder is a platform ADMIN with no App or org membership: participation rests on the role alone.
    const padmin = await db.user.create({ data: { githubId: 77_000_000 + Math.floor(Math.random() * 1e6), githubUsername: `la-padmin-${generateId()}`, roles: ['ADMIN'] }, select: { id: true } });
    await db.worker.update({ where: { id: kit.id }, data: { heldByUserId: padmin.id, heldAt: new Date() } });
    const { opId, grant } = await collectedStart();
    // updateUserRoles' shape: the user's authority anchor exclusively, then the role change, held open.
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    let ready!: () => void;
    const locked = new Promise<void>((r) => { ready = r; });
    const demote = db.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${'authorization:user'}), hashtext(${padmin.id}))`;
      await tx.user.update({ where: { id: padmin.id }, data: { roles: ['READER'] } });
      ready();
      await gate;
    });
    await locked;
    let settled = false;
    // The request's context still carries the role it authenticated with.
    const bind = M.startSession({}, { input: { id: generateId(), tool: 'vitest', launchGrant: grant } }, { db, userId: padmin.id, roles: ['ADMIN'] } as Context)
      .then(() => null, (e: GraphQLError) => e)
      .finally(() => { settled = true; });
    await new Promise((r) => setTimeout(r, 400));
    expect(settled).toBe(false);
    release();
    await demote;
    const err = await bind;
    expect(err?.extensions).toMatchObject({ code: 'LAUNCH_REFUSED', reason: 'FORBIDDEN' });
    expect(await opOf(opId)).toMatchObject({ status: 'failed' });
    expect(await db.session.count({ where: { launchOperationId: opId } })).toBe(0);
  });

  it('control: the same platform-admin holder, not demoted, binds', async () => {
    const padmin = await db.user.create({ data: { githubId: 78_000_000 + Math.floor(Math.random() * 1e6), githubUsername: `la-padmin2-${generateId()}`, roles: ['ADMIN'] }, select: { id: true } });
    await db.worker.update({ where: { id: kit.id }, data: { heldByUserId: padmin.id, heldAt: new Date() } });
    const { opId, grant } = await collectedStart();
    const s = await M.startSession({}, { input: { id: generateId(), tool: 'vitest', launchGrant: grant } }, { db, userId: padmin.id, roles: ['ADMIN'] } as Context);
    expect(s.launchOperationId).toBe(opId);
  });
});

describe('the platform starts an assigned worker with no live session (cor:agt:070:08; #10773 (6): by hand too)', () => {
  const task = (assigneeWorkerId: string | null = null) =>
    db.agentTask.create({ data: { appId: app.id, title: 'Do it', ownerUserId: manager.id, assigneeWorkerId, closeSessionWhenDone: false }, select: { id: true } });

  it('S1: assigning Kit by hand asks orca1 to start Kit in its existing worktree; the session records the platform and the task', async () => {
    const t = await task();
    await M.assignAgentTask({}, { taskId: t.id, assignee: { worker: kit.id } }, ctx(manager.id));
    const [op] = await db.hostOperation.findMany();
    expect(op).toMatchObject({ type: 'worker.start', hostId: 'orca1', issuedBy: 'platform', workerId: kit.id });
    expect(op!.args).toEqual({ workerId: kit.id, worktree: 'hadron-server/kit', family: 'claude', taskId: t.id });
    const [got] = await collect();
    const s = await redeem(holder.id, got!.launchGrant!);
    expect(s).toMatchObject({ launchIssuedBy: 'platform', launchTaskId: t.id });
    // Reassigning to Kit again while its start is in flight or it is live issues nothing more.
    await M.reassignAgentTask({}, { taskId: t.id, assignee: { worker: kit.id } }, ctx(manager.id)).catch(() => undefined);
    expect(await db.hostOperation.count()).toBe(1);
  });

  it('created straight onto Kit, the task starts Kit too', async () => {
    await M.createAgentTask({}, { input: { appRef: app.id, title: 'Now', assignee: { worker: kit.id }, closeSessionWhenDone: false } }, ctx(manager.id));
    expect((await db.hostOperation.findMany()).map((o) => [o.type, o.issuedBy])).toEqual([['worker.start', 'platform']]);
  });

  it('S2: a worker nobody holds is never started; S3: with no worktree on a live host nothing is started, and the task waits', async () => {
    await db.worker.update({ where: { id: kit.id }, data: { heldByUserId: null, heldAt: null } });
    const t1 = await task();
    await M.assignAgentTask({}, { taskId: t1.id, assignee: { worker: kit.id } }, ctx(manager.id));
    expect(await db.hostOperation.count()).toBe(0);
    await db.worker.update({ where: { id: kit.id }, data: { heldByUserId: holder.id, heldAt: new Date() } });
    await M.registerHost({}, { input: { appRef: app.id, label: 'Orca', pollIntervalSeconds: 600, workers: [{ worker: kit.id, family: 'claude' }] } }, keyCtx(orca1));
    const t2 = await task();
    await M.assignAgentTask({}, { taskId: t2.id, assignee: { worker: kit.id } }, ctx(manager.id));
    expect(await db.hostOperation.count()).toBe(0);
    expect((await db.agentTask.findUniqueOrThrow({ where: { id: t2.id } })).status).toBe('pending');
    // cor:agt:070:06: no worktree is ever created for it.
    expect(await db.hostOperation.count({ where: { type: { startsWith: 'worktree.' } } })).toBe(0);
  });

  it('a worker with a live session is not started: it simply has the task', async () => {
    await db.session.create({ data: { id: generateId(), appId: app.id, workerId: kit.id, userId: holder.id, startedAt: new Date(), updatedAt: new Date() } });
    const t = await task();
    await M.assignAgentTask({}, { taskId: t.id, assignee: { worker: kit.id } }, ctx(manager.id));
    expect(await db.hostOperation.count()).toBe(0);
  });

  it('#10773 (5): a worker whose every session is dormant is started on a new session', async () => {
    const quiet = new Date(Date.now() - 60 * 86_400_000);
    await db.session.create({ data: { id: generateId(), appId: app.id, workerId: kit.id, userId: holder.id, startedAt: quiet, updatedAt: quiet } });
    const t = await task();
    await M.assignAgentTask({}, { taskId: t.id, assignee: { worker: kit.id } }, ctx(manager.id));
    expect(await db.hostOperation.count({ where: { type: 'worker.start' } })).toBe(1);
  });
});
