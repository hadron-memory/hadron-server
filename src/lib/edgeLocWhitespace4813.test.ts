/**
 * #4813: an inline edge whose loc is whitespace-only or padded (`'  '`, `' a'`, `'a '`) is REFUSED with the existing
 * loc validation error at BOTH node-write doors, and nothing is written. The GraphQL door already refused (its
 * `validateLocOrThrow` probe was confirmed in the issue); the MCP inline-edge path (`resolveEdgeRefs`, shared by
 * `hadron_create_node` and `hadron_update_node`) stored all three as AUTHORED locs — those pins are red on main.
 * The refusal text must be byte-identical between the doors: the GraphQL `GraphQLError.message` and the MCP refusal
 * text are the same `validateLocOrThrow('loc')` string.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../integrations/db/client.js';
import { cleanDb } from '../test/helpers.js';
import { generateId } from './id.js';
import { resolvers, type Context } from '../api/graphql/schema/resolvers.js';
import { createTestableMcpServer } from '../mcp/server.js';

vi.mock('../integrations/github/writeNodeToGit.js', () => ({ writeNodeToGit: vi.fn().mockResolvedValue(undefined) }));

/** The exact `validateLocOrThrow(loc, 'loc')` invalid-charset message both doors must emit (byte-identical parity). */
const INVALID_LOC =
  'loc is not a valid loc: each ":"-separated segment must use letters, digits, dots, underscores or hyphens, and start and end with a letter or digit.';

let user: { id: string };
let mem: { id: string; urn: string };
const ctx = (): Context => ({ db, userId: user.id, roles: ['ADMIN'] });
const node = (loc: string) => db.node.create({
  data: { id: generateId(), memoryId: mem.id, loc, name: loc, content: `body of ${loc}`, mintedAt: new Date(), mintedByInfo: 'test' },
});
const urn = (loc: string) => `hrn:node:${mem.urn}:${loc}`;
const M = resolvers.Mutation as any;
const mcpServer = () => createTestableMcpServer({ userId: user.id, roles: ['ADMIN'], clientId: `user:${user.id}` });

/** A GraphQL refusal: the door's own loc error, with its #4461 extensions (value never echoed). */
const gqlRefusal = async (op: 'createNode' | 'updateNode', input: Record<string, unknown>) => {
  await expect((M[op] as any)({}, { input }, ctx())).rejects.toMatchObject({
    message: INVALID_LOC,
    extensions: { code: 'BAD_USER_INPUT', field: 'loc', reason: 'invalid-charset' },
  });
};

/** An MCP refusal: isError set (#1789) and the text is the refusal string, not a success that says no. */
const mcpRefusal = async (
  mcp: ReturnType<typeof mcpServer>,
  tool: 'hadron_create_node' | 'hadron_update_node',
  args: Record<string, unknown>,
): Promise<string> => {
  const res = (await mcp.callTool(tool, args)) as unknown as {
    isError?: boolean;
    content: Array<{ type: string; text?: string }>;
  };
  expect(res.isError).toBe(true);
  return (res.content ?? []).filter((c) => c.type === 'text').map((c) => (c.text ?? '')).join('\n');
};

/** An MCP node write must say it wrote; reused to stage an existing authored edge before the refused replacement. */
const mcpWrite = async (mcp: ReturnType<typeof mcpServer>, tool: 'hadron_create_node' | 'hadron_update_node', args: Record<string, unknown>) => {
  const text = await mcp.callToolText(tool, args);
  expect(text).toMatch(/^Node (saved|updated): /);
};

beforeEach(async () => {
  await cleanDb(db);
  const org = await db.organization.create({ data: { id: generateId(), name: 'Whitespace Loc Org', urn: 'edgeloc4813-org.example' } });
  user = await db.user.create({ data: { githubId: 481301, githubUsername: 'edgeloc4813', roles: ['ADMIN'] } });
  await db.orgMember.create({ data: { organizationId: org.id, userId: user.id, role: 'ADMIN' } });
  mem = await db.memory.create({ data: { id: generateId(), organizationId: org.id, urn: `${org.urn}:m`, name: 'm', class: 'knowledge', visibility: 'ORGANIZATION' } });
});

// Tuple rows: a bare string row is one argument, and an empty-looking row must never collapse to zero arguments.
describe.each([['  '], [' a'], ['a ']])('#4813 inline-edge loc %j is refused at both doors', (form) => {
  it('MCP hadron_update_node: refused byte-identically, the outgoing set untouched (RED on main: it saved the loc)', async () => {
    const a = await node('a');
    await node('c');
    const mcp = mcpServer();
    await mcpWrite(mcp, 'hadron_update_node', { urn: urn('a'), edges: [{ targetUrn: urn('c'), name: 'uses', loc: 'custom' }] });
    const text = await mcpRefusal(mcp, 'hadron_update_node', { urn: urn('a'), edges: [{ targetUrn: urn('c'), name: 'uses', loc: form }] });
    expect(text).toBe(INVALID_LOC);
    // No partial write: the replacement that was refused left the existing authored edge exactly as it was.
    const edges = await db.edge.findMany({ where: { sourceId: a.id, deletedAt: null } });
    expect(edges.map((e) => [e.loc, e.locAuthored])).toEqual([['custom', true]]);
  });

  it('MCP hadron_create_node: refused byte-identically, no node and no edge written (RED on main: it saved the loc)', async () => {
    await node('c');
    const mcp = mcpServer();
    const text = await mcpRefusal(mcp, 'hadron_create_node', { urn: urn('n'), name: 'n', edges: [{ targetUrn: urn('c'), name: 'uses', loc: form }] });
    expect(text).toBe(INVALID_LOC);
    expect(await db.node.findFirst({ where: { memoryId: mem.id, loc: 'n' } })).toBeNull();
    expect(await db.edge.count({ where: { memoryId: mem.id } })).toBe(0);
  });

  it('GraphQL updateNode: refused with the door\'s own loc error, no edge written (parity control, green on main)', async () => {
    const a = await node('a');
    await node('c');
    await gqlRefusal('updateNode', { id: a.id, edges: [{ targetId: urn('c'), name: 'uses', loc: form }] });
    expect(await db.edge.count({ where: { sourceId: a.id } })).toBe(0);
  });

  it('GraphQL createNode: refused with the door\'s own loc error, no node and no edge written (parity control, green on main)', async () => {
    await node('c');
    await gqlRefusal('createNode', { memoryId: mem.id, loc: 'g', name: 'g', edges: [{ targetId: urn('c'), name: 'uses', loc: form }] });
    expect(await db.node.findFirst({ where: { memoryId: mem.id, loc: 'g' } })).toBeNull();
    expect(await db.edge.count({ where: { memoryId: mem.id } })).toBe(0);
  });
});
