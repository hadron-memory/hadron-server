/**
 * #4273 — the stall pass does not re-decide an episode whose alarm is already raised.
 *
 * `evaluateStalls` used to open a Serializable transaction and reload the task's inputs for EVERY due candidate on
 * every pass, to find the unique key (task, type, episode start) taken. On the #4271 seed that was 842 re-evaluations a
 * minute (35-41 s). A candidate is now skipped only where an alarm event with its own key exists; a candidate whose
 * episode is new (a reassignment, a restart, another rule) is still decided in its own transaction. The alarms raised
 * are the ones raised before (cor:agt:050:12-:20); only the work for the already-raised ones is gone.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../../integrations/db/client.js';
import { cleanDb } from '../../test/helpers.js';
import { generateId } from '../id.js';
import { resolvers, type Context } from '../../api/graphql/schema/resolvers.js';
import { WORKER_SIGNATURE_DEFAULTS } from '../workerSignature.js';
import { PrismaClient } from '../../generated/prisma/index.js';
import { evaluateStalls } from './stall.js';
import { taskStallTick } from '../../jobs/taskStallEvaluator.js';

vi.mock('../../integrations/github/writeNodeToGit.js', () => ({ writeNodeToGit: vi.fn().mockResolvedValue(undefined) }));

const M = resolvers.Mutation as any;
const ctx = (userId?: string): Context => ({ db, userId, roles: ['READER'] });
const at = (hhmm: string): Date => new Date(`2026-10-09T${hhmm}:00Z`);

let appId: string;
let ada: string;
let anne: string;
let liam: string;

beforeEach(async () => {
  await cleanDb(db);
  const n = Math.floor(Math.random() * 1_000_000);
  const org = await db.organization.create({ data: { name: 'Pass', urn: `pass-${n}.example` } });
  const admin = await db.user.create({ data: { githubId: 600_000 + n, githubUsername: `pass-${n}`, roles: ['READER'] } });
  await db.orgMember.create({ data: { organizationId: org.id, userId: admin.id, role: 'ADMIN' } });
  const agentId = (await M.createAgent({}, { orgId: org.id, name: 'Team Agent' }, ctx(admin.id))).id;
  appId = (await db.app.create({ data: { organizationId: org.id, name: 'Team', urn: `pass-${n}.example:team` }, select: { id: true } })).id;
  const worker = async (name: string) => (await db.worker.create({ data: { ...WORKER_SIGNATURE_DEFAULTS, appId, agentId, name, slug: name.toLowerCase() }, select: { id: true } })).id;
  ada = await worker('Ada');
  anne = await worker('Anne');
  liam = await worker('Liam');
});

const pending = (assignedAt: string, assignee = anne) =>
  db.agentTask.create({ data: { appId, title: 'T', createdAt: at('09:00'), ownerWorkerId: ada, assigneeWorkerId: assignee, assignedAt: at(assignedAt) }, select: { id: true } });

/** How many raising transactions (`raiseStallAlarm` opens one per candidate it decides) a pass opened. */
async function decisions(now: Date): Promise<{ raised: number; transactions: number }> {
  const spy = vi.spyOn(db, '$transaction');
  try {
    const raised = (await evaluateStalls(db, now)).length;
    return { raised, transactions: spy.mock.calls.filter((c) => (c[1] as { isolationLevel?: string } | undefined)?.isolationLevel === 'Serializable').length };
  } finally {
    spy.mockRestore();
  }
}

describe('#4273 — an already-raised episode is not decided again', () => {
  it('the first pass decides and raises the candidate; the next passes open no raising transaction and raise nothing', async () => {
    await pending('10:00');
    expect(await decisions(at('10:15'))).toEqual({ raised: 1, transactions: 1 });
    expect(await decisions(at('10:16'))).toEqual({ raised: 0, transactions: 0 });
    expect(await decisions(at('11:30'))).toEqual({ raised: 0, transactions: 0 });
    expect(await db.agentTeamEvent.count({ where: { type: 'stall.not-started' } })).toBe(1);
  });

  it('a reassignment is a NEW episode of the same rule: it is decided and raised, the old one stays', async () => {
    const t = await pending('10:00');
    await decisions(at('10:15'));
    await db.agentTask.update({ where: { id: t.id }, data: { assigneeWorkerId: liam, assignedAt: at('11:05') } });
    expect(await decisions(at('11:19'))).toEqual({ raised: 0, transactions: 0 }); // the new window has not passed
    expect(await decisions(at('11:20'))).toEqual({ raised: 1, transactions: 1 });
    const rows = await db.agentTeamEvent.findMany({ where: { taskId: t.id, type: 'stall.not-started' }, orderBy: { createdAt: 'asc' }, select: { episodeStart: true, subjectWorkerId: true } });
    expect(rows).toEqual([{ episodeStart: at('10:00'), subjectWorkerId: anne }, { episodeStart: at('11:05'), subjectWorkerId: liam }]);
  });

  it('another RULE on the same task is decided even though the task has an alarm of a different type', async () => {
    const t = await pending('10:00');
    await decisions(at('10:15')); // not-started raised
    await db.agentTask.update({ where: { id: t.id }, data: { status: 'started', startedAt: at('10:20') } });
    await db.session.create({ data: { id: generateId(), appId, workerId: anne, startedAt: at('10:20'), updatedAt: at('10:20') } });
    expect(await decisions(at('11:21'))).toEqual({ raised: 1, transactions: 1 });
    expect((await db.agentTeamEvent.findMany({ where: { taskId: t.id }, select: { type: true }, orderBy: { type: 'asc' } })).map((e) => e.type)).toEqual(['stall.no-progress', 'stall.not-started']);
  });

  it('an episode that ended and began again with the same start is the same key: still one alarm, never two', async () => {
    const t = await pending('10:00');
    await decisions(at('10:15'));
    // Same assignment instant restated (a no-op edit): the key is unchanged.
    await db.agentTask.update({ where: { id: t.id }, data: { assignedAt: at('10:00') } });
    expect(await decisions(at('10:40'))).toEqual({ raised: 0, transactions: 0 });
    expect(await db.agentTeamEvent.count({ where: { taskId: t.id } })).toBe(1);
  });

  it('scale: with twelve alarms already raised, a settled pass opens no raising transaction (the cost does not follow the alarm count)', async () => {
    for (let i = 0; i < 12; i++) await pending('10:00', i % 2 ? anne : liam);
    expect(await decisions(at('10:15'))).toEqual({ raised: 12, transactions: 12 });
    expect(await decisions(at('10:16'))).toEqual({ raised: 0, transactions: 0 });
  });

  it('a whole tick (the tick itself) on a settled App reads, and writes, no new alarm', async () => {
    await pending('10:00');
    await taskStallTick(db, at('10:15'));
    const before = await db.agentTeamEvent.count();
    await taskStallTick(db, at('10:16'));
    expect(await db.agentTeamEvent.count()).toBe(before);
  });
});

describe('#4273 — the liveness aggregate runs with JIT off, locally to its transaction', () => {
  it('a read on the shared client turns JIT off inside its own transaction and leaks nothing to the pool', async () => {
    const { loadWorkersActivity } = await import('../../api/graphql/schema/resolvers.worker.js');
    const spy = vi.spyOn(db, '$transaction');
    try {
      await loadWorkersActivity({ db } as unknown as Context, [anne], at('10:00'));
      expect(spy).toHaveBeenCalledTimes(1);
    } finally {
      spy.mockRestore();
    }
    const [{ jit }] = await db.$queryRaw<{ jit: string }[]>`SELECT current_setting('jit') AS jit`;
    expect(jit).toBe('on');
  });

  it('inside a caller\'s transaction it sets the flag for that transaction and opens no nested one', async () => {
    const { loadWorkersActivity } = await import('../../api/graphql/schema/resolvers.worker.js');
    await db.$transaction(async (tx) => {
      await loadWorkersActivity({ db: tx } as unknown as Context, [anne], at('10:00'));
      const [{ jit }] = await tx.$queryRaw<{ jit: string }[]>`SELECT current_setting('jit') AS jit`;
      expect(jit).toBe('off');
    });
  });
});

describe('#4273 — known limit: a pass that raises N new alarms is linear in N, with a bounded cost per raise', () => {
  it('each raise is one re-decision in its own transaction: at most 40 statements, however many tasks and alarms exist', async () => {
    // A first pass after downtime raises every due episode, one Serializable re-decision each (the stop fence is why raises are
    // not batched). Pinned: the statements per raise stay bounded (about 20 on the #4271 seed), so N raises cost ~N x 10 ms.
    for (let i = 0; i < 20; i++) await pending('10:00', i % 2 ? anne : liam);
    const logged = new PrismaClient({ datasourceUrl: process.env.DATABASE_URL, log: [{ emit: 'event', level: 'query' }] });
    let statements = 0;
    (logged as any).$on('query', () => { statements++; });
    try {
      const raised = (await evaluateStalls(logged as any, at('10:15'))).length;
      expect(raised).toBe(20);
      // The page's own reads are a constant (not per raise); allow 30 of them.
      expect(statements).toBeLessThanOrEqual(20 * 40 + 30);
    } finally {
      await logged.$disconnect();
    }
  });
});
