import { WORKER_SIGNATURE_DEFAULTS } from '../lib/workerSignature.js';
/**
 * #1705 — the agent-task tools on the MCP surface.
 *
 * The rules are pinned in resolvers.agentTask.test.ts; this covers the
 * SURFACE: every write requires `session` and refuses without it (never
 * inferred — #1697/#1701), a worker session makes the worker the actor while a
 * plain session acts as the person, an unusable session is refused, refusals
 * arrive as `[code] message` envelopes with the GraphQL codes, and the reads.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../integrations/db/client.js';
import { cleanDb } from '../test/helpers.js';
import { generateId } from '../lib/id.js';
import type { AuthContext } from '../middleware/auth.js';
import { createTestableMcpServer } from './server.js';
import { AGENT_TASK_WRITE_TOOLS } from './agentTaskTools.js';
import { resolvers, type Context } from '../api/graphql/schema/resolvers.js';

vi.mock('../integrations/github/writeNodeToGit.js', () => ({
  writeNodeToGit: vi.fn().mockResolvedValue(undefined),
}));

const M = resolvers.Mutation as unknown as Record<string, (p: unknown, a: unknown, c: Context) => Promise<any>>;

let org: { id: string };
let admin: { id: string };
let member: { id: string };
let outsider: { id: string };
let app: { id: string; urn: string };
let agentId: string;
let anne: { id: string };
let rook: { id: string };

const authOf = (userId: string) => ({ userId, roles: ['READER'], clientId: `user:${userId}` }) as AuthContext;
const mcp = (auth: AuthContext) =>
  createTestableMcpServer(auth, { sessionId: `at-${generateId()}`, cachedAppResolution: { kind: 'multi-app' } });
const text = (r: { content: Array<{ text: string }> }) => r.content[0].text;
const code = (t: string) => /^\[([a-z_]+)\]/.exec(t)?.[1].toUpperCase() ?? 'NO_ERROR';
const idOf = (t: string) => /\(id: ([0-9a-z]+)\)/.exec(t)![1];

/** A session row as hadron_start_session would leave it. */
async function session(data: { userId?: string; appId?: string; workerId?: string; endedAt?: Date }) {
  return db.session.create({
    data: { id: generateId(), ...data, ...(data.workerId ? { agentId } : {}) },
    select: { id: true },
  });
}

beforeEach(async () => {
  await cleanDb(db);
  org = await db.organization.create({ data: { id: generateId(), name: 'Task MCP', urn: `taskmcp-${generateId().toLowerCase()}.example` } });
  admin = await db.user.create({ data: { githubId: 171001, githubUsername: 'at-admin', handle: 'at-admin', roles: [] } });
  member = await db.user.create({ data: { githubId: 171002, githubUsername: 'at-member', handle: 'at-member', roles: [] } });
  outsider = await db.user.create({ data: { githubId: 171003, githubUsername: 'at-out', handle: 'at-out', roles: [] } });
  await db.orgMember.create({ data: { organizationId: org.id, userId: admin.id, role: 'ADMIN' } });
  const agent = await M.createAgent({}, { orgId: org.id, name: 'Team Agent' }, { db, userId: admin.id, roles: ['READER'] });
  agentId = agent.id;
  app = await db.app.create({ data: { id: generateId(), organizationId: org.id, name: 'Team', urn: `${org.id.toLowerCase()}:team` } });
  await db.appMember.create({ data: { appId: app.id, userId: member.id, role: 'member' } });
  anne = await db.worker.create({ data: { ...WORKER_SIGNATURE_DEFAULTS, appId: app.id, agentId, name: 'Anne', slug: 'anne' }, select: { id: true } });
  rook = await db.worker.create({ data: { ...WORKER_SIGNATURE_DEFAULTS, appId: app.id, agentId, name: 'Rook', slug: 'rook' }, select: { id: true } });
});

describe('agent-task tools: who acts', () => {
  it('every write tool refuses without a session, and writes nothing', async () => {
    const s = mcp(authOf(member.id));
    const t = text(await s.callTool('hadron_task_create', { appRef: app.id, title: 'x' }));
    expect(code(t)).toBe('SESSION_REQUIRED');
    expect(await db.agentTask.count()).toBe(0);
    for (const tool of AGENT_TASK_WRITE_TOOLS.filter((n) => n !== 'hadron_task_create')) {
      const r = text(await s.callTool(tool, {
        taskId: generateId(), assignee: { worker: 'Anne' }, outcome: 'succeeded',
        // #1706's write tools
        eventId: generateId(), worker: anne.id, appRef: app.id, family: 'claude', state: 'UNAVAILABLE', reason: 'OTHER',
      }));
      expect({ tool, code: code(r) }).toEqual({ tool, code: 'SESSION_REQUIRED' });
    }
  });

  it('a session that is not one of yours, or has ended, is refused', async () => {
    const s = mcp(authOf(member.id));
    const foreign = await session({ userId: admin.id });
    const ended = await session({ userId: member.id, endedAt: new Date() });
    for (const sid of [generateId(), foreign.id, ended.id]) {
      expect(code(text(await s.callTool('hadron_task_create', { appRef: app.id, title: 'x', session: sid })))).toBe('SESSION_NOT_BOUND');
    }
    expect(await db.agentTask.count()).toBe(0);
  });

  it('a plain session acts as the person; a worker session as the worker', async () => {
    const s = mcp(authOf(member.id));
    const plain = await session({ userId: member.id });
    const asAnne = await session({ userId: member.id, appId: app.id, workerId: anne.id });
    const mine = idOf(text(await s.callTool('hadron_task_create', { appRef: app.id, title: 'mine', session: plain.id })));
    const hers = idOf(text(await s.callTool('hadron_task_create', { appRef: app.id, title: 'hers', session: asAnne.id })));
    const [a, b] = await Promise.all([
      db.agentTask.findUniqueOrThrow({ where: { id: mine } }),
      db.agentTask.findUniqueOrThrow({ where: { id: hers } }),
    ]);
    expect([a.ownerUserId, a.ownerWorkerId]).toEqual([member.id, null]);
    expect([b.ownerUserId, b.ownerWorkerId, b.createdByWorkerId]).toEqual([null, anne.id, anne.id]);
  });

  it('a full lifecycle through the tools, with the GraphQL refusal codes', async () => {
    const s = mcp(authOf(member.id));
    const plain = await session({ userId: member.id });
    const asAnne = await session({ userId: member.id, appId: app.id, workerId: anne.id });
    const asRook = await session({ userId: member.id, appId: app.id, workerId: rook.id });
    const created = text(await s.callTool('hadron_task_create', {
      appRef: app.id, title: 'Fix it', assignee: { worker: 'Anne' }, tags: ['t1'], closeSessionWhenDone: true, session: plain.id,
    }));
    expect(created).toMatch(/assignee: worker Anne/);
    const id = idOf(created);
    expect(code(text(await s.callTool('hadron_task_start', { taskId: id, session: asRook.id })))).toBe('TASK_NOT_ASSIGNEE');
    expect(text(await s.callTool('hadron_task_start', { taskId: id, session: asAnne.id }))).toMatch(/status: started/);
    const child = text(await s.callTool('hadron_task_create', {
      parentTaskId: id, title: 'Review', assignee: { worker: 'Rook' }, session: asAnne.id,
    }));
    expect(child).toMatch(/owner: worker Anne/);
    expect(text(await s.callTool('hadron_task_get', { taskId: id }))).toMatch(/waiting on child tasks/);
    expect(code(text(await s.callTool('hadron_task_finish', { taskId: id, outcome: 'succeeded', session: plain.id })))).toBe('TASK_NOT_ASSIGNEE');
    expect(code(text(await s.callTool('hadron_task_finish', { taskId: id, outcome: 'two words', session: asAnne.id })))).toBe('BAD_USER_INPUT');
    const done = text(await s.callTool('hadron_task_finish', {
      taskId: id, outcome: 'succeeded', evidence: 'https://github.com/o/r/pull/1', session: asAnne.id,
    }));
    expect(done).toMatch(/result: succeeded/);
    expect(code(text(await s.callTool('hadron_task_cancel', { taskId: id, session: plain.id })))).toBe('TASK_ENDED');
    const ev = text(await s.callTool('hadron_team_events', { appRef: app.id, taskId: id }));
    // #1709: this task asked to close its session when done (R182: the default is no), so finishing asks Anne to end it (cor:agt:050:10).
    expect(ev.split('\n').map((l) => /Z (task\.[a-z-]+)/.exec(l)?.[1])).toEqual([
      'task.created', 'task.assigned', 'task.started', 'task.finished', 'task.session-end-requested',
    ]);
  });
});

describe('agent-task tools: reads', () => {
  it('participants list and get; others are refused or read not-found', async () => {
    const plain = await session({ userId: member.id });
    const s = mcp(authOf(member.id));
    const id = idOf(text(await s.callTool('hadron_task_create', { appRef: app.id, title: 'Visible', session: plain.id })));
    expect(text(await s.callTool('hadron_task_list', { appRef: app.id }))).toMatch(/Visible/);
    const out = mcp(authOf(outsider.id));
    expect(code(text(await out.callTool('hadron_task_list', { appRef: app.id })))).toBe('APP_NOT_FOUND');
    expect(code(text(await out.callTool('hadron_task_get', { taskId: id })))).toBe('TASK_NOT_FOUND');
  });

  it('INTERIM (050:21 unruled): an App key reads nothing, bare or through a worker session of its App', async () => {
    const plain = await session({ userId: member.id });
    const id = idOf(text(await mcp(authOf(member.id)).callTool('hadron_task_create', { appRef: app.id, title: 'x', session: plain.id })));
    const keyAuth = { appId: app.id } as AuthContext;
    const hostSession = await session({ appId: app.id, workerId: anne.id });
    const s = mcp(keyAuth);
    expect(code(text(await s.callTool('hadron_task_get', { taskId: id })))).toBe('TASK_NOT_FOUND');
    expect(code(text(await s.callTool('hadron_task_get', { taskId: id, session: hostSession.id })))).toBe('TASK_NOT_FOUND');
  });
});

describe('agent-task tools: backlog (#1754)', () => {
  it('create parked, park a queued task, make it ready, and filter by BACKLOG', async () => {
    const s = mcp(authOf(member.id));
    const plain = await session({ userId: member.id });
    const created = text(await s.callTool('hadron_task_create', {
      appRef: app.id, title: 'Later', status: 'BACKLOG', session: plain.id,
    }));
    expect(created).toMatch(/status: backlog/);
    const id = idOf(created);
    expect(code(text(await s.callTool('hadron_task_create', {
      appRef: app.id, title: 'Nope', status: 'BACKLOG', assignee: { worker: 'Anne' }, session: plain.id,
    })))).toBe('BAD_USER_INPUT');
    const ready = text(await s.callTool('hadron_task_make_ready', { taskId: id, session: plain.id }));
    expect(ready).toMatch(/status: pending/);
    const parked = text(await s.callTool('hadron_task_park', { taskId: id, session: plain.id }));
    expect(parked).toMatch(/status: backlog/);
    const list = text(await s.callTool('hadron_task_list', { appRef: app.id, status: ['BACKLOG'] }));
    expect(list).toMatch(/Later/);
  });
});
