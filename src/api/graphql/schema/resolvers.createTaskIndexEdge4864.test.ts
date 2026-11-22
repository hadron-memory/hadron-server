/**
 * #4864 — the task door writes a role task AND its tasks-index edge in one transaction.
 *
 * `createTaskNode(input, index)` / `hadron_create_task` (agent, trigger) is the SAME door extended, never a second one
 * (cor:acl:130:03). With the index input the door writes the runnable node and one edge from it to the Agent's
 * `tasksIndexRef` node (cor:dmo:050:15), by id, in the door's transaction: either both exist or neither does. The
 * writer level (cor:acl:010:03) judges the node write, and the edge's source is that node, in the same transaction.
 *
 * Fixture: an org with an Agent `eng` whose system memory holds the `tasks` index (pointed at by `tasksIndexRef`);
 * `admin` (org ADMIN) writes it, `contrib` (CONTRIBUTOR) reads and writes ordinary memory, `stranger` reads nothing.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { GraphQLError } from 'graphql';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { resolvers, type Context } from './resolvers.js';
import { createTestableMcpServer } from '../../../mcp/server.js';

vi.mock('../../../integrations/github/writeNodeToGit.js', () => ({
  writeNodeToGit: vi.fn().mockResolvedValue(undefined),
}));

const M = resolvers.Mutation as unknown as Record<string, (...a: unknown[]) => Promise<any>>;
const Q = resolvers.Query as unknown as Record<string, (...a: unknown[]) => Promise<any>>;

let org: { id: string; urn: string };
let admin: { id: string };
let contrib: { id: string };
let stranger: { id: string };
let writer: { id: string };
let sysMem: { id: string; urn: string };
let otherMem: { id: string; urn: string };
let agent: { id: string; urn: string };
let indexId: string;

const as = (u: { id: string }): Context => ({ db, userId: u.id, roles: [], clientId: `user:${u.id}` });
const mcp = (u: { id: string }, tool: string, params: Record<string, unknown>) =>
  createTestableMcpServer({ userId: u.id, roles: [], clientId: `user:${u.id}` }).callToolText(tool, params);
const nodeUrn = (mem: { urn: string }, loc: string) => `hrn:node:${mem.urn}:${loc}`;
const INDEX = () => ({ agent: agent.id, trigger: 'when asked to deploy' });

async function code(p: Promise<unknown>): Promise<{ code: string; message: string }> {
  try { await p; return { code: 'OK', message: '' }; } catch (e) {
    return e instanceof GraphQLError
      ? { code: String(e.extensions.code), message: e.message }
      : { code: 'ERR', message: (e as Error).message };
  }
}
const create = (u: { id: string }, loc: string, index: unknown = INDEX(), extra: Record<string, unknown> = {}, mem = sysMem, skill?: unknown) =>
  M.createTaskNode({}, { input: { memoryId: mem.id, loc, name: loc, content: 'steps', isRunnable: true, ...extra }, ...(index ? { index } : {}), ...(skill ? { skill } : {}) }, as(u));
const nodesAt = (loc: string) => db.node.findMany({ where: { loc, deletedAt: null } });
const edgesFrom = (nodeId: string) => db.edge.findMany({ where: { sourceId: nodeId, deletedAt: null } });
const totals = async () => ({ nodes: await db.node.count(), edges: await db.edge.count() });

beforeEach(async () => {
  await cleanDb(db);
  org = await db.organization.create({ data: { id: generateId(), name: 'ti-org', urn: 'ti-org' }, select: { id: true, urn: true } });
  admin = await db.user.create({ data: { githubId: 486401, githubUsername: 'ti-admin', handle: 'ti-admin' } });
  contrib = await db.user.create({ data: { githubId: 486402, githubUsername: 'ti-contrib', handle: 'ti-contrib' } });
  writer = await db.user.create({ data: { githubId: 486404, githubUsername: 'ti-writer', handle: 'ti-writer' } });
  stranger = await db.user.create({ data: { githubId: 486403, githubUsername: 'ti-stranger', handle: 'ti-stranger' } });
  await db.orgMember.createMany({ data: [
    { organizationId: org.id, userId: admin.id, role: 'ADMIN' },
    { organizationId: org.id, userId: contrib.id, role: 'READER' },
    { organizationId: org.id, userId: writer.id, role: 'CONTRIBUTOR' },
  ] });
  sysMem = await db.memory.create({ data: { id: generateId(), class: 'system', organizationId: org.id, name: 'eng system', urn: `${org.urn}:eng-system` }, select: { id: true, urn: true } });
  otherMem = await db.memory.create({ data: { id: generateId(), class: 'knowledge', visibility: 'ORGANIZATION', organizationId: org.id, name: 'other', urn: `${org.urn}:other` }, select: { id: true, urn: true } });
  agent = await db.agent.create({
    data: { organizationId: org.id, name: 'eng', urn: `${org.urn}:eng`, visibility: 'ORGANIZATION', systemMemoryId: sysMem.id },
    select: { id: true, urn: true },
  });
  indexId = (await db.node.create({ data: { id: generateId(), memoryId: sysMem.id, loc: 'tasks', name: 'tasks', content: '' } })).id;
  await db.agent.update({ where: { id: agent.id }, data: { tasksIndexRef: indexId } });
});

describe('a valid create with the index input (#4864)', () => {
  it('writes a runnable node and exactly one edge to the Agent\'s tasks index, by id, with the trigger as its name', async () => {
    const node = await create(admin, 'tasks:deploy');
    const row = (await nodesAt('tasks:deploy'))[0];
    expect(row.id).toBe(node.id);
    expect(row.isRunnable).toBe(true);
    const edges = await edgesFrom(row.id);
    expect(edges).toHaveLength(1);
    expect(edges[0].targetId).toBe(indexId);
    expect(edges[0].name).toBe('when asked to deploy');
    const listed = await Q.agentTaskList({}, { ref: agent.id }, as(admin));
    expect(listed.find((t: any) => t.node.id === row.id)?.trigger).toBe('when asked to deploy');
  });

  it('survives a later move of the index: the edge is stored by id, never by URN', async () => {
    await create(admin, 'tasks:deploy');
    await M.moveNode({}, { sourceRef: indexId, targetUrn: nodeUrn(sysMem, 'lists:tasks') }, as(admin));
    const row = (await nodesAt('tasks:deploy'))[0];
    expect((await edgesFrom(row.id))[0].targetId).toBe(indexId);
  });

  it('writes no skill export block by default', async () => {
    await create(admin, 'tasks:deploy');
    const props = ((await nodesAt('tasks:deploy'))[0].properties ?? {}) as Record<string, any>;
    expect(props.exports?.claudeSkill).toBeUndefined();
  });
});

describe('atomicity: a refused step writes nothing (#4864)', () => {
  it('a failure at the edge write leaves no node behind', async () => {
    // The derived edge loc <sourceLoc>:<name>:<targetLoc> is taken by another node's edge, so the edge insert fails.
    const other = await db.node.create({ data: { id: generateId(), memoryId: sysMem.id, loc: 'tasks:other', name: 'other', content: '' } });
    await db.edge.create({ data: { id: generateId(), memoryId: sysMem.id, sourceId: other.id, targetId: indexId, name: 'x', loc: 'tasks:deploy:when asked to deploy:tasks' } });
    const before = await totals();
    const r = await code(create(admin, 'tasks:deploy'));
    expect(r.code).not.toBe('OK');
    expect(await nodesAt('tasks:deploy')).toHaveLength(0);
    expect(await totals()).toEqual(before);
  });

  it.each([
    ['an Agent with no tasksIndexRef', async () => { await db.agent.update({ where: { id: agent.id }, data: { tasksIndexRef: null } }); }, 'tasks:deploy'],
    ['an existing slug', async () => { await db.node.create({ data: { id: generateId(), memoryId: sysMem.id, loc: 'tasks:deploy', name: 'old', content: '' } }); }, 'tasks:deploy'],
    ['an index outside the Agent\'s own system memory', async () => {
      const far = await db.node.create({ data: { id: generateId(), memoryId: otherMem.id, loc: 'tasks', name: 'far', content: '' } });
      await db.agent.update({ where: { id: agent.id }, data: { tasksIndexRef: far.id } });
    }, 'tasks:deploy'],
    ['a malformed slug', async () => {}, 'Tasks Deploy!'],
  ])('%s refuses and writes nothing', async (_label, setup, loc) => {
    await setup();
    const before = await totals();
    const r = await code(create(admin, loc));
    expect(r.code).not.toBe('OK');
    const after = await totals();
    expect(after.edges).toBe(before.edges);
    expect(after.nodes).toBe(before.nodes);
  });

  it('a task created in another memory than the Agent\'s system memory writes no cross-memory edge', async () => {
    const before = await totals();
    const r = await code(create(admin, 'tasks:deploy', INDEX(), {}, otherMem));
    expect(r.code).not.toBe('OK');
    expect(await totals()).toEqual(before);
  });

  it('an unknown Agent refuses and writes nothing', async () => {
    const before = await totals();
    expect((await code(create(admin, 'tasks:deploy', { agent: 'no-such-agent', trigger: 'x' }))).code).not.toBe('OK');
    expect(await totals()).toEqual(before);
  });
});

describe('refusal order: no new oracle (#4864)', () => {
  it('a non-reader gets exactly the missing-memory refusal the door gives without the index input, even when the Agent has no index', async () => {
    await db.agent.update({ where: { id: agent.id }, data: { tasksIndexRef: null } });
    const plain = await code(create(stranger, 'tasks:deploy', null));
    const withIndex = await code(create(stranger, 'tasks:deploy'));
    expect(plain.code).not.toBe('OK');
    expect(withIndex).toEqual(plain);
  });

  it('a non-reader learns nothing of an existing slug: the refusal is the one the door gives without the index input', async () => {
    await db.node.create({ data: { id: generateId(), memoryId: sysMem.id, loc: 'tasks:deploy', name: 'old', content: '' } });
    const plain = await code(create(stranger, 'tasks:deploy', null));
    expect(await code(create(stranger, 'tasks:deploy'))).toEqual(plain);
  });

  it('a reader without write gets the door\'s usual write refusal, byte-identical, with or without the index input', async () => {
    // contrib reads the org-visible memory but cannot write it; the Agent's index lives elsewhere, so the write gate must answer first.
    const plain = await code(create(contrib, 'tasks:deploy', null, {}, otherMem));
    expect(plain.code).not.toBe('OK');
    expect(plain.code).not.toBe('MEMORY_NOT_FOUND');
    expect(await code(create(contrib, 'tasks:deploy', INDEX(), {}, otherMem))).toEqual(plain);
    await db.agent.update({ where: { id: agent.id }, data: { tasksIndexRef: null } });
    expect(await code(create(contrib, 'tasks:deploy', INDEX(), {}, otherMem))).toEqual(plain);
  });
});

describe('writer level on both writes (#4864)', () => {
  it('both are refused below the task writer level, ROLE_WRITER_LEVEL_REQUIRED, and nothing is written', async () => {
    // A contributor cannot write an Agent's system memory at all, so this Agent's "system memory" is an org-visible
    // memory a contributor writes: the memory gate admits them, which the first create proves, and only the rule refuses.
    const index = await db.node.create({ data: { id: generateId(), memoryId: otherMem.id, loc: 'tasks', name: 'tasks', content: '' } });
    await db.agent.update({ where: { id: agent.id }, data: { systemMemoryId: otherMem.id, tasksIndexRef: index.id } });
    expect(await code(create(writer, 'tasks:pre', INDEX(), {}, otherMem))).toEqual({ code: 'OK', message: '' });
    const config = await db.memoryConfig.create({ data: { id: generateId(), memoryId: otherMem.id } });
    await db.nodeRoleRule.create({ data: { id: generateId(), configId: config.id, role: 'task', writers: 'ADMIN' } });
    const before = await totals();
    expect((await code(create(writer, 'tasks:deploy', INDEX(), {}, otherMem))).code).toBe('ROLE_WRITER_LEVEL_REQUIRED');
    expect(await totals()).toEqual(before);
    expect((await code(create(admin, 'tasks:deploy', INDEX(), {}, otherMem))).code).toBe('OK');
  });
});

describe('governed kinds and the role input (#4864)', () => {
  it('a governed base kind through the task door stays refused, with the index input present, and writes nothing', async () => {
    const before = await totals();
    const r = await code(create(admin, 'tasks:deploy', INDEX(), { role: 'review' }));
    expect(r.code).not.toBe('OK');
    expect(await totals()).toEqual(before);
  });

  it('the MCP door takes no role: a stray one is dropped and the node carries none', async () => {
    await mcp(admin, 'hadron_create_task', { urn: nodeUrn(sysMem, 'tasks:deploy'), name: 'Deploy', content: 'steps', agent: agent.id, trigger: 'when deploying', role: 'role-task' });
    expect((await nodesAt('tasks:deploy'))[0].role).toBeNull();
  });
});

describe('skill export is opt-in (#4864)', () => {
  it('with the option, writes an enabled, lint-clean claudeSkill block', async () => {
    await create(admin, 'tasks:deploy', INDEX(), {}, sysMem, { name: 'deploy', description: 'Use when deploying the service.' });
    const props = (await nodesAt('tasks:deploy'))[0].properties as Record<string, any>;
    expect(props.exports.claudeSkill).toEqual({ name: 'deploy', description: 'Use when deploying the service.', enable: true });
  });

  it('a block the skill lint refuses writes nothing', async () => {
    const before = await totals();
    const r = await code(create(admin, 'tasks:deploy', INDEX(), {}, sysMem, { name: 'deploy', description: '<b>bad</b> markup' }));
    expect(r.code).not.toBe('OK');
    expect(await totals()).toEqual(before);
  });
});

describe('GraphQL and MCP agree (#4864)', () => {
  it('the same create writes the same shape, and the same refusals carry the same codes', async () => {
    const out = await mcp(admin, 'hadron_create_task', { urn: nodeUrn(sysMem, 'tasks:viaMcp'), name: 'Via MCP', content: 'steps', agent: agent.id, trigger: 'when deploying' });
    expect(out).toContain('created');
    const row = (await nodesAt('tasks:viaMcp'))[0];
    expect(row.isRunnable).toBe(true);
    const edges = await edgesFrom(row.id);
    expect(edges).toHaveLength(1);
    expect(edges[0].targetId).toBe(indexId);
    expect(edges[0].name).toBe('when deploying');

    await db.agent.update({ where: { id: agent.id }, data: { tasksIndexRef: null } });
    const gql = await code(create(admin, 'tasks:two'));
    const viaMcp = await mcp(admin, 'hadron_create_task', { urn: nodeUrn(sysMem, 'tasks:three'), name: 'Three', content: 's', agent: agent.id, trigger: 'x' });
    expect(gql.code).not.toBe('OK');
    expect(viaMcp).toContain(`[${gql.code.toLowerCase()}]`);
    expect(await nodesAt('tasks:three')).toHaveLength(0);
  });
});
