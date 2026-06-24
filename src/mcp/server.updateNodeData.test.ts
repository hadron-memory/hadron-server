/**
 * hadron_update_node_data (issue #366) — MCP tool that shallow-merges a JSON
 * patch into a node's `data`, delegating to the updateNodeData GraphQL
 * resolver. Pins the merge semantics, URN + ID addressing, the object-only
 * guard, and write-auth denial through the real tool closure.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { db } from '../integrations/db/client.js';
import { cleanDb } from '../test/helpers.js';
import { resolvers, type Context } from '../api/graphql/schema/resolvers.js';
import { createTestableMcpServer } from './server.js';
import type { AuthContext } from '../middleware/auth.js';
import { generateId } from '../lib/id.js';

vi.mock('../integrations/github/writeNodeToGit.js', () => ({
  writeNodeToGit: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../integrations/github/syncGraphFromGithub.js', () => ({
  syncGraphFromGithub: vi.fn().mockResolvedValue({ error: null }),
}));

let memory: { id: string; urn: string };
let admin: { id: string };
let viewer: { id: string };

const adminAuth = (): AuthContext => ({
  userId: admin.id,
  roles: ['ADMIN'],
  clientId: `user:${admin.id}`,
});
// Non-admin with no memory access — the write-auth gate must fire.
const viewerAuth = (): AuthContext => ({
  userId: viewer.id,
  roles: [],
  clientId: `user:${viewer.id}`,
});

async function makeNode(loc: string, data: unknown | null) {
  return db.node.create({
    data: { id: generateId(), memoryId: memory.id, loc, name: loc, data: data as never },
  });
}

beforeEach(async () => {
  await cleanDb(db);
  const org = await db.organization.create({
    data: { id: generateId(), name: 'und-mcp-org', urn: 'und-mcp-org' },
  });
  admin = await db.user.create({
    data: { githubId: 9701, githubUsername: 'und-mcp-admin', roles: ['ADMIN'] },
  });
  await db.orgMember.create({
    data: { organizationId: org.id, userId: admin.id, role: 'ADMIN' },
  });
  viewer = await db.user.create({
    data: { githubId: 9702, githubUsername: 'und-mcp-viewer', roles: [] },
  });
  const ctx: Context = { db, roles: ['ADMIN'], userId: admin.id };
  memory = await resolvers.Mutation.createMemory({}, { orgId: org.id, name: 'und-mcp-mem' }, ctx);
});

describe('hadron_update_node_data', () => {
  it('merges a patch into existing data (patch wins, other keys preserved)', async () => {
    const node = await makeNode('cfg', { a: 1, b: 2 });
    const srv = createTestableMcpServer(adminAuth());
    const text = await srv.callToolText('hadron_update_node_data', {
      nodeUrn: `hrn:node:${memory.urn}:cfg`,
      data: { b: 99, c: 3 },
    });
    expect(text).toContain('Node data merged');
    const reread = await db.node.findUnique({ where: { id: node.id } });
    expect(reread!.data).toEqual({ a: 1, b: 99, c: 3 });
  });

  it('accepts an ID-shape node ref and seeds data when the node had none', async () => {
    const node = await makeNode('fresh', null);
    const srv = createTestableMcpServer(adminAuth());
    const text = await srv.callToolText('hadron_update_node_data', {
      nodeUrn: node.id,
      data: { hello: 'world' },
    });
    expect(text).toContain('Node data merged');
    const reread = await db.node.findUnique({ where: { id: node.id } });
    expect(reread!.data).toEqual({ hello: 'world' });
  });

  it('reports an error for an unknown node instead of throwing', async () => {
    const srv = createTestableMcpServer(adminAuth());
    const text = await srv.callToolText('hadron_update_node_data', {
      nodeUrn: generateId(),
      data: { a: 1 },
    });
    expect(text).toMatch(/error/i);
    expect(text).toMatch(/not found/i);
  });

  it('rejects a non-object patch (array) via the resolver guard', async () => {
    await makeNode('arr', { a: 1 });
    const srv = createTestableMcpServer(adminAuth());
    // createTestableMcpServer bypasses the zod schema, so the resolver's own
    // object-only guard is what protects this path.
    const text = await srv.callToolText('hadron_update_node_data', {
      nodeUrn: `hrn:node:${memory.urn}:arr`,
      data: [1, 2, 3],
    });
    expect(text).toMatch(/must be a JSON object/i);
  });

  it('denies a caller without write access and leaves data untouched', async () => {
    const node = await makeNode('locked', { a: 1 });
    const srv = createTestableMcpServer(viewerAuth());
    const text = await srv.callToolText('hadron_update_node_data', {
      nodeUrn: `hrn:node:${memory.urn}:locked`,
      data: { b: 2 },
    });
    expect(text).toMatch(/error/i);
    const reread = await db.node.findUnique({ where: { id: node.id } });
    expect(reread!.data).toEqual({ a: 1 });
  });
});
