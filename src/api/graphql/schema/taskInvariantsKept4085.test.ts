/**
 * #4085: the retirement deleted untrackedTaskClaims3132.test.ts, whose tables also pinned two invariants that stay:
 *  - an App key is refused on every regular task mutation (cor:agt:050:23);
 *  - a second create holding a live externalId is TASK_EXTERNAL_ID_TAKEN (cor:agt:120:02).
 * They are re-homed here, in this diff, so a reader sees them run rather than a pointer to other files.
 * (Wider coverage of the same two rules: resolvers.agentTaskAppKey1755, resolvers.agentTaskExternalId3125 / 4217.)
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { WORKER_SIGNATURE_DEFAULTS } from '../../../lib/workerSignature.js';
import { resolvers, type Context } from './resolvers.js';

vi.mock('../../../integrations/github/writeNodeToGit.js', () => ({ writeNodeToGit: vi.fn().mockResolvedValue(undefined) }));

const M = resolvers.Mutation as any;
let app: any, member: any, anne: any, key: any, taskId: string;
const userCtx = (): Context => ({ db, userId: member.id, roles: ['READER'] });
const keyCtx = (): Context => ({ db, appId: app.id, appKeyId: key.id, roles: [] });
const refusal = async (p: Promise<unknown>) => {
  try { await p; } catch (e: any) { return e; }
  throw new Error('expected a refusal');
};

beforeEach(async () => {
  await cleanDb(db);
  const org = await db.organization.create({ data: { name: 'Kept4085', urn: `kept4085-${generateId()}.test` } });
  member = await db.user.create({ data: { handle: `kept4085-${generateId()}` } });
  await db.orgMember.create({ data: { organizationId: org.id, userId: member.id, role: 'ADMIN' } });
  app = await db.app.create({ data: { organizationId: org.id, name: 'Kept', urn: `${org.urn}:kept` } });
  await db.appMember.create({ data: { appId: app.id, userId: member.id, role: 'member' } });
  const agent = await M.createAgent({}, { orgRef: org.id, name: 'Kept Agent' }, userCtx());
  anne = await db.worker.create({ data: { ...WORKER_SIGNATURE_DEFAULTS, appId: app.id, agentId: agent.id, name: 'Anne', slug: 'anne' } });
  key = await db.appKey.create({ data: { appId: app.id, keyHash: `h-${generateId()}`, keyPreview: 'abcd' } });
  taskId = (await M.createAgentTask({}, { input: { appRef: app.id, title: 'existing', assignee: { user: member.id } } }, userCtx())).id;
});

describe('an App key makes no task write (cor:agt:050:23), nine mutations', () => {
  const cases: Array<[string, () => Promise<unknown>]> = [
    ['createAgentTask', () => M.createAgentTask({}, { input: { appRef: app.id, title: 'by key', owner: { user: member.id } } }, keyCtx())],
    ['startAgentTask', () => M.startAgentTask({}, { taskRef: taskId }, keyCtx())],
    ['finishAgentTask', () => M.finishAgentTask({}, { taskRef: taskId, result: { outcome: 'done' } }, keyCtx())],
    ['assignAgentTask', () => M.assignAgentTask({}, { taskRef: taskId, assignee: { worker: anne.id } }, keyCtx())],
    ['reassignAgentTask', () => M.reassignAgentTask({}, { taskRef: taskId, assignee: { worker: anne.id } }, keyCtx())],
    ['cancelAgentTask', () => M.cancelAgentTask({}, { taskRef: taskId }, keyCtx())],
    ['parkAgentTask', () => M.parkAgentTask({}, { taskRef: taskId }, keyCtx())],
    ['recordAgentTaskProgress', () => M.recordAgentTaskProgress({}, { taskRef: taskId }, keyCtx())],
    ['setAgentTaskPriority', () => M.setAgentTaskPriority({}, { taskRef: taskId, priority: 3 }, keyCtx())],
  ];
  for (const [name, call] of cases) {
    it(`${name} by the App's own key is refused and writes nothing`, async () => {
      const before = await db.agentTask.findUniqueOrThrow({ where: { id: taskId } });
      const r = await refusal(call());
      expect(['APP_NOT_FOUND', 'TASK_NOT_FOUND']).toContain(r.extensions?.code);
      expect(await db.agentTask.findUniqueOrThrow({ where: { id: taskId } })).toEqual(before);
      expect(await db.agentTask.count({ where: { appId: app.id, title: 'by key' } })).toBe(0);
    });
  }
});

describe('a live externalId is held by one task per App (cor:agt:120:02)', () => {
  const X = 'https://github.com/hadron-memory/hadron-server/issues/4085';
  const create = (title: string) => M.createAgentTask({}, { input: { appRef: app.id, title, externalId: X } }, userCtx());

  it('a second create with the same externalId is TASK_EXTERNAL_ID_TAKEN and writes no task', async () => {
    await create('first');
    const before = await db.agentTask.count({ where: { appId: app.id } });
    const r = await refusal(create('second'));
    expect(r.extensions?.code).toBe('TASK_EXTERNAL_ID_TAKEN');
    expect(await db.agentTask.count({ where: { appId: app.id } })).toBe(before);
  });
});
