import { beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../integrations/db/client.js';
import { generateId } from '../lib/id.js';
import { cleanDb } from '../test/helpers.js';
import { waitForLockWaiters } from '../test/lockWait.js';
import { createTestableMcpServer } from './server.js';

vi.mock('../integrations/github/writeNodeToGit.js', () => ({
  writeNodeToGit: vi.fn().mockResolvedValue(undefined),
}));

let user: { id: string };
let memory: { id: string; urn: string };
let node: { id: string };
let receivingOrg: { id: string };

beforeEach(async () => {
  await cleanDb(db);
  user = await db.user.create({ data: {
    id: generateId(), githubId: 147691, githubUsername: 'mcp-transfer-owner', roles: ['READER'],
  } });
  receivingOrg = await db.organization.create({ data: {
    id: generateId(), name: 'Receiving Org', urn: 'mcp-transfer-receiver',
  } });
  memory = await db.memory.create({ data: {
    id: generateId(), ownerUserId: user.id, urn: 'mcp-transfer-owner:notes', name: 'Notes', class: 'knowledge',
  } });
  node = await db.node.create({ data: {
    id: generateId(), memoryId: memory.id, loc: 'entry', name: 'Entry', content: 'original', tags: [],
  } });
});

describe('MCP node writes while Memory ownership transfers', () => {
  it.each(['hadron_create_parent_node', 'hadron_create_node', 'hadron_update_node'] as const)(
    'refuses a former owner through %s after the pending Memory lock resolves', async (tool) => {
      const server = createTestableMcpServer({ userId: user.id, roles: ['READER'], clientId: `user:${user.id}` });
      const loc = tool === 'hadron_update_node' ? 'entry' : `late-${tool}`;
      const args = { urn: `hrn:node:${memory.urn}:${loc}`, name: 'Late', content: 'late write' };
      let pending: Promise<string> | undefined;
      await db.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT id FROM memories WHERE id = ${memory.id} FOR UPDATE`;
        pending = server.callToolText(tool, args);
        await waitForLockWaiters(db);
        await tx.memory.update({ where: { id: memory.id }, data: {
          ownerUserId: null, organizationId: receivingOrg.id, urn: 'mcp-transfer-receiver:notes',
        } });
      }, { timeout: 10_000 });
      expect(await pending!).toContain('[node_write_conflict] Memory write access changed');
      expect(await db.node.count({ where: { memoryId: memory.id, loc } })).toBe(tool === 'hadron_update_node' ? 1 : 0);
      expect((await db.node.findUniqueOrThrow({ where: { id: node.id } })).content).toBe('original');
    },
  );

  it.each(['hadron_delete_node', 'hadron_move_node'] as const)(
    'refuses a former owner through %s after the pending Memory lock resolves', async (tool) => {
      const server = createTestableMcpServer({ userId: user.id, roles: ['READER'], clientId: `user:${user.id}` });
      const urn = `hrn:node:${memory.urn}:entry`;
      const args = tool === 'hadron_move_node'
        ? { urn, targetUrn: `hrn:node:${memory.urn}:moved` }
        : { urn };
      let pending: Promise<string> | undefined;
      await db.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT id FROM memories WHERE id = ${memory.id} FOR UPDATE`;
        pending = server.callToolText(tool, args);
        await waitForLockWaiters(db);
        await tx.memory.update({ where: { id: memory.id }, data: {
          ownerUserId: null, organizationId: receivingOrg.id, urn: 'mcp-transfer-receiver:notes',
        } });
      }, { timeout: 10_000 });
      expect(await pending!).toMatch(/not found|Memory write access changed/);
      expect(await db.node.findUniqueOrThrow({ where: { id: node.id } })).toMatchObject({
        loc: 'entry', content: 'original', deletedAt: null,
      });
    },
  );

  it('refuses a same-slot leaf rename by a former owner after transfer', async () => {
    const server = createTestableMcpServer({ userId: user.id, roles: ['READER'], clientId: `user:${user.id}` });
    const urn = `hrn:node:${memory.urn}:entry`;
    let pending: Promise<string> | undefined;
    await db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM memories WHERE id = ${memory.id} FOR UPDATE`;
      pending = server.callToolText('hadron_move_node', { urn, targetUrn: urn, renameToLeaf: true });
      await waitForLockWaiters(db);
      await tx.memory.update({ where: { id: memory.id }, data: {
        ownerUserId: null, organizationId: receivingOrg.id, urn: 'mcp-transfer-receiver:notes',
      } });
    }, { timeout: 10_000 });
    expect(await pending!).toContain('[node_write_conflict] Memory write access changed');
    expect(await db.node.findUniqueOrThrow({ where: { id: node.id } })).toMatchObject({ name: 'Entry', loc: 'entry' });
  });
});
