/**
 * #2249 / R182 — `closeSessionWhenDone` defaults to NO (cor:agt:050:10).
 *
 * A task ends its assignee's worker session only when whoever assigns it asks.
 * An OMITTED value on create is therefore false on every create path (GraphQL
 * for a person or a worker, a child task, the MCP tool, the run tool), the
 * column default agrees, and assign/reassign keep the stored value when they
 * name none. Rows stored before the change are NOT rewritten (Vera's FIT on the
 * issue): an explicit `true` still asks for the session end on finish/cancel.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { runAsActor } from '../../../lib/requestActor.js';
import { WORKER_SIGNATURE_DEFAULTS } from '../../../lib/workerSignature.js';
import { runContext } from '../../../jobs/appRunDeps.js';
import { hadronTaskCreate } from '../../../lib/runner/tools/index.js';
import type { RunToolContext } from '../../../lib/runner/tools/types.js';
import type { AppRun } from '../../../generated/prisma/index.js';
import type { AuthContext } from '../../../middleware/auth.js';
import { createTestableMcpServer } from '../../../mcp/server.js';
import { resolvers, type Context } from './resolvers.js';

vi.mock('../../../integrations/github/writeNodeToGit.js', () => ({
  writeNodeToGit: vi.fn().mockResolvedValue(undefined),
}));

const M = resolvers.Mutation as any;

let orgId: string;
let agentId: string;
let app: { id: string; urn: string };
let member: { id: string };
let anne: { id: string };
let liam: { id: string };

const ctx = (userId: string): Context => ({ db, userId, roles: ['READER'] });
const asWorker = <T>(w: { id: string }, fn: () => Promise<T>): Promise<T> => runAsActor({ workerId: w.id, agentId }, fn);
const create = (input: Record<string, unknown> = {}) =>
  M.createAgentTask({}, { input: { appRef: app.id, title: 'Fix the widget', ...input } }, ctx(member.id));
const stored = async (taskId: string) => (await db.agentTask.findUniqueOrThrow({ where: { id: taskId } })).closeSessionWhenDone;
const requestOf = (taskId: string) => db.taskSessionEndRequest.findUnique({ where: { taskId } });

beforeEach(async () => {
  await cleanDb(db);
  const n = Math.floor(Math.random() * 1_000_000);
  const org = await db.organization.create({ data: { id: generateId(), name: 'csd-org', urn: `csd-${n}.example` } });
  orgId = org.id;
  const admin = await db.user.create({ data: { githubId: 2_000_000 + n, githubUsername: `csd-admin-${n}`, roles: ['READER'] }, select: { id: true } });
  member = await db.user.create({ data: { githubId: 3_000_000 + n, githubUsername: `csd-member-${n}`, roles: ['READER'] }, select: { id: true } });
  await db.orgMember.create({ data: { id: generateId(), organizationId: org.id, userId: admin.id, role: 'ADMIN' } });
  agentId = (await M.createAgent({}, { orgId: org.id, name: 'Team Agent' }, ctx(admin.id))).id;
  app = await db.app.create({ data: { id: generateId(), organizationId: org.id, name: 'Team', urn: `${org.urn}:team` } });
  await db.appMember.create({ data: { appId: app.id, userId: member.id, role: 'member' } });
  anne = await db.worker.create({ data: { ...WORKER_SIGNATURE_DEFAULTS, id: generateId(), appId: app.id, agentId, name: 'Anne', slug: 'anne' }, select: { id: true } });
  liam = await db.worker.create({ data: { ...WORKER_SIGNATURE_DEFAULTS, id: generateId(), appId: app.id, agentId, name: 'Liam', slug: 'liam' }, select: { id: true } });
});

describe('create: an omitted closeSessionWhenDone is false (R182)', () => {
  it('a person caller', async () => {
    const t = await create();
    expect(t.closeSessionWhenDone).toBe(false);
    expect(await stored(t.id)).toBe(false);
  });

  it('a worker caller, and the child task it creates', async () => {
    const root: any = await asWorker(anne, () => create({ assignee: { worker: 'Anne' } }));
    expect(root.closeSessionWhenDone).toBe(false);
    await asWorker(anne, () => M.startAgentTask({}, { taskId: root.id }, ctx(member.id)));
    const child: any = await asWorker(anne, () =>
      M.createAgentTask({}, { input: { parentTaskId: root.id, title: 'Review', assignee: { worker: 'Liam' } } }, ctx(member.id)));
    expect(child.closeSessionWhenDone).toBe(false);
    expect(await stored(child.id)).toBe(false);
  });

  it('an explicit value is kept, true and false', async () => {
    expect(await stored((await create({ closeSessionWhenDone: true })).id)).toBe(true);
    expect(await stored((await create({ closeSessionWhenDone: false })).id)).toBe(false);
  });

  it('hadron_task_create over MCP', async () => {
    const auth = { userId: member.id, roles: ['READER'], clientId: `user:${member.id}` } as AuthContext;
    const mcp = createTestableMcpServer(auth, { sessionId: `csd-${generateId()}`, cachedAppResolution: { kind: 'multi-app' } });
    const plain = await db.session.create({ data: { id: generateId(), userId: member.id }, select: { id: true } });
    const out = (await mcp.callTool('hadron_task_create', { appRef: app.id, title: 'via mcp', session: plain.id })) as { content: Array<{ text: string }> };
    const id = /\(id: ([0-9a-z]+)\)/.exec(out.content[0].text)![1];
    expect(await stored(id)).toBe(false);
    const yes = (await mcp.callTool('hadron_task_create', { appRef: app.id, title: 'asks', closeSessionWhenDone: true, session: plain.id })) as { content: Array<{ text: string }> };
    expect(await stored(/\(id: ([0-9a-z]+)\)/.exec(yes.content[0].text)![1])).toBe(true);
  });

  it('the run tool', async () => {
    const run: AppRun = await db.appRun.create({
      data: {
        id: generateId(), organizationId: orgId, appId: app.id, triggerKind: 'MANUAL', entryNodeUrn: 'csd::mem::flow:entry',
        status: 'RUNNING', userId: member.id,
      },
    });
    const toolCtx: RunToolContext = { log: vi.fn(), db, run, principal: runContext(db, run) };
    const out = (await hadronTaskCreate.execute(toolCtx, { title: 'from a run' })) as { id: string };
    expect(await stored(out.id)).toBe(false);
    const yes = (await hadronTaskCreate.execute(toolCtx, { title: 'asks', closeSessionWhenDone: true })) as { id: string };
    expect(await stored(yes.id)).toBe(true);
  });

  it('the column default agrees: an insert that omits it stores false', async () => {
    const row = await db.agentTask.create({ data: { appId: app.id, title: 'raw', ownerUserId: member.id } });
    expect(row.closeSessionWhenDone).toBe(false);
    const [raw] = await db.$queryRaw<Array<{ v: boolean }>>`
      INSERT INTO agent_tasks (id, app_id, title, owner_user_id, status, created_at, updated_at)
      VALUES (${generateId()}, ${app.id}, 'raw sql', ${member.id}, 'pending', now(), now())
      RETURNING close_session_when_done AS v`;
    expect(raw!.v).toBe(false);
  });
});

describe('finish: only an explicit true asks the assignee to end its session', () => {
  async function started(input: Record<string, unknown>) {
    const t = await create({ assignee: { worker: 'Anne' }, ...input });
    await db.session.create({ data: { id: generateId(), appId: app.id, workerId: anne.id, agentId, userId: member.id }, select: { id: true } });
    await asWorker(anne, () => M.startAgentTask({}, { taskId: t.id }, ctx(member.id)));
    return t;
  }
  const finish = (taskId: string) =>
    asWorker(anne, () => M.finishAgentTask({}, { taskId, result: { outcome: 'succeeded' } }, ctx(member.id)));

  it('omitted: no session-end request is made', async () => {
    const t = await started({});
    await finish(t.id);
    expect(await requestOf(t.id)).toBeNull();
  });

  it('explicit true: the request is made, on finish and on cancel', async () => {
    const t = await started({ closeSessionWhenDone: true });
    await finish(t.id);
    expect(await requestOf(t.id)).toMatchObject({ workerId: anne.id, resolution: null });
    const c = await create({ assignee: { worker: 'Anne' }, closeSessionWhenDone: true });
    await M.cancelAgentTask({}, { taskId: c.id }, ctx(member.id));
    expect(await requestOf(c.id)).toMatchObject({ workerId: anne.id });
  });
});

describe('assign / reassign: omitted keeps the stored value, a named value sets it', () => {
  it.each([true, false])('stored %s survives an omitted assign and reassign', async (flag) => {
    const t = await create({ closeSessionWhenDone: flag });
    const assigned = await M.assignAgentTask({}, { taskId: t.id, assignee: { worker: 'Anne' } }, ctx(member.id));
    expect(assigned.closeSessionWhenDone).toBe(flag);
    const re = await M.reassignAgentTask({}, { taskId: t.id, assignee: { worker: 'Liam' } }, ctx(member.id));
    expect(re.closeSessionWhenDone).toBe(flag);
    expect(await stored(t.id)).toBe(flag);
    const events = await db.agentTeamEvent.findMany({ where: { taskId: t.id, type: { in: ['task.assigned', 'task.reassigned'] } } });
    expect(events.map((e) => (e.payload as { closeSessionWhenDone: boolean }).closeSessionWhenDone)).toEqual([flag, flag]);
  });

  it('a named value overrides, on assign and on reassign', async () => {
    const t = await create();
    expect((await M.assignAgentTask({}, { taskId: t.id, assignee: { worker: 'Anne' }, closeSessionWhenDone: true }, ctx(member.id))).closeSessionWhenDone).toBe(true);
    expect((await M.reassignAgentTask({}, { taskId: t.id, assignee: { worker: 'Liam' }, closeSessionWhenDone: false }, ctx(member.id))).closeSessionWhenDone).toBe(false);
  });
});
