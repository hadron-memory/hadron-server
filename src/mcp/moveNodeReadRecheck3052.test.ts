/** #3052: hadron_move_node repeats the source content-read refusal inside the deciding transaction (MCP twin of #3039). */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../integrations/db/client.js';
import { cleanDb } from '../test/helpers.js';
import { generateId } from '../lib/id.js';
import { safeNodeUrnV2 } from '../lib/urnEmit.js';
import type { AuthContext } from '../middleware/auth.js';
import { createTestableMcpServer } from './server.js';
import * as archive from '../lib/tombstoneArchive.js';

vi.mock('../integrations/github/writeNodeToGit.js', () => ({ writeNodeToGit: vi.fn().mockResolvedValue(undefined) }));

const text = (r: { content: Array<{ text: string }> }) => r.content.map((c) => c.text).join('\n');
beforeEach(async () => { await cleanDb(db); });
afterEach(() => vi.restoreAllMocks());

/** A platform admin who owns an Agent's system memory, with a node, and a destination memory the admin owns. */
async function fixture() {
  const actor = await db.user.create({ data: { name: 'fixture-admin', roles: ['ADMIN'] } });
  const next = await db.user.create({ data: { name: 'fixture-new-owner' } });
  const memory = await db.memory.create({ data: { name: 'fixture-brain', urn: `fixture.test:brain-${generateId()}`, class: 'system', ownerUserId: actor.id } });
  const agent = await db.agent.create({ data: { name: 'fixture-agent', urn: `fixture.test:agent-${generateId()}`, ownerUserId: actor.id, systemMemoryId: memory.id } });
  const node = await db.node.create({ data: { id: generateId(), memoryId: memory.id, loc: 'source', name: 'Source', content: 'before' } });
  const destination = await db.memory.create({ data: { name: 'fixture-destination', urn: `fixture.test:dest-${generateId()}`, class: 'private', userId: actor.id, ownerUserId: actor.id } });
  const auth = { userId: actor.id, roles: ['ADMIN'], clientId: `user:${actor.id}` } as AuthContext;
  const server = createTestableMcpServer(auth, { sessionId: `m3052-${generateId()}`, cachedAppResolution: { kind: 'multi-app' } });
  // The owner moves to someone else: the admin keeps platform WRITE over the Agent but loses the content READ.
  const removeRead = () => db.$transaction(async (tx) => {
    await tx.agent.update({ where: { id: agent.id }, data: { ownerUserId: next.id } });
    await tx.memory.update({ where: { id: memory.id }, data: { ownerUserId: next.id } });
  });
  const sourceUrn = safeNodeUrnV2(memory.urn, 'source');
  return { actor, memory, node, destination, server, removeRead, sourceUrn, destUrn: (loc: string) => safeNodeUrnV2(destination.urn, loc), memoryUrn: memory.urn };
}

/** Runs `change` after the tool's preflight, immediately before its n-th deciding transaction begins. */
function beforeTransaction(change: () => Promise<void>, nth = 1) {
  const original = db.$transaction.bind(db) as (...a: unknown[]) => Promise<unknown>;
  let calls = 0;
  vi.spyOn(db, '$transaction').mockImplementation((async (...args: unknown[]) => {
    calls++;
    if (calls === nth) await change();
    return original(...args);
  }) as never);
  return { calls: () => calls };
}

async function state(memoryIds: string[]) {
  return {
    nodes: await db.node.findMany({ where: { memoryId: { in: memoryIds } }, orderBy: { id: 'asc' } }),
    edges: await db.edge.findMany({ where: { memoryId: { in: memoryIds } }, orderBy: { id: 'asc' } }),
    revisions: await db.nodeRevision.findMany({ where: { memoryId: { in: memoryIds } }, orderBy: { id: 'asc' } }),
  };
}

describe('#3052 hadron_move_node source read recheck', () => {
  it('allows the reader and moves the node', async () => {
    const f = await fixture();
    const out = text(await f.server.callTool('hadron_move_node', { urn: f.sourceUrn, targetUrn: f.destUrn('moved') }));
    expect(out).not.toMatch(/not found|denied/i);
    expect(await db.node.findUniqueOrThrow({ where: { id: f.node.id } })).toMatchObject({ memoryId: f.destination.id, loc: 'moved' });
  });

  it('refuses a write-only manager at preflight with the existing text and no change', async () => {
    const f = await fixture(); await f.removeRead();
    const before = await state([f.memory.id, f.destination.id]);
    const out = text(await f.server.callTool('hadron_move_node', { urn: f.sourceUrn, targetUrn: f.destUrn('moved') }));
    expect(out).toContain(`Source memory not found: "${f.memoryUrn}".`);
    expect(await state([f.memory.id, f.destination.id])).toEqual(before);
  });

  it('refuses after preflight when ownership transfers before the deciding transaction, byte-identical, unchanged', async () => {
    const f = await fixture();
    const before = await state([f.memory.id, f.destination.id]);
    const seam = beforeTransaction(f.removeRead);
    const out = text(await f.server.callTool('hadron_move_node', { urn: f.sourceUrn, targetUrn: f.destUrn('moved') }));
    expect(seam.calls()).toBeGreaterThanOrEqual(1);
    expect(out).toContain(`Source memory not found: "${f.memoryUrn}".`);
    expect(out).not.toMatch(/before|Source"/);
    expect(await state([f.memory.id, f.destination.id])).toEqual(before);
  });

  it('refuses the same-slot rename after preflight and keeps the name', async () => {
    const f = await fixture();
    const before = await state([f.memory.id]);
    beforeTransaction(f.removeRead);
    const out = text(await f.server.callTool('hadron_move_node', { urn: f.sourceUrn, targetUrn: f.sourceUrn, renameToLeaf: true }));
    expect(out).toContain(`Source memory not found: "${f.memoryUrn}".`);
    expect(await state([f.memory.id])).toEqual(before);
    expect((await db.node.findUniqueOrThrow({ where: { id: f.node.id } })).name).toBe('Source');
  });

  it('refuses on the retry attempt when the transfer lands between attempts', async () => {
    const f = await fixture();
    const before = await state([f.memory.id, f.destination.id]);
    vi.spyOn(archive, 'validateArchivePlan').mockImplementationOnce(async () => { throw new archive.ArchivePlanStaleError(); });
    const seam = beforeTransaction(f.removeRead, 2);
    const out = text(await f.server.callTool('hadron_move_node', { urn: f.sourceUrn, targetUrn: f.destUrn('moved') }));
    expect(seam.calls()).toBeGreaterThanOrEqual(2);
    expect(out).toContain(`Source memory not found: "${f.memoryUrn}".`);
    expect(await state([f.memory.id, f.destination.id])).toEqual(before);
  });
});
