import { WORKER_SIGNATURE_DEFAULTS } from '../../../lib/workerSignature.js';
/**
 * #2249 / R182 (cor:agt:050:10) — a task ends its assignee's session only when whoever assigns it asks.
 *
 * `closeSessionWhenDone` therefore defaults to FALSE on every way a task comes to exist (GraphQL worker and
 * person callers, child tasks, the MCP tool, the run tool, a raw insert), while an explicit `true` still asks the
 * assignee's session to end on finish and on cancel. Rows created under the old default are NOT rewritten, an
 * omitted flag on assign/reassign keeps the stored value, and the matcher consumes the stored value unchanged.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { runAsActor } from '../../../lib/requestActor.js';
import { resolvers, type Context } from './resolvers.js';
import { runContext } from '../../../jobs/appRunDeps.js';
import { hadronTaskCreate } from '../../../lib/runner/tools/index.js';
import { taskMatcherTick } from '../../../jobs/taskMatcher.js';
import { createTestableMcpServer } from '../../../mcp/server.js';

vi.mock('../../../integrations/github/writeNodeToGit.js', () => ({
  writeNodeToGit: vi.fn().mockResolvedValue(undefined),
}));

const M = resolvers.Mutation as any;

let org: { id: string; urn: string };
let member: { id: string };
let admin: { id: string };
let app: { id: string; urn: string };
let teamAgent: { id: string };
let anne: { id: string };
let liam: { id: string };

const ctx = (userId?: string): Context => ({ db, userId, roles: ['READER'] });
const asWorker = (w: { id: string }, fn: () => Promise<any>) => runAsActor({ workerId: w.id, agentId: teamAgent.id }, fn);
const create = (c: Context, input: Record<string, unknown> = {}) =>
  M.createAgentTask({}, { input: { appRef: app.id, title: 'Fix the widget', ...input } }, c);
const stored = async (id: string) => (await db.agentTask.findUniqueOrThrow({ where: { id } })).closeSessionWhenDone;
const endRequests = (taskId: string) => db.taskSessionEndRequest.count({ where: { taskId } });

/** An open session for `w`, as a live worker would hold, so a finish/cancel has something to ask to end. */
const openSession = (w: { id: string }) =>
  db.session.create({ data: { id: generateId(), appId: app.id, workerId: w.id, agentId: teamAgent.id, startedAt: new Date(), updatedAt: new Date() }, select: { id: true } });

beforeEach(async () => {
  await cleanDb(db);
  const n = Math.floor(Math.random() * 1_000_000);
  org = await db.organization.create({ data: { id: generateId(), name: 'cs-org', urn: `cs-org-${n}.example` } });
  admin = await db.user.create({ data: { id: generateId(), githubId: 810_000 + n, githubUsername: `cs-admin-${n}`, roles: ['READER'] } });
  member = await db.user.create({ data: { id: generateId(), githubId: 820_000 + n, githubUsername: `cs-mia-${n}`, roles: ['READER'] } });
  await db.orgMember.create({ data: { id: generateId(), organizationId: org.id, userId: admin.id, role: 'ADMIN' } });
  teamAgent = await M.createAgent({}, { orgId: org.id, name: 'Team Agent' }, ctx(admin.id));
  app = await db.app.create({ data: { id: generateId(), organizationId: org.id, name: 'Team', urn: `${org.urn}:team` } });
  await db.appMember.create({ data: { appId: app.id, userId: member.id, role: 'member' } });
  const worker = (name: string) =>
    db.worker.create({ data: { ...WORKER_SIGNATURE_DEFAULTS, id: generateId(), appId: app.id, agentId: teamAgent.id, name, slug: name.toLowerCase(), heldByUserId: member.id }, select: { id: true } });
  anne = await worker('Anne');
  liam = await worker('Liam');
});

describe('#2249 every create path defaults the flag to false', () => {
  it('a person creating a root task', async () => {
    const t = await create(ctx(member.id));
    expect(t.closeSessionWhenDone).toBe(false);
    expect(await stored(t.id)).toBe(false);
  });

  it('a worker creating a child task (worker caller, child of its own started task)', async () => {
    const parent = await create(ctx(member.id), { assignee: { worker: anne.id } });
    await asWorker(anne, () => M.startAgentTask({}, { taskId: parent.id }, ctx(member.id)));
    const child = await asWorker(anne, () => create(ctx(member.id), { parentTaskId: parent.id }));
    expect(child.parentTaskId).toBe(parent.id);
    expect(child.closeSessionWhenDone).toBe(false);
    expect(await stored(child.id)).toBe(false);
  });

  it('the MCP hadron_task_create tool', async () => {
    const session = await db.session.create({ data: { id: generateId(), userId: member.id, appId: app.id } });
    const mcp = createTestableMcpServer({ userId: member.id, roles: ['READER'], clientId: `user:${member.id}` }, { sessionId: `cs-${generateId()}`, cachedAppResolution: { kind: 'multi-app' } });
    const out = (await mcp.callTool('hadron_task_create', { appRef: app.id, title: 'via mcp', session: session.id })) as { content: Array<{ text: string }> };
    const id = /\(id: ([0-9a-z]+)\)/.exec(out.content[0].text)![1];
    expect(await stored(id)).toBe(false);
  });

  it('the run tool hadron_task_create', async () => {
    const run = await db.appRun.create({
      data: { id: generateId(), organizationId: org.id, appId: app.id, triggerKind: 'MANUAL', entryNodeUrn: 'cs::mem::flow:entry', status: 'RUNNING', userId: member.id },
    });
    const out = (await hadronTaskCreate.execute({ log: vi.fn(), db, run, principal: runContext(db, run) }, { title: 'via run' })) as { id: string };
    expect(await stored(out.id)).toBe(false);
  });

  it('a raw insert that omits the column (the schema default itself)', async () => {
    const id = generateId();
    await db.$executeRaw`INSERT INTO agent_tasks (id, app_id, title, owner_user_id, status, created_at, updated_at)
      VALUES (${id}, ${app.id}, 'raw', ${member.id}, 'pending', now(), now())`;
    expect(await stored(id)).toBe(false);
  });

  it('an explicit value on create is kept, true and false', async () => {
    expect(await stored((await create(ctx(member.id), { closeSessionWhenDone: true })).id)).toBe(true);
    expect(await stored((await create(ctx(member.id), { closeSessionWhenDone: false })).id)).toBe(false);
  });
});

describe('#2249 the flag still drives the session-end request', () => {
  it.each([
    ['finish', (id: string) => asWorker(anne, () => M.finishAgentTask({}, { taskId: id, result: { outcome: 'succeeded' } }, ctx(member.id)))],
    ['cancel', (id: string) => M.cancelAgentTask({}, { taskId: id }, ctx(member.id))],
  ] as const)('explicit true asks the assignee session to end on %s', async (_name, end) => {
    await openSession(anne);
    const t = await create(ctx(member.id), { assignee: { worker: anne.id }, closeSessionWhenDone: true });
    await asWorker(anne, () => M.startAgentTask({}, { taskId: t.id }, ctx(member.id)));
    await end(t.id);
    expect(await endRequests(t.id)).toBe(1);
  });

  it.each([
    ['finish', (id: string) => asWorker(anne, () => M.finishAgentTask({}, { taskId: id, result: { outcome: 'succeeded' } }, ctx(member.id)))],
    ['cancel', (id: string) => M.cancelAgentTask({}, { taskId: id }, ctx(member.id))],
  ] as const)('an omitted flag asks for nothing on %s', async (_name, end) => {
    await openSession(anne);
    const t = await create(ctx(member.id), { assignee: { worker: anne.id } });
    await asWorker(anne, () => M.startAgentTask({}, { taskId: t.id }, ctx(member.id)));
    await end(t.id);
    expect(await endRequests(t.id)).toBe(0);
  });
});

describe('#2249 assign and reassign keep the stored value when the flag is omitted', () => {
  it.each([true, false])('assign, stored %s', async (value) => {
    const t = await create(ctx(member.id), { closeSessionWhenDone: value });
    const out = await M.assignAgentTask({}, { taskId: t.id, assignee: { worker: anne.id } }, ctx(member.id));
    expect(out.closeSessionWhenDone).toBe(value);
    expect(await stored(t.id)).toBe(value);
  });

  it.each([true, false])('reassign, stored %s', async (value) => {
    const t = await create(ctx(member.id), { assignee: { worker: anne.id }, closeSessionWhenDone: value });
    const out = await M.reassignAgentTask({}, { taskId: t.id, assignee: { worker: liam.id } }, ctx(member.id));
    expect(out.closeSessionWhenDone).toBe(value);
    const ev = await db.agentTeamEvent.findFirstOrThrow({ where: { taskId: t.id, type: 'task.reassigned' } });
    expect(ev.payload).toMatchObject({ closeSessionWhenDone: value });
  });

  it('an explicit value on assign still overrides the stored one', async () => {
    const t = await create(ctx(member.id), { closeSessionWhenDone: false });
    const out = await M.assignAgentTask({}, { taskId: t.id, assignee: { worker: anne.id }, closeSessionWhenDone: true }, ctx(member.id));
    expect(out.closeSessionWhenDone).toBe(true);
  });
});

describe('#2249 the matcher carries the stored value unchanged', () => {
  it.each([true, false])('a queued task stored %s is matched and assignment.matched reports the same', async (value) => {
    const when = new Date('2026-10-09T11:00:00Z');
    await db.session.create({ data: { id: generateId(), appId: app.id, workerId: anne.id, agentId: teamAgent.id, family: 'codex', startedAt: when, updatedAt: when } });
    const t = await db.agentTask.create({ data: { appId: app.id, title: 'Queued', ownerUserId: member.id, createdAt: when, closeSessionWhenDone: value }, select: { id: true } });
    await taskMatcherTick(db, new Date('2026-10-09T11:01:00Z'));
    const ev = await db.agentTeamEvent.findFirstOrThrow({ where: { taskId: t.id, type: 'assignment.matched' } });
    expect(ev.payload).toMatchObject({ closeSessionWhenDone: value });
    expect(await stored(t.id)).toBe(value);
  });
});

describe('#2249 existing rows are not rewritten', () => {
  it('a row created with the old default (true) keeps asking for the end on finish', async () => {
    await openSession(anne);
    const id = generateId();
    await db.$executeRaw`INSERT INTO agent_tasks (id, app_id, title, owner_user_id, assignee_worker_id, assigned_at, status, started_at, close_session_when_done, created_at, updated_at)
      VALUES (${id}, ${app.id}, 'old', ${member.id}, ${anne.id}, now(), 'started', now(), true, now(), now())`;
    await asWorker(anne, () => M.finishAgentTask({}, { taskId: id, result: { outcome: 'succeeded' } }, ctx(member.id)));
    expect(await stored(id)).toBe(true);
    expect(await endRequests(id)).toBe(1);
  });
});
