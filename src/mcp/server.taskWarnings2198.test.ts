import { WORKER_SIGNATURE_DEFAULTS } from '../lib/workerSignature.js';
/**
 * #2198 — the MCP tools return the SAME warnings as GraphQL, as lines after the task text; a refusal stays a
 * refusal (no warning lines), and a person (no Agent) gets code + text only.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../integrations/db/client.js';
import { cleanDb } from '../test/helpers.js';
import { generateId } from '../lib/id.js';
import type { AuthContext } from '../middleware/auth.js';
import { createTestableMcpServer } from './server.js';
import { resolvers, type Context } from '../api/graphql/schema/resolvers.js';

vi.mock('../integrations/github/writeNodeToGit.js', () => ({ writeNodeToGit: vi.fn().mockResolvedValue(undefined) }));

const M = resolvers.Mutation as unknown as Record<string, (p: unknown, a: unknown, c: Context) => Promise<any>>;
let app: { id: string };
let member: { id: string };
let agentId: string;
let memoryId: string;
let anne: { id: string };

const authOf = (userId: string) => ({ userId, roles: ['READER'], clientId: `user:${userId}` }) as AuthContext;
const mcp = (auth: AuthContext) => createTestableMcpServer(auth, { sessionId: `tw-${generateId()}`, cachedAppResolution: { kind: 'multi-app' } });
const text = (r: { content: Array<{ text: string }> }) => r.content[0].text;
const idOf = (t: string) => /\(id: ([0-9a-z]+)\)/.exec(t)![1];
const session = (data: { userId: string; appId?: string; workerId?: string }) =>
  db.session.create({ data: { id: generateId(), ...data, ...(data.workerId ? { agentId } : {}) }, select: { id: true } });

beforeEach(async () => {
  await cleanDb(db);
  const org = await db.organization.create({ data: { id: generateId(), name: 'TW MCP', urn: `twmcp-${generateId().toLowerCase()}.example` } });
  const admin = await db.user.create({ data: { githubId: 218101, githubUsername: 'tw-admin', handle: 'tw-admin', roles: [] } });
  member = await db.user.create({ data: { githubId: 218102, githubUsername: 'tw-member', handle: 'tw-member', roles: [] } });
  await db.orgMember.create({ data: { organizationId: org.id, userId: admin.id, role: 'ADMIN' } });
  const agent = await M.createAgent({}, { orgId: org.id, name: 'Team Agent' }, { db, userId: admin.id, roles: ['READER'] });
  agentId = agent.id;
  memoryId = (await db.agent.findUniqueOrThrow({ where: { id: agentId } })).systemMemoryId as string;
  app = await db.app.create({ data: { id: generateId(), organizationId: org.id, name: 'Team', urn: `${org.id.toLowerCase()}:team` } });
  await db.appMember.create({ data: { appId: app.id, userId: member.id, role: 'member' } });
  await db.appAgent.create({ data: { appId: app.id, agentId } });
  await db.node.create({ data: { id: generateId(), memoryId, loc: 'roles', name: 'roles', content: 'x' } });
  anne = await db.worker.create({ data: { ...WORKER_SIGNATURE_DEFAULTS, appId: app.id, agentId, name: 'Anne', slug: 'anne' }, select: { id: true } });
});

describe('hadron_task_* return the warnings', () => {
  it('a person: the warning line (code + text), no task mapping; none once a source is given', async () => {
    const s = mcp(authOf(member.id));
    const plain = await session({ userId: member.id });
    const warned = text(await s.callTool('hadron_task_create', { appRef: app.id, title: 'no source', session: plain.id }));
    expect(warned).toMatch(/Created\./);
    expect(warned).toMatch(/\nWarning \[task\.create\.no-source\]: .+/);
    expect(warned).not.toMatch(/→/);
    const clean = text(await s.callTool('hadron_task_create', { appRef: app.id, title: 'sourced', source: 'https://example.test/1', session: plain.id }));
    expect(clean).not.toMatch(/Warning \[/);
  });

  it('a worker session: the mapped role task rides on the line; an open-children finish warns and still finishes', async () => {
    const memory = await db.memory.findUniqueOrThrow({ where: { id: memoryId } });
    await db.node.create({ data: { id: generateId(), memoryId, loc: 'register:task.finish.open-children', name: 'r', content: 'x', data: { registerEntry: { code: 'task.finish.open-children', taskLoc: 'tasks:finish' } } } });
    await db.node.create({ data: { id: generateId(), memoryId, loc: 'tasks:finish', name: 'finish', content: 'x', isRunnable: true } });
    const s = mcp(authOf(member.id));
    const plain = await session({ userId: member.id });
    const asAnne = await session({ userId: member.id, appId: app.id, workerId: anne.id });
    const parent = idOf(text(await s.callTool('hadron_task_create', { appRef: app.id, title: 'p', source: 's', assignee: { worker: anne.id }, session: plain.id })));
    await s.callTool('hadron_task_start', { taskId: parent, session: asAnne.id });
    await s.callTool('hadron_task_create', { parentTaskId: parent, title: 'child', source: 's', session: asAnne.id });
    const out = text(await s.callTool('hadron_task_finish', { taskId: parent, outcome: 'succeeded', session: asAnne.id }));
    expect(out).toMatch(/Finished\./);
    expect(out).toContain(`Warning [task.finish.open-children]:`);
    expect(out).toContain(`→ hrn:node:${memory.urn}:tasks:finish`);
    expect((await db.agentTask.findUniqueOrThrow({ where: { id: parent } })).status).toBe('finished');
  });

  it('a refused call carries no warning lines', async () => {
    const s = mcp(authOf(member.id));
    const plain = await session({ userId: member.id });
    const out = text(await s.callTool('hadron_task_finish', { taskId: generateId(), outcome: 'succeeded', session: plain.id }));
    expect(out).not.toMatch(/Warning \[/);
  });
});
