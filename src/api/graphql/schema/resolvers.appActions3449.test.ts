/** #3449: App action contract, real database; the stream remains App-wide. */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { pendingTaskWakes } from '../../../lib/agentTasks/taskWakes.js';
import { WORKER_SIGNATURE_DEFAULTS } from '../../../lib/workerSignature.js';
import { runAsActor } from '../../../lib/requestActor.js';
import { resolvers, type Context } from './resolvers.js';
vi.mock('../../../integrations/github/writeNodeToGit.js', () => ({ writeNodeToGit: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../../../integrations/github/syncGraphFromGithub.js', () => ({ syncGraphFromGithub: vi.fn().mockResolvedValue({ error: null }) }));
const M = resolvers.Mutation as any, Q = resolvers.Query as any;
let userId: string, outsiderId: string, appId: string, foreignAppId: string;
const ctx = (id = userId): Context => ({ db, userId: id, roles: ['READER'] });
const record = (args: Record<string, unknown> = {}, c = ctx()) => M.recordAppAction({}, { appRef: appId, code: 'app.team.design.approved', ...args }, c);
beforeEach(async () => {
  await cleanDb(db);
  const root = 'aa-' + generateId().toLowerCase();
  const org = await db.organization.create({ data: { id: generateId(), name: 'Actions', urn: root } });
  userId = (await db.user.create({ data: { handle: 'aa-' + generateId().toLowerCase() } })).id;
  outsiderId = (await db.user.create({ data: { handle: 'ao-' + generateId().toLowerCase() } })).id;
  await db.orgMember.create({ data: { organizationId: org.id, userId, role: 'ADMIN' } });
  appId = (await db.app.create({ data: { id: generateId(), name: 'Team', organizationId: org.id, urn: root + ':team' } })).id;
  foreignAppId = (await db.app.create({ data: { id: generateId(), name: 'Other', ownerUserId: outsiderId, urn: 'aa-other:elsewhere' } })).id;
});
async function refused(args: Record<string, unknown>, code = 'APP_ACTION_CODE_INVALID', c = ctx()) {
  const before = await db.agentTeamEvent.count({ where: { appId } });
  await expect(record(args, c)).rejects.toMatchObject({ extensions: { code } });
  expect(await db.agentTeamEvent.count({ where: { appId } })).toBe(before);
}
describe('App-defined actions', () => {
  it('records the exact code, wrapper payload, actor and unmapped answer', async () => {
    const answer = await record({ payload: { approved: true } });
    expect(answer.action).toEqual({ code: 'app.team.design.approved', state: 'UNMAPPED', taskLoc: null, taskUrn: null });
    expect(await db.agentTeamEvent.findUnique({ where: { id: answer.eventId } })).toMatchObject({ appId, type: 'app.team.design.approved', payload: { payload: { approved: true } }, actorUserId: userId });
  });
  it.each(['app.other.design.approved', 'task.start', 'app.team.UPPER', 'app.team.design approved', 'app.team.', 'app.team..x', 'app.team.x-', 'app.team.' + 'x'.repeat(56)])('refuses invalid code %s with no event', async code => { await refused({ code }); });
  it('accepts a 64-character code and exactly 4KiB JSON object', async () => {
    await record({ code: 'app.team.' + 'x'.repeat(55), payload: { x: 'x'.repeat(4088) } });
  });
  it.each([null, [], 'text', 3, true, { x: 'x'.repeat(4089) }, { x: 'é'.repeat(2045) }].map(payload => [payload]))('refuses invalid payload %#', async payload => { await refused({ payload }, 'BAD_USER_INPUT'); });
  it('refuses an invalid App slug and malformed stored URN', async () => {
    await db.app.update({ where: { id: appId }, data: { urn: 'aa-root:bad_slug' } });
    await refused({});
    await db.app.update({ where: { id: appId }, data: { urn: 'not a urn' } });
    await refused({});
  });
  it('conceals unauthorized App and refuses impersonation without an event', async () => {
    await refused({}, 'APP_NOT_FOUND', ctx(outsiderId));
    await refused({}, 'FORBIDDEN', { ...ctx(), impersonation: true } as unknown as Context);
  });
  it('conceals foreign and missing task refs with the same answer', async () => {
    const task = await M.createAgentTask({}, { input: { appRef: foreignAppId, title: 'Foreign' } }, ctx(outsiderId));
    await refused({ taskRef: task.id }, 'TASK_NOT_FOUND');
    await refused({ taskRef: generateId() }, 'TASK_NOT_FOUND');
  });
  it('reads with/without a task and intersects codePrefix with exact types', async () => {
    const task = await M.createAgentTask({}, { input: { appRef: appId, title: 'Local' } }, ctx());
    const a = await record(), b = await record({ taskRef: task.id, code: 'app.team.review.ready' });
    const rows = await Q.agentTeamEvents({}, { appRef: appId, codePrefix: 'app.team.' }, ctx());
    expect(rows.map((r: any) => r.id)).toEqual([a.eventId, b.eventId]);
    expect((await Q.agentTeamEvents({}, { appRef: appId, codePrefix: 'app.team.design.', types: ['app.team.review.ready'] }, ctx())).length).toBe(0);
    await expect(Q.agentTeamEvents({}, { appRef: appId, codePrefix: 'app.' }, ctx(outsiderId))).rejects.toMatchObject({ extensions: { code: 'APP_NOT_FOUND' } });
  });
});

describe('App actions are passive', () => {
  it('keeps both assignment and child-finished wakes due after task-bound actions', async () => {
    const app = await db.app.findUniqueOrThrow({ where: { id: appId } });
    const agent = await M.createAgent({}, { orgId: app.organizationId, name: 'Action worker' }, ctx());
    const worker = await db.worker.create({ data: { ...WORKER_SIGNATURE_DEFAULTS, id: generateId(), appId, agentId: agent.id, name: 'Writer', slug: 'writer' } });
    const root = await M.createAgentTask({}, { input: { appRef: appId, title: 'Parent', owner: { worker: worker.id }, assignee: { worker: worker.id } } }, ctx());
    const actor = { workerId: worker.id, agentId: agent.id };
    const before = (await pendingTaskWakes(db, [worker.id], new Date())).get(worker.id) ?? [];
    expect(before.some(w => w.taskId === root.id && w.event === 'ASSIGNED')).toBe(true);
    await runAsActor(actor, () => record({ taskRef: root.id }));
    const assigned = (await pendingTaskWakes(db, [worker.id], new Date())).get(worker.id) ?? [];
    expect(assigned.some(w => w.taskId === root.id && w.event === 'ASSIGNED')).toBe(true);
    const child = await runAsActor(actor, () => M.createAgentTask({}, { input: { parentTaskId: root.id, title: 'Child', assignee: { user: userId } } }, ctx()));
    await M.startAgentTask({}, { taskId: child.id }, ctx());
    await M.finishAgentTask({}, { taskId: child.id, result: { outcome: 'succeeded' } }, ctx());
    const finished = (await pendingTaskWakes(db, [worker.id], new Date())).get(worker.id) ?? [];
    expect(finished.some(w => w.taskId === child.id && w.event === 'CHILD_FINISHED')).toBe(true);
    await runAsActor(actor, () => record({ taskRef: root.id }));
    expect(((await pendingTaskWakes(db, [worker.id], new Date())).get(worker.id) ?? []).some(w => w.taskId === child.id && w.event === 'CHILD_FINISHED')).toBe(true);
  });
  it('code follows the current App slug; old events keep their original code', async () => {
    const first = await record();
    const app = await db.app.findUniqueOrThrow({ where: { id: appId } });
    await db.app.update({ where: { id: appId }, data: { urn: app.urn.replace(/:team$/, ':renamed') } });
    await refused({});
    await record({ code: 'app.renamed.design.approved' });
    expect((await db.agentTeamEvent.findUniqueOrThrow({ where: { id: first.eventId } })).type).toBe('app.team.design.approved');
  });
});
