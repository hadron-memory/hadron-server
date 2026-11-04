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
  it.each(['app.team.v2', 'app.team.2x', 'app.team.a.b2', 'app.team.a--b'])('persists legal code %s through the database CHECK', async code => {
    const result = await record({ code });
    expect((await db.agentTeamEvent.findUniqueOrThrow({ where: { id: result.eventId } })).type).toBe(code);
  });
  it('records for an App slug containing digits and repeated hyphens', async () => {
    const app = await db.app.findUniqueOrThrow({ where: { id: appId } });
    await db.app.update({ where: { id: appId }, data: { urn: app.urn.replace(/:team$/, ':app2--team') } });
    const result = await record({ code: 'app.app2--team.v2' });
    expect((await db.agentTeamEvent.findUniqueOrThrow({ where: { id: result.eventId } })).type).toBe('app.app2--team.v2');
  });
  it.each([{ x: '\0' }, { nested: [{ x: '\0' }] }, { ['bad\0key']: true }])('refuses PostgreSQL-incompatible NUL in payload %# before insertion', async payload => {
    await refused({ payload }, 'BAD_USER_INPUT');
  });
  it('preserves a literal backslash-u0000 string as ordinary JSON data', async () => {
    const payload = { x: String.raw`\u0000` };
    const result = await record({ payload });
    expect((await db.agentTeamEvent.findUniqueOrThrow({ where: { id: result.eventId } })).payload).toEqual({ payload });
  });
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
    await refused({}, 'APP_NOT_FOUND', { ...ctx(), impersonation: true } as unknown as Context);
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
    for (const prefix of ['app.%', 'app._', 'app.\\']) expect(await Q.agentTeamEvents({}, { appRef: appId, codePrefix: prefix }, ctx())).toEqual([]);
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

describe('register and App-wide access', () => {
  it('maps a worker through its own Agent and keeps the task loc when unresolved', async () => {
    const app = await db.app.findUniqueOrThrow({ where: { id: appId } });
    const team = await M.createAgent({}, { orgId: app.organizationId, name: 'Team Agent' }, ctx());
    const coder = await M.createAgent({}, { orgId: app.organizationId, name: 'Coder' }, ctx());
    const teamRow = await db.agent.findUniqueOrThrow({ where: { id: team.id } });
    const coderRow = await db.agent.findUniqueOrThrow({ where: { id: coder.id } });
    await db.appAgent.create({ data: { appId, agentId: team.id } });
    await db.node.create({ data: { id: generateId(), memoryId: teamRow.systemMemoryId!, loc: 'roles', name: 'Roles' } });
    const worker = await db.worker.create({ data: { ...WORKER_SIGNATURE_DEFAULTS, id: generateId(), appId, agentId: coder.id, name: 'Coder', slug: 'coder' } });
    const asCoder = (fn: () => Promise<any>) => runAsActor({ workerId: worker.id, agentId: coder.id }, fn);
    expect((await asCoder(() => record())).action.state).toBe('UNMAPPED');
    const entry = await db.node.create({ data: { id: generateId(), memoryId: teamRow.systemMemoryId!, loc: 'register:app.team.design.approved', name: 'Action', data: { registerEntry: { code: 'app.team.design.approved', taskLoc: 'tasks:approve' } } } });
    expect((await asCoder(() => record())).action).toMatchObject({ state: 'UNRESOLVED', taskLoc: 'tasks:approve', taskUrn: null });
    await db.node.create({ data: { id: generateId(), memoryId: teamRow.systemMemoryId!, loc: 'tasks:approve', name: 'Team approve', isRunnable: true } });
    const person = (await record()).action;
    expect(person.state).toBe('MAPPED');
    expect(person.taskUrn).toBe('hrn:node:' + (await db.memory.findUniqueOrThrow({ where: { id: teamRow.systemMemoryId! } })).urn + ':tasks:approve');
    expect((await asCoder(() => record())).action.state).toBe('UNRESOLVED');
    await db.node.create({ data: { id: generateId(), memoryId: coderRow.systemMemoryId!, loc: 'tasks:approve', name: 'Approve', isRunnable: true } });
    const attributed = await asCoder(() => record());
    expect(await db.agentTeamEvent.findUnique({ where: { id: attributed.eventId } })).toMatchObject({ actorUserId: userId, actorWorkerId: worker.id, actorAgentId: coder.id });
    const mapped = attributed.action;
    expect(mapped).toMatchObject({ code: 'app.team.design.approved', state: 'MAPPED', taskLoc: 'tasks:approve' });
    expect(mapped.taskUrn).toContain(':tasks:approve');
    const foreignOrg = await db.organization.create({ data: { id: generateId(), name: 'Foreign', urn: 'foreign-' + generateId().toLowerCase() } });
    await db.orgMember.create({ data: { organizationId: foreignOrg.id, userId: outsiderId, role: 'ADMIN' } });
    const hidden = await M.createAgent({}, { orgId: foreignOrg.id, name: 'Hidden base' }, ctx(outsiderId));
    await db.agent.update({ where: { id: coder.id }, data: { extendsAgentId: hidden.id } });
    const withheld = await asCoder(() => record());
    expect(withheld.action).toEqual({ code: 'app.team.design.approved', state: 'WITHHELD', taskLoc: null, taskUrn: null });
    expect(await db.agentTeamEvent.findUnique({ where: { id: withheld.eventId } })).not.toBeNull();
    await db.agent.update({ where: { id: coder.id }, data: { extendsAgentId: null } });

    await db.node.update({ where: { id: entry.id }, data: { data: { registerEntry: { code: 'wrong', taskLoc: 'tasks:approve' } } } });
    expect((await asCoder(() => record())).action.state).toBe('UNMAPPED');
  });
  it('an App participant and own key see actions regardless of task, another key never does', async () => {
    await db.appMember.create({ data: { appId, userId: outsiderId, role: 'member' } });
    const key = await db.appKey.create({ data: { id: generateId(), appId, keyHash: generateId(), keyPreview: 'test' } });
    const keyCtx = { db, appId, appKeyId: key.id, roles: [] } as Context;
    const task = await M.createAgentTask({}, { input: { appRef: appId, title: 'Action task' } }, ctx());
    const a = await record(), b = await record({ taskRef: task.id });
    for (const c of [ctx(outsiderId), keyCtx]) {
      const rows = await Q.agentTeamEvents({}, { appRef: appId, codePrefix: 'app.team.' }, c);
      expect(rows.map((r: any) => r.id)).toEqual([a.eventId, b.eventId]);
    }
    await refused({}, 'APP_NOT_FOUND', keyCtx);
    await expect(Q.agentTeamEvents({}, { appRef: foreignAppId, codePrefix: 'app.' }, keyCtx)).rejects.toMatchObject({ extensions: { code: 'APP_NOT_FOUND' } });
    await db.agentTeamEvent.create({ data: { appId, type: 'app.manager-act', payload: {} } });
    expect((await Q.agentTeamEvents({}, { appRef: appId, codePrefix: 'app.' }, ctx())).length).toBe(3);
    expect((await Q.agentTeamEvents({}, { appRef: appId, codePrefix: 'app.team.' }, ctx())).length).toBe(2);
  });
});

describe('write-time authority and current slug', () => {
  it('rechecks a committed membership revocation after the outer gate', async () => {
    let intercepted = false;
    const proxied = new Proxy(db, { get(target, prop, receiver) {
      if (prop === '$transaction') return async (...args: any[]) => {
        if (!intercepted) { intercepted = true; await db.orgMember.deleteMany({ where: { userId } }); }
        return (target.$transaction as any)(...args);
      };
      const value = Reflect.get(target, prop, receiver);
      return typeof value === 'function' ? value.bind(target) : value;
    } });
    await refused({}, 'APP_NOT_FOUND', { ...ctx(), db: proxied });
    expect(intercepted).toBe(true);
  });
  it('rechecks the slug after a committed rename in the pre-transaction window', async () => {
    let intercepted = false;
    const proxied = new Proxy(db, { get(target, prop, receiver) {
      if (prop === '$transaction') return async (...args: any[]) => {
        if (!intercepted) {
          intercepted = true;
          const a = await db.app.findUniqueOrThrow({ where: { id: appId } });
          await db.app.update({ where: { id: appId }, data: { urn: a.urn.replace(/:team$/, ':renamed') } });
        }
        return (target.$transaction as any)(...args);
      };
      const value = Reflect.get(target, prop, receiver);
      return typeof value === 'function' ? value.bind(target) : value;
    } });
    await refused({}, 'APP_ACTION_CODE_INVALID', { ...ctx(), db: proxied });
    expect(intercepted).toBe(true);
  });
});
