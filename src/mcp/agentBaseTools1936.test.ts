/**
 * #1936 — an Agent's base and its tasks/processes index pointers, written over
 * MCP: `hadron_agent_set_base` and `hadron_agent_set_index_refs`, with GraphQL
 * parity (cor:dmo:050:14, :15, :16).
 *
 * The tools delegate to `setAgentBase` / `setAgentIndexRefs`, so what is pinned
 * here is that nothing is lost or added on the way: the same gate (whoever
 * manages the child), the same refusals in the same order, each surfaced with
 * the resolver's own code and message (every refusal case calls the resolver
 * and the tool on the same state and compares), and the same three states for
 * an index pointer (omitted leaves it, null clears it, a value sets it),
 * through the registered schema as well as the handler.
 *
 * The parity oracle is the GraphQL WIRE (Andi's P2 on #1943): each refusal is
 * also run as a real GraphQL request through `formatGraphQLError`, the server's
 * own formatter, so a code the formatter assigns (URN_NOT_QUALIFIED, the
 * ambiguous legacy alias) is what the tool must say too, exactly as written.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApolloServer } from '@apollo/server';
import { db } from '../integrations/db/client.js';
import { cleanDb, createDbAgentOrgGrant } from '../test/helpers.js';
import { generateId } from '../lib/id.js';
import { resolvers, type Context } from '../api/graphql/schema/resolvers.js';
import { typeDefs } from '../api/graphql/schema/typeDefs.js';
import { formatGraphQLError } from '../api/graphql/formatError.js';
import { createTestableMcpServer } from './server.js';

vi.mock('../integrations/github/writeNodeToGit.js', () => ({
  writeNodeToGit: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../integrations/github/syncGraphFromGithub.js', () => ({
  syncGraphFromGithub: vi.fn().mockResolvedValue({ error: null }),
}));

const graphql = new ApolloServer<Context>({ typeDefs, resolvers, formatError: formatGraphQLError });
const ctxOf = (userId: string): Context => ({ db, userId, roles: ['READER'] });
const server = (userId: string) => createTestableMcpServer({ userId, roles: ['READER'], clientId: `user:${userId}` });
const call = async (userId: string, tool: string, args: Record<string, unknown>) => {
  const out = await server(userId).callTool(tool, args) as { isError?: boolean; content: Array<{ text: string }> };
  return { isError: out.isError === true, text: out.content.map((c) => c.text).join('\n') };
};

/** What GraphQL sends a client for this mutation on the current state: `[code] message`, off the wire. */
async function wireRefusal(userId: string, query: string, variables: Record<string, unknown>): Promise<string> {
  const res = await graphql.executeOperation({ query, variables }, { contextValue: ctxOf(userId) });
  const errors = res.body.kind === 'single' ? res.body.singleResult.errors : undefined;
  expect(errors?.length, 'expected GraphQL to refuse').toBe(1);
  const code = errors![0]!.extensions?.code;
  expect(code, 'a typed refusal').toBeTruthy();
  expect(code).not.toBe('INTERNAL_SERVER_ERROR');
  return `[${String(code)}] ${errors![0]!.message}`;
}
const wireBase = (userId: string, ref: string, baseRef: string | null) =>
  wireRefusal(userId, 'mutation($ref: ID!, $baseRef: ID) { setAgentBase(ref: $ref, baseRef: $baseRef) { id } }', { ref, baseRef });
const wireIndex = (userId: string, args: { ref: string; tasksIndexRef?: string | null; processesIndexRef?: string | null }) =>
  wireRefusal(userId, 'mutation($ref: ID!, $tasksIndexRef: ID, $processesIndexRef: ID) { setAgentIndexRefs(ref: $ref, tasksIndexRef: $tasksIndexRef, processesIndexRef: $processesIndexRef) { id } }', args);

/** The tool refuses exactly as GraphQL's wire does, code as written, and nothing changes. */
async function expectParity(
  userId: string,
  tool: string,
  args: Record<string, unknown>,
  wire: () => Promise<string>,
  code: string,
) {
  const before = await db.agent.findMany({ orderBy: { id: 'asc' }, select: { id: true, extendsAgentId: true, tasksIndexRef: true, processesIndexRef: true } });
  const expected = await wire();
  expect(expected.startsWith(`[${code}] `), expected).toBe(true);
  const got = await call(userId, tool, args);
  expect(got.isError).toBe(true);
  expect(got.text).toBe(expected);
  const after = await db.agent.findMany({ orderBy: { id: 'asc' }, select: { id: true, extendsAgentId: true, tasksIndexRef: true, processesIndexRef: true } });
  expect(after).toEqual(before);
}

let n: number;
let orgA: { id: string; urn: string };
let orgB: { id: string; urn: string };
let adminA: string;
let memberA: string;
let adminB: string;
let ana: string;

async function user(handle: string): Promise<string> {
  return (await db.user.create({ data: { id: generateId(), name: handle, handle: `${handle}-${n}`, roles: ['READER'] } })).id;
}

async function orgAgent(org: { id: string; urn: string }, slug: string, visibility: 'PUBLIC' | 'ORGANIZATION' = 'ORGANIZATION') {
  const mem = await db.memory.create({ data: { class: 'system', organizationId: org.id, name: `${slug} system`, urn: `${org.urn}:${slug}-system` } });
  const a = await db.agent.create({ data: { organizationId: org.id, name: slug, urn: `${org.urn}:${slug}`, visibility, systemMemoryId: mem.id } });
  return { id: a.id, urn: a.urn, mem: mem.id, memUrn: mem.urn };
}

const baseOf = async (id: string) => (await db.agent.findUniqueOrThrow({ where: { id } })).extendsAgentId;
const refsOf = async (id: string) => db.agent.findUniqueOrThrow({ where: { id }, select: { tasksIndexRef: true, processesIndexRef: true } });
const link = (childId: string, baseId: string) => db.agent.update({ where: { id: childId }, data: { extendsAgentId: baseId } });

beforeEach(async () => {
  await cleanDb(db);
  n = Math.floor(Math.random() * 1_000_000);
  orgA = await db.organization.create({ data: { name: 'A', urn: `mcp-base-a-${n}.example` }, select: { id: true, urn: true } });
  orgB = await db.organization.create({ data: { name: 'B', urn: `mcp-base-b-${n}.example` }, select: { id: true, urn: true } });
  adminA = await user('admin-a');
  memberA = await user('member-a');
  adminB = await user('admin-b');
  ana = await user('ana');
  await db.orgMember.create({ data: { organizationId: orgA.id, userId: adminA, role: 'ADMIN' } });
  await db.orgMember.create({ data: { organizationId: orgA.id, userId: memberA, role: 'READER' } });
  await db.orgMember.create({ data: { organizationId: orgB.id, userId: adminB, role: 'ADMIN' } });
});

describe('the tools exist, and write (so they carry the caller-session gate)', () => {
  it('both are registered, each with the session argument every writing tool takes', () => {
    const s = server(adminA);
    expect(s.toolNames()).toEqual(expect.arrayContaining(['hadron_agent_set_base', 'hadron_agent_set_index_refs']));
    for (const tool of ['hadron_agent_set_base', 'hadron_agent_set_index_refs']) {
      expect(() => s.toolParamSchema(tool, 'session')).not.toThrow();
    }
  });
});

describe('hadron_agent_set_base — set, change, clear (cor:dmo:050:14)', () => {
  it('whoever manages the child sets a base by id, changes it by URN, and clears it with null', async () => {
    const engineer = await orgAgent(orgA, 'engineer');
    const other = await orgAgent(orgA, 'other');
    const backend = await orgAgent(orgA, 'backend-engineer');

    const set = await call(adminA, 'hadron_agent_set_base', { agentRef: backend.id, baseRef: engineer.id });
    expect(set.isError).toBe(false);
    expect(await baseOf(backend.id)).toBe(engineer.id);
    expect(set.text).toContain(`hrn:agent:${backend.urn}`);
    expect(set.text).toContain(`Base: hrn:agent:${engineer.urn}`);

    const changed = await call(adminA, 'hadron_agent_set_base', { agentRef: `hrn:agent:${backend.urn}`, baseRef: `hrn:agent:${other.urn}` });
    expect(changed.isError).toBe(false);
    expect(await baseOf(backend.id)).toBe(other.id);

    const cleared = await call(adminA, 'hadron_agent_set_base', { agentRef: backend.id, baseRef: null });
    expect(cleared.isError).toBe(false);
    expect(await baseOf(backend.id)).toBeNull();
    expect(cleared.text).toContain('Base: none');
  });

  it('the result is what GraphQL returns: the same base, as the resolver wrote it', async () => {
    const engineer = await orgAgent(orgA, 'engineer');
    const backend = await orgAgent(orgA, 'backend-engineer');
    await call(adminA, 'hadron_agent_set_base', { agentRef: backend.id, baseRef: engineer.id });
    const grant = await db.agentOrgGrant.findUnique({ where: { orgId_agentId: { orgId: orgA.id, agentId: engineer.id } } });
    expect(grant?.activatedAt).not.toBeNull();
  });

  it('baseRef is required: an omitted base is never read as a clear', () => {
    const schema = server(adminA).toolParamSchema('hadron_agent_set_base', 'baseRef');
    expect(() => schema.parse(undefined)).toThrow();
    expect(schema.parse(null)).toBeNull();
  });
});

describe('hadron_agent_set_base — every refusal, as the resolver gives it, in its order', () => {
  const tool = 'hadron_agent_set_base';
  const viaResolver = (userId: string, ref: string, baseRef: string | null) => () => wireBase(userId, ref, baseRef);

  it('a member who does not manage the child', async () => {
    const engineer = await orgAgent(orgA, 'engineer');
    const backend = await orgAgent(orgA, 'backend-engineer');
    const err = await wireBase(memberA, backend.id, engineer.id);
    const got = await call(memberA, tool, { agentRef: backend.id, baseRef: engineer.id });
    expect(got).toEqual({ isError: true, text: err });
    expect(await baseOf(backend.id)).toBeNull();
  });

  it('AGENT_NOT_FOUND: a retired base', async () => {
    const engineer = await orgAgent(orgA, 'engineer');
    const backend = await orgAgent(orgA, 'backend-engineer');
    await db.agent.update({ where: { id: engineer.id }, data: { deletedAt: new Date() } });
    await expectParity(adminA, tool, { agentRef: backend.id, baseRef: engineer.id }, viaResolver(adminA, backend.id, engineer.id), 'AGENT_NOT_FOUND');
  });

  it('AGENT_NOT_FOUND: another org\'s non-public Agent is concealed', async () => {
    const engineer = await orgAgent(orgA, 'engineer');
    const bAgent = await orgAgent(orgB, 'b-engineer');
    await expectParity(adminB, tool, { agentRef: bAgent.id, baseRef: engineer.id }, viaResolver(adminB, bAgent.id, engineer.id), 'AGENT_NOT_FOUND');
  });

  it('AGENT_ORG_GRANT_REQUIRED: another org\'s PUBLIC Agent with no grant', async () => {
    const engineer = await orgAgent(orgA, 'engineer', 'PUBLIC');
    const bAgent = await orgAgent(orgB, 'b-engineer');
    await expectParity(adminB, tool, { agentRef: bAgent.id, baseRef: engineer.id }, viaResolver(adminB, bAgent.id, engineer.id), 'AGENT_ORG_GRANT_REQUIRED');
  });

  it('AGENT_ORG_GRANT_INACTIVE: a revoked grant', async () => {
    const engineer = await orgAgent(orgA, 'engineer');
    const backend = await orgAgent(orgA, 'backend-engineer');
    await createDbAgentOrgGrant(db, orgA.id, engineer.id, { revokedAt: new Date() });
    await expectParity(adminA, tool, { agentRef: backend.id, baseRef: engineer.id }, viaResolver(adminA, backend.id, engineer.id), 'AGENT_ORG_GRANT_INACTIVE');
  });

  it('AGENT_SUBSCRIPTION_REQUIRED: a user-owned child and an org\'s PUBLIC Agent', async () => {
    const engineer = await orgAgent(orgA, 'engineer', 'PUBLIC');
    const mine = await db.agent.create({ data: { ownerUserId: ana, name: 'helper', urn: `u${n}-helper:helper`, visibility: 'PERSONAL' } });
    await expectParity(ana, tool, { agentRef: mine.id, baseRef: engineer.id }, viaResolver(ana, mine.id, engineer.id), 'AGENT_SUBSCRIPTION_REQUIRED');
  });

  it('AGENT_BASE_CYCLE', async () => {
    const engineer = await orgAgent(orgA, 'engineer');
    const backend = await orgAgent(orgA, 'backend-engineer');
    await link(backend.id, engineer.id);
    await expectParity(adminA, tool, { agentRef: engineer.id, baseRef: backend.id }, viaResolver(adminA, engineer.id, backend.id), 'AGENT_BASE_CYCLE');
  });

  it('AGENT_BASE_CHAIN_TOO_LONG', async () => {
    const [a, b, c, d, e] = await Promise.all(['a', 'b', 'c', 'd', 'e'].map((s) => orgAgent(orgA, s)));
    await link(c.id, d.id);
    await link(b.id, c.id);
    await link(a.id, b.id);
    await expectParity(adminA, tool, { agentRef: d.id, baseRef: e.id }, viaResolver(adminA, d.id, e.id), 'AGENT_BASE_CHAIN_TOO_LONG');
  });

  it('the grant comes before the chain: a concealed base never answers with a cycle', async () => {
    const engineer = await orgAgent(orgA, 'engineer');
    const bAgent = await orgAgent(orgB, 'b-engineer');
    await createDbAgentOrgGrant(db, orgA.id, bAgent.id);
    await link(engineer.id, bAgent.id);
    await expectParity(adminB, tool, { agentRef: bAgent.id, baseRef: engineer.id }, viaResolver(adminB, bAgent.id, engineer.id), 'AGENT_NOT_FOUND');
  });

  it('an unknown child', async () => {
    const engineer = await orgAgent(orgA, 'engineer');
    const ghost = generateId();
    await expectParity(adminA, tool, { agentRef: ghost, baseRef: engineer.id }, viaResolver(adminA, ghost, engineer.id), 'AGENT_NOT_FOUND');
  });
});

describe('hadron_agent_set_index_refs — the three states (cor:dmo:050:15, :16)', () => {
  let backend: Awaited<ReturnType<typeof orgAgent>>;
  const ids: Record<string, string> = {};
  const nodeUrn = (loc: string) => `hrn:node:${backend.memUrn}:${loc}`;

  beforeEach(async () => {
    backend = await orgAgent(orgA, 'backend-engineer');
    for (const loc of ['tasks', 'processes', 'tasks-two']) {
      ids[loc] = (await db.node.create({ data: { memoryId: backend.mem, loc, name: loc, content: `${loc} index` } })).id;
    }
    await db.agent.update({ where: { id: backend.id }, data: { tasksIndexRef: ids.tasks, processesIndexRef: ids.processes } });
  });

  it('the schema keeps omitted, null and a value apart for both pointers', () => {
    const s = server(adminA);
    for (const param of ['tasksIndexRef', 'processesIndexRef']) {
      const schema = s.toolParamSchema('hadron_agent_set_index_refs', param);
      expect(schema.parse(undefined)).toBeUndefined();
      expect(schema.parse(null)).toBeNull();
      expect(schema.parse('x')).toBe('x');
    }
  });

  it('a value sets one pointer by URN, and the omitted one stays as it was', async () => {
    const out = await call(adminA, 'hadron_agent_set_index_refs', { agentRef: backend.id, tasksIndexRef: nodeUrn('tasks-two') });
    expect(out.isError).toBe(false);
    expect(await refsOf(backend.id)).toEqual({ tasksIndexRef: ids['tasks-two'], processesIndexRef: ids.processes });
    expect(out.text).toContain(`Tasks index: ${nodeUrn('tasks-two')}`);
    expect(out.text).toContain(`Processes index: ${nodeUrn('processes')}`);
  });

  it('null clears one pointer, and the omitted one stays', async () => {
    const out = await call(adminA, 'hadron_agent_set_index_refs', { agentRef: backend.id, processesIndexRef: null });
    expect(out.isError).toBe(false);
    expect(await refsOf(backend.id)).toEqual({ tasksIndexRef: ids.tasks, processesIndexRef: null });
    expect(out.text).toContain('Processes index: none');
  });

  it('both in one call, one set by id and one cleared', async () => {
    await call(adminA, 'hadron_agent_set_index_refs', { agentRef: backend.id, tasksIndexRef: ids['tasks-two'], processesIndexRef: null });
    expect(await refsOf(backend.id)).toEqual({ tasksIndexRef: ids['tasks-two'], processesIndexRef: null });
  });

  it('both omitted changes nothing', async () => {
    const out = await call(adminA, 'hadron_agent_set_index_refs', { agentRef: backend.id });
    expect(out.isError).toBe(false);
    expect(await refsOf(backend.id)).toEqual({ tasksIndexRef: ids.tasks, processesIndexRef: ids.processes });
  });
});

describe('hadron_agent_set_index_refs — refusals, as the resolver gives them', () => {
  let backend: Awaited<ReturnType<typeof orgAgent>>;
  let index: string;

  beforeEach(async () => {
    backend = await orgAgent(orgA, 'backend-engineer');
    index = (await db.node.create({ data: { memoryId: backend.mem, loc: 'tasks', name: 'tasks', content: 'index' } })).id;
    await db.agent.update({ where: { id: backend.id }, data: { tasksIndexRef: index } });
  });

  it('a member who does not manage the Agent', async () => {
    const err = await wireIndex(memberA, { ref: backend.id, tasksIndexRef: null });
    expect(await call(memberA, 'hadron_agent_set_index_refs', { agentRef: backend.id, tasksIndexRef: null })).toEqual({ isError: true, text: err });
    expect((await refsOf(backend.id)).tasksIndexRef).toBe(index);
  });

  it('NODE_NOT_FOUND: a target the manager can\'t read', async () => {
    const theirs = await db.memory.create({ data: { class: 'personal', userId: memberA, ownerUserId: memberA, name: 'm', urn: `${orgA.urn}:m-${n}` } });
    const hidden = (await db.node.create({ data: { memoryId: theirs.id, loc: 'idx', name: 'idx', content: 'x' } })).id;
    await expectParity(adminA, 'hadron_agent_set_index_refs', { agentRef: backend.id, tasksIndexRef: hidden },
      () => wireIndex(adminA, { ref: backend.id, tasksIndexRef: hidden }), 'NODE_NOT_FOUND');
  });

  it('AGENT_NOT_FOUND: a retired Agent', async () => {
    await db.agent.update({ where: { id: backend.id }, data: { deletedAt: new Date() } });
    await expectParity(adminA, 'hadron_agent_set_index_refs', { agentRef: backend.id, tasksIndexRef: null },
      () => wireIndex(adminA, { ref: backend.id, tasksIndexRef: null }), 'AGENT_NOT_FOUND');
  });
});

describe('codes the GraphQL formatter assigns reach the tool exactly as on the wire (Andi\'s P2 on #1943)', () => {
  let backend: Awaited<ReturnType<typeof orgAgent>>;
  const legacy = () => `hrn:agent:old-${n}.example::dup`;

  beforeEach(async () => {
    backend = await orgAgent(orgA, 'backend-engineer');
    // Two live Agents answering one legacy URN: resolving it must refuse loudly (#697).
    for (const k of [1, 2]) {
      await db.agent.create({ data: { organizationId: orgA.id, name: `dup-${k}`, urn: `${orgA.urn}:dup-${k}`, legacyUrn: `old-${n}.example:dup` } });
    }
  });

  it('URN_NOT_QUALIFIED: a bare slug as the child, both tools', async () => {
    await expectParity(adminA, 'hadron_agent_set_base', { agentRef: 'backend-engineer', baseRef: null },
      () => wireBase(adminA, 'backend-engineer', null), 'URN_NOT_QUALIFIED');
    await expectParity(adminA, 'hadron_agent_set_index_refs', { agentRef: 'backend-engineer', tasksIndexRef: null },
      () => wireIndex(adminA, { ref: 'backend-engineer', tasksIndexRef: null }), 'URN_NOT_QUALIFIED');
  });

  it('URN_NOT_QUALIFIED: a bare slug as the base', async () => {
    await expectParity(adminA, 'hadron_agent_set_base', { agentRef: backend.id, baseRef: 'engineer' },
      () => wireBase(adminA, backend.id, 'engineer'), 'URN_NOT_QUALIFIED');
  });

  it('the ambiguous legacy alias, as the child (both tools) and as the base', async () => {
    await expectParity(adminA, 'hadron_agent_set_base', { agentRef: legacy(), baseRef: null },
      () => wireBase(adminA, legacy(), null), 'AmbiguousLegacyUrnError');
    await expectParity(adminA, 'hadron_agent_set_index_refs', { agentRef: legacy(), processesIndexRef: null },
      () => wireIndex(adminA, { ref: legacy(), processesIndexRef: null }), 'AmbiguousLegacyUrnError');
    await expectParity(adminA, 'hadron_agent_set_base', { agentRef: backend.id, baseRef: legacy() },
      () => wireBase(adminA, backend.id, legacy()), 'AmbiguousLegacyUrnError');
  });
});
