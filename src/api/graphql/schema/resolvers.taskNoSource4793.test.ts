/**
 * #4793 — a task created without a source raises no warning (Holger, 2026-11-21); the code stays a closed-list code and
 * history already recorded with it still reads (cor:agt:110:01, cor:agt:050:11).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { WORKER_SIGNATURE_DEFAULTS } from '../../../lib/workerSignature.js';
import { settledTeamEventQueries, useTeamEventHorizonTimeout } from '../../../test/teamEventHorizon.js';
import { appendTaskEvent, RECORDED_TASK_WARNING_CODES } from '../../../lib/agentTasks/events.js';
import { resolvers, type Context } from './resolvers.js';
import { TASK_WARNING_CODES, TASK_WARNING_TEXT } from './resolvers.taskWarnings.js';

useTeamEventHorizonTimeout();
vi.mock('../../../integrations/github/writeNodeToGit.js', () => ({ writeNodeToGit: vi.fn().mockResolvedValue(undefined) }));

const M = resolvers.Mutation as any;
const Q = settledTeamEventQueries(resolvers.Query, db) as any;
let member: { id: string };
let app: { id: string };
let anne: { id: string };
const ctx = (userId: string): Context => ({ db, userId, roles: ['READER'] });
const create = (c: Context, input: Record<string, unknown>) => M.createAgentTask({}, { input: { appRef: app.id, title: 'Fix the widget', ...input } }, c);
const codes = (c: Context) => (c.taskWarnings ?? []).map((w) => w.warning.code);

beforeEach(async () => {
  await cleanDb(db);
  const org = await db.organization.create({ data: { id: generateId(), name: 'ns-org', urn: `ns-${generateId().toLowerCase()}.example` } });
  const admin = await db.user.create({ data: { githubId: 479301, githubUsername: 'ns-admin', handle: 'ns-admin', roles: ['READER'] } });
  member = await db.user.create({ data: { githubId: 479302, githubUsername: 'ns-member', handle: 'ns-member', roles: ['READER'] } });
  await db.orgMember.create({ data: { organizationId: org.id, userId: admin.id, role: 'ADMIN' } });
  const agent = await M.createAgent({}, { orgRef: org.id, name: 'Team Agent' }, ctx(admin.id));
  const memoryId = (await db.agent.findUniqueOrThrow({ where: { id: agent.id } })).systemMemoryId as string;
  app = await db.app.create({ data: { id: generateId(), organizationId: org.id, name: 'Team', urn: `${org.urn}:team` } });
  await db.appMember.create({ data: { appId: app.id, userId: member.id, role: 'member' } });
  await db.appAgent.create({ data: { appId: app.id, agentId: agent.id } });
  await db.node.create({ data: { id: generateId(), memoryId, loc: 'roles', name: 'roles', content: '# x' } }); // the Team Agent marker
  anne = await db.worker.create({ data: { ...WORKER_SIGNATURE_DEFAULTS, id: generateId(), appId: app.id, agentId: agent.id, name: 'Anne', slug: 'anne' }, select: { id: true } });
});

describe('#4793 a source-less create raises no task.create.no-source warning', () => {
  it('none for a create with no source (absent, null, blank, whitespace); the task is still created', async () => {
    for (const source of [undefined, null, '', '   ']) {
      const c = ctx(member.id);
      const t = await create(c, { source });
      expect(t.id).toBeTruthy();
      expect(codes(c)).toEqual([]);
    }
  });

  it('the other create warnings are unchanged: a source-less create onto a busy worker warns busy only', async () => {
    await create(ctx(member.id), { assignee: { worker: anne.id } });
    const c = ctx(member.id);
    await create(c, { assignee: { worker: anne.id } });
    expect(codes(c)).toEqual(['task.assign.assignee-busy']);
  });
});

describe('#4793 the retired code stays on the closed lists and stays readable in history', () => {
  it('is still a closed-list code with its text, and still a recordable history code', () => {
    expect(TASK_WARNING_CODES).toContain('task.create.no-source');
    expect(TASK_WARNING_TEXT['task.create.no-source']).toBeTruthy();
    expect(RECORDED_TASK_WARNING_CODES).toContain('task.create.no-source');
  });

  it('a task.warning event recorded with the code is accepted by the writer and read back through the event query', async () => {
    const task = await create(ctx(member.id), {});
    await db.$transaction((tx) => appendTaskEvent(tx, { appId: app.id, taskId: task.id,
      actor: { userId: member.id, workerId: null, agentId: null }, event: { type: 'task.warning', code: 'task.create.no-source' } }));
    const rows = await Q.agentTeamEvents({}, { appRef: app.id, types: ['task.warning'], taskId: task.id }, ctx(member.id));
    expect(rows.map((r: any) => r.payload)).toEqual([{ code: 'task.create.no-source' }]);
  });
});
