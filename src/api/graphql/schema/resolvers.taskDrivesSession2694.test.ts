import { WORKER_SIGNATURE_DEFAULTS } from '../../../lib/workerSignature.js';
/**
 * #2694 (cor:agt:020:11 r3, Vera's reading in team chat #60465): a task mutation made by a worker through its own
 * bound, LIVE session is that worker driving the session, so it counts as activity — through the same heartbeat the
 * bind gate and the roster read (`touchLiveSession` / `isSessionLive`), never a roster-only patch. A write through a
 * session that already lapsed never revives it (cor:agt:020:05, #1543), and a session that is not the actor's is
 * never touched.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { runAsActor } from '../../../lib/requestActor.js';
import { resolvers, type Context } from './resolvers.js';
import { loadWorkerCheckStatuses } from '../../../lib/workerCheckStatus.js';

vi.mock('../../../integrations/github/writeNodeToGit.js', () => ({
  writeNodeToGit: vi.fn().mockResolvedValue(undefined),
}));

const M = resolvers.Mutation as any;
const HOUR = 3_600_000;
const ago = (hours: number) => new Date(Date.now() - hours * HOUR);

let member: { id: string };
let app: { id: string };
let teamAgent: { id: string };
let anne: { id: string };
let liam: { id: string };

const ctxFor = (sessionId?: string): Context => ({ db, userId: member.id, roles: ['READER'], sessionId }) as Context;
const asWorker = (w: { id: string }, fn: () => Promise<any>) => runAsActor({ workerId: w.id, agentId: teamAgent.id }, fn);
const session = (w: { id: string }, hoursSilent: number) =>
  db.session.create({
    data: { id: generateId(), appId: app.id, workerId: w.id, agentId: teamAgent.id, userId: member.id, startedAt: ago(hoursSilent), updatedAt: ago(hoursSilent) },
    select: { id: true },
  });
const heartbeat = async (id: string) => (await db.session.findUniqueOrThrow({ where: { id } })).updatedAt!.getTime();
const assigned = async (w: { id: string }) =>
  (await M.createAgentTask({}, { input: { appRef: app.id, title: 'T', assignee: { worker: w.id } } }, ctxFor())).id as string;

beforeEach(async () => {
  await cleanDb(db);
  const n = Math.floor(Math.random() * 1_000_000);
  const org = await db.organization.create({ data: { id: generateId(), name: 'drv-org', urn: `drv-org-${n}.example` } });
  const admin = await db.user.create({ data: { id: generateId(), githubId: 830_000 + n, githubUsername: `drv-admin-${n}`, roles: ['READER'] } });
  member = await db.user.create({ data: { id: generateId(), githubId: 840_000 + n, githubUsername: `drv-mia-${n}`, roles: ['READER'] } });
  await db.orgMember.create({ data: { id: generateId(), organizationId: org.id, userId: admin.id, role: 'ADMIN' } });
  teamAgent = await M.createAgent({}, { orgId: org.id, name: 'Team Agent' }, { db, userId: admin.id, roles: ['READER'] });
  app = await db.app.create({ data: { id: generateId(), organizationId: org.id, name: 'Team', urn: `${org.urn}:team` } });
  await db.appMember.create({ data: { appId: app.id, userId: member.id, role: 'member' } });
  const worker = (name: string) =>
    db.worker.create({ data: { ...WORKER_SIGNATURE_DEFAULTS, id: generateId(), appId: app.id, agentId: teamAgent.id, name, slug: name.toLowerCase(), heldByUserId: member.id }, select: { id: true } });
  anne = await worker('Anne');
  liam = await worker('Liam');
});

describe('#2694 a task mutation through the worker\'s own live session drives it', () => {
  it.each([
    ['start', async (id: string, c: Context) => asWorker(anne, () => M.startAgentTask({}, { taskId: id }, c))],
    ['progress', async (id: string, c: Context) => {
      await asWorker(anne, () => M.startAgentTask({}, { taskId: id }, ctxFor()));
      return asWorker(anne, () => M.recordAgentTaskProgress({}, { taskId: id }, c));
    }],
    ['finish', async (id: string, c: Context) => {
      await asWorker(anne, () => M.startAgentTask({}, { taskId: id }, ctxFor()));
      return asWorker(anne, () => M.finishAgentTask({}, { taskId: id, result: { outcome: 'succeeded' } }, c));
    }],
  ] as const)('%s refreshes the heartbeat of a live session driven 20h ago', async (_n, act) => {
    const s = await session(anne, 20);
    const before = await heartbeat(s.id);
    await act(await assigned(anne), ctxFor(s.id));
    expect(await heartbeat(s.id)).toBeGreaterThan(before + HOUR); // moved to now, not a rounding bump
  });

  it('Hugo\'s shape: a task-only worker driven ~24h ago by updatedAt reads live after a start', async () => {
    const s = await session(anne, 23.9); // 6 minutes from lapsing
    const id = await assigned(anne);
    await asWorker(anne, () => M.startAgentTask({}, { taskId: id }, ctxFor(s.id)));
    // 30 minutes later it would have lapsed; the refresh keeps it live.
    const later = new Date(Date.now() + 0.5 * HOUR);
    const statuses = await loadWorkerCheckStatuses(db as never, { appId: app.id, teamChannelId: null, workerIds: [anne.id], now: later });
    expect(statuses.get(anne.id)!.status).not.toBe('NO_SESSION');
  });

  it('creating a child task refreshes the heartbeat of a live session (the one task write outside mutateTask)', async () => {
    const parent = await assigned(anne);
    await asWorker(anne, () => M.startAgentTask({}, { taskId: parent }, ctxFor()));
    const s = await session(anne, 20);
    const before = await heartbeat(s.id);
    await asWorker(anne, () => M.createAgentTask({}, { input: { appRef: app.id, title: 'child', parentTaskId: parent } }, ctxFor(s.id)));
    expect(await heartbeat(s.id)).toBeGreaterThan(before + HOUR);
  });

  it('fence 2: a session that already lapsed is NOT revived by a task mutation', async () => {
    const s = await session(anne, 30);
    const before = await heartbeat(s.id);
    const id = await assigned(anne);
    await asWorker(anne, () => M.startAgentTask({}, { taskId: id }, ctxFor(s.id)));
    expect(await heartbeat(s.id)).toBe(before);
    const statuses = await loadWorkerCheckStatuses(db as never, { appId: app.id, teamChannelId: null, workerIds: [anne.id], now: new Date() });
    expect(statuses.get(anne.id)!.status).toBe('NO_SESSION'); // control: truly lapsed stays NO_SESSION
  });

  it('a session bound to ANOTHER worker is never touched by this worker\'s mutation', async () => {
    const other = await session(liam, 20);
    const before = await heartbeat(other.id);
    const id = await assigned(anne);
    await asWorker(anne, () => M.startAgentTask({}, { taskId: id }, ctxFor(other.id)));
    expect(await heartbeat(other.id)).toBe(before);
  });

  it('a refused mutation drives nothing (the assignee gate throws first)', async () => {
    const s = await session(liam, 20);
    const before = await heartbeat(s.id);
    const id = await assigned(anne);
    await expect(asWorker(liam, () => M.startAgentTask({}, { taskId: id }, ctxFor(s.id)))).rejects.toMatchObject({ extensions: { code: 'TASK_NOT_ASSIGNEE' } });
    expect(await heartbeat(s.id)).toBe(before);
  });

  it('a person (no bound worker) mutating a task touches no session', async () => {
    const s = await session(anne, 20);
    const before = await heartbeat(s.id);
    const id = await assigned(anne);
    await M.cancelAgentTask({}, { taskId: id }, ctxFor(s.id));
    expect(await heartbeat(s.id)).toBe(before);
  });
});
