/**
 * #5223 door 5: MCP `hadron_create_parent_node`'s re-save of a live section measures size only
 * AFTER the role and authoring gates (#5160 item 10 already ordered the create/revive branch;
 * the re-save branch was left measuring first). A size refusal counts stored fields, so a writer
 * the authoring gate refuses must not learn the over/under bit. RED on main: the "authoring
 * refusal" case answers `[node_content_too_large]` there. Over the real Streamable HTTP transport.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createServer as httpServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Client } from '@modelcontextprotocol/client';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { db } from '../integrations/db/client.js';
import { cleanDb } from '../test/helpers.js';
import { createServerOnCleanDb } from '../test/startServerFixture.js';
import { generateId } from '../lib/id.js';
import { signJwt } from '../auth/jwt.js';

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
const urn = (loc: string) => `hrn:node:go5223-org:o:${loc}`;
const node = (loc: string, extra: Record<string, unknown> = {}) => db.node.create({ data: { id: generateId(), memoryId: mem, loc, name: loc, ...extra } });
const row = (id: string) => db.node.findUniqueOrThrow({ where: { id } });
async function call(name: string, args: Record<string, unknown>) {
  const r = await client.callTool({ name, arguments: args });
  return { isError: r.isError === true, text: (r.content as Array<{ text: string }>).map(c => c.text).join('\n') };
}

beforeEach(async () => {
  await cleanDb(db);
  u = (await db.user.create({ data: { id: generateId(), handle: 'go5223-u', email: 'go5223-u@example.test', roles: ['READER'] } })).id;
  const orgId = (await db.organization.create({ data: { id: generateId(), name: 'go5223', urn: 'go5223-org' } })).id;
  await db.orgMember.create({ data: { organizationId: orgId, userId: u, role: 'OWNER' } });
  mem = (await db.memory.create({ data: { id: generateId(), name: 'o', urn: 'go5223-org:o', class: 'knowledge', organizationId: orgId, vectorIndexEnabled: false } })).id;
  client = new Client({ name: 'gate-order-5223', version: '1' });
  const headers = { authorization: `Bearer ${await signJwt({ sub: u, roles: ['READER'] })}` };
  await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers } }));
  vi.stubEnv('NODE_CONTENT_MAX_BYTES', '1000');
});
afterEach(async () => { vi.unstubAllEnvs(); await client.close(); });

describe('#5223 door 5 — hadron_create_parent_node re-save: authoring before the ceiling', () => {
  it('a re-save the authoring gate refuses answers authoring, not the size bit, and writes nothing', async () => {
    const task = await node('author-task', { isRunnable: true, content: 'instructions' });
    const config = await db.memoryConfig.create({ data: { id: generateId(), memoryId: mem } });
    await db.nodeRoleRule.create({ data: { id: generateId(), configId: config.id, role: 'guide', authorTaskId: task.id, authorTaskRequired: true } });
    const section = await node('s', { role: 'guide', content: 'Section: s' });
    const before = await row(section.id);
    const r = await call('hadron_create_parent_node', { urn: urn('s'), name: 's', description: a(501) });
    expect([r.isError, r.text]).toEqual([true, expect.stringMatching(/author/i)]);
    expect(r.text).not.toContain('node_content_too_large');
    expect(await row(section.id)).toEqual(before);
    expect(await db.nodeRevision.count({ where: { nodeId: section.id } })).toBe(0);
  });

  it('an admitted writer\'s over-size re-save is still refused for size and writes nothing', async () => {
    const section = await node('s', { content: 'Section: s' });
    const before = await row(section.id);
    const r = await call('hadron_create_parent_node', { urn: urn('s'), name: 's', description: a(501) });
    expect([r.isError, r.text]).toEqual([true, '[node_content_too_large] A node can hold at most 1000 bytes.']);
    expect(await row(section.id)).toEqual(before);
  });
});
