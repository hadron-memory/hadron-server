import { beforeEach, expect, it, vi } from 'vitest';
import type { Prisma } from '../generated/prisma/index.js';
import { db } from '../integrations/db/client.js';
import { cleanDb } from '../test/helpers.js';
import { waitForLockWaitersOfType } from '../test/lockWait.js';
import { withIncludeHistoryTransaction } from '../lib/includes/includeHistoryFence.js';
import { createTestableMcpServer } from './server.js';

vi.mock('../integrations/github/writeNodeToGit.js', () => ({ writeNodeToGit: vi.fn().mockResolvedValue(undefined) }));
let memoryId: string;
let userId: string;
let agentId: string;
let sourceId: string;
const tools = ['hadron_update_node', 'hadron_create_parent_node', 'hadron_create_node', 'hadron_move_node'] as const;
beforeEach(async () => {
  await cleanDb(db);
  const org = await db.organization.create({ data: { urn: 'mcp-qualification.example', name: 'Qualification' } });
  userId = (await db.user.create({ data: { handle: 'mcp-qualification-admin', roles: ['ADMIN'] } })).id;
  await db.orgMember.create({ data: { organizationId: org.id, userId, role: 'ADMIN' } });
  memoryId = (await db.memory.create({ data: { class: 'system', organizationId: org.id, urn: 'mcp-qualification.example:system', name: 'System' } })).id;
  agentId = (await db.agent.create({ data: { organizationId: org.id, systemMemoryId: memoryId, urn: 'mcp-qualification.example:agent', name: 'Agent' } })).id;
  sourceId = (await db.node.create({ data: { memoryId, loc: 'part', name: 'Part', content: 'Before' } })).id;
});
async function prepare(tool: typeof tools[number]) {
  if (tool === 'hadron_create_node') await db.node.update({ where: { id: sourceId }, data: { deletedAt: new Date() } });
}
function write(tool: typeof tools[number]) {
  return createTestableMcpServer({ userId, roles: ['ADMIN'], clientId: `user:${userId}` }, { cachedAppResolution: { kind: 'multi-app' } })
    .callToolText(tool, tool === 'hadron_move_node'
      ? { urn: 'hrn:node:mcp-qualification.example:system:part', targetUrn: 'hrn:node:mcp-qualification.example:system:relocated' }
      : { urn: 'hrn:node:mcp-qualification.example:system:part', name: 'Part', content: 'After' });
}
function check(value: string) { expect(value).toMatch(/Node saved|updated|moved/i); }

it.each(tools)('%s waits before source rows and snapshots', async (tool) => {
  await prepare(tool);
  let entered!: () => void;
  let release!: () => void;
  const ready = new Promise<void>((resolve) => { entered = resolve; });
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const holder = withIncludeHistoryTransaction(db, async () => { entered(); await gate; });
  await ready;
  const pending = write(tool);
  const outcome = pending.then((value) => ({ value }), (error: unknown) => ({ error }));
  try {
    await waitForLockWaitersOfType(db, 'advisory', 1, 1000);
    await db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM memories WHERE id = ${memoryId} FOR UPDATE NOWAIT`;
      await tx.$queryRaw`SELECT id FROM nodes WHERE id = ${sourceId} FOR UPDATE NOWAIT`;
    });
    expect(await db.nodeRevision.count({ where: { nodeId: sourceId } })).toBe(0);
  } finally { release(); await holder; await outcome; }
  check(await pending);
  expect((await db.node.findUniqueOrThrow({ where: { id: sourceId } })).content).toBe(tool === 'hadron_create_parent_node' ? 'Section: Part' : tool === 'hadron_move_node' ? 'Before' : 'After');
});

it.each(tools)('%s holds history exclusivity through its actual commit', async (tool) => {
  await prepare(tool);
  let entered!: () => void;
  let release!: () => void;
  const ready = new Promise<void>((resolve) => { entered = resolve; });
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const transaction = db.$transaction.bind(db);
  let first = true;
  const hook = vi.spyOn(db, '$transaction').mockImplementation((async (work: (tx: Prisma.TransactionClient) => Promise<unknown>, options: unknown) => {
    const held = first; first = false;
    return transaction(async (tx) => { const result = await work(tx); if (held) { entered(); await gate; } return result; }, options as never);
  }) as typeof db.$transaction);
  const pending = write(tool);
  const outcome = pending.then((value) => ({ value }), (error: unknown) => ({ error }));
  let otherEntered = false;
  try {
    await Promise.race([ready, outcome.then((result) => { if ('error' in result) throw result.error; throw new Error('missing MCP commit barrier'); })]);
    const other = withIncludeHistoryTransaction(db, async () => { otherEntered = true; });
    const otherOutcome = other.then(() => undefined, (error: unknown) => error);
    try {
      await waitForLockWaitersOfType(db, 'advisory', 1, 1000);
      expect(otherEntered).toBe(false);
      expect((await db.node.findUniqueOrThrow({ where: { id: sourceId } })).content).toBe('Before');
    } finally { release(); await outcome; await otherOutcome; }
    check(await pending);
    expect(otherEntered).toBe(true);
  } finally { release(); hook.mockRestore(); }
});
