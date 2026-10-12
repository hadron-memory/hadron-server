import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createServer as createHttpServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createServer } from '../server.js';
import { mintUserApiKey } from '../middleware/auth.js';
import { Prisma } from '../generated/prisma/index.js';
import { GraphQLError } from 'graphql';
import { db } from '../integrations/db/client.js';
import { cleanDb } from '../test/helpers.js';
import { generateId } from '../lib/id.js';
import { createTestableMcpServer } from './server.js';
import { resolvers } from '../api/graphql/schema/resolvers.js';
import * as locValidation from '../lib/validateLoc.js';

vi.mock('../integrations/github/writeNodeToGit.js', () => ({ writeNodeToGit: vi.fn() }));

let mcp: ReturnType<typeof createTestableMcpServer>;
let server: Server;
let baseUrl: string;
let userId: string;
let memoryId: string;
const memoryUrn = 'sanitize1695.example:knowledge';
const urn = `hrn:node:${memoryUrn}:test`;
const privateDetail = 'Invalid `prisma.node.upsert()` at /srv/hadron/src/private.ts:123 memory_id=private-memory-1695 Unknown argument session';
const failure = () => new Prisma.PrismaClientValidationError(privateDetail, { clientVersion: Prisma.prismaVersion.client });
// Resolver maps include heterogeneous GraphQL signatures; the spies only
// replace an async failure at the delegation boundary.
const mutations = resolvers.Mutation as unknown as Record<string, (...args: unknown[]) => Promise<unknown>>;
const queries = resolvers.Query as unknown as Record<string, (...args: unknown[]) => Promise<unknown>>;

beforeAll(async () => {
  server = createHttpServer(await createServer());
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => { await new Promise<void>((resolve) => server.close(() => resolve())); });

beforeEach(async () => {
  await cleanDb(db);
  const org = await db.organization.create({ data: { id: generateId(), urn: 'sanitize1695.example', name: 'Sanitization' } });
  const user = await db.user.create({ data: { githubId: 169501, githubUsername: 'sanitize1695', roles: ['READER'] } });
  userId = user.id;
  await db.orgMember.create({ data: { userId: user.id, organizationId: org.id, role: 'ADMIN' } });
  memoryId = (await db.memory.create({ data: { id: generateId(), urn: memoryUrn, name: 'knowledge', class: 'knowledge', organizationId: org.id } })).id;
  mcp = createTestableMcpServer({ userId: user.id, roles: ['READER'] });
});
afterEach(() => vi.restoreAllMocks());

function assertSanitized(result: unknown) {
  expect(result).toEqual({ isError: true, content: [{ type: 'text', text: '[internal_server_error] Unable to complete this request. Please try again.' }] });
  expect(JSON.stringify(result)).not.toMatch(/prisma|private-memory|\/srv\/|Unknown argument/i);
}

describe('#1695 MCP raw-fallback sites', () => {
  it.each([
    ['hadron_create_task', 'createTaskNode', { urn, name: 'Test' }],
    ['hadron_update_task', 'updateTaskNode', { urn, content: 'Test' }],
    ['hadron_create_review', 'createReviewNode', { urn, name: 'Test' }],
    ['hadron_update_review', 'updateReviewNode', { urn, content: 'Test' }],
    ['hadron_update_node_data', 'updateNodeData', { nodeUrn: urn, data: {} }],
    ['hadron_create_object', 'createObject', { memoryUrn, type: 'item', fields: {} }],
    ['hadron_update_object', 'updateObject', { ref: urn, fields: {} }],
    ['hadron_delete_object', 'deleteObject', { ref: urn }],
    ['hadron_replace_text', 'searchReplaceInNodes', { oldText: 'a', newText: 'b', nodeUrns: [urn] }],
  ])('%s redacts a deep Prisma failure and reports failure', async (tool, resolver, args) => {
    const error = failure();
    vi.spyOn(mutations, resolver).mockRejectedValueOnce(error);
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    assertSanitized(await mcp.callTool(tool, args));
    expect(log).toHaveBeenCalledWith('[mcp] tool_database_error', expect.objectContaining({ error }));
  });

  it.each([
    ['hadron_get_object', 'object', { ref: urn }],
    ['hadron_find_objects', 'findObjects', { memoryUrn, type: 'item' }],
  ])('%s redacts read/query Prisma failures', async (tool, resolver, args) => {
    vi.spyOn(queries, resolver).mockRejectedValueOnce(failure());
    vi.spyOn(console, 'error').mockImplementation(() => {});
    assertSanitized(await mcp.callTool(tool, args));
  });

  it.each(['hadron_create_parent_node', 'hadron_create_node'])('%s guards the validateLoc catch', async (tool) => {
    vi.spyOn(locValidation, 'validateLoc').mockImplementationOnce(() => { throw failure(); });
    vi.spyOn(console, 'error').mockImplementation(() => {});
    assertSanitized(await mcp.callTool(tool, { urn, name: 'Test' }));
  });

  it('a GraphQL wrapper and its code cannot launder Prisma details', async () => {
    vi.spyOn(mutations, 'createTaskNode').mockRejectedValueOnce(new GraphQLError(privateDetail, {
      originalError: failure(), extensions: { code: 'BAD_USER_INPUT', debug: privateDetail },
    }));
    vi.spyOn(console, 'error').mockImplementation(() => {});
    assertSanitized(await mcp.callTool('hadron_create_task', { urn, name: 'Test' }));
  });

  it('preserves a typed domain refusal', async () => {
    vi.spyOn(mutations, 'createTaskNode').mockRejectedValueOnce(new GraphQLError('Authoring needs the required task.', { extensions: { code: 'AUTHOR_TASK_REQUIRED' } }));
    expect(await mcp.callToolText('hadron_create_task', { urn, name: 'Test' })).toBe('[author_task_required] Authoring needs the required task.');
  });

  it('real HTTP governed door redacts an actual Prisma unknown-argument failure', async () => {
    const { rawKey } = await mintUserApiKey(db, { userId, label: null, createdBy: userId, issuedVia: 'test' });
    const headers = { authorization: `Bearer ${rawKey}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' };
    const init = await fetch(`${baseUrl}/mcp`, {
      method: 'POST', headers,
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'sanitization-1695', version: '1' } } }),
    });
    expect(init.status).toBe(200);
    await init.text();
    const sid = init.headers.get('mcp-session-id')!;
    vi.spyOn(mutations, 'createTaskNode').mockImplementationOnce(async (_parent, args) => {
      const { input } = args as { input: { memoryId: string; loc: string } };
      // Reach a REAL Prisma write validation fault at the delegated seam.
      // The door's advertised args are valid; the internal resolver is faulty.
      return db.node.create({ data: { memoryId: input.memoryId, loc: input.loc, name: 'Test', session: 'private-memory-1695' } as never });
    });
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const response = await fetch(`${baseUrl}/mcp`, {
      method: 'POST', headers: { ...headers, 'mcp-session-id': sid },
      body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'hadron_create_task', arguments: { urn, name: 'Test' } } }),
    });
    expect(response.status).toBe(200);
    const wire = await response.text();
    const data = wire.split('\n').find((line) => line.startsWith('data: '));
    assertSanitized(JSON.parse(data ? data.slice(6) : wire).result);
    expect(log).toHaveBeenCalledWith('[mcp] tool_database_error', expect.objectContaining({ error: expect.any(Prisma.PrismaClientValidationError) }));
    expect(await db.node.count({ where: { memoryId, loc: 'test' } })).toBe(0);
    await fetch(`${baseUrl}/mcp`, { method: 'DELETE', headers: { ...headers, 'mcp-session-id': sid } });
  });
});
