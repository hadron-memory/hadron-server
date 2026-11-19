/**
 * #3441 (ruling 0233, "Assignee too"; hrn:node:hadronmemory.com:specs:cor:agt:050:01 and :09; cor:agt:050:28):
 * a task's assignee may set, change and remove the task's references through the one-call edit, as it writes
 * properties. Only references move; every other field stays refused to the assignee with TASK_NOT_OWNER.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { runAsActor } from '../../../lib/requestActor.js';
import { WORKER_SIGNATURE_DEFAULTS } from '../../../lib/workerSignature.js';
import { resolvers, type Context } from './resolvers.js';
vi.mock('../../../integrations/github/writeNodeToGit.js', () => ({ writeNodeToGit: vi.fn().mockResolvedValue(undefined) }));

const M = resolvers.Mutation as any;
let org: any, app: any, owner: any, manager: any, assignee: any, sibling: any, outsider: any, task: any;
const ctx = (userId: string = owner.id): Context => ({ db, userId, roles: ['READER'] });
const PR1 = 'https://github.com/hadron-memory/hadron-server/pull/1';
const PR2 = 'https://github.com/hadron-memory/hadron-server/pull/2';
const ISSUE = 'https://github.com/hadron-memory/hadron-server/issues/3441';
const code = (c: string) => ({ extensions: { code: c } });
const edit = (input: Record<string, unknown>, userId: string = assignee.id, taskId: string = task.id) =>
  M.updateAgentTask({}, { taskId, input }, ctx(userId));
const row = async (id: string = task.id) => (await db.agentTask.findUniqueOrThrow({ where: { id } })) as any;
const edited = (id: string = task.id) => db.agentTeamEvent.findMany({ where: { taskId: id, type: 'task.edited' } });

beforeEach(async () => {
  await cleanDb(db);
  org = await db.organization.create({ data: { name: 'AR', urn: `ar-${generateId()}.test` } });
  [owner, manager, assignee, sibling, outsider] = await Promise.all(
    ['owner', 'manager', 'assignee', 'sibling', 'outsider'].map(h => db.user.create({ data: { handle: `ar3441-${h}` } })));
  app = await db.app.create({ data: { organizationId: org.id, name: 'AR', urn: `${org.urn}:ar` } });
  for (const [u, role] of [[owner, 'member'], [manager, 'owner'], [assignee, 'member'], [sibling, 'member']] as const) {
    await db.appMember.create({ data: { appId: app.id, userId: u.id, role } });
  }
  task = await M.createAgentTask({}, { input: { appRef: app.id, title: 'Refs', source: 'fixed', assignee: { user: assignee.id } } }, ctx());
});

describe('the assignee writes references (#3441)', () => {
  it('sets, changes, removes and clears them', async () => {
    await edit({ references: [{ kind: 'PULL_REQUEST', target: PR1 }, { kind: 'ISSUE', target: ISSUE }] });
    expect((await row()).references.map((r: any) => r.target)).toEqual([PR1, ISSUE]);
    await edit({ references: [{ kind: 'PULL_REQUEST', target: PR2 }] });
    expect((await row()).references.map((r: any) => r.target)).toEqual([PR2]);
    await edit({ references: [] });
    expect((await row()).references).toEqual([]);
    await edit({ references: [{ kind: 'ISSUE', target: ISSUE }] });
    await edit({ references: null });
    expect((await row()).references).toEqual([]);
  });

  it('a call naming properties and references applies both', async () => {
    await edit({ properties: { a: 1 }, references: [{ kind: 'PULL_REQUEST', target: PR1 }] });
    const r = await row();
    expect(r.properties).toEqual({ a: 1 });
    expect(r.references.map((x: any) => x.target)).toEqual([PR1]);
  });

  it('task.edited names references, never its values', async () => {
    await edit({ references: [{ kind: 'PULL_REQUEST', target: PR1 }] });
    const events = await edited();
    expect(events).toHaveLength(1);
    expect(JSON.stringify(events[0])).toContain('references');
    expect(JSON.stringify(events[0])).not.toContain(PR1);
  });
});

describe('everything else stays refused to the assignee (#3441)', () => {
  it('any other field, alone or beside references, refuses the whole call', async () => {
    await expect(edit({ title: 'Hijack' })).rejects.toMatchObject(code('TASK_NOT_OWNER'));
    await expect(edit({ references: [{ kind: 'PULL_REQUEST', target: PR1 }], title: 'Hijack' })).rejects.toMatchObject(code('TASK_NOT_OWNER'));
    await expect(edit({ references: [{ kind: 'PULL_REQUEST', target: PR1 }], description: 'x' })).rejects.toMatchObject(code('TASK_NOT_OWNER'));
    await expect(edit({})).rejects.toMatchObject(code('TASK_NOT_OWNER'));
    const r = await row();
    expect(r.title).toBe('Refs');
    expect(r.references).toEqual([]);
    expect(await edited()).toHaveLength(0);
  });

  it('a non-assignee who cannot direct the task is refused unchanged', async () => {
    await expect(edit({ references: [{ kind: 'PULL_REQUEST', target: PR1 }] }, sibling.id)).rejects.toMatchObject(code('TASK_NOT_OWNER'));
    await expect(edit({ references: [{ kind: 'PULL_REQUEST', target: PR1 }] }, outsider.id)).rejects.toMatchObject(code('TASK_NOT_FOUND'));
    expect((await row()).references).toEqual([]);
  });

  it('a reassigned-away assignee is refused', async () => {
    await M.reassignAgentTask({}, { taskId: task.id, assignee: { user: sibling.id } }, ctx());
    await expect(edit({ references: [{ kind: 'PULL_REQUEST', target: PR1 }] })).rejects.toMatchObject(code('TASK_NOT_OWNER'));
    await edit({ references: [{ kind: 'PULL_REQUEST', target: PR1 }] }, sibling.id);
    expect((await row()).references).toHaveLength(1);
  });

  it.each(['finished', 'cancelled'])('a %s task refuses the assignee', async (status) => {
    await db.agentTask.update({
      where: { id: task.id },
      data: status === 'finished'
        ? { status, startedAt: new Date(), finishedAt: new Date(), resultOutcome: 'done' }
        : { status, cancelledAt: new Date() },
    });
    await expect(edit({ references: [{ kind: 'PULL_REQUEST', target: PR1 }] })).rejects.toMatchObject(code('TASK_ENDED'));
    expect((await row()).references).toEqual([]);
  });
});

describe('§10 negatives (#3441)', () => {
  it('an impersonation session never authorizes it, even as the assignee', async () => {
    const impersonation = { sessionId: generateId(), actorUserId: manager.id, orgId: app.organizationId, expiresAt: new Date(Date.now() + 3600_000) };
    await expect(M.updateAgentTask({}, { taskId: task.id, input: { references: [{ kind: 'PULL_REQUEST', target: PR1 }] } }, { ...ctx(assignee.id), impersonation }))
      .rejects.toMatchObject(code('FORBIDDEN'));
    expect((await row()).references).toEqual([]);
  });

  it('an App key is refused', async () => {
    const key = await db.appKey.create({ data: { appId: app.id, keyHash: generateId(), keyPreview: 'test' } });
    await expect(M.updateAgentTask({}, { taskId: task.id, input: { references: [{ kind: 'PULL_REQUEST', target: PR1 }] } }, { db, appId: app.id, appKeyId: key.id, roles: [] }))
      .rejects.toMatchObject(code('TASK_NOT_FOUND'));
    expect((await row()).references).toEqual([]);
  });

  it('a removed App member who is still the recorded assignee is refused', async () => {
    await db.appMember.deleteMany({ where: { appId: app.id, userId: assignee.id } });
    await expect(edit({ references: [{ kind: 'PULL_REQUEST', target: PR1 }] })).rejects.toMatchObject(code('TASK_NOT_FOUND'));
    expect((await row()).references).toEqual([]);
  });
});

describe('a worker assignee (#3441, LOCAL P3 and §10 P3-1: the any-worker mutant)', () => {
  let agent: any, worker: any, otherWorker: any, workerTask: any;
  const asWorker = (w: any, input: Record<string, unknown>, userId: string) =>
    runAsActor({ workerId: w.id, agentId: agent.id }, () => M.updateAgentTask({}, { taskId: workerTask.id, input }, ctx(userId)));
  beforeEach(async () => {
    const system = await db.memory.create({ data: { organizationId: org.id, name: 'Team system', urn: `${org.urn}:team-system`, class: 'system' } });
    agent = await db.agent.create({ data: { organizationId: org.id, name: 'Team', urn: `${org.urn}:team`, systemMemoryId: system.id } });
    await db.appAgent.create({ data: { appId: app.id, agentId: agent.id } });
    worker = await db.worker.create({ data: { ...WORKER_SIGNATURE_DEFAULTS, appId: app.id, agentId: agent.id, name: 'Worker', slug: 'worker', heldByUserId: sibling.id } });
    otherWorker = await db.worker.create({ data: { ...WORKER_SIGNATURE_DEFAULTS, appId: app.id, agentId: agent.id, name: 'Other', slug: 'other', heldByUserId: sibling.id } });
    workerTask = await db.agentTask.create({ data: { appId: app.id, title: 'W', ownerUserId: owner.id, assigneeWorkerId: worker.id, assignedAt: new Date() } });
  });

  it('the assignee worker writes references through its session; another worker with the same holder is refused', async () => {
    await asWorker(worker, { references: [{ kind: 'PULL_REQUEST', target: PR1 }] }, sibling.id);
    expect(((await row(workerTask.id)).references).map((r: any) => r.target)).toEqual([PR1]);
    await expect(asWorker(otherWorker, { references: [{ kind: 'PULL_REQUEST', target: PR2 }] }, sibling.id)).rejects.toMatchObject(code('TASK_NOT_OWNER'));
    expect(((await row(workerTask.id)).references).map((r: any) => r.target)).toEqual([PR1]);
  });

  it('the worker\'s holder acting as a person, with no worker actor, is refused', async () => {
    await expect(M.updateAgentTask({}, { taskId: workerTask.id, input: { references: [{ kind: 'PULL_REQUEST', target: PR2 }] } }, ctx(sibling.id)))
      .rejects.toMatchObject(code('TASK_NOT_OWNER'));
    expect((await row(workerTask.id)).references).toEqual([]);
  });
});
