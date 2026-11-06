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

/** #3067: a populated source: an outgoing edge, an inbound edge and a revision, so a refusal has rows it could disturb. */
async function populate(f: Awaited<ReturnType<typeof fixture>>) {
  const peer = await db.node.create({ data: { id: generateId(), memoryId: f.memory.id, loc: 'peer', name: 'Peer', content: 'peer' } });
  await db.edge.create({ data: { memoryId: f.memory.id, sourceId: f.node.id, targetId: peer.id, loc: 'source-to-peer', name: 'depends_on' } });
  await db.edge.create({ data: { memoryId: f.memory.id, sourceId: peer.id, targetId: f.node.id, loc: 'peer-to-source', name: 'imports' } });
  // A node at revision 2 with its snapshot of revision 1: the next snapshot takes revNo 2, so a real move can proceed.
  await db.nodeRevision.create({ data: { nodeId: f.node.id, memoryId: f.memory.id, loc: 'source', name: 'Source', content: 'older', revNo: 1 } });
  await db.node.update({ where: { id: f.node.id }, data: { revSeq: 2 } });
  const seeded = await state([f.memory.id, f.destination.id]);
  expect([seeded.edges.length, seeded.revisions.length]).toEqual([2, 1]);
  return seeded;
}

/** The full refusal envelope: one text block, flagged, naming the memory and nothing else. */
const expectRefusal = (result: unknown, memoryUrn: string) =>
  expect(result).toEqual({ content: [{ type: 'text', text: `Source memory not found: "${memoryUrn}".` }], isError: true });

describe('#3052 hadron_move_node source read recheck', () => {
  it('allows the reader and moves the node', async () => {
    const f = await fixture();
    const out = text(await f.server.callTool('hadron_move_node', { urn: f.sourceUrn, targetUrn: f.destUrn('moved') }));
    expect(out).not.toMatch(/not found|denied/i);
    expect(await db.node.findUniqueOrThrow({ where: { id: f.node.id } })).toMatchObject({ memoryId: f.destination.id, loc: 'moved' });
  });

  // Control for the refusal pins below: on this same seed a move that is allowed does disturb the seeded rows, so their
  // byte comparison can fail. Without it, a seed that faults the move would read as "nothing changed".
  it('allows the reader to move a populated source, and that move changes the seeded rows', async () => {
    const f = await fixture();
    const before = await populate(f);
    const result = await f.server.callTool('hadron_move_node', { urn: f.sourceUrn, targetUrn: f.destUrn('moved') });
    // MCP success may omit the optional flag; an explicit error must never pass this control.
    expect('isError' in result ? result.isError ?? false : false).toBe(false);
    expect(text(result)).not.toMatch(/not found|denied|internal/i);
    expect(await db.node.findUniqueOrThrow({ where: { id: f.node.id } })).toMatchObject({ memoryId: f.destination.id, loc: 'moved' });
    const after = await state([f.memory.id, f.destination.id]);
    expect(after.nodes).not.toEqual(before.nodes);
    expect(after.edges).not.toEqual(before.edges);
    expect(after.revisions).not.toEqual(before.revisions);
  });

  it('refuses a write-only manager at preflight with the existing text and no change', async () => {
    const f = await fixture(); const before = await populate(f); await f.removeRead();
    const result = await f.server.callTool('hadron_move_node', { urn: f.sourceUrn, targetUrn: f.destUrn('moved') });
    expectRefusal(result, f.memoryUrn);
    expect(await state([f.memory.id, f.destination.id])).toEqual(before);
  });

  it('refuses after preflight when ownership transfers before the deciding transaction, byte-identical, unchanged', async () => {
    const f = await fixture();
    const before = await populate(f);
    const seam = beforeTransaction(f.removeRead);
    const result = await f.server.callTool('hadron_move_node', { urn: f.sourceUrn, targetUrn: f.destUrn('moved') });
    expect(seam.calls()).toBeGreaterThanOrEqual(1);
    expectRefusal(result, f.memoryUrn);
    expect(await state([f.memory.id, f.destination.id])).toEqual(before);
  });

  it('refuses the same-slot rename after preflight and keeps the name', async () => {
    const f = await fixture();
    const before = await populate(f);
    beforeTransaction(f.removeRead);
    const result = await f.server.callTool('hadron_move_node', { urn: f.sourceUrn, targetUrn: f.sourceUrn, renameToLeaf: true });
    expectRefusal(result, f.memoryUrn);
    expect(await state([f.memory.id, f.destination.id])).toEqual(before);
    expect((await db.node.findUniqueOrThrow({ where: { id: f.node.id } })).name).toBe('Source');
  });

  it('refuses on the retry attempt when the transfer lands between attempts', async () => {
    const f = await fixture();
    const before = await populate(f);
    vi.spyOn(archive, 'validateArchivePlan').mockImplementationOnce(async () => { throw new archive.ArchivePlanStaleError(); });
    const seam = beforeTransaction(f.removeRead, 2);
    const result = await f.server.callTool('hadron_move_node', { urn: f.sourceUrn, targetUrn: f.destUrn('moved') });
    expect(seam.calls()).toBeGreaterThanOrEqual(2);
    expectRefusal(result, f.memoryUrn);
    expect(await state([f.memory.id, f.destination.id])).toEqual(before);
  });
});
