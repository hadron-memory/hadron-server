/**
 * hadron-internal#79 (cor:api:140:03, cor:acl:010:02): which edges the MCP node reads print, over the real Streamable HTTP transport. The rule
 * is GraphQL's: the reader may read the memory that holds the edge and the memory of its far node.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createServer as httpServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { db } from '../integrations/db/client.js';
import { cleanDb } from '../test/helpers.js';
import { createServerOnCleanDb } from '../test/startServerFixture.js';
import { generateId } from '../lib/id.js';
import { signJwt } from '../auth/jwt.js';
import { sessionKeyCache } from '../lib/sessionKeyCache.js';

vi.mock('../integrations/github/writeNodeToGit.js', () => ({ writeNodeToGit: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../lib/bus/index.js', () => ({ getBusClient: vi.fn(async () => null) }));

let server: Server, base: string, client: Client, u: string, mem: string;
beforeAll(async () => {
  server = httpServer(await createServerOnCleanDb());
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => { await new Promise<void>((resolve, reject) => server.close(e => e ? reject(e) : resolve())); });

const urn = (loc: string) => `hrn:node:mcp79-org:o:${loc}`;
const node = (loc: string, extra: Record<string, unknown> = {}) => db.node.create({ data: { id: generateId(), memoryId: mem, loc, name: loc, ...extra } });
async function call(name: string, args: Record<string, unknown>) {
  const r = await client.callTool({ name, arguments: args });
  return { isError: r.isError === true, text: (r.content as Array<{ text: string }>).map(c => c.text).join('\n') };
}
const ok = (r: { isError: boolean; text: string }) => expect(r.isError, r.text).toBe(false);

beforeEach(async () => {
  await cleanDb(db);
  sessionKeyCache.clear();
  u = (await db.user.create({ data: { id: generateId(), handle: 'mcp79-u', email: 'mcp79-u@example.test', roles: ['READER'] } })).id;
  const orgId = (await db.organization.create({ data: { id: generateId(), name: 'mcp79', urn: 'mcp79-org' } })).id;
  await db.orgMember.create({ data: { organizationId: orgId, userId: u, role: 'OWNER' } });
  mem = (await db.memory.create({ data: { id: generateId(), name: 'o', urn: 'mcp79-org:o', class: 'knowledge', organizationId: orgId, vectorIndexEnabled: false } })).id;
  client = new Client({ name: 'node-content-79', version: '1' });
  const headers = { authorization: `Bearer ${await signJwt({ sub: u, roles: ['READER'] })}` };
  await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers } }));
});
afterEach(async () => { sessionKeyCache.clear(); await client.close(); });


const edge = (name: string, memoryId: string, sourceId: string, targetId: string) =>
  db.edge.create({ data: { id: generateId(), loc: `e:${name}`, name, memoryId, sourceId, targetId } as never });

describe('#79 the edges of an MCP node read', () => {
  let near: string, sibling: string, other: string, far: string, mineFar: string, mine: string;
  beforeEach(async () => {
    const o = await db.user.create({ data: { id: generateId(), handle: 'mcp79-o', email: 'mcp79-o@example.test' } });
    const priv = (slug: string, userId: string) => db.memory.create({ data: { id: generateId(), name: slug, urn: `mcp79-x:${slug}`, class: 'private', userId, ownerUserId: userId, vectorIndexEnabled: false } }).then((m) => m.id);
    other = await priv('far-slug', o.id);
    mine = await priv('mine', u);
    near = (await node('near', { content: 'nearprobe' })).id;
    sibling = (await node('sibling')).id;
    far = (await db.node.create({ data: { id: generateId(), memoryId: other, loc: 'far-loc', name: 'far' } })).id;
    mineFar = (await db.node.create({ data: { id: generateId(), memoryId: mine, loc: 'mine-loc', name: 'mine' } })).id;
    await edge('same-out', mem, near, sibling);
    await edge('own-out', mem, near, mineFar);
  });
  const reads: Array<[string, () => Promise<{ isError: boolean; text: string }>]> = [
    ['hadron_find_nodes brief', () => call('hadron_find_nodes', { query: 'nearprobe', brief: true, memoryUrn: 'hrn:mem:mcp79-org:o' })],
    ['hadron_get_node', () => call('hadron_get_node', { urn: urn('near') })],
    ['hadron_get_next_node', async () => { await node('p'); await db.node.update({ where: { id: near }, data: { loc: 'p:near', seq: 1 } }); return call('hadron_get_next_node', { parent: urn('p') }); }],
    ['hadron_get_nodes', () => call('hadron_get_nodes', { refs: [urn('near')] })],
  ];

  it.each(reads)('%s prints no far node of an unread memory, and keeps the others', async (_name, read) => {
    await edge('far-out', mem, near, far);
    await edge('far-in', mem, far, near);
    const r = await read();
    ok(r);
    for (const s of ['far-slug', 'far-loc', 'far-out', 'far-in']) expect(r.text).not.toContain(s);
    for (const s of ['sibling', 'mine-loc']) expect(r.text).toContain(s);
  });

  it.each(reads)('%s prints no edge an unread memory holds between two readable nodes', async (_name, read) => {
    await edge('third-out', other, near, sibling);
    await edge('third-in', other, sibling, near);
    const r = await read();
    ok(r);
    for (const s of ['third-out', 'third-in']) expect(r.text).not.toContain(s);
    expect(r.text).toContain('same-out');
  });

  it('the reads that print no far edge keep printing none, and the brief line prints outgoing edges only', async () => {
    await edge('far-out', mem, near, far);
    await edge('far-in', mem, far, near);
    await edge('same-in', mem, sibling, near);
    const q = { query: 'nearprobe', memoryUrn: 'hrn:mem:mcp79-org:o' };
    for (const [name, args] of [['hadron_find_nodes', { ...q, expand: 1 }], ['hadron_find_nodes', { ...q, brief: true, expand: 1 }], ['hadron_list_nodes', { memoryUrn: q.memoryUrn }]] as const) {
      const r = await call(name, args);
      ok(r);
      for (const s of ['far-slug', 'far-loc', 'far-out', 'far-in']) expect([name, r.text]).toEqual([name, expect.not.stringContaining(s)]);
    }
    const brief = await call('hadron_find_nodes', { ...q, brief: true });
    expect(brief.text).toContain('same-out');
    expect(brief.text).not.toContain('same-in');
  });
});
