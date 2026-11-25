/**
 * #5019 (Billing A11, cor:dmo:060:19 Proposed): the MCP content doors refuse a node over `NODE_CONTENT_MAX_BYTES`, over the
 * real Streamable HTTP transport. RED on main: each "refused" case wrote.
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
import { parseDataKey } from '../lib/crypto.js';
import { encryptWithSecret } from '../test/encryptMemoryWithSecret.js';
import type { Context } from '../api/graphql/schema/resolvers.js';

vi.mock('../integrations/github/writeNodeToGit.js', () => ({ writeNodeToGit: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../lib/bus/index.js', () => ({ getBusClient: vi.fn(async () => null) }));

let server: Server, base: string, client: Client, u: string, mem: string;
beforeAll(async () => {
  server = httpServer(await createServerOnCleanDb());
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => { await new Promise<void>((resolve, reject) => server.close(e => e ? reject(e) : resolve())); });

const a = (n: number) => 'a'.repeat(n);
const urn = (loc: string) => `hrn:node:mcp5019-org:o:${loc}`;
const node = (loc: string, extra: Record<string, unknown> = {}) => db.node.create({ data: { id: generateId(), memoryId: mem, loc, name: loc, ...extra } });
const row = (id: string) => db.node.findUniqueOrThrow({ where: { id } });
async function call(name: string, args: Record<string, unknown>) {
  const r = await client.callTool({ name, arguments: args });
  return { isError: r.isError === true, text: (r.content as Array<{ text: string }>).map(c => c.text).join('\n') };
}
const REFUSED = { isError: true, text: '[node_content_too_large] A node can hold at most 1000 bytes.' };
const ok = (r: { isError: boolean; text: string }) => expect(r.isError, r.text).toBe(false);

beforeEach(async () => {
  await cleanDb(db);
  sessionKeyCache.clear();
  u = (await db.user.create({ data: { id: generateId(), handle: 'mcp5019-u', email: 'mcp5019-u@example.test', roles: ['READER'] } })).id;
  const orgId = (await db.organization.create({ data: { id: generateId(), name: 'mcp5019', urn: 'mcp5019-org' } })).id;
  await db.orgMember.create({ data: { organizationId: orgId, userId: u, role: 'OWNER' } });
  mem = (await db.memory.create({ data: { id: generateId(), name: 'o', urn: 'mcp5019-org:o', class: 'knowledge', organizationId: orgId, vectorIndexEnabled: false } })).id;
  client = new Client({ name: 'node-content-5019', version: '1' });
  const headers = { authorization: `Bearer ${await signJwt({ sub: u, roles: ['READER'] })}` };
  await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers } }));
  vi.stubEnv('NODE_CONTENT_MAX_BYTES', '1000');
});
afterEach(async () => { vi.unstubAllEnvs(); sessionKeyCache.clear(); await client.close(); });

describe('#5019 MCP content doors', () => {
  it('hadron_create_node: 1,001 bytes refused, nothing written; 1,000 accepted', async () => {
    expect(await call('hadron_create_node', { urn: urn('n'), name: 'n', content: a(1001) })).toEqual(REFUSED);
    expect(await db.node.count({ where: { memoryId: mem } })).toBe(0);
    ok(await call('hadron_create_node', { urn: urn('n'), name: 'n', content: a(1000) }));
  });

  it('hadron_create_node counts data, and what a revived tombstone keeps', async () => {
    expect(await call('hadron_create_node', { urn: urn('n'), name: 'n', content: a(600), data: { k: a(600) } })).toEqual(REFUSED);
    const t = await node('t', { data: { k: a(600) }, deletedAt: new Date() });
    expect(await call('hadron_create_node', { urn: urn('t'), name: 't', content: a(600) })).toEqual(REFUSED);
    expect((await row(t.id)).deletedAt).not.toBeNull();
    expect(await db.nodeRevision.count({ where: { nodeId: t.id } })).toBe(0);
  });

  it('hadron_update_node: the resulting node, full, partial and appended; a refusal leaves the row unchanged', async () => {
    const n = await node('n', { content: a(600) });
    const before = await row(n.id);
    expect(await call('hadron_update_node', { urn: urn('n'), content: a(1001) })).toEqual(REFUSED);
    expect(await call('hadron_update_node', { urn: urn('n'), data: { k: a(600) } })).toEqual(REFUSED);
    expect(await call('hadron_update_node', { urn: urn('n'), appendContent: a(600) })).toEqual(REFUSED);
    expect(await row(n.id)).toEqual(before);
    ok(await call('hadron_update_node', { urn: urn('n'), data: { k: a(300) } }));
  });

  it('hadron_update_node: an over-size node takes an edge-only change, not a tag-only one', async () => {
    await node('n', { content: a(2000) });
    await node('t');
    ok(await call('hadron_update_node', { urn: urn('n'), addEdges: [{ targetUrn: urn('t'), name: 'to' }] }));
    expect(await call('hadron_update_node', { urn: urn('n'), tags: ['x'] })).toEqual(REFUSED);
  });

  it('hadron_update_node on an encrypted memory measures plaintext', async () => {
    const dataKey = Buffer.alloc(32, 9).toString('base64');
    mem = (await db.memory.create({ data: { id: generateId(), name: 'p', urn: 'mcp5019-u:private', class: 'private', userId: u, ownerUserId: u, vectorIndexEnabled: false } })).id;
    await encryptWithSecret(null, { memoryRef: mem, dataKey }, { db, userId: u, roles: ['READER'] } as Context);
    sessionKeyCache.set('mcp5019', mem, parseDataKey(dataKey));
    const p = (loc: string) => `hrn:node:mcp5019-u:private:${loc}`;
    ok(await call('hadron_create_node', { urn: p('n'), name: 'n', content: a(1000) }));
    expect(await call('hadron_create_node', { urn: p('n2'), name: 'n2', content: a(1001) })).toEqual(REFUSED);
    expect(await call('hadron_update_node', { urn: p('n'), description: 'd' })).toEqual(REFUSED);
    ok(await call('hadron_update_node', { urn: p('n'), content: a(990), description: a(10) }));
  });

  it('hadron_create_parent_node: a new section and a re-save', async () => {
    expect(await call('hadron_create_parent_node', { urn: urn('s'), name: 's', description: a(1001) })).toEqual(REFUSED);
    expect(await db.node.count({ where: { memoryId: mem, loc: 's' } })).toBe(0);
    ok(await call('hadron_create_parent_node', { urn: urn('s'), name: 's', description: 'short' }));
    const before = await db.node.findFirstOrThrow({ where: { memoryId: mem, loc: 's' } });
    expect(await call('hadron_create_parent_node', { urn: urn('s'), name: 's', description: a(1001) })).toEqual(REFUSED);
    expect(await row(before.id)).toEqual(before);
  });

  describe('#5160 encrypted memory', () => {
    const p = (loc: string) => `hrn:node:mcp5019-u:private:${loc}`;
    beforeEach(async () => {
      const dataKey = Buffer.alloc(32, 9).toString('base64');
      mem = (await db.memory.create({ data: { id: generateId(), name: 'p', urn: 'mcp5019-u:private', class: 'private', userId: u, ownerUserId: u, vectorIndexEnabled: false } })).id;
      await encryptWithSecret(null, { memoryRef: mem, dataKey }, { db, userId: u, roles: ['READER'] } as Context);
      sessionKeyCache.set('mcp5019', mem, parseDataKey(dataKey));
    });

    it('hadron_create_parent_node is measured in plaintext, new and re-saved (the description counts twice)', async () => {
      expect(await call('hadron_create_parent_node', { urn: p('s'), name: 's', description: a(501) })).toEqual(REFUSED);
      expect(await db.node.count({ where: { memoryId: mem, loc: 's' } })).toBe(0);
      ok(await call('hadron_create_parent_node', { urn: p('s'), name: 's', description: a(500) }));
      const before = await db.node.findFirstOrThrow({ where: { memoryId: mem, loc: 's' } });
      expect(await call('hadron_create_parent_node', { urn: p('s'), name: 's', description: a(501) })).toEqual(REFUSED);
      expect(await row(before.id)).toEqual(before);
    });

    it('a section counts the data it keeps in plaintext, live and deleted', async () => {
      ok(await call('hadron_create_node', { urn: p('s'), name: 's', data: { k: a(592) } })); // 600 bytes
      ok(await call('hadron_create_parent_node', { urn: p('s'), name: 's', description: a(200) }));
      expect(await call('hadron_create_parent_node', { urn: p('s'), name: 's', description: a(201) })).toEqual(REFUSED);
      await db.node.updateMany({ where: { memoryId: mem, loc: 's' }, data: { deletedAt: new Date() } });
      expect(await call('hadron_create_parent_node', { urn: p('s'), name: 's', description: a(201) })).toEqual(REFUSED);
    });

    it('with no ceiling set, a tombstone that does not decrypt is not read for its size', async () => {
      vi.stubEnv('NODE_CONTENT_MAX_BYTES', '');
      await node('t', { data: { __enc: Buffer.alloc(64, 1).toString('base64') }, deletedAt: new Date() });
      await node('s', { data: { __enc: Buffer.alloc(64, 1).toString('base64') }, deletedAt: new Date() });
      ok(await call('hadron_create_node', { urn: p('t'), name: 't', content: 'x' }));
      ok(await call('hadron_create_parent_node', { urn: p('s'), name: 's', description: 'x' }));
    });
  });

  it('#5160 hadron_create_node: a revive is judged by the role gates before the ceiling', async () => {
    const config = await db.memoryConfig.create({ data: { id: generateId(), memoryId: mem } });
    const task = await node('author-task', { isRunnable: true, content: 'instructions' });
    await db.nodeRoleRule.createMany({ data: [
      { id: generateId(), configId: config.id, role: 'policy', writers: 'ADMIN' },
      { id: generateId(), configId: config.id, role: 'doc', strictSubRoles: true },
      { id: generateId(), configId: config.id, role: 'guide', authorTaskId: task.id, authorTaskRequired: true },
    ] });
    await db.orgMember.updateMany({ where: { userId: u }, data: { role: 'CONTRIBUTOR' } });
    for (const role of ['policy', 'doc', 'guide']) {
      await node(role, { role, data: { k: a(600) }, deletedAt: new Date() });
      const r = await call('hadron_create_node', { urn: urn(role), name: role, content: a(600), ...(role === 'doc' ? { role: 'doc.unknown' } : {}) });
      expect(r.isError).toBe(true);
      expect([role, r.text]).toEqual([role, expect.not.stringContaining('node_content_too_large')]);
      expect([role, r.text]).toEqual([role, expect.stringMatching({ policy: /writer|ADMIN/i, doc: /declared/i, guide: /author/i }[role]!)]);
    }
  });

  it('hadron_update_node_data and hadron_replace_text', async () => {
    const n = await node('n', { content: `cat ${a(600)}`, data: { first: a(300) } });
    const before = await row(n.id);
    expect(await call('hadron_update_node_data', { nodeUrn: urn('n'), data: { second: a(300) } })).toEqual(REFUSED);
    expect(await call('hadron_replace_text', { nodeUrns: [urn('n')], oldText: 'cat', newText: a(300), fields: ['content'] })).toEqual(REFUSED);
    expect(await row(n.id)).toEqual(before);
  });
});
