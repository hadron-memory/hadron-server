/**
 * #4738 item 1: an inline edge sent with `loc: ''` is the same as no authored loc (cor:dmo:060:03; #2947
 * `isAuthoredLoc('')` is false), so it DERIVES. It was stored with an empty loc at both doors.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../integrations/db/client.js';
import { cleanDb } from '../test/helpers.js';
import { generateId } from './id.js';
import { resolvers, type Context } from '../api/graphql/schema/resolvers.js';
import { createTestableMcpServer } from '../mcp/server.js';

vi.mock('../integrations/github/writeNodeToGit.js', () => ({ writeNodeToGit: vi.fn().mockResolvedValue(undefined) }));

let user: { id: string };
let mem: { id: string; urn: string };
const ctx = (): Context => ({ db, userId: user.id, roles: ['ADMIN'] });
const node = (loc: string) => db.node.create({
  data: { id: generateId(), memoryId: mem.id, loc, name: loc, content: `body of ${loc}`, mintedAt: new Date(), mintedByInfo: 'test' },
});
const urn = (loc: string) => `hrn:node:${mem.urn}:${loc}`;
const M = resolvers.Mutation as any;
const mcpServer = () => createTestableMcpServer({ userId: user.id, roles: ['ADMIN'], clientId: `user:${user.id}` });
/** A GraphQL node write must return the node; an unchecked result would fail later with a misleading message. */
const gql = async (op: 'createNode' | 'updateNode', input: Record<string, unknown>) => {
  const written = await M[op]({}, { input }, ctx());
  expect(written?.id).toBeTruthy();
  return written;
};
/** An MCP node write must say it wrote; an error payload is returned as text, not thrown. */
const mcpWrite = async (mcp: ReturnType<typeof mcpServer>, tool: 'hadron_create_node' | 'hadron_update_node', args: Record<string, unknown>) => {
  const text = await mcp.callToolText(tool, args);
  expect(text).toMatch(/^Node (saved|updated): /);
};

beforeEach(async () => {
  await cleanDb(db);
  const org = await db.organization.create({ data: { id: generateId(), name: 'Empty Loc Org', urn: 'emptyloc-org.example' } });
  user = await db.user.create({ data: { githubId: 473801, githubUsername: 'emptyloc', roles: ['ADMIN'] } });
  await db.orgMember.create({ data: { organizationId: org.id, userId: user.id, role: 'ADMIN' } });
  mem = await db.memory.create({ data: { id: generateId(), organizationId: org.id, urn: `${org.urn}:m`, name: 'm', class: 'knowledge', visibility: 'ORGANIZATION' } });
});

describe('#4738 an inline edge with loc "" derives its loc', () => {
  it('GraphQL updateNode', async () => {
    const a = await node('a');
    await node('c');
    await gql('updateNode', { id: a.id, edges: [{ targetId: urn('c'), name: 'uses', loc: '' }] });
    const e = await db.edge.findFirstOrThrow({ where: { sourceId: a.id } });
    expect(e.loc).toBe('a:uses:c');
    expect(e.locAuthored).toBe(false);
  });

  it('MCP hadron_update_node', async () => {
    const a = await node('a');
    await node('c');
    const mcp = mcpServer();
    await mcpWrite(mcp, 'hadron_update_node', { urn: urn('a'), edges: [{ targetUrn: urn('c'), name: 'uses', loc: '' }] });
    const e = await db.edge.findFirstOrThrow({ where: { sourceId: a.id } });
    expect(e.loc).toBe('a:uses:c');
    expect(e.locAuthored).toBe(false);
  });

  it('MCP hadron_create_node', async () => {
    const c = await node('c');
    const mcp = mcpServer();
    await mcpWrite(mcp, 'hadron_create_node', { urn: urn('n'), name: 'n', edges: [{ targetUrn: urn('c'), name: 'uses', loc: '' }] });
    const e = await db.edge.findFirstOrThrow({ where: { targetId: c.id } });
    expect(e.loc).toBe('n:uses:c');
    expect(e.locAuthored).toBe(false);
  });

  it('GraphQL createNode', async () => {
    const c = await node('c');
    await gql('createNode', { memoryId: mem.id, loc: 'g', name: 'g', edges: [{ targetId: urn('c'), name: 'uses', loc: '' }] });
    const e = await db.edge.findFirstOrThrow({ where: { targetId: c.id } });
    expect(e.loc).toBe('g:uses:c');
    expect(e.locAuthored).toBe(false);
  });

  // Blind P2 (AT0.9607.2): the coercion is bounded. An authored loc must survive, and an authored edge replaced by one
  // sent with '' (updateNode REPLACES the outgoing set) must derive, not keep or blank the old loc.
  it('GraphQL: an authored loc is preserved and flagged authored (control)', async () => {
    const a = await node('a');
    await node('c');
    await gql('updateNode', { id: a.id, edges: [{ targetId: urn('c'), name: 'uses', loc: 'custom' }] });
    const e = await db.edge.findFirstOrThrow({ where: { sourceId: a.id, deletedAt: null } });
    expect(e.loc).toBe('custom');
    expect(e.locAuthored).toBe(true);
  });

  it('MCP: an authored loc is preserved and flagged authored (control)', async () => {
    const a = await node('a');
    await node('c');
    const mcp = mcpServer();
    await mcpWrite(mcp, 'hadron_update_node', { urn: urn('a'), edges: [{ targetUrn: urn('c'), name: 'uses', loc: 'custom' }] });
    const e = await db.edge.findFirstOrThrow({ where: { sourceId: a.id, deletedAt: null } });
    expect(e.loc).toBe('custom');
    expect(e.locAuthored).toBe(true);
  });

  it('GraphQL: an authored edge rewritten with loc "" derives (overwrite case)', async () => {
    const a = await node('a');
    await node('c');
    await gql('updateNode', { id: a.id, edges: [{ targetId: urn('c'), name: 'uses', loc: 'custom' }] });
    await gql('updateNode', { id: a.id, edges: [{ targetId: urn('c'), name: 'uses', loc: '' }] });
    const edges = await db.edge.findMany({ where: { sourceId: a.id, deletedAt: null } });
    expect(edges.map((e) => [e.loc, e.locAuthored])).toEqual([['a:uses:c', false]]);
  });

  it('MCP: an authored edge rewritten with loc "" derives (overwrite case)', async () => {
    const a = await node('a');
    await node('c');
    const mcp = mcpServer();
    await mcpWrite(mcp, 'hadron_update_node', { urn: urn('a'), edges: [{ targetUrn: urn('c'), name: 'uses', loc: 'custom' }] });
    await mcpWrite(mcp, 'hadron_update_node', { urn: urn('a'), edges: [{ targetUrn: urn('c'), name: 'uses', loc: '' }] });
    const edges = await db.edge.findMany({ where: { sourceId: a.id, deletedAt: null } });
    expect(edges.map((e) => [e.loc, e.locAuthored])).toEqual([['a:uses:c', false]]);
  });
});
