/**
 * hadron-internal#40 (ruling 0197 (3)) — a write whose stored text alone is over the resolved-read byte limit warns and
 * never refuses. The warning rides the existing write-advice carriers (GraphQL `extensions.warnings`, MCP text), judges
 * the written text only, and survives a field error inside the committed write's own response.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApolloServer } from '@apollo/server';
import { db } from '../../integrations/db/client.js';
import { cleanDb } from '../../test/helpers.js';
import { generateId } from '../id.js';
import { resolvers, type Context } from '../../api/graphql/schema/resolvers.js';
import { typeDefs } from '../../api/graphql/schema/typeDefs.js';
import { taskWarningsPlugin } from '../../api/graphql/taskWarningsPlugin.js';
import { createTestableMcpServer } from '../../mcp/server.js';
import { CONTENT_RESOLUTION_LIMIT_EXCEEDED, setResolutionLimits } from './resolutionBudget.js';
import { oversizeContentWarnings, renderIncludePinWarnings, safePlainPinWarnings } from './plainPinWarnings.js';

vi.mock('../../integrations/github/writeNodeToGit.js', () => ({ writeNodeToGit: vi.fn().mockResolvedValue(undefined) }));

const CODE = 'content.resolution.oversize';
let userId: string;
let memoryId: string;
let memoryUrn: string;
const ctx = (): Context => ({ db, userId, roles: ['READER'] });
const server = new ApolloServer<Context>({ typeDefs, resolvers, plugins: [taskWarningsPlugin] });
async function execute(query: string, variables: Record<string, unknown>) {
  const r = await server.executeOperation({ query, variables }, { contextValue: ctx() });
  if (r.body.kind !== 'single') throw new Error('unexpected response');
  return r.body.singleResult;
}
const CREATE = (sel: string) => `mutation($i:CreateNodeInput!){createNode(input:$i)${sel}}`;
const UPDATE = (sel: string) => `mutation($i:UpdateNodeInput!){updateNode(input:$i)${sel}}`;
const codes = (r: { extensions?: Record<string, unknown> }) =>
  ((r.extensions?.warnings ?? []) as Array<{ code: string }>).map((w) => w.code);

beforeEach(async () => {
  await cleanDb(db);
  const org = await db.organization.create({ data: { id: generateId(), name: 'Ww Org', urn: 'ww40.example' } });
  const user = await db.user.create({ data: { githubId: 404301, githubUsername: 'ww40', handle: 'ww40', roles: [] } });
  userId = user.id;
  await db.orgMember.create({ data: { organizationId: org.id, userId, role: 'ADMIN' } });
  const m = await resolvers.Mutation.createMemory(null, { orgId: org.id, name: 'ww40' }, ctx());
  memoryId = m.id; memoryUrn = m.urn;
  setResolutionLimits({ limits: { maxBytes: 16 } });
});
afterEach(() => setResolutionLimits(null));

describe('#40 the oversize rule', () => {
  it('only template text over the byte limit, counted in UTF-8', () => {
    expect(oversizeContentWarnings('{{x}}' + 'a'.repeat(11))).toEqual([]); // 16 bytes
    expect(oversizeContentWarnings('{{x}}' + 'a'.repeat(12))).toHaveLength(1); // 17 bytes
    expect(oversizeContentWarnings('{{x}}' + 'é'.repeat(6))).toHaveLength(1); // 11 characters, 17 bytes
    expect(oversizeContentWarnings('z'.repeat(100))).toEqual([]); // no template syntax: served as stored
    expect(oversizeContentWarnings(null)).toEqual([]);
  });

  it('a pin-lookup fault drops only the pin advice, not the oversize warning', async () => {
    const broken = { ...ctx(), db: new Proxy(db, { get: () => { throw new Error('boom'); } }) } as Context;
    const got = await safePlainPinWarnings(broken, { memoryId }, '{{> t rev=1}}' + 'a'.repeat(20));
    expect(got?.map((w) => w.code)).toEqual([CODE]);
  });

  it('renders each code once, with its own fixed text', () => {
    const text = renderIncludePinWarnings([
      { code: CODE, text: 'ignored' }, { code: 'include.pin.unkept', text: 'ignored' }, { code: CODE, text: 'ignored' },
    ]);
    expect(text.match(/Warning \[/g)).toHaveLength(2);
    expect(text).toContain(`Warning [${CODE}]: Saved. This content uses template syntax and is larger than a resolved read allows, so reading it resolved may be refused; read it with raw: true to get the stored text.`);
    expect(text).toContain('Warning [include.pin.unkept]: A pinned include revision');
    expect(text).not.toContain('ignored');
  });
});

describe('#40 GraphQL writes warn, never refuse', () => {
  it('create and update over the limit commit and carry the warning; under the limit they do not', async () => {
    const big = '{{x}} ' + 'a'.repeat(40);
    const created = await execute(CREATE('{ id }'), { i: { memoryId, loc: 'big', name: 'Big', content: big } });
    expect(created.errors).toBeUndefined();
    expect(codes(created)).toEqual([CODE]);
    const id = (created.data as any).createNode.id;
    expect((await db.node.findUniqueOrThrow({ where: { id } })).content).toBe(big);

    const updated = await execute(UPDATE('{ id }'), { i: { id, content: big + 'b' } });
    expect(updated.errors).toBeUndefined();
    expect(codes(updated)).toEqual([CODE]);

    const small = await execute(CREATE('{ id }'), { i: { memoryId, loc: 'small', name: 'Small', content: '{{x}} ok' } });
    expect(codes(small)).toEqual([]);
    const plain = await execute(CREATE('{ id }'), { i: { memoryId, loc: 'plain', name: 'Plain', content: 'p'.repeat(40) } });
    expect(codes(plain)).toEqual([]);
  });

  it('a response that selects content: the write commits, content refuses as a field error, the warning stays', async () => {
    const big = '{{x}} ' + 'a'.repeat(40);
    const created = await execute(CREATE('{ id content }'), { i: { memoryId, loc: 'big', name: 'Big', content: big } });
    expect((created.data as any).createNode.id).toBeTruthy();
    expect((created.data as any).createNode.content).toBeNull();
    expect(created.errors?.map((e) => e.extensions?.code)).toEqual([CONTENT_RESOLUTION_LIMIT_EXCEEDED]);
    expect(codes(created)).toEqual([CODE]);
    expect(await db.node.count({ where: { memoryId, loc: 'big' } })).toBe(1);
  });
});

describe('#40 MCP writes warn, never refuse', () => {
  it('hadron_create_node and hadron_update_node save and append the warning', async () => {
    const client = createTestableMcpServer({ userId, roles: ['READER'], clientId: `user:${userId}` });
    const urn = `hrn:node:${memoryUrn}:mcp`;
    const big = '{{x}} ' + 'a'.repeat(40);
    const created = await client.callToolText('hadron_create_node', { urn, name: 'MCP', content: big });
    expect(created).toMatch(/Node (saved|created)/);
    expect(created).toContain(`Warning [${CODE}]`);
    const updated = await client.callToolText('hadron_update_node', { urn, content: big + 'b' });
    expect(updated).toContain('Node updated');
    expect(updated).toContain(`Warning [${CODE}]`);
    expect(await client.callToolText('hadron_update_node', { urn, content: '{{x}} ok' })).not.toContain(CODE);
  });

  it('hadron_replace_text commits an edit that takes the text over the limit and appends the warning', async () => {
    const client = createTestableMcpServer({ userId, roles: ['READER'], clientId: `user:${userId}` });
    const urn = `hrn:node:${memoryUrn}:rt`;
    await client.callToolText('hadron_create_node', { urn, name: 'RT', content: '{{x}} ok' });
    const replaced = await client.callToolText('hadron_replace_text', { nodeUrns: [urn], oldText: 'ok', newText: 'a'.repeat(40), fields: ['content'] });
    expect(replaced).toMatch(/^Replaced 1 occurrence/);
    expect(replaced).toContain(`Warning [${CODE}]`);
    const row = await db.node.findFirst({ where: { memoryId, loc: 'rt' }, select: { content: true } });
    expect(row?.content).toBe('{{x}} ' + 'a'.repeat(40));
    const back = await client.callToolText('hadron_replace_text', { nodeUrns: [urn], oldText: 'a'.repeat(40), newText: 'ok', fields: ['content'] });
    expect(back).not.toContain(CODE);
  });
});
