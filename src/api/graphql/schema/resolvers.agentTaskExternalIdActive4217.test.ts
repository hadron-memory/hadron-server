/**
 * #4217 (hrn:node:hadronmemory.com:specs:cor:agt:120:02, Holger's amendment of 2026-11-14): an external id is held by
 * at most ONE ACTIVE task per App (backlog, pending or started). A finished or cancelled task keeps its external id but no
 * longer blocks a new claim, so an item can have a history of tasks. Reopening is refused for good (cor:agt:050:02) and the
 * id is set only at create, so create is the only write that can meet the index. Readers may now get several tasks per id.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { resolvers, type Context } from './resolvers.js';
vi.mock('../../../integrations/github/writeNodeToGit.js', () => ({ writeNodeToGit: vi.fn().mockResolvedValue(undefined) }));

const M = resolvers.Mutation as any;
const Q = resolvers.Query as any;
let app: any, other: any, owner: any, member: any;
const ctx = (userId: string = owner.id): Context => ({ db, userId, roles: ['READER'] });
const X = 'https://github.com/hadron-memory/hadron-server/issues/4217';
const Y = 'https://github.com/hadron-memory/hadron-server/issues/4218';

const create = (input: Record<string, unknown>, userId: string = owner.id, appRef: string = app.id) =>
  M.createAgentTask({}, { input: { appRef, title: 'T', ...input } }, ctx(userId));
const list = (args: Record<string, unknown>, userId: string = owner.id) => Q.agentTasks(null, { appRef: app.id, ...args }, ctx(userId));
const finish = (id: string) => db.agentTask.update({
  where: { id }, data: { status: 'finished', startedAt: new Date(), finishedAt: new Date(), resultOutcome: 'done', assigneeUserId: owner.id, assignedAt: new Date() } as any });
const cancel = (id: string) => db.agentTask.update({ where: { id }, data: { status: 'cancelled', cancelledAt: new Date() } as any });

beforeEach(async () => {
  await cleanDb(db);
  const org = await db.organization.create({ data: { name: 'Ext4217', urn: `ext4217-${generateId()}.test` } });
  [owner, member] = await Promise.all(['owner', 'member'].map(h => db.user.create({ data: { handle: `ext4217-${h}` } })));
  app = await db.app.create({ data: { organizationId: org.id, name: 'Ext4217', urn: `${org.urn}:a` } });
  other = await db.app.create({ data: { organizationId: org.id, name: 'Other', urn: `${org.urn}:b` } });
  for (const u of [owner, member]) await db.appMember.create({ data: { appId: app.id, userId: u.id, role: 'member' } });
  await db.appMember.create({ data: { appId: other.id, userId: owner.id, role: 'member' } });
});

describe('an ended task no longer holds its external id (cor:agt:120:02, 2026-11-14)', () => {
  it('a finished holder, then a successful second create; the first task keeps its id', async () => {
    const first = await create({ externalId: X });
    await finish(first.id);
    const second = await create({ title: 'second', externalId: X }, member.id);
    expect(second.externalId).toBe(X);
    expect((await db.agentTask.findUniqueOrThrow({ where: { id: first.id } }) as any).externalId).toBe(X);
    expect(await db.agentTask.count({ where: { appId: app.id, externalId: X } as any })).toBe(2);
  });

  it('a cancelled holder, then a successful second create', async () => {
    const first = await create({ externalId: X });
    await cancel(first.id);
    const second = await create({ title: 'second', externalId: X });
    expect(second.externalId).toBe(X);
  });

  it('a history of several ended tasks does not block either, and the newest is then the one holder', async () => {
    for (let i = 0; i < 3; i++) { const t = await create({ externalId: X }); await (i % 2 ? cancel(t.id) : finish(t.id)); }
    const live = await create({ title: 'live', externalId: X });
    expect(live.status).toBe('pending');
    const err = await create({ title: 'again', externalId: X }, member.id).catch((e: any) => e);
    expect(err?.extensions?.code).toBe('TASK_EXTERNAL_ID_TAKEN');
  });

  for (const [state, data] of [
    ['pending', {}],
    ['backlog', { status: 'backlog' }],
    ['started', { status: 'started', startedAt: new Date(), assigneeUserId: 'OWNER', assignedAt: new Date() }],
  ] as Array<[string, Record<string, unknown>]>) {
    it(`an ACTIVE holder (${state}) still refuses, naming no task, and consumes no handle`, async () => {
      const first = await create({ externalId: X });
      if (Object.keys(data).length) await db.agentTask.update({ where: { id: first.id }, data: { ...data, ...(data.assigneeUserId ? { assigneeUserId: owner.id } : {}) } as any });
      const before = await db.agentTask.count({ where: { appId: app.id } });
      const err = await create({ title: 'second', externalId: X }, member.id).catch((e: any) => e);
      expect(err?.extensions?.code).toBe('TASK_EXTERNAL_ID_TAKEN');
      const text = JSON.stringify({ m: err?.message, e: err?.extensions });
      for (const secret of [first.id, first.handle, X]) expect(text).not.toContain(secret);
      expect(await db.agentTask.count({ where: { appId: app.id } })).toBe(before);
    });
  }

  it('after a finished holder, two concurrent creates: exactly one wins, the other is TASK_EXTERNAL_ID_TAKEN', async () => {
    await finish((await create({ externalId: X })).id);
    const results = await Promise.allSettled([create({ title: 'a', externalId: X }), create({ title: 'b', externalId: X }, member.id)]);
    expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1);
    const failed = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
    expect(failed.map(r => r.reason?.extensions?.code)).toEqual(['TASK_EXTERNAL_ID_TAKEN']);
    expect(await db.agentTask.count({ where: { appId: app.id, externalId: X, status: 'pending' } as any })).toBe(1);
  });

  it('another App is unaffected, with or without history here', async () => {
    await finish((await create({ externalId: X })).id);
    const there = await create({ title: 'there', externalId: X }, owner.id, other.id);
    expect(there.externalId).toBe(X);
  });

  it('the database holds the rule on ACTIVE rows only: ended + ended and ended + active coexist, two active do not', async () => {
    const a = await create({}); const b = await create({}); const c = await create({}); const d = await create({});
    const set = (id: string) => db.$executeRawUnsafe('UPDATE agent_tasks SET external_id = $1 WHERE id = $2', X, id);
    await finish(a.id); await cancel(b.id);
    await set(a.id); await set(b.id);            // ended + ended
    await set(c.id);                              // ended + ended + active
    await expect(set(d.id)).rejects.toThrow(/23505[\s\S]*\(app_id, external_id\)/);   // a second active
  });

  it('the index predicate names exactly the three active statuses', async () => {
    const rows = await db.$queryRawUnsafe<{ indexdef: string }[]>(`SELECT indexdef FROM pg_indexes WHERE indexname = 'agent_tasks_app_external_id_uniq'`);
    expect(rows).toHaveLength(1);
    expect(rows[0].indexdef).toMatch(/UNIQUE/);
    expect(rows[0].indexdef).toMatch(/backlog/);
    expect(rows[0].indexdef).toMatch(/pending/);
    expect(rows[0].indexdef).toMatch(/started/);
    expect(rows[0].indexdef).not.toMatch(/finished|cancelled/);
  });
});

describe('no transition leaves finished or cancelled, so create is the only write that meets the index (cor:agt:050:02)', () => {
  it('a finished task and a cancelled task cannot be restarted, finished again or cancelled, and keep their status', async () => {
    const f = await create({ externalId: X }); await finish(f.id);
    const c = await create({ externalId: Y }); await cancel(c.id);
    for (const t of [f, c]) {
      for (const call of [
        () => M.startAgentTask({}, { taskId: t.id }, ctx()),
        () => M.finishAgentTask({}, { taskId: t.id, result: { outcome: 'succeeded' } }, ctx()),
        () => M.cancelAgentTask({}, { taskId: t.id }, ctx()),
      ]) await expect(call()).rejects.toBeTruthy();
    }
    expect((await db.agentTask.findUniqueOrThrow({ where: { id: f.id } })).status).toBe('finished');
    expect((await db.agentTask.findUniqueOrThrow({ where: { id: c.id } })).status).toBe('cancelled');
  });
});

describe('readers may now get several tasks per external id', () => {
  it('agentTasks(externalId:) returns every task holding the id, newest first', async () => {
    const a = await create({ externalId: X }); await finish(a.id);
    const b = await create({ title: 'b', externalId: X });
    const rows = await list({ externalId: X });
    expect(rows.map((r: any) => r.id)).toEqual([b.id, a.id]);
  });

  it('agentTasks(externalIds:) with limit omitted returns a finished AND an active holder of one id, and the other ids', async () => {
    const a = await create({ externalId: X }); await finish(a.id);
    const b = await create({ title: 'b', externalId: X });
    const y = await create({ title: 'y', externalId: Y });
    const rows = await list({ externalIds: [X, Y] });
    expect(new Set(rows.map((r: any) => r.id))).toEqual(new Set([a.id, b.id, y.id]));
    expect(rows).toHaveLength(3);
  });

  it('a batch of one id with a three-task history returns all three (the list cap is the only bound)', async () => {
    for (let i = 0; i < 2; i++) await finish((await create({ externalId: X })).id);
    await create({ title: 'live', externalId: X });
    expect(await list({ externalIds: [X] })).toHaveLength(3);
  });

  it('an explicit limit still windows the batch', async () => {
    await finish((await create({ externalId: X })).id);
    await create({ title: 'live', externalId: X });
    expect(await list({ externalIds: [X], limit: 1 })).toHaveLength(1);
  });
});
