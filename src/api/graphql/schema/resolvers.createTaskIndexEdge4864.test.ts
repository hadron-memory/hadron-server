/**
 * #4864 — the task door writes a role task AND its tasks-index edge in one transaction.
 *
 * `createTaskNode(input, index)` / `hadron_create_task` (agent, trigger) is the SAME door extended, never a second one
 * (cor:acl:130:03). With the index input the door writes the runnable node and one edge from it to the Agent's
 * `tasksIndexRef` node (cor:dmo:050:15), by id, in the door's transaction: either both exist or neither does. The
 * writer level (cor:acl:010:03) judges the node write, and the edge's source is that node, in the same transaction.
 *
 * Fixture: an org with an Agent `eng` whose system memory holds the `tasks` index (pointed at by `tasksIndexRef`);
 * `admin` (org ADMIN) writes it, `contrib` (org READER) reads org-visible memory but cannot write it, `writer` (CONTRIBUTOR) writes org-visible memory, `stranger` reads nothing.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { GraphQLError } from 'graphql';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { deriveEdgeLoc } from '../../../lib/edgeLoc.js';
import { resolvers, type Context } from './resolvers.js';
import { createTestableMcpServer } from '../../../mcp/server.js';
import { runAuthContext } from '../../../lib/auth/runPrincipal.js';
import { attestedAuthoring } from '../../../lib/authoringAttestation.js';
import { writeNodeCore } from './resolvers.mutation.node.js';

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
// loc-scope-ok: this test's two fixture memories only
const nodesAt = (loc: string) => db.node.findMany({ where: { loc, memoryId: { in: [sysMem.id, otherMem.id] }, deletedAt: null } });
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
    const made = await create(admin, 'tasks:deploy');
    await M.moveNode({}, { sourceRef: indexId, targetUrn: nodeUrn(sysMem, 'lists:tasks') }, as(admin));
    expect((await db.node.findUniqueOrThrow({ where: { id: indexId } })).loc).toBe('lists:tasks');
    expect((await edgesFrom(made.id))[0].targetId).toBe(indexId);
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
    await db.edge.create({ data: { id: generateId(), memoryId: sysMem.id, sourceId: other.id, targetId: indexId, name: 'x', loc: deriveEdgeLoc('tasks:deploy', 'when asked to deploy', 'tasks') } });
    const before = await totals();
    const r = await code(create(admin, 'tasks:deploy'));
    expect(r.code).toBe('EDGE_LOC_CONFLICT');
    expect(await nodesAt('tasks:deploy')).toHaveLength(0);
    expect(await totals()).toEqual(before);
  });

  it.each([
    ['an Agent with no tasksIndexRef', async () => { await db.agent.update({ where: { id: agent.id }, data: { tasksIndexRef: null } }); }, 'tasks:deploy', 'TASKS_INDEX_NOT_SET'],
    ['an existing slug', async () => { await db.node.create({ data: { id: generateId(), memoryId: sysMem.id, loc: 'tasks:deploy', name: 'old', content: '' } }); }, 'tasks:deploy', 'NodeLocConflictError'],
    ['an index outside the Agent\'s own system memory', async () => {
      const far = await db.node.create({ data: { id: generateId(), memoryId: otherMem.id, loc: 'tasks', name: 'far', content: '' } });
      await db.agent.update({ where: { id: agent.id }, data: { tasksIndexRef: far.id } });
    }, 'tasks:deploy', 'TASKS_INDEX_OUT_OF_SCOPE'],
    ['a deleted index node', async () => { await db.node.update({ where: { id: indexId }, data: { deletedAt: new Date() } }); }, 'tasks:deploy', 'TASKS_INDEX_OUT_OF_SCOPE'],
    ['a malformed slug', async () => {}, 'Tasks Deploy!', 'BAD_USER_INPUT'],
  ])('%s refuses with its own code and writes nothing', async (_label, setup, loc, expected) => {
    await setup();
    const before = await totals();
    const r = await code(create(admin, loc));
    expect(r.code).toBe(expected);
    expect(await totals()).toEqual(before);
  });

  it.each(['', '   '])('a blank trigger (%j) refuses with BAD_USER_INPUT and writes nothing', async (trigger) => {
    const before = await totals();
    expect((await code(create(admin, 'tasks:deploy', { agent: agent.id, trigger }))).code).toBe('BAD_USER_INPUT');
    expect(await totals()).toEqual(before);
  });

  it('an existing slug names the task and says to extend it', async () => {
    await db.node.create({ data: { id: generateId(), memoryId: sysMem.id, loc: 'tasks:deploy', name: 'old', content: '' } });
    const r = await code(create(admin, 'tasks:deploy'));
    expect(r.message).toContain('tasks:deploy');
    expect(r.message).toContain('hadron_update_task');
  });

  it('an Agent the caller cannot read answers as absent, and writes nothing', async () => {
    const hidden = await db.agent.create({
      data: { name: 'hidden', urn: `ti-hidden-${stranger.id}`, visibility: 'PERSONAL', ownerUserId: stranger.id, systemMemoryId: sysMem.id, tasksIndexRef: indexId },
    });
    const before = await totals();
    const unknown = await code(create(admin, 'tasks:a', { agent: generateId(), trigger: 'x' }));
    const malformed = await code(create(admin, 'tasks:m', { agent: 'no-such-agent', trigger: 'x' }));
    const unreadable = await code(create(admin, 'tasks:b', { agent: hidden.id, trigger: 'x' }));
    expect(unknown.code).toBe('NOT_FOUND');
    expect(malformed.message).toContain('not fully qualified');   // an input-shape refusal, never read as "not found"
    expect(unreadable.code).toBe('NOT_FOUND');
    expect(await totals()).toEqual(before);
  });

  it('a task created in another memory than the Agent\'s system memory writes no cross-memory edge', async () => {
    const before = await totals();
    const r = await code(create(admin, 'tasks:deploy', INDEX(), {}, otherMem));
    expect(r.code).toBe('TASKS_INDEX_OUT_OF_SCOPE');
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
    expect(r.code).toBe('ROLE_GOVERNED');
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
    expect(r.code).toBe('BAD_USER_INPUT');
    expect(r.message).toContain('skill lint');
    expect(await totals()).toEqual(before);
  });
});

describe('GraphQL and MCP agree (#4864)', () => {
  it('the skill option on MCP writes the same enabled block, and a lint-refused block writes nothing, as on GraphQL', async () => {
    await mcp(admin, 'hadron_create_task', { urn: nodeUrn(sysMem, 'tasks:skilled'), name: 'Skilled', content: 'steps', agent: agent.id, trigger: 'when deploying', skill: { name: 'deploy', description: 'Use when deploying the service.' } });
    const props = (await nodesAt('tasks:skilled'))[0].properties as Record<string, any>;
    expect(props.exports.claudeSkill).toEqual({ name: 'deploy', description: 'Use when deploying the service.', enable: true });
    const before = await totals();
    const out = await mcp(admin, 'hadron_create_task', { urn: nodeUrn(sysMem, 'tasks:badskill'), name: 'Bad', content: 'steps', skill: { name: 'deploy', description: '<b>bad</b> markup' } });
    expect(out).toContain('[bad_user_input]');
    expect(await totals()).toEqual(before);
  });

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

describe('an App write grant never reaches the index edge (#4864)', () => {
  it('a userless run of the granted App cannot create a task WITH an index edge, though the same create without one is a grant write', async () => {
    // cor:agt:010:01: a prefix grant permits node create and update, and "no edges outside the prefix" — the index edge
    // is an edge the write carries, so the grant arm must not answer for it.
    const app = await db.app.create({ data: { name: 'Grant App', urn: 'ti-org:grantapp', organizationId: org.id } });
    await db.appMember.create({ data: { appId: app.id, userId: admin.id, role: 'owner' } });
    await db.appMemoryWriteGrant.create({ data: { appId: app.id, memoryId: otherMem.id, prefix: 'tasks', grantedBy: admin.id } });
    const run = () => ({ db, ...runAuthContext({ id: generateId(), appId: app.id, userId: null, organizationId: org.id }) }) as never;
    const door = (loc: string, taskIndex?: { agent: string; trigger: string }) =>
      writeNodeCore({ memoryId: otherMem.id, loc, name: loc, isRunnable: true, content: 'x' } as never, run(), 'create',
        { authoring: attestedAuthoring(null), ownsKind: 'task', governedContext: 'node-write', ...(taskIndex ? { taskIndex } : {}) });
    expect(await code(door('tasks:control'))).toEqual({ code: 'OK', message: '' });
    const before = await totals();
    expect((await code(door('tasks:deploy', INDEX()))).code).toBe('FORBIDDEN');
    expect(await totals()).toEqual(before);
  });
});

describe('the remaining input paths of the extended door (#4864, blind F3)', () => {
  it('names the Agent by URN, and trims the trigger', async () => {
    await create(admin, 'tasks:deploy', { agent: `hrn:agent:${agent.urn}`, trigger: '  when deploying  ' });
    const row = (await nodesAt('tasks:deploy'))[0];
    const edges = await edgesFrom(row.id);
    expect(edges).toHaveLength(1);
    expect(edges[0].name).toBe('when deploying');
  });

  it('a create over a soft-deleted task at the loc still writes the edge, to the resurrected node', async () => {
    const old = await db.node.create({ data: { id: generateId(), memoryId: sysMem.id, loc: 'tasks:deploy', name: 'old', content: '', deletedAt: new Date() } });
    const made = await create(admin, 'tasks:deploy');
    expect(made.id).toBe(old.id);
    const edges = await edgesFrom(made.id);
    expect(edges).toHaveLength(1);
    expect(edges[0].targetId).toBe(indexId);
  });

  it('caller edges and the index edge are both written', async () => {
    const note = await db.node.create({ data: { id: generateId(), memoryId: sysMem.id, loc: 'notes:n', name: 'n', content: '' } });
    const made = await create(admin, 'tasks:deploy', INDEX(), { edges: [{ targetId: note.id, name: 'see also' }] });
    const edges = await edgesFrom(made.id);
    expect(edges.map((e) => e.targetId).sort()).toEqual([indexId, note.id].sort());
  });

  it('a blank skill name or description is refused by the skill lint and writes nothing', async () => {
    const before = await totals();
    expect((await code(create(admin, 'tasks:deploy', INDEX(), {}, sysMem, { name: '', description: 'Use when deploying.' }))).code).toBe('BAD_USER_INPUT');
    expect((await code(create(admin, 'tasks:deploy', INDEX(), {}, sysMem, { name: 'deploy', description: '' }))).code).toBe('BAD_USER_INPUT');
    expect(await totals()).toEqual(before);
  });

  it('the skill block merges over the caller\'s own exports, keeping other hosts and keys', async () => {
    await create(admin, 'tasks:deploy', INDEX(), { properties: { keep: 'me', exports: { codexSkill: { name: 'c', description: 'Use when c.', enable: true } } } }, sysMem, { name: 'deploy', description: 'Use when deploying the service.' });
    const props = (await nodesAt('tasks:deploy'))[0].properties as Record<string, any>;
    expect(props.keep).toBe('me');
    expect(props.exports.codexSkill.name).toBe('c');
    expect(props.exports.claudeSkill).toEqual({ name: 'deploy', description: 'Use when deploying the service.', enable: true });
  });

  it('properties that are not an object are refused when the skill option is given, never silently replaced', async () => {
    const before = await totals();
    const r = await code(create(admin, 'tasks:deploy', INDEX(), { properties: 'nope' }, sysMem, { name: 'deploy', description: 'Use when deploying the service.' }));
    expect(r.code).toBe('BAD_USER_INPUT');
    expect(await totals()).toEqual(before);
  });

  it('MCP: agent without trigger (or trigger without agent) is refused before any write, with the door\'s own message', async () => {
    const before = await totals();
    for (const args of [{ agent: agent.id }, { trigger: 'when deploying' }]) {
      const out = await mcp(admin, 'hadron_create_task', { urn: nodeUrn(sysMem, 'tasks:half'), name: 'Half', content: 's', ...args });
      expect(out).toContain('"agent" and "trigger" go together');
    }
    expect(await totals()).toEqual(before);
  });
});

describe('a database fault never reads as "agent not found" (#4864, blind F1)', () => {
  it('the fault propagates as itself and nothing is written', async () => {
    const before = await totals();
    const spy = vi.spyOn(db.agent, 'findUnique').mockRejectedValueOnce(new Error('connection lost'));
    try {
      const r = await code(create(admin, 'tasks:deploy'));
      expect(r.code).toBe('ERR');
      expect(r.message).toBe('connection lost');
    } finally { spy.mockRestore(); }
    expect(await totals()).toEqual(before);
  });
});

describe('trigger bounds and the skill-lint order (#4864, local F2/F3)', () => {
  it('a trigger over 200 characters, or with a line break, is refused and writes nothing', async () => {
    const before = await totals();
    expect((await code(create(admin, 'tasks:deploy', { agent: agent.id, trigger: 'x'.repeat(201) }))).code).toBe('BAD_USER_INPUT');
    expect((await code(create(admin, 'tasks:deploy', { agent: agent.id, trigger: 'when\ndeploying' }))).code).toBe('BAD_USER_INPUT');
    expect(await totals()).toEqual(before);
    expect((await code(create(admin, 'tasks:deploy', { agent: agent.id, trigger: 'x'.repeat(200) }))).code).toBe('OK');
  });

  it('the skill lint judges only the caller\'s own input, so an outsider\'s invalid skill answers BAD_USER_INPUT before the memory gate: a decision, pinned', async () => {
    const r = await code(create(stranger, 'tasks:deploy', INDEX(), {}, sysMem, { name: 'deploy', description: '<b>bad</b>' }));
    expect(r.code).toBe('BAD_USER_INPUT');
    // and a VALID skill from the same outsider gets the missing-memory refusal, exactly as without the option
    const plain = await code(create(stranger, 'tasks:deploy', null));
    expect(await code(create(stranger, 'tasks:deploy', INDEX(), {}, sysMem, { name: 'deploy', description: 'Use when deploying.' }))).toEqual(plain);
  });
});
