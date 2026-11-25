/**
 * #4813: an inline edge whose loc is whitespace-only or padded (`'  '`, `' a'`, `'a '`) is REFUSED with the existing
 * loc validation error at BOTH node-write doors, and nothing is written. The GraphQL door already refused (its
 * `validateLocOrThrow` probe was confirmed in the issue); the MCP inline-edge path (`resolveEdgeRefs`, shared by
 * `hadron_create_node` and `hadron_update_node`) stored all three as AUTHORED locs — those pins are red on main.
 * The refusal text must be byte-identical between the doors: the GraphQL `GraphQLError.message` and the MCP refusal
 * text are the same `validateLocOrThrow('loc')` string.
 *
 * The second describe pins that the MCP door's refusal is the FULL `validateLocOrThrow` surface — any invalid loc
 * (charset, over-length), not just whitespace forms — and that an edge LIST holding any invalid loc is refused
 * atomically: no edge of the list is written (#4813 BLIND findings F1/F3).
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

/** The `too-long` variant of the same refusal (an atom past 64 chars), from the same `REASON_TEXT` (#4813 BLIND F1). */
const TOO_LONG_LOC =
  'loc is not a valid loc: each ":"-separated segment must be at most 64 characters and the whole loc at most 512.';

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
    await gqlRefusal('createNode', { memoryRef: mem.id, loc: 'g', name: 'g', edges: [{ targetRef: urn('c'), name: 'uses', loc: form }] });
    expect(await db.node.findFirst({ where: { memoryId: mem.id, loc: 'g' } })).toBeNull();
    expect(await db.edge.count({ where: { memoryId: mem.id } })).toBe(0);
  });
});

// #4813 BLIND F1/F3: the MCP door's refusal is the FULL validateLocOrThrow surface, not a whitespace special case —
// one non-whitespace charset form and one over-length atom — and a list holding ANY invalid loc is refused atomically:
// no edge of the list is written (validation loops the whole list before any write).
describe('#4813 MCP inline-edge loc: the full refusal surface, atomically', () => {
  it('hadron_update_node: a bad-charset loc that is not whitespace is refused with the same text (F1)', async () => {
    const a = await node('a');
    await node('c');
    const mcp = mcpServer();
    const text = await mcpRefusal(mcp, 'hadron_update_node', { urn: urn('a'), edges: [{ targetUrn: urn('c'), name: 'uses', loc: 'a!b' }] });
    expect(text).toBe(INVALID_LOC);
    expect(await db.edge.count({ where: { sourceId: a.id } })).toBe(0);
  });

  it('hadron_create_node: an over-64-char atom is refused with the too-long text, nothing written (F1)', async () => {
    await node('c');
    const mcp = mcpServer();
    const text = await mcpRefusal(mcp, 'hadron_create_node', { urn: urn('n'), name: 'n', edges: [{ targetUrn: urn('c'), name: 'uses', loc: 'a'.repeat(65) }] });
    expect(text).toBe(TOO_LONG_LOC);
    expect(await db.node.findFirst({ where: { memoryId: mem.id, loc: 'n' } })).toBeNull();
    expect(await db.edge.count({ where: { memoryId: mem.id } })).toBe(0);
  });

  it('hadron_update_node: a list [valid, invalid] is refused whole — not even the valid edge is written (F3)', async () => {
    const a = await node('a');
    await node('c');
    await node('d');
    const mcp = mcpServer();
    await mcpWrite(mcp, 'hadron_update_node', { urn: urn('a'), edges: [{ targetUrn: urn('c'), name: 'uses', loc: 'custom' }] });
    const text = await mcpRefusal(mcp, 'hadron_update_node', {
      urn: urn('a'),
      edges: [
        { targetUrn: urn('d'), name: 'uses', loc: 'validname' },
        { targetUrn: urn('c'), name: 'uses', loc: '  ' },
      ],
    });
    expect(text).toBe(INVALID_LOC);
    // No partial write: the refused list replaced nothing, so the staged authored edge is the whole outgoing set.
    const edges = await db.edge.findMany({ where: { sourceId: a.id, deletedAt: null } });
    expect(edges.map((e) => [e.loc, e.locAuthored])).toEqual([['custom', true]]);
  });
});

// #4813 LOCAL finding (a): the loc validation runs BEFORE target resolution at both doors — an edge whose loc is
// invalid AND whose target does not exist refuses with the LOC error, never a target error. A mutant that moves the
// validation later (or deletes it) fails here with a different refusal text.
describe('#4813 the loc check precedes target resolution at both doors', () => {
  const MISSING = () => `hrn:node:${mem.urn}:does-not-exist`;

  it('MCP hadron_create_node: invalid loc + missing target refuses with the loc error, not a target error', async () => {
    const mcp = mcpServer();
    const text = await mcpRefusal(mcp, 'hadron_create_node', { urn: urn('n'), name: 'n', edges: [{ targetUrn: MISSING(), name: 'uses', loc: '  ' }] });
    expect(text).toBe(INVALID_LOC);
  });

  it('GraphQL updateNode: invalid loc + missing target refuses with the loc error, not a target error', async () => {
    const a = await node('a');
    await gqlRefusal('updateNode', { id: a.id, edges: [{ targetId: MISSING(), name: 'uses', loc: ' a' }] });
  });
});
