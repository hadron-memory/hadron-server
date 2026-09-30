/**
 * Event pivot — git mirror as an evt.node.written.v1 subscriber.
 *
 * Pins handleNodeWrittenForGit's contract: re-read + faithful NodeForGit
 * payload (tags deserialized, edges included), no-op on vanished/deleted
 * nodes, and the encrypted-memory punt (request-time direct writes own
 * encrypted mirrors — a subscriber has no session key).
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { db } from '../db/client.js';
import { cleanDb } from '../../test/helpers.js';
import { generateId } from '../../lib/id.js';

vi.mock('./writeNodeToGit.js', () => ({
  writeNodeToGit: vi.fn(async () => {}),
}));

import { writeNodeToGit } from './writeNodeToGit.js';
import { handleNodeWrittenForGit } from './nodeWrittenSubscriber.js';

const mockWrite = vi.mocked(writeNodeToGit);

let memoryId: string;

beforeEach(async () => {
  vi.clearAllMocks();
  await cleanDb(db);
  const org = await db.organization.create({
    data: { id: generateId(), name: 'git-evt-org', urn: 'git-evt-org' },
  });
  const memory = await db.memory.create({
    data: {
      id: generateId(),
      organizationId: org.id,
      name: 'gitevt',
      urn: 'git-evt-org:gitevt',
      class: 'knowledge',
    },
  });
  memoryId = memory.id;
});

describe('handleNodeWrittenForGit', () => {
  it('re-reads the node and mirrors a faithful payload (tags, edges, routing args)', async () => {
    const target = await db.node.create({
      data: { id: generateId(), memoryId, loc: 'tgt', name: 'Target', tags: [] },
    });
    const node = await db.node.create({
      data: {
        id: generateId(),
        memoryId,
        loc: 'src-node',
        name: 'Source',
        content: 'hello',
        abstract: 'An abstract.',
        tags: ['a', 'b'],
        outgoingEdges: {
          create: {
            memoryId,
            targetId: target.id,
            loc: 'src-node:documents:tgt',
            name: 'documents',
          },
        },
      },
    });
    await handleNodeWrittenForGit(db, {
      nodeId: node.id,
      memoryId,
      ownerRepo: 'acme/repo',
      clientId: 'client-1',
    });
    expect(mockWrite).toHaveBeenCalledTimes(1);
    const [payload, ownerRepo, clientId, memId] = mockWrite.mock.calls[0];
    expect(payload).toMatchObject({
      id: node.id,
      loc: 'src-node',
      name: 'Source',
      content: 'hello',
      abstract: 'An abstract.',
      tags: ['a', 'b'],
    });
    expect(payload.outgoingEdges).toHaveLength(1);
    expect(payload.outgoingEdges[0]).toMatchObject({ name: 'documents', loc: 'src-node:documents:tgt' });
    expect(ownerRepo).toBe('acme/repo');
    expect(clientId).toBe('client-1');
    expect(memId).toBe(memoryId);
  });

  it('refreshes edge metadata when a queued Git write finally holds the checkout lock', async () => {
    const target = await db.node.create({
      data: { id: generateId(), memoryId, loc: 'target', name: 'Target', tags: [] },
    });
    const node = await db.node.create({
      data: { id: generateId(), memoryId, loc: 'source', name: 'Source', tags: [] },
    });
    const edge = await db.edge.create({
      data: {
        id: generateId(), memoryId, sourceId: node.id, targetId: target.id,
        loc: 'source:uses:target', name: 'uses', description: 'old',
      },
    });

    await handleNodeWrittenForGit(db, { nodeId: node.id, memoryId });
    const initial = mockWrite.mock.calls[0][0];
    const refresh = mockWrite.mock.calls[0][4];
    expect(initial.outgoingEdges[0].description).toBe('old');
    expect(refresh).toBeTypeOf('function');

    // The first event was already dispatched, but a later edge commit can
    // happen while that job waits for another checkout writer.
    await db.edge.update({ where: { id: edge.id }, data: { description: 'new' } });
    const latest = await refresh!();
    expect(latest?.outgoingEdges[0].description).toBe('new');
  });

  it('defaults ownerRepo to "" and clientId to null when the event omits them', async () => {
    const node = await db.node.create({
      data: { id: generateId(), memoryId, loc: 'bare', name: 'Bare', tags: [] },
    });
    await handleNodeWrittenForGit(db, { nodeId: node.id, memoryId });
    const [, ownerRepo, clientId] = mockWrite.mock.calls[0];
    expect(ownerRepo).toBe('');
    expect(clientId).toBeNull();
  });

  it('no-ops for a node that vanished since the event', async () => {
    await handleNodeWrittenForGit(db, { nodeId: generateId(), memoryId });
    expect(mockWrite).not.toHaveBeenCalled();
  });

  it('no-ops for a soft-deleted node', async () => {
    const node = await db.node.create({
      data: {
        id: generateId(),
        memoryId,
        loc: 'gone',
        name: 'Gone',
        tags: [],
        deletedAt: new Date(),
      },
    });
    await handleNodeWrittenForGit(db, { nodeId: node.id, memoryId });
    expect(mockWrite).not.toHaveBeenCalled();
  });

  it('refuses an event whose memoryId disagrees with the node (forged/corrupt routing)', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const otherMemory = await db.memory.create({
      data: {
        id: generateId(),
        organizationId: (await db.memory.findUniqueOrThrow({ where: { id: memoryId } }))
          .organizationId,
        name: 'other',
        urn: 'git-evt-org:other',
        class: 'knowledge',
      },
    });
    const node = await db.node.create({
      data: { id: generateId(), memoryId, loc: 'real-home', name: 'Real', tags: [] },
    });
    // Event claims the node lives in otherMemory — mirroring would route this
    // node's content into otherMemory's repo (PR-507 review, Codex P2).
    await handleNodeWrittenForGit(db, { nodeId: node.id, memoryId: otherMemory.id });
    expect(mockWrite).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('memoryId mismatch'));
    warnSpy.mockRestore();
  });

  it('punts on an encrypted memory (request-time direct write owns those)', async () => {
    await db.memory.update({ where: { id: memoryId }, data: { isEncrypted: true } });
    const node = await db.node.create({
      data: { id: generateId(), memoryId, loc: 'enc', name: 'Enc', tags: [] },
    });
    await handleNodeWrittenForGit(db, { nodeId: node.id, memoryId });
    expect(mockWrite).not.toHaveBeenCalled();
  });
});
