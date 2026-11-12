/**
 * #4084 — tracker-neutral task intake reads and release (hrn:node:hadronmemory.com:specs:cor:agt:120,
 * hrn:node:hadronmemory.com:specs:cor:agt:120:02; release authority Proposed as V87). Four parts:
 *  1. `agentTasks(externalIds:)`: a bounded batch lookup inside the App read gate (cor:agt:050:21), each entry checked as
 *     the single form is; one bad entry refuses the whole list.
 *  2. `agentTaskExternalIdChanges`: the tasks with an external id that changed after an opaque cursor, covering an
 *     assignment, a reassignment, a hand-back, a cancel, a finish and a release. A release clears the id, so the change
 *     carries the RELEASED id (the FIT finding the gate made binding).
 *  3. `releaseAgentTaskExternalId`: whoever may cancel the task (cor:agt:050:09), in any status, and the assignee
 *     alone may not; nothing else changes; a task with no id refuses; one team event names the released id.
 *  4. `AgentTask.portalUrl`: the portal's task page, `/app/apps/<appId>/tasks/<taskId>`, null without FRONTEND_URL.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApolloServer } from '@apollo/server';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { runAsActor } from '../../../lib/requestActor.js';
import { WORKER_SIGNATURE_DEFAULTS } from '../../../lib/workerSignature.js';
import { formatGraphQLError } from '../formatError.js';
import { DEFAULT_OMITTED_PAGE_SIZE, OMITTED_PAGE_SIZE } from '../admissionComplexity.js';
import { TASK_EXTERNAL_IDS_MAX } from './resolvers.agentTask.js';
import { resolvers, type Context } from './resolvers.js';
import { typeDefs } from './typeDefs.js';

vi.mock('../../../integrations/github/writeNodeToGit.js', () => ({ writeNodeToGit: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../../../lib/bus/index.js', () => ({ getBusClient: vi.fn(async () => null) }));

const R = resolvers as any;
const M = R.Mutation;
const Q = R.Query;
let org: any, app: any, other: any, owner: any, assignee: any, manager: any, sibling: any, outsider: any;
let agent: any, head: any, worker: any;
const ctx = (userId: string = owner.id): Context => ({ db, userId, roles: ['READER'] }) as Context;
const code = (value: string) => ({ extensions: { code: value } });

const X = 'https://github.com/hadron-memory/hadron-server/issues/1999';
const Y = 'https://github.com/hadron-memory/hadron-server/issues/2000';
const Z = 'https://github.com/hadron-memory/hadron-server/issues/2001';

const create = (input: Record<string, unknown>, userId: string = owner.id, appRef: string = app.id) =>
  M.createAgentTask({}, { input: { appRef, title: 'T', ...input } }, ctx(userId));
const list = (args: Record<string, unknown>, userId: string = owner.id, appRef: string = app.id) =>
  Q.agentTasks(null, { appRef, ...args }, ctx(userId));
const changes = (args: Record<string, unknown> = {}, userId: string = owner.id, appRef: string = app.id) =>
  Q.agentTaskExternalIdChanges(null, { appRef, ...args }, ctx(userId));
const release = (taskId: string, c: Context = ctx()) => M.releaseAgentTaskExternalId({}, { taskId }, c);
const stored = (id: string) => db.agentTask.findUniqueOrThrow({ where: { id } });
const releaseEvents = (taskId: string) => db.agentTeamEvent.findMany({ where: { taskId, type: 'task.external-id-released' } });

async function gql(query: string, variables: Record<string, unknown>, userId: string = owner.id) {
  const api = new ApolloServer<Context>({ typeDefs, resolvers, formatError: formatGraphQLError, includeStacktraceInErrorResponses: false });
  const r = await api.executeOperation({ query, variables }, { contextValue: ctx(userId) });
  if (r.body.kind !== 'single') throw new Error('unexpected body');
  return r.body.singleResult as { data?: any; errors?: any[] };
}

beforeEach(async () => {
  await cleanDb(db);
  org = await db.organization.create({ data: { name: 'Intake', urn: `intake4084-${generateId()}.test` } });
  [owner, assignee, manager, sibling, outsider] = await Promise.all(
    ['owner', 'assignee', 'manager', 'sibling', 'outsider'].map((h) => db.user.create({ data: { handle: `intake4084-${h}` } })));
  app = await db.app.create({ data: { organizationId: org.id, name: 'Intake', urn: `${org.urn}:intake` } });
  other = await db.app.create({ data: { organizationId: org.id, name: 'Other', urn: `${org.urn}:other` } });
  for (const [u, role] of [[owner, 'member'], [assignee, 'member'], [manager, 'owner'], [sibling, 'member']] as const) {
    await db.appMember.create({ data: { appId: app.id, userId: u.id, role } });
  }
  await db.appMember.create({ data: { appId: other.id, userId: outsider.id, role: 'member' } });
  await db.appMember.create({ data: { appId: other.id, userId: owner.id, role: 'member' } });
  const memory = await db.memory.create({ data: { organizationId: org.id, name: 'System', urn: `${org.urn}:system`, class: 'system' } });
  agent = await db.agent.create({ data: { organizationId: org.id, name: 'Team', urn: `${org.urn}:team`, systemMemoryId: memory.id } });
  await db.appAgent.create({ data: { appId: app.id, agentId: agent.id } });
  head = await db.worker.create({ data: { ...WORKER_SIGNATURE_DEFAULTS, appId: app.id, agentId: agent.id, name: 'Head', slug: 'head', heldByUserId: owner.id } });
  worker = await db.worker.create({ data: { ...WORKER_SIGNATURE_DEFAULTS, appId: app.id, agentId: agent.id, name: 'Worker', slug: 'worker', heldByUserId: owner.id, reportsToWorkerId: head.id } });
});

describe('#4084 (1): agentTasks(externalIds:) — a bounded batch lookup inside the App read gate', () => {
  it('returns the tasks holding any of the ids, only in this App; an id nobody holds matches nothing', async () => {
    const a = await create({ externalId: X });
    const b = await create({ externalId: Y });
    await create({ externalId: X }, owner.id, other.id); // the same id in another App stays invisible
    await create({});
    const got = await list({ externalIds: [X, Y, Z] });
    expect(got.map((t: any) => t.id).sort()).toEqual([a.id, b.id].sort());
  });

  it('with limit omitted, every id in the list can be answered (not cut at the list default of 20)', async () => {
    const ids = Array.from({ length: 25 }, (_, i) => `https://example.com/items/${i}`);
    for (const id of ids) await create({ externalId: id });
    expect(await list({ externalIds: ids })).toHaveLength(25);
  });

  it('one bad entry refuses the whole list with BAD_USER_INPUT naming its position, never echoing it', async () => {
    await create({ externalId: X });
    // The single form's check (checkExternalIdText: 1 to 512 code points, no lone surrogate), entry by entry.
    const long = `https://example.com/${'x'.repeat(600)}`;
    for (const bad of ['', long, 'https://example.com/\ud800']) {
      const err = await list({ externalIds: [X, bad] }).catch((e: any) => e);
      expect(err).toMatchObject(code('BAD_USER_INPUT'));
      expect(err.message).toContain('externalIds[1]');
      if (bad) expect(err.message).not.toContain(bad);
    }
  });

  it('an empty list and a list over the cap are refused', async () => {
    await expect(list({ externalIds: [] })).rejects.toMatchObject(code('BAD_USER_INPUT'));
    const many = Array.from({ length: 101 }, (_, i) => `https://example.com/items/${i}`);
    await expect(list({ externalIds: many })).rejects.toMatchObject(code('BAD_USER_INPUT'));
    // 100 is accepted, and with limit omitted one page answers all of them.
    expect(await list({ externalIds: many.slice(0, 100) })).toEqual([]);
  });

  it('the no-limit batch page never exceeds what admission charges an omitted agentTasks limit', () => {
    expect(TASK_EXTERNAL_IDS_MAX).toBeLessThanOrEqual(OMITTED_PAGE_SIZE['Query.agentTasks'] ?? DEFAULT_OMITTED_PAGE_SIZE);
  });

  it('a caller who does not participate in the App gets APP_NOT_FOUND, as for any list', async () => {
    await create({ externalId: X });
    await expect(list({ externalIds: [X] }, outsider.id)).rejects.toMatchObject(code('APP_NOT_FOUND'));
  });

  it('is in the SDL', async () => {
    const t = await create({ externalId: X });
    const r = await gql('query($a:ID!,$ids:[String!]){agentTasks(appRef:$a,externalIds:$ids){id externalId}}', { a: app.id, ids: [X] });
    expect(r.errors).toBeUndefined();
    expect(r.data.agentTasks).toEqual([{ id: t.id, externalId: X }]);
  });
});

describe('#4084 (2): agentTaskExternalIdChanges — what changed on tasks with an external id', () => {
  it('reports assign, reassign, hand-back, cancel, finish and release, oldest first; a task without an id never appears', async () => {
    const a = await create({ externalId: X });
    const b = await create({ externalId: Y });
    const c = await create({ externalId: Z });
    const plain = await create({});
    await M.assignAgentTask({}, { taskId: a.id, assignee: { user: assignee.id } }, ctx());
    await M.assignAgentTask({}, { taskId: plain.id, assignee: { user: assignee.id } }, ctx());
    await M.reassignAgentTask({}, { taskId: a.id, assignee: { user: sibling.id } }, ctx());
    await M.startAgentTask({}, { taskId: a.id }, ctx(sibling.id));
    await M.handBackAgentTask({}, { taskRef: a.id, reason: { code: 'CANNOT_DO' } }, ctx(sibling.id));
    await M.assignAgentTask({}, { taskId: b.id, assignee: { user: assignee.id } }, ctx());
    await M.startAgentTask({}, { taskId: b.id }, ctx(assignee.id));
    await M.finishAgentTask({}, { taskId: b.id, result: { outcome: 'done' } }, ctx(assignee.id));
    await M.cancelAgentTask({}, { taskId: c.id }, ctx());
    await release(c.id);
    const page = await changes();
    expect(page.changes.map((ch: any) => [ch.kind, ch.externalId, ch.task.id])).toEqual([
      ['ASSIGNED', X, a.id],
      ['REASSIGNED', X, a.id],
      ['HANDED_BACK', X, a.id],
      ['ASSIGNED', Y, b.id],
      ['FINISHED', Y, b.id],
      ['CANCELLED', Z, c.id],
      ['RELEASED', Z, c.id],
    ]);
    expect(page.hasMore).toBe(false);
    expect(page.nextCursor).toBeNull();
  });

  it('a released id reaches the answer, though the task no longer holds it (the FIT finding)', async () => {
    const t = await create({ externalId: X });
    await release(t.id);
    expect((await stored(t.id)).externalId).toBeNull();
    const page = await changes();
    expect(page.changes.map((ch: any) => [ch.kind, ch.externalId, ch.task.id, ch.task.externalId])).toEqual([['RELEASED', X, t.id, null]]);
  });

  it('a change after the release carries no id and is left out; the changes before it keep the released id', async () => {
    const t = await create({ externalId: X });
    await M.assignAgentTask({}, { taskId: t.id, assignee: { user: assignee.id } }, ctx());
    // Read between the assignment and the release: the reader sees the assignment with X.
    const early = await changes();
    expect(early.changes.map((ch: any) => [ch.kind, ch.externalId])).toEqual([['ASSIGNED', X]]);
    await release(t.id);
    await M.reassignAgentTask({}, { taskId: t.id, assignee: { user: sibling.id } }, ctx());
    // Read after both: the same assignment, then the release; the later reassignment concerns no outside item.
    const late = await changes();
    expect(late.changes.map((ch: any) => [ch.kind, ch.externalId])).toEqual([['ASSIGNED', X], ['RELEASED', X]]);
    expect(late.changes[0].cursor).toBe(early.changes[0].cursor);
    expect((await changes({ after: early.changes[0].cursor })).changes.map((ch: any) => ch.kind)).toEqual(['RELEASED']);
  });

  it('pages by an opaque cursor with no repeat and no skip', async () => {
    const ids: string[] = [];
    for (const id of [X, Y, Z]) {
      const t = await create({ externalId: id });
      await M.cancelAgentTask({}, { taskId: t.id }, ctx());
      ids.push(id);
    }
    const first = await changes({ limit: 2 });
    expect(first.changes.map((ch: any) => ch.externalId)).toEqual([X, Y]);
    expect(first.hasMore).toBe(true);
    expect(first.nextCursor).toBe(first.changes[1].cursor);
    const second = await changes({ after: first.nextCursor, limit: 2 });
    expect(second.changes.map((ch: any) => ch.externalId)).toEqual([Z]);
    expect(second.hasMore).toBe(false);
    // Nothing new after the last change: an empty page, the cursor still accepted.
    expect((await changes({ after: second.changes[0].cursor })).changes).toEqual([]);
  });

  it('a cursor from another App is refused like an unknown one; a non-participant gets APP_NOT_FOUND', async () => {
    const t = await create({ externalId: X }, owner.id, other.id);
    await M.cancelAgentTask({}, { taskId: t.id }, ctx());
    const foreign = (await changes({}, owner.id, other.id)).changes[0].cursor;
    // Another App's change never appears in this App's answer, even for a reader of both Apps.
    expect((await changes()).changes).toEqual([]);
    const mine = await create({ externalId: X });
    await M.cancelAgentTask({}, { taskId: mine.id }, ctx());
    expect((await changes()).changes.map((ch: any) => ch.task.id)).toEqual([mine.id]);
    await expect(changes({ after: foreign })).rejects.toMatchObject(code('BAD_USER_INPUT'));
    await expect(changes({ after: 'nonsense' })).rejects.toMatchObject(code('BAD_USER_INPUT'));
    await expect(changes({}, outsider.id)).rejects.toMatchObject(code('APP_NOT_FOUND'));
  });

  it('is in the SDL', async () => {
    const t = await create({ externalId: X });
    await M.cancelAgentTask({}, { taskId: t.id }, ctx());
    const r = await gql(
      'query($a:ID!){agentTaskExternalIdChanges(appRef:$a,limit:5){changes{cursor at kind externalId task{id}} hasMore nextCursor}}',
      { a: app.id },
    );
    expect(r.errors).toBeUndefined();
    expect(r.data.agentTaskExternalIdChanges.changes.map((ch: any) => [ch.kind, ch.externalId, ch.task.id])).toEqual([['CANCELLED', X, t.id]]);
  });
});

describe('#4084 (3): releaseAgentTaskExternalId — V87 (Proposed): whoever may cancel the task', () => {
  it('S6: a worker the owner reports to releases a cancelled task; it stays cancelled, the id is cleared, X can be claimed again', async () => {
    const t = await runAsActor({ workerId: worker.id, agentId: agent.id }, () => create({ externalId: X }));
    expect(t.ownerWorkerId).toBe(worker.id);
    await runAsActor({ workerId: worker.id, agentId: agent.id }, () => M.cancelAgentTask({}, { taskId: t.id }, ctx()));
    const before = await stored(t.id);
    const released = await runAsActor({ workerId: head.id, agentId: agent.id }, () => release(t.id));
    expect(released).toMatchObject({ id: t.id, status: 'cancelled', externalId: null });
    // Nothing else about the task changes (the who-and-when-last-written stamps every task write sets aside).
    const after = await stored(t.id);
    const content = (row: any) => Object.fromEntries(Object.entries(row).filter(([k]) => k !== 'externalId' && !k.startsWith('updated')));
    expect(content(after)).toEqual(content(before));
    expect(before.externalId).toBe(X);
    // One team event naming the released id.
    const events = await releaseEvents(t.id);
    expect(events.map((e) => [e.payload, e.actorWorkerId])).toEqual([[{ externalId: X }, head.id]]);
    // The next create with X succeeds.
    const again = await create({ externalId: X }, sibling.id);
    expect(again.externalId).toBe(X);
  });

  it('S7: the assignee alone may not release; refused as for any task it may not change, nothing written', async () => {
    const t = await create({ externalId: X, assignee: { user: assignee.id } });
    const before = await stored(t.id);
    const err = await release(t.id, ctx(assignee.id)).catch((e: any) => e);
    expect(err).toMatchObject(code('TASK_NOT_OWNER'));
    const cancelErr = await M.cancelAgentTask({}, { taskId: t.id }, ctx(assignee.id)).catch((e: any) => e);
    expect(cancelErr).toMatchObject(code('TASK_NOT_OWNER'));
    expect(await stored(t.id)).toEqual(before);
    expect(await releaseEvents(t.id)).toEqual([]);
  });

  it('a caller who cannot read the task gets TASK_NOT_FOUND, exactly as for an absent task', async () => {
    const t = await create({ externalId: X });
    const hidden = await release(t.id, ctx(outsider.id)).catch((e: any) => e);
    const absent = await release(generateId(), ctx(outsider.id)).catch((e: any) => e);
    expect(hidden).toMatchObject(code('TASK_NOT_FOUND'));
    expect({ c: hidden.extensions.code, m: hidden.message.replace(t.id, '<id>') })
      .toEqual({ c: absent.extensions.code, m: absent.message.replace(/[0-9a-f]{32}/, '<id>') });
    expect((await stored(t.id)).externalId).toBe(X);
  });

  it('a task with no external id refuses (a second release too), and nothing changes', async () => {
    const bare = await create({});
    await expect(release(bare.id)).rejects.toMatchObject(code('TASK_EXTERNAL_ID_NONE'));
    const t = await create({ externalId: X });
    await release(t.id);
    const before = await stored(t.id);
    await expect(release(t.id)).rejects.toMatchObject(code('TASK_EXTERNAL_ID_NONE'));
    expect(await stored(t.id)).toEqual(before);
    expect(await releaseEvents(t.id)).toHaveLength(1);
    expect(await releaseEvents(bare.id)).toHaveLength(0);
  });

  it('in any status: whoever manages the App releases a finished task, which stays finished', async () => {
    const t = await create({ externalId: X, assignee: { user: assignee.id } });
    await M.startAgentTask({}, { taskId: t.id }, ctx(assignee.id));
    await M.finishAgentTask({}, { taskId: t.id, result: { outcome: 'done' } }, ctx(assignee.id));
    const released = await release(t.id, ctx(manager.id));
    expect(released).toMatchObject({ status: 'finished', externalId: null });
    // The owner may release a started one too.
    const s = await create({ externalId: Y, assignee: { user: assignee.id } });
    await M.startAgentTask({}, { taskId: s.id }, ctx(assignee.id));
    expect(await release(s.id)).toMatchObject({ status: 'started', externalId: null, assigneeUserId: assignee.id });
  });

  it('a sibling member who neither owns nor manages is refused', async () => {
    const t = await create({ externalId: X });
    await expect(release(t.id, ctx(sibling.id))).rejects.toMatchObject(code('TASK_NOT_OWNER'));
    expect((await stored(t.id)).externalId).toBe(X);
  });

  it('is in the SDL', async () => {
    const t = await create({ externalId: X });
    const r = await gql('mutation($t:ID!){releaseAgentTaskExternalId(taskId:$t){id externalId status}}', { t: t.id });
    expect(r.errors).toBeUndefined();
    expect(r.data.releaseAgentTaskExternalId).toEqual({ id: t.id, externalId: null, status: 'PENDING' });
  });
});

describe('#4084 (4): AgentTask.portalUrl — the server prints the task page link', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('the create result carries <FRONTEND_URL>/app/apps/<appId>/tasks/<taskId>', async () => {
    vi.stubEnv('FRONTEND_URL', 'https://portal.example.com/');
    const r = await gql(
      'mutation($i:CreateAgentTaskInput!){createAgentTask(input:$i){id portalUrl}}',
      { i: { appRef: app.id, title: 'link', externalId: X } },
    );
    expect(r.errors).toBeUndefined();
    const { id, portalUrl } = r.data.createAgentTask;
    expect(portalUrl).toBe(`https://portal.example.com/app/apps/${app.id}/tasks/${id}`);
  });

  it('is null when FRONTEND_URL is unset or malformed, so no client builds the link', async () => {
    const t = await create({});
    vi.stubEnv('FRONTEND_URL', '');
    expect((await gql('query($id:ID!){agentTask(id:$id){portalUrl}}', { id: t.id })).data.agentTask.portalUrl).toBeNull();
    vi.stubEnv('FRONTEND_URL', 'not a url');
    expect((await gql('query($id:ID!){agentTask(id:$id){portalUrl}}', { id: t.id })).data.agentTask.portalUrl).toBeNull();
  });
});
