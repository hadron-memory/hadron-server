/**
 * #2043 S6 PR 3 — a direct read of a boot-prompt node shows its variables as
 * written (cor:dmo:150:08) while its includes still resolve (cor:dmo:150:03).
 * Red-first on main a2463194: today every non-raw read renders Mustache over
 * the node's data and the memory's default data, boot prompt or not.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApolloServer } from '@apollo/server';
import { db } from '../../integrations/db/client.js';
import { cleanDb } from '../../test/helpers.js';
import { generateId } from '../id.js';
import { typeDefs } from '../../api/graphql/schema/typeDefs.js';
import { resolvers, type Context } from '../../api/graphql/schema/resolvers.js';
import { createTestableMcpServer } from '../../mcp/server.js';
import { COMPILED_BOOT_PROMPT_NODE_TYPE } from '../bootPrompt.js';

vi.mock('../../integrations/github/writeNodeToGit.js', () => ({
  writeNodeToGit: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../../integrations/github/syncGraphFromGithub.js', () => ({
  syncGraphFromGithub: vi.fn().mockResolvedValue({ error: null }),
}));

const server = new ApolloServer<Context>({ typeDefs, resolvers });
async function run(query: string, ctx: Context, variables?: Record<string, unknown>) {
  const res = await server.executeOperation({ query, variables }, { contextValue: ctx });
  if (res.body.kind !== 'single') throw new Error('unexpected incremental result');
  return res.body.singleResult;
}

let memoryId: string;
let memoryUrn: string;
let admin: { id: string };
const gql = (): Context => ({ db, userId: admin.id, roles: [] });
const mcp = () => createTestableMcpServer({ userId: admin.id, roles: [], clientId: `user:${admin.id}` });
const urn = (loc: string) => `hrn:node:${memoryUrn}:${loc}`;
const mk = (loc: string, content: string | null, extra: Record<string, unknown> = {}) =>
  db.node.create({ data: { id: generateId(), memoryId, loc, name: loc, content, ...extra } });

const PLATFORM = 'You are {{worker.name}} ({{worker.role}}), session {{session.llmModel}}.';
const LEGACY = 'Hello {{greeting}} and {{data.greeting}}.';

beforeEach(async () => {
  await cleanDb(db);
  const org = await db.organization.create({ data: { id: generateId(), name: 'Bp Org', urn: 'bp.example' } });
  admin = await db.user.create({ data: { githubId: 204301, githubUsername: 'bp-admin', handle: 'bp-admin', roles: [] } });
  await db.orgMember.create({ data: { organizationId: org.id, userId: admin.id, role: 'ADMIN' } });
  const m = await resolvers.Mutation.createMemory(null, { orgId: org.id, name: 'bp' }, gql());
  memoryId = m.id; memoryUrn = m.urn;
  await mk('data', null, { data: { greeting: 'DEFAULT', worker: { name: 'DATA-WORKER' } } });
  await mk('inc', 'INCLUDED {{greeting}}');
});

const NODE_Q = `query($ref: ID!, $raw: Boolean) { node(ref: $ref, raw: $raw) { content } }`;
const read = async (loc: string, raw?: boolean) =>
  ((await run(NODE_Q, gql(), { ref: urn(loc), raw })).data as { node: { content: string } }).node.content;

describe('a direct read of a boot-prompt node (cor:dmo:150:08)', () => {
  it('GraphQL: includes resolve, platform and legacy variable tokens stay as written', async () => {
    await mk('src', `${PLATFORM} ${LEGACY} [{{> inc}}]`, { role: 'boot-prompt', data: { greeting: 'OWN' } });
    // The include's own text is spliced in with ITS variable left literal too.
    expect(await read('src')).toBe(`${PLATFORM} ${LEGACY} [INCLUDED {{greeting}}]`);
    expect(await read('src', true)).toBe(`${PLATFORM} ${LEGACY} [{{> inc}}]`);
  });

  it('a dotted boot-prompt role (boot-prompt.coordinator) is in the family', async () => {
    await mk('dotted', `${PLATFORM} [{{> inc}}]`, { role: 'boot-prompt.coordinator' });
    expect(await read('dotted')).toBe(`${PLATFORM} [INCLUDED {{greeting}}]`);
  });

  it('the compiled node reads literal too', async () => {
    await mk('compiled', `${PLATFORM} ${LEGACY}`, { role: 'boot-prompt', nodeType: COMPILED_BOOT_PROMPT_NODE_TYPE });
    expect(await read('compiled')).toBe(`${PLATFORM} ${LEGACY}`);
  });

  it('control: an ordinary node keeps its Mustache rendering and includes', async () => {
    await mk('plain', 'Hi {{greeting}} [{{> inc}}]', { data: { greeting: 'OWN' } });
    expect(await read('plain')).toBe('Hi OWN [INCLUDED OWN]');
    await mk('other-role', 'Hi {{greeting}}', { role: 'boot-promptly', data: { greeting: 'OWN' } });
    expect(await read('other-role')).toBe('Hi OWN');
  });

  it('a nested Node field (an edge target) reads literal as well', async () => {
    const src = await mk('src', PLATFORM, { role: 'boot-prompt' });
    const hub = await mk('hub', 'hub');
    await db.edge.create({ data: { id: generateId(), memoryId, sourceId: hub.id, targetId: src.id, loc: 'e:boot', name: 'boot' } });
    const q = `query($ref: ID!) { node(ref: $ref) { outgoingEdges { target { content } } } }`;
    const out = (await run(q, gql(), { ref: urn('hub') })).data as { node: { outgoingEdges: Array<{ target: { content: string } }> } };
    expect(out.node.outgoingEdges[0].target.content).toBe(PLATFORM);
  });

  it('MCP hadron_get_node and hadron_get_nodes: same behaviour, raw keeps the tag', async () => {
    await mk('src', `${PLATFORM} [{{> inc}}]`, { role: 'boot-prompt', data: { greeting: 'OWN' } });
    await mk('plain', 'Hi {{greeting}}', { data: { greeting: 'OWN' } });
    const one = await mcp().callToolText('hadron_get_node', { urn: urn('src') });
    expect(one).toContain(`${PLATFORM} [INCLUDED {{greeting}}]`);
    expect(await mcp().callToolText('hadron_get_node', { urn: urn('src'), raw: true })).toContain(`${PLATFORM} [{{> inc}}]`);
    const batch = await mcp().callToolText('hadron_get_nodes', { refs: [urn('src'), urn('plain')] });
    expect(batch).toContain(`${PLATFORM} [INCLUDED {{greeting}}]`);
    expect(batch).toContain('Hi OWN');
  });

  it('the stored row is untouched by a read', async () => {
    await mk('src', `${PLATFORM} [{{> inc}}]`, { role: 'boot-prompt' });
    await read('src');
    expect((await db.node.findFirstOrThrow({ where: { memoryId, loc: 'src' } })).content).toBe(`${PLATFORM} [{{> inc}}]`);
  });
});
