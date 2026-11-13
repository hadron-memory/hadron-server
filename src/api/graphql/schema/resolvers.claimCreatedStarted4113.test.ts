/**
 * #4113 (hrn:node:hadronmemory.com:specs:cor:agt:050:02, cor:agt:120): a create that names an `externalId` AND whose
 * assignee is the caller is the claim, so the task is born STARTED in the one call: `startedAt` set, the events
 * `startAgentTask` writes, no not-started alarm (050:14), never matched. Every other create keeps today's statuses.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { resolvers, type Context } from './resolvers.js';
import { taskStallTick } from '../../../jobs/taskStallEvaluator.js';
import { taskMatcherTick } from '../../../jobs/taskMatcher.js';
vi.mock('../../../integrations/github/writeNodeToGit.js', () => ({ writeNodeToGit: vi.fn().mockResolvedValue(undefined) }));

const M = resolvers.Mutation as any;
let org: any, app: any, me: any, other: any;
const ctx = (userId: string = me.id): Context => ({ db, userId, roles: ['READER'] });
const X = 'https://github.com/hadron-memory/hadron-server/issues/4113';
const create = (input: Record<string, unknown>, userId: string = me.id) =>
  M.createAgentTask({}, { input: { appRef: app.id, title: 'T', ...input } }, ctx(userId));
const row = (id: string) => db.agentTask.findUniqueOrThrow({ where: { id } });
const events = async (taskId: string) => (await db.agentTeamEvent.findMany({ where: { taskId }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] })).map((e) => e.type);

beforeEach(async () => {
  await cleanDb(db);
  org = await db.organization.create({ data: { name: 'Claim', urn: `claim-${generateId()}.test` } });
  [me, other] = await Promise.all(['me', 'other'].map((h) => db.user.create({ data: { handle: `claim4113-${h}` } })));
  app = await db.app.create({ data: { organizationId: org.id, name: 'Claim', urn: `${org.urn}:claim` } });
  for (const u of [me, other]) await db.appMember.create({ data: { appId: app.id, userId: u.id, role: 'member' } });
});

describe('#4113 a caller-own claim is created STARTED', () => {
  it('externalId + the caller as assignee: STARTED with startedAt, in one call', async () => {
    const t = await create({ externalId: X, assignee: { user: me.id } });
    const r = await row(t.id);
    expect(r.status).toBe('started');
    expect(r.startedAt).toBeInstanceOf(Date);
    expect(r.externalId).toBe(X);
    expect(r.assigneeUserId).toBe(me.id);
    expect(t.status).toBe('started');
  });

  it('writes the events startAgentTask writes, in order, with the same task.started shape', async () => {
    const claim = await create({ externalId: X, assignee: { user: me.id } });
    expect(await events(claim.id)).toEqual(['task.created', 'task.assigned', 'task.started']);
    // The reference shape: create then start, as the CLI does today.
    const manual = await create({ assignee: { user: me.id } });
    await M.startAgentTask({}, { taskId: manual.id }, ctx());
    expect(await events(manual.id)).toEqual(['task.created', 'task.assigned', 'task.started']);
    const shape = async (id: string) => {
      const e = await db.agentTeamEvent.findFirstOrThrow({ where: { taskId: id, type: 'task.started' } });
      const { taskId: _t, id: _i, createdAt: _c, ...rest } = e as any;
      return rest;
    };
    expect(await shape(claim.id)).toEqual(await shape(manual.id));
  });

  it('a claim for ANOTHER assignee stays PENDING (cor:agt:050:08)', async () => {
    const t = await create({ externalId: X, assignee: { user: other.id } });
    const r = await row(t.id);
    expect(r.status).toBe('pending');
    expect(r.startedAt).toBeNull();
    expect(await events(t.id)).toEqual(['task.created', 'task.assigned']);
  });

  it('a create with no externalId behaves as today: the caller as assignee stays PENDING', async () => {
    const t = await create({ assignee: { user: me.id } });
    expect((await row(t.id)).status).toBe('pending');
  });

  it('a claim with no assignee stays PENDING and queued; a backlog claim still refuses an assignee', async () => {
    const t = await create({ externalId: X });
    expect((await row(t.id)).status).toBe('pending');
    expect(await events(t.id)).toEqual(['task.created', 'assignment.queued']);
    await expect(create({ externalId: 'https://x/2', status: 'BACKLOG', assignee: { user: me.id } }))
      .rejects.toMatchObject({ extensions: { code: 'BAD_USER_INPUT' } });
  });

  it('a claim naming open blockers is not started (startAgentTask refuses a blocked task)', async () => {
    const blocker = await create({});
    const t = await create({ externalId: X, assignee: { user: me.id }, blockedBy: [blocker.id] });
    const r = await row(t.id);
    expect(r.blocked).toBe(true);
    expect(r.status).toBe('pending');
  });

  it('externalId is bounded as the intake query bounds it: 512 units pass, 513 refuse that create alone', async () => {
    const ok = `https://x/${'a'.repeat(512 - 'https://x/'.length)}`;
    expect((await row((await create({ externalId: ok, assignee: { user: me.id } })).id)).status).toBe('started');
    const before = await db.agentTask.count({ where: { appId: app.id } });
    await expect(create({ externalId: ok + 'b', assignee: { user: me.id } })).rejects.toMatchObject({ extensions: { code: 'BAD_USER_INPUT' } });
    expect(await db.agentTask.count({ where: { appId: app.id } })).toBe(before);
  });

  it('a second claim of the same item is refused TASK_EXTERNAL_ID_TAKEN and leaves the first STARTED', async () => {
    const first = await create({ externalId: X, assignee: { user: me.id } });
    await expect(create({ externalId: X, assignee: { user: me.id } })).rejects.toMatchObject({ extensions: { code: 'TASK_EXTERNAL_ID_TAKEN' } });
    expect((await row(first.id)).status).toBe('started');
  });
});

describe('#4113 a claim-born STARTED task is not queued, matched or alarmed', () => {
  it('the matcher leaves it alone and the stall evaluator raises no not-started alarm', async () => {
    const t = await create({ externalId: X, assignee: { user: me.id } });
    // 20 min: past the not-started window (15 min, 050:14), before no-progress (60 min), so only the former could fire.
    const later = new Date(Date.now() + 20 * 60 * 1000);
    await taskMatcherTick(db, later);
    const stall = await taskStallTick(db, later);
    const r = await row(t.id);
    expect(r.status).toBe('started');
    expect(r.assigneeUserId).toBe(me.id);
    const kinds = (await db.agentTeamEvent.findMany({ where: { taskId: t.id } })).map((e) => e.type);
    expect(kinds).not.toContain('assignment.queued');
    expect(kinds).not.toContain('stall.not-started');
    expect(stall.raised).toBe(0);
  });

  it('control: the same horizon DOES raise the not-started alarm for a pending assigned task', async () => {
    const t = await create({ assignee: { user: me.id } });
    await taskStallTick(db, new Date(Date.now() + 20 * 60 * 1000));
    expect((await db.agentTeamEvent.findMany({ where: { taskId: t.id } })).map((e) => e.type)).toContain('stall.not-started');
  });
});

// Andi's P2 (#4115 LOCAL): the claim starts only after every blocker link of its batch has landed, so a forward or a
// backward blockedByPositions link on a caller-own claim neither refuses the batch nor starts a blocked task.
describe('#4113 a claim inside createAgentTasks', () => {
  const INFO = { path: { key: 'createAgentTasks', prev: undefined, typename: 'Mutation' } };
  const batch = (tasks: unknown[]) => M.createAgentTasks(null, { appRef: app.id, tasks }, ctx(), INFO);
  const mine = (extra: Record<string, unknown> = {}) => ({ title: 'claim', externalId: X, assignee: { user: me.id }, ...extra });

  it('an unblocked claim in a batch is STARTED', async () => {
    const out = await batch([{ task: mine() }, { task: { title: 'plain' } }]);
    expect((await row(out[0].id)).status).toBe('started');
    expect((await row(out[1].id)).status).toBe('pending');
  });

  it.each([
    ['forward', () => [{ task: mine(), blockedByPositions: [2] }, { task: { title: 'blocker' } }], 0],
    ['backward', () => [{ task: { title: 'blocker' } }, { task: mine(), blockedByPositions: [1] }], 1],
  ] as const)('a claim with a %s blockedByPositions link does not refuse the batch and stays PENDING, blocked', async (_n, tasks, at) => {
    const out = await batch(tasks());
    const r = await row(out[at].id);
    expect(r.status).toBe('pending');
    expect(r.blocked).toBe(true);
    expect(r.startedAt).toBeNull();
  });
});
