/**
 * #3263, the review follow-ups to #3244 (cor:agt:050:02, "What a clone does"; ruling 0010). Tests only: production is
 * unchanged, so these are controls that pass on current source, and each guard's mutant is what makes them mean
 * something. No existing defect is claimed.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { GraphQLError } from 'graphql';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { resolvers } from './resolvers.js';
vi.mock('../../../integrations/github/writeNodeToGit.js', () => ({ writeNodeToGit: vi.fn().mockResolvedValue(undefined) }));
// Row 2's fault: a lookup INSIDE the real copied-properties check breaks. Mocking the check itself does not work:
// properties.ts sits on an import cycle with the resolvers, so they would keep the real one. Every other read is real.
const fault = vi.hoisted(() => ({ error: null as Error | null, reached: [] as string[] }));
vi.mock('../../../lib/effectiveSystemMemory.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../../lib/effectiveSystemMemory.js')>();
  return { ...real, findEffectiveNodeIdByLoc: (...a: Parameters<typeof real.findEffectiveNodeIdByLoc>) => {
    if (fault.error && a[2] === 'schema:task-properties') {
      fault.reached.push(a[2]);
      throw fault.error;
    }
    return real.findEffectiveNodeIdByLoc(...a);
  } };
});

const M = resolvers.Mutation as any;
const F = (resolvers as any).AgentTask as any;
let org: any, app: any, other: any, owner: any, foreignMember: any, source: any;
const ctx = (userId: string, extra: Record<string, unknown> = {}) => ({ db, userId, roles: ['READER'], ...extra }) as any;
const stored = (id: string) => db.agentTask.findUniqueOrThrow({ where: { id } }) as Promise<any>;
const clonedFromIdInDb = async (id: string) => (await db.$queryRaw<Array<{ v: string | null }>>`SELECT cloned_from_id AS v FROM agent_tasks WHERE id = ${id}`)[0].v;

/** Every row a clone would write: the task, and its events anywhere. */
const writes = async () => ({ tasks: await db.agentTask.count(), events: await db.agentTeamEvent.count() });

beforeEach(async () => {
  await cleanDb(db);
  fault.error = null;
  fault.reached = [];
  org = await db.organization.create({ data: { name: 'Clone', urn: `clone-${generateId()}.test` } });
  [owner, foreignMember] = await Promise.all(['owner', 'foreign'].map((handle) => db.user.create({ data: { handle } })));
  app = await db.app.create({ data: { organizationId: org.id, name: 'Clone', urn: `${org.urn}:clone` } });
  other = await db.app.create({ data: { organizationId: org.id, name: 'Other', urn: `${org.urn}:other` } });
  await db.appMember.create({ data: { appId: app.id, userId: owner.id, role: 'owner' } });
  await db.appMember.create({ data: { appId: other.id, userId: foreignMember.id, role: 'member' } });
  source = await M.createAgentTask({}, { input: { appRef: app.id, title: 'Source', priority: 2, properties: { review: { tier: 'T2' } } } }, ctx(owner.id));
});

describe('row 1: a clone is refused where a plain create is', () => {
  const impersonating = () => ({ impersonation: { orgId: org.id, sessionId: generateId(), actorUserId: foreignMember.id, expiresAt: new Date(Date.now() + 60_000) } });
  const refusal = (p: Promise<unknown>) => p.then(() => null, (e: GraphQLError) => ({ code: e.extensions.code, message: e.message }));

  it.each([
    ['under impersonation', impersonating, 'FORBIDDEN'],
    ['with a refused session binding', () => ({ sessionBindingRefused: true }), 'SESSION_NOT_BOUND'],
  ])('%s: the same refusal as a create, and nothing written', async (_name, extra, expected) => {
    const caller = ctx(owner.id, extra());
    const before = await writes();
    const sourceBefore = await stored(source.id);
    const plain = await refusal(M.createAgentTask({}, { input: { appRef: app.id, title: 'Plain' } }, caller));
    const cloned = await refusal(M.cloneAgentTask({}, { taskId: source.id, input: {} }, caller));
    expect(plain?.code).toBe(expected);
    expect(cloned).toEqual(plain);
    // The gate is judged first, before the fields. The transaction re-checks it, so only this ordering shows that a
    // clone goes through the gate in prepareTaskCreate rather than leaning on the re-check.
    const invalid = { title: '   ' };
    const plainInvalid = await refusal(M.createAgentTask({}, { input: { appRef: app.id, ...invalid } }, caller));
    const clonedInvalid = await refusal(M.cloneAgentTask({}, { taskId: source.id, input: invalid }, caller));
    expect(plainInvalid?.code).toBe(expected);
    expect(clonedInvalid).toEqual(plainInvalid);
    expect(await writes()).toEqual(before);
    expect(await stored(source.id)).toEqual(sourceBefore);
  });

  it('CONTROL: the same caller, plainly, may clone (a blank title is a field refusal), so the refusals above are the context\'s', async () => {
    await expect(M.cloneAgentTask({}, { taskId: source.id, input: { title: '   ' } }, ctx(owner.id))).rejects.toMatchObject({ extensions: { code: expect.not.stringMatching(/^(FORBIDDEN|SESSION_NOT_BOUND)$/) } });
    const c = await M.cloneAgentTask({}, { taskId: source.id, input: {} }, ctx(owner.id));
    expect((await stored(c.id)).clonedFromId).toBe(source.id);
  });
});

describe('row 2: the catch around copied properties is only for GraphQL refusals', () => {
  // A Team Agent, so the check really runs down to the schema lookup; no schema node, so nothing else refuses.
  beforeEach(async () => {
    const sys = await db.memory.create({ data: { organizationId: org.id, name: 'Sys', urn: `${org.urn}:sys`, class: 'system' } });
    const agent = await db.agent.create({ data: { organizationId: org.id, name: 'Team', urn: `${org.urn}:team`, systemMemoryId: sys.id } });
    await db.appAgent.create({ data: { appId: app.id, agentId: agent.id } });
    await db.node.create({ data: { id: generateId(), memoryId: sys.id, loc: 'roles:lead', name: 'Lead' } });
  });

  it('a plain Error from the check propagates out of the clone, and nothing is written', async () => {
    fault.error = new Error('the check itself broke');
    expect(fault.error).not.toBeInstanceOf(GraphQLError);
    const before = await writes();
    await expect(M.cloneAgentTask({}, { taskId: source.id, input: {} }, ctx(owner.id))).rejects.toBe(fault.error);
    expect(fault.reached).toEqual(['schema:task-properties']);
    expect(await writes()).toEqual(before);
  });

  it('CONTROL: a GraphQL refusal at the same point is swallowed: the clone is made, without the properties', async () => {
    fault.error = new GraphQLError('refused', { extensions: { code: 'PROPERTIES_SCHEMA_VIOLATION' } });
    const c = await M.cloneAgentTask({}, { taskId: source.id, input: {} }, ctx(owner.id));
    expect(fault.reached).toEqual(['schema:task-properties']);
    expect(await stored(c.id)).toMatchObject({ clonedFromId: source.id, properties: null });
  });
});

describe('row 4a: a source removed from under its clones', () => {
  it('leaves each clone standing with a null link, through the real foreign key', async () => {
    const a = await M.cloneAgentTask({}, { taskId: source.id, input: {} }, ctx(owner.id));
    const b = await M.cloneAgentTask({}, { taskId: source.id, input: {} }, ctx(owner.id));
    expect((await F.clonedFrom(await stored(a.id), {}, ctx(owner.id))).id).toBe(source.id);

    await db.agentTask.delete({ where: { id: source.id } });

    expect(await db.agentTask.count({ where: { id: source.id } })).toBe(0);
    for (const c of [a, b]) {
      const row = await stored(c.id);
      expect(await clonedFromIdInDb(c.id)).toBeNull();
      expect(row).toMatchObject({ clonedFromId: null, title: 'Source', status: 'pending' });
      await expect(F.clonedFrom(row, {}, ctx(owner.id))).resolves.toBeNull();
    }
  });
});

describe('row 4b: a clone link across Apps', () => {
  it('is left out of both the count and the page; an ordinary clone is counted and listed', async () => {
    const ordinary = await M.cloneAgentTask({}, { taskId: source.id, input: {} }, ctx(owner.id));
    const foreign = await M.createAgentTask({}, { input: { appRef: other.id, title: 'Foreign' } }, ctx(foreignMember.id));
    // SQL only: the API cannot make this row, because a clone is always made in its source's App (and refuses a
    // source in another). It exists here to pin the same-App join, which is defence in depth.
    expect(await db.$executeRaw`UPDATE agent_tasks SET cloned_from_id = ${source.id} WHERE id = ${foreign.id}`).toBe(1);
    expect(await clonedFromIdInDb(foreign.id)).toBe(source.id);

    const page = await F.clones(await stored(source.id), {}, ctx(owner.id));
    expect(page.total).toBe(1);
    expect(page.items.map((t: any) => t.id)).toEqual([ordinary.id]);
  });
});
