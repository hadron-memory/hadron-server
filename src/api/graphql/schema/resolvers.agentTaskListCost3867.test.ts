/**
 * #3867: the per-task field resolvers a wide `agentTasks` page selects (the `--team` view reads the whole App) cost a
 * fixed number of statements, not several per row. Pins the count, the unchanged answers, and the unscoped refusal.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { WORKER_SIGNATURE_DEFAULTS } from '../../../lib/workerSignature.js';
import { resolvers, type Context } from './resolvers.js';

const Q = resolvers.Query as any;
const F = resolvers as any;
let appId: string, ownerId: string, outsiderId: string, workerId: string, agentId: string;

function counted(userId: string): { ctx: Context; count: () => number } {
  let n = 0;
  const bump = async ({ args, query }: any) => { n++; return query(args); };
  const spy = db.$extends({ query: { $allOperations: bump, $queryRaw: bump, $queryRawUnsafe: bump } as any });
  return { ctx: { db: spy as any, userId, roles: ['READER'] }, count: () => n };
}

async function seed() {
  await cleanDb(db);
  ownerId = (await db.user.create({ data: { id: generateId(), name: 'Owner', handle: 'syntheticowner' } })).id;
  outsiderId = (await db.user.create({ data: { id: generateId(), name: 'Outsider', handle: 'syntheticoutsider' } })).id;
  appId = (await db.app.create({ data: { id: generateId(), ownerUserId: ownerId, name: 'Synthetic', urn: 'syntheticowner:app' } })).id;
  agentId = (await db.agent.create({ data: { id: generateId(), ownerUserId: ownerId, name: 'Synthetic', urn: 'syntheticowner:agent' } })).id;
  workerId = (await db.worker.create({ data: { ...WORKER_SIGNATURE_DEFAULTS, id: generateId(), appId, agentId, name: 'Rook', slug: 'rook' } })).id;
}

/** n finished tasks owned by the user, assigned and created by the worker, each carrying findings. */
async function finished(n: number) {
  const now = new Date();
  for (let i = 0; i < n; i++) {
    await db.agentTask.create({
      data: {
        appId, title: `t${i}`, ownerUserId: ownerId, assigneeWorkerId: workerId, assignedAt: now, createdByWorkerId: workerId,
        status: 'finished', startedAt: now, finishedAt: now, resultOutcome: 'succeeded', resultSummary: `s${i}`, resultEvidence: `e${i}`,
        resultFindings: [{ id: `f${i}`, text: 'finding' }] as any,
      },
    });
  }
}

/** n started parents; the first `open` have an open child, the rest only a finished one. */
async function parents(n: number, open: number) {
  const now = new Date();
  for (let i = 0; i < n; i++) {
    const base = { appId, ownerUserId: ownerId, assigneeWorkerId: workerId, assignedAt: now, createdByWorkerId: workerId, startedAt: now };
    const parent = await db.agentTask.create({ data: { ...base, title: `p${i}`, status: 'started' } });
    const child = i < open
      ? { ...base, title: `c${i}`, status: 'started', parentTaskId: parent.id }
      : { ...base, title: `c${i}`, status: 'finished', finishedAt: now, resultOutcome: 'succeeded', resultSummary: 's', resultEvidence: 'e', parentTaskId: parent.id };
    await db.agentTask.create({ data: child as any });
  }
}

/** The list page and every per-row field resolver the CLI's task fragment selects, started in one pass like GraphQL does. */
async function wide(ctx: Context) {
  const rows: any[] = await Q.agentTasks(null, { appRef: appId, limit: 200 }, ctx);
  const out = await Promise.all(rows.map(async (t) => ({
    id: t.id,
    owner: await F.AgentTask.owner(t, {}, ctx),
    assignee: await F.AgentTask.assignee(t, {}, ctx),
    createdBy: await F.AgentTask.createdBy(t, {}, ctx),
    assignedBy: await F.AgentTask.assignedBy(t, {}, ctx),
    waiting: await F.AgentTask.waitingOnChildren(t, {}, ctx),
    result: await F.AgentTask.result(t, {}, ctx),
    blockedBy: await F.AgentTask.blockedBy(t, { limit: 20 }, ctx),
  })));
  return { rows, out };
}

beforeEach(seed);

describe('#3867 list cost', () => {
  it('issues a number of statements that does not depend on how many finished tasks are listed', async () => {
    await finished(3);
    const a = counted(ownerId);
    const small = await wide(a.ctx);
    const nSmall = a.count();
    await finished(25);
    const b = counted(ownerId);
    const large = await wide(b.ctx);
    expect(small.out).toHaveLength(3);
    expect(large.out).toHaveLength(28);
    expect(b.count()).toBe(nSmall);
    expect(b.count()).toBeLessThanOrEqual(30);
  }, 60000);

  it('keeps every answer: parties, result fields, and findings loaded on demand under the read gate', async () => {
    await finished(2);
    const { ctx } = counted(ownerId);
    const { out, rows } = await wide(ctx);
    for (const o of out) {
      expect(o.owner).toMatchObject({ kind: 'USER', name: 'syntheticowner' });
      expect(o.assignee).toMatchObject({ kind: 'WORKER', id: workerId, name: 'Rook' });
      expect(o.createdBy).toMatchObject({ kind: 'WORKER', id: workerId });
      expect(o.assignedBy).toBeNull();
      expect(o.waiting).toBe(false);
      expect(o.result).toMatchObject({ outcome: 'succeeded' });
      expect(o.result.summary).toMatch(/^s\d$/);
    }
    const first = out.find((o) => o.id === rows[0].id)!;
    const page = await F.AgentTaskResult.findings(first.result, { limit: 10 });
    expect(page.total).toBe(1);
    expect(page.items[0].text).toBe('finding');
  });

  it('refuses an unscoped caller the whole page and every field', async () => {
    await finished(2);
    const { ctx } = counted(outsiderId);
    await expect(Q.agentTasks(null, { appRef: appId, limit: 200 }, ctx)).rejects.toThrow();
    // A wide row handed to an unscoped caller by some other path reads as no result: the batched recheck keeps the gate.
    const row = await db.agentTask.findFirstOrThrow({ where: { appId }, omit: { resultFindings: true } });
    expect(await F.AgentTask.result(row, {}, ctx)).toBeNull();
    const owner = counted(ownerId).ctx;
    const result = await F.AgentTask.result(row, {}, owner);
    expect((await F.AgentTaskResult.findings(result, { limit: 10 })).total).toBe(1);
  });

  it('answers waitingOnChildren from one batched open-child query, whatever the page size', async () => {
    await parents(2, 1);
    const a = counted(ownerId);
    const small = await wide(a.ctx);
    const nSmall = a.count();
    const waiting = (r: { rows: any[]; out: any[] }) => new Map(r.rows.map((row, i) => [row.title, r.out[i].waiting]));
    expect(waiting(small).get('p0')).toBe(true);
    expect(waiting(small).get('p1')).toBe(false);
    await parents(10, 4); // adds 4 more open-child parents and 6 with only a finished child
    const b = counted(ownerId);
    const large = await wide(b.ctx);
    expect(large.out.filter((o) => o.waiting)).toHaveLength(5);
    expect(b.count()).toBe(nSmall);
  }, 60000);
});
