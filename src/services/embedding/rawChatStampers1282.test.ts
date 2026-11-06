// Real SQL/move/Channel paths run under the ordinary disposable Vitest DB lane.
// Endpoint calls are always an explicit synthetic mock, never a real provider.
import { beforeEach, expect, it, vi } from 'vitest';
import { db } from '../../integrations/db/client.js';
import { cleanDb, createDbOrgAndGraph } from '../../test/helpers.js';
import { generateId } from '../../lib/id.js';
import { stampEmbeddingObligation, resetEmbeddingObligations } from './obligation.js';
import { backfillMemoryEmbeddings, restampFailedEmbeddings, stampMemoryEmbeddingsBatch } from './enqueue.js';
import { embeddingEligibleSql, isRawChatNode } from './rawChat.js';
import { embedNode } from '../../jobs/embedNodes.js';
import { ensureChannelWithRoot } from '../../lib/channels.js';
import { moveNodeSubtree } from '../../lib/nodeSubtreeMove.js';
vi.mock('../../lib/metering/index.js', () => ({ recordLlmUsage: vi.fn(async () => {}) }));
let memoryId: string;
let ids: string[];
const shapes = [
  ['chat-message', 'team:messages:001-user'], ['record', 'bot:messages:001-user'],
  ['record', 'bot:messages:002-assistant'], ['record', 'ledger:invoice'],
  ['chat', 'team'], ['record', 'bot'], ['abstract', 'bot:messages:002a-summary'], ['info', 'bot:summary'],
];
beforeEach(async () => {
  await cleanDb(db);
  const { graph } = await createDbOrgAndGraph(db); memoryId = graph.id;
  await db.memory.update({ where: { id: memoryId }, data: { vectorIndexEnabled: true, embeddingSource: 'abstract' } });
  ids = [];
  for (const [nodeType, loc] of shapes) {
    const id = generateId(); ids.push(id);
    await db.node.create({ data: { id, memoryId, loc, nodeType, name: loc, abstract: 'Synthetic summary', content: 'Synthetic content' } });
  }
});
it.each(['write', 'reset/move/clone/merge/extract', 'backfill', 'retry', 'system batch'])('%s stamps no raw turn and the worker sends none while records/summary remain eligible', async path => {
  if (path === 'write') for (const id of ids) await db.$transaction(tx => stampEmbeddingObligation(tx, id, memoryId));
  if (path === 'reset/move/clone/merge/extract') await db.$transaction(tx => resetEmbeddingObligations(tx, ids, true));
  if (path === 'backfill') await backfillMemoryEmbeddings(db, memoryId);
  if (path === 'retry') {
    await db.node.updateMany({ where: { id: { in: ids } }, data: { embeddingFailedAt: new Date() } });
    await restampFailedEmbeddings(db, memoryId);
  }
  if (path === 'system batch') {
    await db.memory.update({ where: { id: memoryId }, data: { class: 'system' } });
    const result = await stampMemoryEmbeddingsBatch(db, memoryId, { limit: 100 });
    expect(result.eligible).toBe(5);
  }
  const rows = await db.node.findMany({ where: { memoryId } });
  const client = { provider: 'synthetic', model: 'test', dim: 768, embed: vi.fn(async () => [Array.from({ length: 768 }, (_, i) => i === 0 ? 1 : 0)]) };
  for (const row of rows) {
    if (isRawChatNode(row)) {
      expect(row.embeddingPendingAt).toBeNull(); expect(row.embeddingWorkToken).toBeNull();
      expect(await embedNode(db, row.id, undefined, client)).toBe('skipped');
    } else { expect(row.embeddingPendingAt).not.toBeNull(); expect(row.embeddingWorkToken).not.toBeNull(); }
  }
  expect(client.embed).not.toHaveBeenCalled();
  for (const id of [ids[3], ids[6], ids[7]]) expect(await embedNode(db, id!, undefined, client)).toBe('embedded');
  expect(client.embed).toHaveBeenCalledTimes(3);
});
it('SQL eligibility exactly matches the TS worker predicate on stored shapes', async () => {
  const rows = await db.$queryRaw<Array<{ id: string; eligible: boolean }>>`SELECT nodes.id, ${embeddingEligibleSql()} AS eligible FROM nodes WHERE memory_id = ${memoryId}`;
  for (const row of rows) { const index = ids.indexOf(row.id); const [nodeType, loc] = shapes[index]!; expect(row.eligible).toBe(!isRawChatNode({ nodeType: nodeType!, loc: loc! })); }
});
it('a cross-memory subtree move restamps controls but not record turns under the moved prefix', async () => {
  const memory = await db.memory.findUniqueOrThrow({ where: { id: memoryId } });
  const destination = await db.memory.create({ data: { id: generateId(), organizationId: memory.organizationId, urn: `test:dest-${generateId()}`, name: 'Destination', class: 'knowledge', vectorIndexEnabled: true } });
  const root = await db.node.findUniqueOrThrow({ where: { id: ids[5]! } });
  await db.$transaction(tx => moveNodeSubtree(tx, { source: root, destLoc: 'moved', destMemoryId: destination.id, editor: { userId: null } }));
  const rows = await db.node.findMany({ where: { memoryId: destination.id } });
  expect(rows.length).toBe(5);
  for (const row of rows) expect(row.embeddingWorkToken === null).toBe(isRawChatNode(row));
});
it('Channel creation guards structural ancestors and revival keeps the eligible chat root', async () => {
  // #2622: a Channel ADDRESS may no longer carry a `messages` segment
  // (LOC_RESERVED_SEGMENT), so a freshly created structural ancestor can no
  // longer be raw-chat-classified by its loc — the reachable guard is an
  // ADOPTED raw-chat ancestor row. Channel creation must leave it unstamped
  // while the fresh clean ancestor above it gets its obligation.
  await db.node.create({ data: { id: generateId(), memoryId, loc: 'archive:old', name: 'stray turn', nodeType: 'chat-message', content: 'stray', createdBy: null } });
  await ensureChannelWithRoot(db, { memoryId, loc: 'archive:old:thread', name: 'thread', createdBy: null });
  const ancestor = await db.node.findUniqueOrThrow({ where: { loc_memoryId: { loc: 'archive:old', memoryId } } });
  expect(ancestor.nodeType).toBe('chat-message');
  expect(ancestor.embeddingWorkToken).toBeNull();
  expect(ancestor.embeddingPendingAt).toBeNull();
  const cleanAncestor = await db.node.findUniqueOrThrow({ where: { loc_memoryId: { loc: 'archive', memoryId } } });
  expect(cleanAncestor.embeddingWorkToken).not.toBeNull();
  await db.node.create({ data: { id: generateId(), memoryId, loc: 'revived', name: 'revived', nodeType: 'chat', deletedAt: new Date() } });
  const { rootId } = await ensureChannelWithRoot(db, { memoryId, loc: 'revived', name: 'revived', createdBy: null });
  const root = await db.node.findUniqueOrThrow({ where: { id: rootId } });
  expect(root.embeddingWorkToken).not.toBeNull();
});
