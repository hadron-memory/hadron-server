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
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createMcpServerInstance, createTestableMcpServer } from './server.js';
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

  it('project:true survives the real MCP SDK path (argument parsing included): a top-level project (AT1), not a child of AT0', async () => {
    const server = createMcpServerInstance(authOf(member.id), () => undefined, { kind: 'multi-app' });
    const client = new Client({ name: 'task-handle-2553', version: '1' });
    const [local, remote] = InMemoryTransport.createLinkedPair();
    await server.connect(remote);
    await client.connect(local);
    try {
      const plain = await session({ userId: member.id });
      const call = async (args: Record<string, unknown>) =>
        (((await client.callTool({ name: 'hadron_task_create', arguments: { appRef: app.id, session: plain.id, ...args } })) as any).content[0].text as string);
      const id = idOf(await call({ title: 'proj', project: true }));
      expect(await db.agentTask.findUniqueOrThrow({ where: { id } })).toMatchObject({ handle: 'AT1', parentTaskId: null });
      const loose = idOf(await call({ title: 'loose' }));
      expect((await db.agentTask.findUniqueOrThrow({ where: { id: loose } })).handle).toBe('AT0.1');
    } finally {
      await client.close();
      await server.close();
    }
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
    // #1709: the assigner asked for the session to close when done (explicit since #2249: the default is false), so finishing asks Anne to end it (cor:agt:050:10).
    expect(ev.split('\n').map((l) => /Z (task\.[a-z-]+)/.exec(l)?.[1])).toEqual([
      'task.created', 'task.assigned', 'task.warning', 'task.started', 'task.finished', 'task.session-end-requested', 'task.warning',
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

describe('agent-task tools: creator filter (#2370)', () => {
  it('P7: hadron_task_list takes creator {worker|user} and returns what the GraphQL filter does', async () => {
    const s = mcp(authOf(member.id));
    const plain = await session({ userId: member.id });
    const asAnne = await session({ userId: member.id, appId: app.id, workerId: anne.id });
    await s.callTool('hadron_task_create', { appRef: app.id, title: 'Mine', session: plain.id });
    await s.callTool('hadron_task_create', { appRef: app.id, title: 'Hers', session: asAnne.id });
    const byWorker = text(await s.callTool('hadron_task_list', { appRef: app.id, creator: { worker: 'Anne' } }));
    expect(byWorker).toMatch(/Hers/);
    expect(byWorker).not.toMatch(/Mine/);
    const byUser = text(await s.callTool('hadron_task_list', { appRef: app.id, creator: { user: member.id } }));
    expect(byUser).toMatch(/Mine/);
    expect(byUser).not.toMatch(/Hers/);
    expect(text(await s.callTool('hadron_task_list', { appRef: app.id, creator: { worker: 'Nobody' } }))).toBe('No tasks match.');
    const out = mcp(authOf(outsider.id));
    expect(code(text(await out.callTool('hadron_task_list', { appRef: app.id, creator: { worker: 'Anne' } })))).toBe('APP_NOT_FOUND');
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


describe('#2644 MCP blocker and priority parity', () => {
  it('round-trips all three mutations and create fields through SDK argument parsing', async () => {
    const server = createMcpServerInstance(authOf(member.id), () => undefined, { kind: 'multi-app' });
    const client = new Client({ name: 'blockers2644', version: '1' });
    const [local, remote] = InMemoryTransport.createLinkedPair();
    await server.connect(remote); await client.connect(local);
    try {
      const plain = await session({ userId: member.id });
      const call = async (name: string, args: Record<string, unknown>) =>
        ((await client.callTool({ name, arguments: { session: plain.id, ...args } })) as any).content[0].text as string;
      const b = idOf(await call('hadron_task_create', { appRef: app.id, title: 'blocker', status: 'BACKLOG' }));
      const t = idOf(await call('hadron_task_create', { appRef: app.id, title: 'dependent', priority: 4, blockedBy: [b], assignee: { user: member.id } }));
      expect(await call('hadron_task_get', { taskId: t, dependencyLimit: 0 })).toMatch(/blocked by \(1 total, more pages\)/);
      expect(code(await call('hadron_task_start', { taskId: t }))).toBe('TASK_BLOCKED');
      expect(await call('hadron_task_priority_set', { taskRef: t, priority: 2 })).toMatch(/priority: 2/);
      expect(await call('hadron_task_blocker_remove', { taskRef: t, blockerTaskRef: b })).toMatch(/blocked: false/);
      expect(await call('hadron_task_blocker_add', { taskRef: t, blockerTaskRef: b })).toMatch(/blocked: true/);
    } finally { await client.close(); await server.close(); }
  });
});

it('#2831 S3 roster renders current model-group names, including an explicit empty list', async () => {
  await db.modelGroup.create({ data: { appId: app.id, name: 'custom', patterns: ['unknown-*'] } });
  await db.session.create({ data: { appId: app.id, workerId: anne.id, agentId, userId: member.id, llmModel: 'unknown-model' } });
  const result = text(await mcp(authOf(member.id)).callTool('hadron_team_roster', { appRef: app.id }));
  expect(result.split('\n').find(line => line.startsWith('Anne —'))).toContain('model groups custom');
  expect(result.split('\n').find(line => line.startsWith('Rook —'))).toContain('model groups none');
});
