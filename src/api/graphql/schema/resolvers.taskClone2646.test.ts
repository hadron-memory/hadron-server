/**
 * #2646 (cor:agt:050:02, "What a clone does", Decided, ruling 0010): a clone is a create with its fields filled in from
 * the source, in the source's App, linked to it (`clonedFrom`, `clones`); an ended task never reopens.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { resolvers } from './resolvers.js';
vi.mock('../../../integrations/github/writeNodeToGit.js', () => ({ writeNodeToGit: vi.fn().mockResolvedValue(undefined) }));

const M = resolvers.Mutation as any;
const F = (resolvers as any).AgentTask as any;
let org: any, app: any, other: any;
let owner: any, manager: any, assignee: any, sibling: any, outsider: any;
const ctx = (userId: string) => ({ db, userId, roles: ['READER'] });
const code = (c: string) => ({ extensions: { code: c } });
const stored = (id: string) => db.agentTask.findUniqueOrThrow({ where: { id } }) as Promise<any>;
const created = (id: string) => db.agentTeamEvent.findMany({ where: { taskId: id, type: 'task.created' } });
const clone = (taskId: string, input: any = {}, userId = owner.id) => M.cloneAgentTask({}, { taskId, input }, ctx(userId));
const eventCount = (id: string) => db.agentTeamEvent.count({ where: { taskId: id } });

async function finish(taskId: string, userId: string) {
  await M.startAgentTask({}, { taskId }, ctx(userId));
  await M.finishAgentTask({}, { taskId, result: { outcome: 'succeeded', summary: 'done', evidence: 'e' } }, ctx(userId));
}

let source: any;
beforeEach(async () => {
  await cleanDb(db);
  org = await db.organization.create({ data: { name: 'Clone', urn: `clone-${generateId()}.test` } });
  [owner, manager, assignee, sibling, outsider] = await Promise.all(
    ['owner', 'manager', 'assignee', 'sibling', 'outsider'].map((handle) => db.user.create({ data: { handle } })),
  );
  app = await db.app.create({ data: { organizationId: org.id, name: 'Clone', urn: `${org.urn}:clone` } });
  other = await db.app.create({ data: { organizationId: org.id, name: 'Other', urn: `${org.urn}:other` } });
  for (const [u, role] of [[owner, 'member'], [manager, 'owner'], [assignee, 'member'], [sibling, 'member']] as const) {
    await db.appMember.create({ data: { appId: app.id, userId: u.id, role } });
  }
  await db.appMember.create({ data: { appId: other.id, userId: outsider.id, role: 'member' } });
  source = await M.createAgentTask({}, {
    input: {
      appRef: app.id, title: 'Review PR', description: 'Look hard', source: 'https://example.test/pr/1', tags: ['review', 'blind'],
      requirements: { role: 'reviewer', minTier: 'mid' }, references: [{ kind: 'URL', target: 'https://example.test/x', label: 'x' }],
      closeSessionWhenDone: true, priority: 2, properties: { review: { tier: 'T2' } }, assignee: { user: assignee.id },
    },
  }, ctx(owner.id));
});

describe('a clone of a finished task (S8)', () => {
  it('is a new pending task with a new handle, the copied fields, and none of the not-copied ones; the source is untouched', async () => {
    await finish(source.id, assignee.id);
    const before = await stored(source.id);
    const eventsBefore = await eventCount(source.id);
    const c = await clone(source.id);
    const row = await stored(c.id);
    expect(row.id).not.toBe(source.id);
    expect(row.handle).not.toBe(before.handle);
    expect(row.appId).toBe(app.id);
    expect(row).toMatchObject({
      title: 'Review PR', description: 'Look hard', source: 'https://example.test/pr/1', tags: ['review', 'blind'],
      closeSessionWhenDone: true, priority: 2, status: 'pending', clonedFromId: source.id,
      assigneeWorkerId: null, assigneeUserId: null, resultOutcome: null, startBy: null, finishBy: null, externalId: null,
    });
    expect(row.requirements).toEqual({ role: 'reviewer', minTier: 'mid' });
    expect(row.references).toEqual(before.references);
    expect(row.properties).toEqual({ review: { tier: 'T2' } });
    expect(await db.agentTaskBlocker.count({ where: { taskId: c.id } })).toBe(0);
    const after = await stored(source.id);
    expect(after).toEqual(before);
    expect(await eventCount(source.id)).toBe(eventsBefore);
  });

  it('records exactly one task.created event, naming the source', async () => {
    const c = await clone(source.id);
    const events = await created(c.id);
    expect(events).toHaveLength(1);
    expect((events[0].payload as any).clonedFromTaskId).toBe(source.id);
  });

  it('a plain create names no source in its event', async () => {
    const events = await created(source.id);
    expect((events[0].payload as any).clonedFromTaskId).toBeUndefined();
  });

  it('any status may be cloned, and a backlog clone is made when the call asks', async () => {
    const c = await clone(source.id, { status: 'BACKLOG' });
    expect((await stored(c.id)).status).toBe('backlog');
  });
});

describe('overrides', () => {
  it('replace a copied field, and naming it empty clears it', async () => {
    const c = await clone(source.id, { title: 'New title', description: '', tags: [], source: 'https://example.test/other' });
    expect(await stored(c.id)).toMatchObject({ title: 'New title', description: null, tags: [], source: 'https://example.test/other' });
  });
});

describe('the link', () => {
  it('clonedFrom names the source and clones lists the clones, paged', async () => {
    const a = await clone(source.id);
    const b = await clone(source.id);
    const ofClone = await F.clonedFrom(await stored(a.id), {}, ctx(owner.id));
    expect(ofClone.id).toBe(source.id);
    const page = await F.clones(await stored(source.id), { limit: 1, offset: 0 }, ctx(owner.id));
    expect(page.total).toBe(2);
    expect(page.items).toHaveLength(1);
    expect(page.hasMore).toBe(true);
    const all = await F.clones(await stored(source.id), {}, ctx(owner.id));
    expect(all.items.map((t: any) => t.id).sort()).toEqual([a.id, b.id].sort());
    expect(await F.clonedFrom(await stored(source.id), {}, ctx(owner.id))).toBeNull();
  });

  it('a person outside the App reads neither side', async () => {
    const c = await clone(source.id);
    expect(await F.clonedFrom(await stored(c.id), {}, ctx(outsider.id))).toBeNull();
    const page = await F.clones(await stored(source.id), {}, ctx(outsider.id));
    expect(page.total).toBe(0);
    expect(page.items).toEqual([]);
  });
});

describe('who may clone, and what the clone carries for them', () => {
  it('a person who cannot read the source gets the refusal an unknown id gets', async () => {
    const real = await clone(source.id, {}, outsider.id).catch((e: any) => e);
    const unknown = await clone('no-such-task-id', {}, outsider.id).catch((e: any) => e);
    expect(real.extensions.code).toBe('TASK_NOT_FOUND');
    expect(real.extensions.code).toBe(unknown.extensions.code);
    expect(real.message.replace(source.id, 'X')).toBe(unknown.message.replace('no-such-task-id', 'X'));
    expect(await db.agentTask.count({ where: { clonedFromId: source.id } })).toBe(0);
  });

  it('properties and priority are copied for a caller who may write them', async () => {
    const c = await clone(source.id, {}, manager.id);
    expect(await stored(c.id)).toMatchObject({ priority: 2, properties: { review: { tier: 'T2' } } });
  });

  it('a caller who may not write them gets the clone without them, and no refusal', async () => {
    const c = await clone(source.id, { owner: { user: owner.id } }, sibling.id);
    const row = await stored(c.id);
    expect(row.properties).toBeNull();
    expect(row.priority).toBe(1);
    expect(row.ownerUserId).toBe(owner.id);
  });

  it('a priority the caller names and may not set is still refused (a plain create rule)', async () => {
    await expect(clone(source.id, { owner: { user: owner.id }, priority: 3 }, sibling.id)).rejects.toMatchObject(code('TASK_NOT_OWNER'));
    expect(await db.agentTask.count({ where: { clonedFromId: source.id } })).toBe(0);
  });
});

describe('copied properties the team schema now refuses', () => {
  it('are left out of the clone, never a refusal; a value the caller types is still judged', async () => {
    const sys = await db.memory.create({ data: { organizationId: org.id, name: 'Sys', urn: `${org.urn}:sys`, class: 'system' } });
    const agent = await db.agent.create({ data: { organizationId: org.id, name: 'Team', urn: `${org.urn}:team`, systemMemoryId: sys.id } });
    await db.appAgent.create({ data: { appId: app.id, agentId: agent.id } });
    await db.node.create({ data: { id: generateId(), memoryId: sys.id, loc: 'roles:lead', name: 'Lead' } });
    await db.node.create({ data: { id: generateId(), memoryId: sys.id, loc: 'schema:task-properties', name: 'Schema', data: { type: 'object', properties: { review: { type: 'object', properties: { tier: { enum: ['T1'] } } } } } as any } });
    const c = await clone(source.id);
    expect((await stored(c.id)).properties).toBeNull();
    await expect(clone(source.id, { properties: { review: { tier: 'T2' } } })).rejects.toBeDefined();
  });
});

describe('parent, root and project', () => {
  it('a root with no project is cloned under AT0 as a root; a project stays a project', async () => {
    const c = await clone(source.id);
    const row = await stored(c.id);
    const at0 = await db.agentTask.findFirstOrThrow({ where: { appId: app.id, handle: 'AT0' } });
    expect(row.parentTaskId).toBe(at0.id);
    const project = await M.createAgentTask({}, { input: { appRef: app.id, title: 'Project', project: true } }, ctx(owner.id));
    const pc = await clone(project.id);
    const prow = await stored(pc.id);
    expect(prow.parentTaskId).toBeNull();
    expect(prow.handle).toMatch(/^AT[1-9]\d*$/);
    expect(prow.handle).not.toBe(project.handle);
  });

  it('AT0 itself cannot be cloned', async () => {
    const at0 = await db.agentTask.findFirstOrThrow({ where: { appId: app.id, handle: 'AT0' } });
    await expect(clone(at0.id)).rejects.toBeDefined();
    expect(await db.agentTask.count({ where: { clonedFromId: at0.id } })).toBe(0);
  });

  describe('a child task', () => {
    let child: any;
    beforeEach(async () => {
      await M.startAgentTask({}, { taskId: source.id }, ctx(assignee.id));
      child = await M.createAgentTask({}, { input: { parentTaskId: source.id, title: 'Child', source: 's' } }, ctx(assignee.id));
    });

    it('keeps its parent for the parent\'s assignee', async () => {
      const c = await clone(child.id, {}, assignee.id);
      expect((await stored(c.id)).parentTaskId).toBe(source.id);
    });

    it('is refused for anyone else unless the call names another parent or none; nothing is created', async () => {
      await expect(clone(child.id, {}, sibling.id)).rejects.toMatchObject(code('TASK_NOT_ASSIGNEE'));
      expect(await db.agentTask.count({ where: { clonedFromId: child.id } })).toBe(0);
      const none = await clone(child.id, { parentTaskId: null }, sibling.id);
      const at0 = await db.agentTask.findFirstOrThrow({ where: { appId: app.id, handle: 'AT0' } });
      expect((await stored(none.id)).parentTaskId).toBe(at0.id);
    });

    it('goes under AT0 when its parent has ended', async () => {
      await M.cancelAgentTask({}, { taskId: child.id }, ctx(assignee.id));
      await M.finishAgentTask({}, { taskId: source.id, result: { outcome: 'succeeded' } }, ctx(assignee.id));
      const c = await clone(child.id, {}, sibling.id);
      const at0 = await db.agentTask.findFirstOrThrow({ where: { appId: app.id, handle: 'AT0' } });
      expect((await stored(c.id)).parentTaskId).toBe(at0.id);
    });

    it('a parent named from another App reads as not found', async () => {
      const foreign = await M.createAgentTask({}, { input: { appRef: other.id, title: 'Foreign' } }, ctx(outsider.id));
      await expect(clone(child.id, { parentTaskId: foreign.id }, assignee.id)).rejects.toMatchObject(code('TASK_NOT_FOUND'));
    });
  });
});

describe('no reopen', () => {
  it('an ended task still never moves again', async () => {
    await finish(source.id, assignee.id);
    await expect(M.cancelAgentTask({}, { taskId: source.id }, ctx(owner.id))).rejects.toMatchObject(code('TASK_ENDED'));
    await clone(source.id);
    expect((await stored(source.id)).status).toBe('finished');
  });
});
