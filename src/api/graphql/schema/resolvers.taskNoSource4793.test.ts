import { WORKER_SIGNATURE_DEFAULTS } from '../../../lib/workerSignature.js';
/**
 * #4793 — a task created without a source raises no warning (Holger, 2026-11-21); the code stays a closed-list code and stays readable in history.
 *
 */
import { ApolloServer } from '@apollo/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { runAsActor } from '../../../lib/requestActor.js';
import { RegisterLookup } from '../../../lib/actionRegister/lookup.js';
import { resolvers, type Context } from './resolvers.js';
import { typeDefs } from './typeDefs.js';
import { taskWarningsPlugin } from '../taskWarningsPlugin.js';
import {
  boundedRead, emitTaskWarnings, renderTaskWarnings, resolveRegisters, shapeResponseWarnings,
  MAX_WARNINGS_PER_OPERATION, MAX_WARNINGS_PER_RESPONSE, type TaskWarning, type TaskWarningCode,
} from './resolvers.taskWarnings.js';

vi.mock('../../../integrations/github/writeNodeToGit.js', () => ({ writeNodeToGit: vi.fn().mockResolvedValue(undefined) }));
const hooks: { afterCommit: (() => Promise<void>) | null } = { afterCommit: null };
vi.mock('../../../lib/hostOperations/launch.js', async (orig) => ({
  ...(await orig<typeof import('../../../lib/hostOperations/launch.js')>()),
  launchForAssignment: async (...a: unknown[]) => {
    await hooks.afterCommit?.();
    return (await orig<typeof import('../../../lib/hostOperations/launch.js')>()).launchForAssignment(...(a as [never, never]));
  },
}));
vi.mock('../../../integrations/github/syncGraphFromGithub.js', () => ({ syncGraphFromGithub: vi.fn().mockResolvedValue({ error: null }) }));

const M = resolvers.Mutation as any;

let org: { id: string; urn: string };
let admin: { id: string };
let member: { id: string };
let outsider: { id: string };
let app: { id: string };
let teamAgentId: string;
let teamMemoryId: string;
let teamMemoryUrn: string;
let anne: { id: string };
let liam: { id: string };
let rook: { id: string };

const ctx = (userId: string): Context => ({ db, userId, roles: ['READER'] });
const asWorker = (w: { id: string }, agentId: string | null, fn: () => Promise<any>) => runAsActor({ workerId: w.id, agentId }, fn);
const create = (c: Context, input: Record<string, unknown>) =>
  M.createAgentTask({}, { input: { appRef: app.id, title: 'Fix the widget', source: 'https://example.test/1', ...input } }, c);
const codes = (c: Context) => (c.taskWarnings ?? []).map((w) => w.warning.code);
const worker = (name: string, agentId = teamAgentId) =>
  db.worker.create({ data: { ...WORKER_SIGNATURE_DEFAULTS, id: generateId(), appId: app.id, agentId, name, slug: name.toLowerCase() }, select: { id: true } });

async function node(memoryId: string, loc: string, extra: Record<string, unknown> = {}) {
  return db.node.create({ data: { id: generateId(), memoryId, loc, name: loc, content: '# x', ...extra } });
}
const registerEntry = (memoryId: string, code: string, taskLoc: unknown, entryCode: string = code) =>
  node(memoryId, `register:${code}`, { data: { registerEntry: { code: entryCode, taskLoc } } });

beforeEach(async () => {
  await cleanDb(db);
  const suffix = generateId().toLowerCase();
  org = await db.organization.create({ data: { id: generateId(), name: 'tw-org', urn: `tw-${suffix}.example` } });
  admin = await db.user.create({ data: { githubId: 218001, githubUsername: 'tw-admin', handle: 'tw-admin', roles: ['READER'] } });
  member = await db.user.create({ data: { githubId: 218002, githubUsername: 'tw-member', handle: 'tw-member', roles: ['READER'] } });
  outsider = await db.user.create({ data: { githubId: 218003, githubUsername: 'tw-out', handle: 'tw-out', roles: ['READER'] } });
  await db.orgMember.create({ data: { organizationId: org.id, userId: admin.id, role: 'ADMIN' } });
  const agent = await M.createAgent({}, { orgRef: org.id, name: 'Team Agent' }, ctx(admin.id));
  teamAgentId = agent.id;
  const row = await db.agent.findUniqueOrThrow({ where: { id: teamAgentId } });
  teamMemoryId = row.systemMemoryId as string;
  teamMemoryUrn = (await db.memory.findUniqueOrThrow({ where: { id: teamMemoryId } })).urn;
  app = await db.app.create({ data: { id: generateId(), organizationId: org.id, name: 'Team', urn: `${org.urn}:team` } });
  await db.appMember.create({ data: { appId: app.id, userId: member.id, role: 'member' } });
  await db.appAgent.create({ data: { appId: app.id, agentId: teamAgentId } });
  await node(teamMemoryId, 'roles'); // the Team Agent marker (locateTeamAgent)
  anne = await worker('Anne');
  liam = await worker('Liam');
  rook = await worker('Rook');
});

describe('#4793 a source-less create raises no task.create.no-source warning', () => {
  it('none on a create with no source (absent, blank, whitespace); the task is still created', async () => {
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
    await create(c, { source: undefined, assignee: { worker: anne.id } });
    expect(codes(c)).toEqual(['task.assign.assignee-busy']);
  });

  it('a source-less batch create (createAgentTasks) raises none either', async () => {
    const c = ctx(member.id);
    await M.createAgentTasks(null, { appRef: app.id, tasks: [{ task: { title: 'One' } }, { task: { title: 'Two' } }] }, c, { path: { key: 'createAgentTasks', prev: undefined, typename: 'Mutation' } });
    expect(codes(c)).toEqual([]);
  });

  it('the code is still a closed-list code (clients and the register keep tolerating it)', async () => {
    const { TASK_WARNING_CODES, TASK_WARNING_TEXT } = await import('./resolvers.taskWarnings.js');
    expect(TASK_WARNING_CODES).toContain('task.create.no-source');
    expect(TASK_WARNING_TEXT['task.create.no-source']).toBeTruthy();
  });
});
