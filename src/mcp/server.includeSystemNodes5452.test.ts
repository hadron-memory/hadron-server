/**
 * #5452 (cor:api:090:02) — `includeSystemNodes` on MCP `hadron_find_nodes` and `hadron_list_nodes`.
 *
 * `hadron_find_nodes` hands the parameter to the same resolver as GraphQL `findNodes`, so the two return the
 * same nodes. `hadron_list_nodes` renders the content tree from its own read, which has never applied the
 * node-type default (it leaves out comments only): it already lists `system` nodes, so the parameter is
 * accepted there for one vocabulary across the two tools and changes nothing. Both facts are pinned.
 * (createTestableMcpServer bypasses zod, so what a tool ACCEPTS is asked of the registered schema.)
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../integrations/db/client.js';
import { cleanDb, createDbOrgAndGraph } from '../test/helpers.js';
import { generateId } from '../lib/id.js';
import { resolvers, type Context } from '../api/graphql/schema/resolvers.js';
import { createTestableMcpServer } from './server.js';

vi.mock('../integrations/github/writeNodeToGit.js', () => ({
  writeNodeToGit: vi.fn().mockResolvedValue(undefined),
}));

let memId: string;
let memUrn: string;
let userId: string;
let mcp: ReturnType<typeof createTestableMcpServer>;

const NODES: Array<[loc: string, nodeType: string]> = [
  ['conversations', 'system'],
  ['conversations:intro', 'system'],
  ['conversations:outro', 'system'],
  ['conversations:note', 'info'],
  ['conversations:msg', 'chat-message'],
  ['docs', 'info'],
];
const SYSTEM_CHILDREN = ['conversations:intro', 'conversations:outro'];

beforeEach(async () => {
  await cleanDb(db);
  const { graph } = await createDbOrgAndGraph(db, { orgName: 'sysmcp5452.example', graphName: 'kb' });
  memId = graph.id;
  for (const [loc, nodeType] of NODES) {
    await db.node.create({ data: { id: generateId(), memoryId: memId, loc, name: `sysmarker ${loc}`, content: `sysmarker ${loc}`, nodeType } as any });
  }
  const mem = await db.memory.findUniqueOrThrow({ where: { id: memId } });
  memUrn = mem.urn.startsWith('hrn:') ? mem.urn : `hrn:mem:${mem.urn}`;
  const user = await db.user.create({ data: { githubId: 545203, githubUsername: 'sys-mcp-admin', handle: 'sys-mcp-admin', roles: [] } });
  userId = user.id;
  mcp = createTestableMcpServer({ userId, roles: ['ADMIN'], clientId: `user:${userId}` });
});

const find = (args: Record<string, unknown>) => mcp.callToolText('hadron_find_nodes', { memoryUrn: memUrn, limit: 50, ...args });
const gql = async (filter: Record<string, unknown>, extra: Record<string, unknown> = {}): Promise<string[]> => {
  const ctx: Context = { db, userId, roles: ['ADMIN'] } as Context;
  const res = await (resolvers.Query as any).findNodes(null, { ...extra, filter: { memoryRefs: [memId], ...filter }, limit: 50 }, ctx);
  return res.hits.map((h: { node: { loc: string } }) => h.node.loc).sort();
};
/** The fixture locs a tool's text names, as node URNs end in `:<loc>` followed by a non-loc character. */
const namedIn = (text: string): string[] =>
  NODES.map(([loc]) => loc).filter((loc) => new RegExp(`:${loc.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\w:-])`).test(text)).sort();

describe('#5452 hadron_find_nodes takes includeSystemNodes through the same resolver', () => {
  it.each([
    ['survey', { query: '*' }, {}],
    ['keyword', { query: 'sysmarker', mode: 'keyword' }, { query: 'sysmarker', mode: 'keyword' }],
    ['regex', { query: 'sysmarker', mode: 'regex' }, { query: 'sysmarker', mode: 'regex' }],
  ] as const)('%s: the direct children of a system parent, the same nodes as GraphQL, with and without the flag', async (_m, mcpArgs, gqlArgs) => {
    const without = namedIn(await find({ ...mcpArgs, childrenOf: 'conversations' }));
    expect(without).toEqual(['conversations:note']);
    expect(without).toEqual(await gql({ childrenOf: 'conversations' }, gqlArgs));

    const withFlag = namedIn(await find({ ...mcpArgs, childrenOf: 'conversations', includeSystemNodes: true }));
    expect(withFlag).toEqual([...SYSTEM_CHILDREN, 'conversations:note'].sort());
    expect(withFlag).toEqual(await gql({ childrenOf: 'conversations', includeSystemNodes: true }, gqlArgs));
  });

  it('the whole memory: system nodes join, chat-message nodes stay out, and false is the same as omitted', async () => {
    const withFlag = namedIn(await find({ query: '*', includeSystemNodes: true }));
    expect(withFlag).toEqual(['conversations', ...SYSTEM_CHILDREN, 'conversations:note', 'docs'].sort());
    expect(withFlag).toEqual(await gql({ includeSystemNodes: true }));
    expect(withFlag).not.toContain('conversations:msg');
    const omitted = namedIn(await find({ query: '*' }));
    expect(omitted).toEqual(['conversations:note', 'docs']);
    expect(namedIn(await find({ query: '*', includeSystemNodes: false }))).toEqual(omitted);
  });

  it('an explicit nodeType or nodeTypes decides alone; the flag is ignored, not refused', async () => {
    expect(namedIn(await find({ query: '*', nodeTypes: ['info'], includeSystemNodes: true }))).toEqual(['conversations:note', 'docs']);
    expect(namedIn(await find({ query: '*', nodeType: 'chat-message', includeSystemNodes: true }))).toEqual(['conversations:msg']);
  });

  it('a memory the caller cannot read answers the same with and without the flag', async () => {
    const stranger = await db.user.create({ data: { githubId: 545204, githubUsername: 'sys-mcp-stranger', handle: 'sys-mcp-stranger', roles: [] } });
    const other = createTestableMcpServer({ userId: stranger.id, roles: [], clientId: `user:${stranger.id}` });
    const without = await other.callToolText('hadron_find_nodes', { memoryUrn: memUrn, query: '*' });
    const withFlag = await other.callToolText('hadron_find_nodes', { memoryUrn: memUrn, query: '*', includeSystemNodes: true });
    expect(withFlag).toBe(without);
    expect(namedIn(withFlag)).toEqual([]);
  });

  it('the registered schema takes a boolean, null and omitted, and nothing else; the description says what stays out', () => {
    const schema = mcp.toolParamSchema('hadron_find_nodes', 'includeSystemNodes');
    for (const ok of [true, false, null, undefined]) expect(() => schema.parse(ok), String(ok)).not.toThrow();
    for (const bad of ['true', 1, []]) expect(() => schema.parse(bad), JSON.stringify(bad)).toThrow();
    const text = mcp.toolParamDescription('hadron_find_nodes', 'includeSystemNodes');
    for (const word of ['system', 'chat-message', 'nodeType', 'memory-class']) expect(text, word).toContain(word);
  });
});

describe('#5452 hadron_list_nodes takes includeSystemNodes', () => {
  const list = (args: Record<string, unknown>) => mcp.callToolText('hadron_list_nodes', { memoryUrn: memUrn, depth: 5, ...args });

  it('the registered schema takes a boolean, null and omitted, and nothing else; the description states it changes nothing here', () => {
    const schema = mcp.toolParamSchema('hadron_list_nodes', 'includeSystemNodes');
    for (const ok of [true, false, null, undefined]) expect(() => schema.parse(ok), String(ok)).not.toThrow();
    for (const bad of ['true', 1, []]) expect(() => schema.parse(bad), JSON.stringify(bad)).toThrow();
    const text = mcp.toolParamDescription('hadron_list_nodes', 'includeSystemNodes');
    expect(text).toContain('system');
    expect(text).toContain('hadron_find_nodes');
  });

  it('with the parameter, the tree names every system node GraphQL returns with the flag', async () => {
    const tree = await list({ includeSystemNodes: true });
    const systemNodes = (await gql({ includeSystemNodes: true })).filter((loc) => loc === 'conversations' || SYSTEM_CHILDREN.includes(loc));
    expect(systemNodes).toEqual(['conversations', ...SYSTEM_CHILDREN]);
    for (const loc of systemNodes) expect(tree, loc).toContain(loc.split(':').at(-1)!);
    expect(namedInTree(tree)).toEqual(expect.arrayContaining(['conversations', 'intro', 'outro', 'note', 'docs']));
  });

  it('the tree is unchanged by the parameter: this tool never applied the node-type default', async () => {
    const omitted = await list({});
    expect(await list({ includeSystemNodes: true })).toBe(omitted);
    expect(await list({ includeSystemNodes: false })).toBe(omitted);
    expect(namedInTree(omitted)).toEqual(expect.arrayContaining(['conversations', 'intro', 'outro']));
  });
});

/** The last loc segments a tree rendering names among the fixture's. */
function namedInTree(tree: string): string[] {
  return ['conversations', 'intro', 'outro', 'note', 'docs'].filter((seg) => new RegExp(`(^|[^\\w-])${seg}([^\\w-]|$)`, 'm').test(tree));
}
