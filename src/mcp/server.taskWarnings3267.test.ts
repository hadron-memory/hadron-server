import { WORKER_SIGNATURE_DEFAULTS } from '../lib/workerSignature.js';
/**
 * #3267 — hadron_task_start and hadron_task_progress return the SAME warnings as GraphQL, as lines after the task
 * text; nothing is recorded as a team event, and a refusal stays a refusal (no warning lines).
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
  const org = await db.organization.create({ data: { id: generateId(), name: 'TW3267 MCP', urn: `tw3267mcp-${generateId().toLowerCase()}.example` } });
  const admin = await db.user.create({ data: { githubId: 326711, githubUsername: 'tw3267-admin', handle: 'tw3267-admin', roles: [] } });
  member = await db.user.create({ data: { githubId: 326712, githubUsername: 'tw3267-member', handle: 'tw3267-member', roles: [] } });
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

describe('hadron_task_start / hadron_task_progress return the warnings', () => {
  it('start: other-started and parent-ended ride on the line, and nothing is recorded', async () => {
    const s = mcp(authOf(member.id));
    const plain = await session({ userId: member.id });
    const asAnne = await session({ userId: member.id, appId: app.id, workerId: anne.id });
    const parent = idOf(text(await s.callTool('hadron_task_create', { appRef: app.id, title: 'p', source: 's', assignee: { worker: anne.id }, session: plain.id })));
    await s.callTool('hadron_task_start', { taskId: parent, session: asAnne.id });
    const kid = idOf(text(await s.callTool('hadron_task_create', { parentTaskId: parent, title: 'kid', source: 's', assignee: { worker: anne.id }, session: asAnne.id })));
    await s.callTool('hadron_task_cancel', { taskId: parent, session: plain.id });
    const out = text(await s.callTool('hadron_task_start', { taskId: kid, session: asAnne.id }));
    expect(out).toMatch(/Started/);
    expect(out).toContain('Warning [task.start.parent-ended]:');
    expect((await db.agentTask.findUniqueOrThrow({ where: { id: kid } })).status).toBe('started');
    expect(await db.agentTeamEvent.count({ where: { appId: app.id, type: 'task.warning' } })).toBe(0);
  });

  it('start: the second started task for one worker warns other-started', async () => {
    const s = mcp(authOf(member.id));
    const plain = await session({ userId: member.id });
    const asAnne = await session({ userId: member.id, appId: app.id, workerId: anne.id });
    const first = idOf(text(await s.callTool('hadron_task_create', { appRef: app.id, title: 'a', source: 's', assignee: { worker: anne.id }, session: plain.id })));
    const second = idOf(text(await s.callTool('hadron_task_create', { appRef: app.id, title: 'b', source: 's', assignee: { worker: anne.id }, session: plain.id })));
    expect(text(await s.callTool('hadron_task_start', { taskId: first, session: asAnne.id }))).not.toMatch(/Warning \[/);
    expect(text(await s.callTool('hadron_task_start', { taskId: second, session: asAnne.id }))).toContain('Warning [task.start.other-started]:');
  });

  it('progress: children-ended rides on the line once every child has ended; a refused call carries none', async () => {
    const s = mcp(authOf(member.id));
    const plain = await session({ userId: member.id });
    const asAnne = await session({ userId: member.id, appId: app.id, workerId: anne.id });
    const parent = idOf(text(await s.callTool('hadron_task_create', { appRef: app.id, title: 'p', source: 's', assignee: { worker: anne.id }, session: plain.id })));
    await s.callTool('hadron_task_start', { taskId: parent, session: asAnne.id });
    const kid = idOf(text(await s.callTool('hadron_task_create', { parentTaskId: parent, title: 'kid', source: 's', session: asAnne.id })));
    expect(text(await s.callTool('hadron_task_progress', { taskId: parent, session: asAnne.id }))).not.toMatch(/Warning \[/);
    await s.callTool('hadron_task_cancel', { taskId: kid, session: asAnne.id });
    const out = text(await s.callTool('hadron_task_progress', { taskId: parent, session: asAnne.id }));
    expect(out).toContain('Warning [task.progress.children-ended]:');
    const refused = text(await s.callTool('hadron_task_progress', { taskId: generateId(), session: plain.id }));
    expect(refused).not.toMatch(/Warning \[/);
  });
});
