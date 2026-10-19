import { WORKER_SIGNATURE_DEFAULTS } from '../workerSignature.js';
/**
 * #1881 (cor:agt:070:02; Holger via Vera #10765) — nothing stays in flight forever: a collected operation with no
 * report fails after the App's timeout, and an operation never collected is settled when its host lapses or its
 * reason goes away. Plus (Ada's scope additions, Holger #10849, cor:agt:070:07) every host-key call is recorded,
 * reads and refusals included, and the listing's reader audience (part 2) pinned in both directions.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { GraphQLError } from 'graphql';
import { randomBytes } from 'node:crypto';
import { db } from '../../integrations/db/client.js';
import { cleanDb } from '../../test/helpers.js';
import { generateId } from '../id.js';
import { APP_KEY_PREFIX, hashAppKey } from '../../middleware/auth.js';
import { resolvers, type Context } from '../../api/graphql/schema/resolvers.js';
import { HOST_REPORT_TIMEOUT_DEFAULT_MINUTES, sweepUnreportedHostOperations } from './settle.js';
import { taskStallTick } from '../../jobs/taskStallEvaluator.js';
import { lockAppHostLapse } from '../agentTasks/hosts.js';

vi.mock('../../integrations/github/writeNodeToGit.js', () => ({ writeNodeToGit: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../bus/index.js', () => ({ getBusClient: vi.fn(async () => null) }));

const M = resolvers.Mutation as any;
const Q = resolvers.Query as any;
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
let manager: { id: string };
let holder: { id: string };
let member: { id: string };
let kit: { id: string };
let orca1: { id: string };
let plainKey: { id: string };

async function mkKey(label: string) {
  const raw = `${APP_KEY_PREFIX}${randomBytes(32).toString('hex')}`;
  return db.appKey.create({ data: { id: generateId(), appId: app.id, keyHash: hashAppKey(raw), keyPreview: raw.slice(-4), label }, select: { id: true } });
}
const keyCtx = (k: { id: string }): Context => ({ db, appId: app.id, appKeyId: k.id, organizationId: org.id, roles: [] }) as Context;
const START = { worktree: 'hadron-server/kit', family: 'claude' };
const issue = (type: string, args: Record<string, unknown>) =>
  M.issueHostOperation({}, { input: { appRef: app.id, hostId: 'orca1', worker: kit.id, type, args } }, ctx(manager.id));
const issueCreate = () => issue('worktree.create', { repo: 'hadron-server', baseBranch: 'main', branchName: 'kit-9', label: 'kit-9' });
const collect = (): Promise<Array<{ id: string; launchGrant: string | null }>> =>
  M.collectHostOperations({}, { appRef: app.id }, keyCtx(orca1));
const report = (id: string, input: Record<string, unknown>) =>
  M.reportHostOperation({}, { input: { appRef: app.id, id, ...input } }, keyCtx(orca1));
const redeem = (userId: string, launchGrant: string) =>
  M.startSession({}, { input: { id: generateId(), tool: 'vitest', launchGrant } }, ctx(userId));
const opOf = (id: string) => db.hostOperation.findUniqueOrThrow({ where: { id } });
const minutes = (m: number) => m * 60_000;
/** A worker.end op as the platform issues it (#1877), straight into the table: it needs only a valid shape. */
const endOp = (sessionId: string, status: 'issued' | 'collected') =>
  db.hostOperation.create({
    data: {
      id: generateId(), appId: app.id, hostId: 'orca1', type: 'worker.end', args: { workerId: kit.id, sessionId }, workerId: kit.id,
      status, issuedBy: 'platform', ...(status === 'collected' ? { collectedAt: new Date() } : {}),
    },
  });
const kitSession = (ended: boolean) =>
  db.session.create({ data: { id: generateId(), userId: holder.id, workerId: kit.id, type: 'DEVELOPER', ...(ended ? { endedAt: new Date() } : {}) } });

beforeEach(async () => {
  await cleanDb(db);
  const n = Math.floor(Math.random() * 1_000_000);
  org = await db.organization.create({ data: { name: 'Settle', urn: `settle-${n}.example` }, select: { id: true, urn: true } });
  const u = (k: number, name: string) =>
    db.user.create({ data: { githubId: k * 1_000_000 + n, githubUsername: `st-${name}-${n}`, roles: ['READER'] }, select: { id: true } });
  manager = await u(61, 'manager');
  holder = await u(62, 'holder');
  member = await u(63, 'member');
  await db.orgMember.create({ data: { organizationId: org.id, userId: manager.id, role: 'ADMIN' } });
  const agent = await M.createAgent({}, { orgId: org.id, name: 'Team Agent' }, ctx(manager.id));
  app = await db.app.create({ data: { organizationId: org.id, name: 'Team', urn: `${org.urn}:team` }, select: { id: true } });
  for (const id of [holder.id, member.id]) await db.appMember.create({ data: { appId: app.id, userId: id, role: 'member' } });
  kit = await db.worker.create({ data: { ...WORKER_SIGNATURE_DEFAULTS, appId: app.id, agentId: agent.id, name: 'Kit', slug: 'kit', heldByUserId: holder.id, heldAt: new Date() }, select: { id: true } });
  orca1 = await mkKey('orca1');
  plainKey = await mkKey('plain');
  await M.grantAppKeyScope({}, { id: orca1.id, scope: 'host:operate', hostId: 'orca1' }, ctx(manager.id));
  await M.registerHost({}, {
    input: { appRef: app.id, label: 'Orca', pollIntervalSeconds: 600, workers: [{ worker: kit.id, family: 'claude', worktrees: ['hadron-server/kit'] }] },
  }, keyCtx(orca1));
});

describe('a collected operation with no report fails after the App\'s timeout (070:02)', () => {
  it(`never early: at ${HOST_REPORT_TIMEOUT_DEFAULT_MINUTES} minutes by default, with why; the outcome event; a later report is refused`, async () => {
    const op = await issueCreate();
    await collect();
    const at = (await opOf(op.id)).collectedAt!.getTime();
    expect(await sweepUnreportedHostOperations(db, new Date(at + minutes(59)))).toBe(0);
    expect((await opOf(op.id)).status).toBe('collected');
    expect(await sweepUnreportedHostOperations(db, new Date(at + minutes(60)))).toBe(1);
    expect(await opOf(op.id)).toMatchObject({ status: 'failed', failureReason: 'No report within 60 minutes of collection.', result: null });
    expect(await db.agentTeamEvent.count({ where: { type: 'host.operation.failed' } })).toBe(1);
    expect(await code(report(op.id, { outcome: 'SUCCEEDED', worktree: 'hadron-server/kit-9' }))).toBe('HOST_OPERATION_ALREADY_REPORTED');
    // Settled is settled: a second pass finds nothing.
    expect(await sweepUnreportedHostOperations(db, new Date(at + minutes(120)))).toBe(0);
  });

  it('each App sets its own timeout (5 to 1440 minutes; null is the default), and the stall loop runs the sweep', async () => {
    const set = (v: number | null) => M.setAgentTaskStallSchedule({}, { appRef: app.id, input: { hostReportTimeoutMinutes: v } }, ctx(manager.id));
    expect(await code(set(4))).toBe('BAD_USER_INPUT');
    expect(await code(set(1441))).toBe('BAD_USER_INPUT');
    expect(await code(M.setAgentTaskStallSchedule({}, { appRef: app.id, input: { hostReportTimeoutMinutes: 10 } }, ctx(member.id)))).toBe('APP_MANAGER_REQUIRED');
    expect((await set(5)).hostReportTimeoutMinutes).toBe(5);
    const op = await issueCreate();
    await collect();
    const at = (await opOf(op.id)).collectedAt!.getTime();
    expect((await taskStallTick(db, new Date(at + minutes(4)))).hostOperationsSettled).toBe(0);
    expect((await taskStallTick(db, new Date(at + minutes(5)))).hostOperationsSettled).toBe(1);
    expect((await opOf(op.id)).failureReason).toBe('No report within 5 minutes of collection.');
    expect((await set(null)).hostReportTimeoutMinutes).toBe(HOST_REPORT_TIMEOUT_DEFAULT_MINUTES);
  });

  it('never early under a concurrent raise (Anne #1932 P3): a sweep waiting on the setter decides under the NEW timeout', async () => {
    await M.setAgentTaskStallSchedule({}, { appRef: app.id, input: { hostReportTimeoutMinutes: 5 } }, ctx(manager.id));
    const op = await issueCreate();
    await collect();
    const at = (await opOf(op.id)).collectedAt!.getTime();
    let release!: () => void;
    const held = new Promise<void>((r) => { release = r; });
    let locked!: () => void;
    const isLocked = new Promise<void>((r) => { locked = r; });
    // The setter's shape: the App's host-lapse lock exclusive, the timeout raised to 60, not yet committed.
    const raiser = db.$transaction(async (tx) => {
      await lockAppHostLapse(tx, app.id, 'exclusive');
      await tx.agentTaskStallSchedule.update({ where: { appId: app.id }, data: { hostReportTimeoutMinutes: 60 } });
      locked();
      await held;
    }, { timeout: 20_000 });
    await isLocked;
    // Read at +6 minutes, the old 5-minute timeout has passed; the sweep's decision waits for the raise.
    const sweep = sweepUnreportedHostOperations(db, new Date(at + minutes(6)));
    await new Promise((r) => setTimeout(r, 300));
    release();
    await raiser;
    expect(await sweep).toBe(0);
    expect((await opOf(op.id)).status).toBe('collected');
  });

  it('a timed-out start: failed with its grant revoked, or succeeded when its session is bound (a FAILED report\'s rules)', async () => {
    const unbound = await issue('worker.start', START);
    const [got] = await collect();
    const at = (await opOf(unbound.id)).collectedAt!.getTime();
    await sweepUnreportedHostOperations(db, new Date(at + minutes(60)));
    expect((await opOf(unbound.id)).status).toBe('failed');
    expect(await db.launchGrant.count({ where: { operationId: unbound.id, revokedAt: null } })).toBe(0);
    expect(await code(redeem(holder.id, got!.launchGrant!))).toBe('LAUNCH_GRANT_INVALID');

    const bound = await issue('worker.start', START);
    const [again] = await collect();
    const session = await redeem(holder.id, again!.launchGrant!);
    const at2 = (await opOf(bound.id)).collectedAt!.getTime();
    await sweepUnreportedHostOperations(db, new Date(at2 + minutes(60)));
    expect(await opOf(bound.id)).toMatchObject({ status: 'succeeded', result: { sessionId: session.id }, failureReason: null });
  });

  it('a timed-out worker.end: succeeded when its session ended; failed when it did not, and the session is NOT ended', async () => {
    const ended = await kitSession(true);
    const endedOp = await endOp(ended.id, 'collected');
    const open = await kitSession(false);
    const openOp = await endOp(open.id, 'collected');
    const later = new Date(Date.now() + minutes(61));
    expect(await sweepUnreportedHostOperations(db, later)).toBe(2);
    expect(await opOf(endedOp.id)).toMatchObject({ status: 'succeeded', result: { handoff: false } });
    expect(await opOf(openOp.id)).toMatchObject({ status: 'failed', failureReason: 'No report within 60 minutes of collection.' });
    expect((await db.session.findUniqueOrThrow({ where: { id: open.id } })).endedAt).toBeNull();
  });
});

describe('an operation never collected is settled when its host lapses or its reason goes away (070:02)', () => {
  it('its host\'s registration lapsed (recorded lost): failed, with no collected_at; a live host keeps it in flight', async () => {
    const op = await issueCreate();
    expect(await sweepUnreportedHostOperations(db)).toBe(0);
    await db.hostRegistration.updateMany({ where: { appId: app.id, hostId: 'orca1' }, data: { lostAt: new Date() } });
    expect(await sweepUnreportedHostOperations(db)).toBe(1);
    expect(await opOf(op.id)).toMatchObject({ status: 'failed', collectedAt: null, failureReason: "The host's registration lapsed before it collected this." });
  });

  it('a start whose task is no longer the worker\'s open task: failed', async () => {
    const t = await db.agentTask.create({ data: { appId: app.id, title: 'T', ownerUserId: manager.id, assigneeWorkerId: kit.id, assignedAt: new Date(), closeSessionWhenDone: false }, select: { id: true } });
    const op = await issue('worker.start', { ...START, taskId: t.id });
    expect(await sweepUnreportedHostOperations(db)).toBe(0);
    await M.cancelAgentTask({}, { taskId: t.id }, ctx(manager.id));
    expect(await sweepUnreportedHostOperations(db)).toBe(1);
    expect(await opOf(op.id)).toMatchObject({ status: 'failed', collectedAt: null, failureReason: "The task this start was for is no longer the worker's open task." });
  });

  it('a start whose hold changed, or whose worker retired: failed', async () => {
    const held = await issue('worker.start', START);
    await db.worker.update({ where: { id: kit.id }, data: { heldAt: new Date(Date.now() + 5000) } });
    expect(await sweepUnreportedHostOperations(db)).toBe(1);
    expect((await opOf(held.id)).failureReason).toBe('The hold changed after this start was issued.');
    const retired = await issue('worker.start', START);
    await db.worker.update({ where: { id: kit.id }, data: { retiredAt: new Date() } });
    expect(await sweepUnreportedHostOperations(db)).toBe(1);
    expect((await opOf(retired.id)).failureReason).toBe('The worker was retired before its start was collected.');
  });

  it('a worker.end whose session already ended: succeeded (020:10: it fails only if the session did not end); an open one stays', async () => {
    const ended = await endOp((await kitSession(true)).id, 'issued');
    const open = await endOp((await kitSession(false)).id, 'issued');
    expect(await sweepUnreportedHostOperations(db)).toBe(1);
    expect(await opOf(ended.id)).toMatchObject({ status: 'succeeded', collectedAt: null, result: { handoff: false } });
    expect((await opOf(open.id)).status).toBe('issued');
  });

  it('a worktree operation has no reason that can go away: only its host\'s lapse settles it', async () => {
    const op = await issueCreate();
    await db.worker.update({ where: { id: kit.id }, data: { heldByUserId: null, heldAt: null } });
    expect(await sweepUnreportedHostOperations(db)).toBe(0);
    expect((await opOf(op.id)).status).toBe('issued');
  });
});

describe('every host-key call is recorded, reads and refusals included (070:07, Holger #10849)', () => {
  it('a host key\'s read is a use; its refused listing read is recorded apart with the code; other readers record nothing', async () => {
    await Q.hostRegistrations({}, { appRef: app.id }, keyCtx(orca1));
    expect(await code(Q.hostOperations({}, { appRef: app.id }, keyCtx(orca1)))).toBe('FORBIDDEN');
    await Q.hostRegistrations({}, { appRef: app.id }, keyCtx(plainKey));
    await Q.hostOperations({}, { appRef: app.id }, keyCtx(plainKey));
    await Q.hostOperations({}, { appRef: app.id }, ctx(member.id));
    const reads = await db.hostKeyUse.findMany({ where: { action: 'read' }, orderBy: { usedAt: 'asc' } });
    expect(reads.map((u) => [u.appKeyId, u.hostId, u.count, u.refusedCode])).toEqual([
      [orca1.id, 'orca1', 1, null],
      [orca1.id, 'orca1', null, 'FORBIDDEN'],
    ]);
  });

  it('a refused report is recorded with the operation it named, apart from the refused call', async () => {
    const op = await issueCreate();
    expect(await code(report(op.id, { outcome: 'SUCCEEDED', worktree: 'hadron-server/kit-9' }))).toBe('HOST_OPERATION_NOT_COLLECTED');
    const [use] = await db.hostKeyUse.findMany({ where: { action: 'report' } });
    expect(use).toMatchObject({ operationId: op.id, refusedCode: 'HOST_OPERATION_NOT_COLLECTED', hostId: 'orca1' });
  });
});

describe('part 2: the App-wide listing\'s readers (Holger #10778; the host key: #1884, #1919)', () => {
  it('participants and the App\'s non-host key read it; an outsider and a revoked member do not', async () => {
    const op = await issueCreate();
    const ids = async (c: Context) => (await Q.hostOperations({}, { appRef: app.id }, c)).items.map((o: any) => o.id);
    expect(await ids(ctx(member.id))).toEqual([op.id]);
    expect(await ids(ctx(manager.id))).toEqual([op.id]);
    expect(await ids(keyCtx(plainKey))).toEqual([op.id]);
    const outsider = await db.user.create({ data: { githubId: 990_000_000 + Math.floor(Math.random() * 1e6), githubUsername: `st-out-${generateId()}`, roles: ['READER'] }, select: { id: true } });
    expect(await code(Q.hostOperations({}, { appRef: app.id }, ctx(outsider.id)))).toBe('APP_NOT_FOUND');
    await db.appMember.deleteMany({ where: { appId: app.id, userId: member.id } });
    expect(await code(Q.hostOperations({}, { appRef: app.id }, ctx(member.id)))).toBe('APP_NOT_FOUND');
  });
});
