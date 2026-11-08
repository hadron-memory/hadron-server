/**
 * #1272 — restoreNodeRevision hands the embedder the restored PLAINTEXT, never
 * the stored ciphertext. The defect is already fixed on main; these are
 * regression pins (green on main), proven by a mutant that feeds the stored
 * row to the embedder instead (see the PR).
 *
 * Pins: (1) plaintext memory, (2) encrypted memory (ciphertext at rest, plaintext
 * to the embedder), (3) restore success is distinct from indexing success (an
 * enqueue that rejects or throws never fails the restore), (4) a keyless restore
 * into an encrypted memory refuses before any write or enqueue.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { resolvers, type Context } from './resolvers.js';
import { generateId } from '../../../lib/id.js';
import { isCiphertext, parseDataKey } from '../../../lib/crypto.js';
import { sessionKeyCache } from '../../../lib/sessionKeyCache.js';
import { requestKeyStorage } from '../../../lib/requestKeys.js';

const enqueueSpy = vi.hoisted(() => vi.fn());

vi.mock('../../../integrations/github/writeNodeToGit.js', () => ({
  writeNodeToGit: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../../../lib/bus/index.js', () => ({
  getBusClient: vi.fn(async () => null),
}));
vi.mock('../../../services/embedding/enqueue.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../services/embedding/enqueue.js')>()),
  enqueueNodeEmbedding: enqueueSpy,
}));

const dataKey = Buffer.alloc(32, 11).toString('base64');

let owner: { id: string };
let memoryId: string;
let nodeId: string;
let priorId: string;

function ownerCtx(): Context {
  return { db, roles: ['READER'], userId: owner.id };
}

/** encryptMemory refuses an indexed memory without an inversion ack; turn the index off first. */
async function encryptWithIndexOff(): Promise<void> {
  await db.memory.update({ where: { id: memoryId }, data: { vectorIndexEnabled: false } });
  await resolvers.Mutation.encryptMemory({}, { memoryId, dataKey }, ownerCtx());
}

/** The `plaintext` argument of every enqueue call so far. */
function embedInputs(): Array<{ content: unknown; abstract: unknown }> {
  return enqueueSpy.mock.calls.map((c) => (c[1] as { plaintext: { content: unknown; abstract: unknown } }).plaintext);
}

beforeEach(async () => {
  await cleanDb(db);
  sessionKeyCache.clear();
  enqueueSpy.mockReset();
  const org = await db.organization.create({ data: { id: generateId(), name: 'r1272-org', urn: 'r1272-org' } });
  owner = await db.user.create({ data: { githubId: 12720, githubUsername: 'r1272-owner', roles: ['READER'] } });
  await db.orgMember.create({ data: { organizationId: org.id, userId: owner.id, role: 'ADMIN' } });
  const memory = await db.memory.create({
    data: {
      id: generateId(), organizationId: org.id, name: 'diary', urn: 'r1272-org:diary',
      class: 'private', userId: owner.id, vectorIndexEnabled: true,
    },
  });
  memoryId = memory.id;
  const node = await db.node.create({
    data: {
      id: generateId(), memoryId, loc: 'entry-1', name: 'Entry 1',
      content: 'current text', abstract: 'current abstract', data: {}, tags: [],
    },
  });
  nodeId = node.id;
  const prior = await db.nodeRevision.create({
    data: {
      id: generateId(), nodeId, memoryId, loc: 'entry-1', name: 'Entry 1',
      content: 'restored plaintext body', abstract: 'restored plaintext abstract',
      data: {}, nodeType: 'info',
    },
  });
  priorId = prior.id;
});

afterEach(() => sessionKeyCache.clear());

describe('restoreNodeRevision → embedder input (#1272)', () => {
  it('plaintext memory: the embedder receives the restored content and abstract', async () => {
    await resolvers.Mutation.restoreNodeRevision({}, { revisionId: priorId }, ownerCtx());
    expect(enqueueSpy).toHaveBeenCalledTimes(1);
    expect(enqueueSpy.mock.calls[0][1]).toMatchObject({ nodeId, memoryId });
    expect(embedInputs()).toEqual([
      { content: 'restored plaintext body', abstract: 'restored plaintext abstract' },
    ]);
  });

  it('encrypted memory: ciphertext at rest, restored plaintext (never ciphertext) to the embedder', async () => {
    await encryptWithIndexOff();
    // Re-enable the index (with the inversion ack the CHECK requires) so the
    // embedding obligation path is live for the restore.
    await db.memory.update({
      where: { id: memoryId },
      data: { vectorIndexEnabled: true, vectorIndexEncryptedAckAt: new Date() },
    });
    enqueueSpy.mockReset();
    await requestKeyStorage.run(new Map([[memoryId, parseDataKey(dataKey)]]), async () => {
      await resolvers.Mutation.restoreNodeRevision({}, { revisionId: priorId }, ownerCtx());
    });
    const stored = await db.node.findUniqueOrThrow({ where: { id: nodeId } });
    expect(isCiphertext(stored.content)).toBe(true);
    expect(isCiphertext(stored.abstract)).toBe(true);
    expect(enqueueSpy).toHaveBeenCalledTimes(1);
    const [input] = embedInputs();
    expect(input).toEqual({ content: 'restored plaintext body', abstract: 'restored plaintext abstract' });
    expect(isCiphertext(input.content as string)).toBe(false);
    expect(isCiphertext(input.abstract as string)).toBe(false);
  });

  it('restore success is distinct from indexing success: a failing enqueue never fails the restore', async () => {
    // The caller fires and forgets (`void`); pre-handle the rejection so the pin
    // does not depend on the runner's unhandled-rejection policy.
    enqueueSpy.mockImplementation(() => {
      const failed = Promise.reject(new Error('embedder down'));
      failed.catch(() => undefined);
      return failed;
    });
    const response = await resolvers.Mutation.restoreNodeRevision({}, { revisionId: priorId }, ownerCtx());
    expect(response).toMatchObject({ content: 'restored plaintext body' });
    expect((await db.node.findUniqueOrThrow({ where: { id: nodeId } })).content).toBe('restored plaintext body');
  });

  it('keyless restore into an encrypted memory refuses before any write or enqueue', async () => {
    await encryptWithIndexOff();
    sessionKeyCache.clear();
    enqueueSpy.mockReset();
    const before = await db.node.findUniqueOrThrow({ where: { id: nodeId } });
    const revisions = await db.nodeRevision.count({ where: { nodeId } });
    await expect(resolvers.Mutation.restoreNodeRevision({}, { revisionId: priorId }, ownerCtx()))
      .rejects.toMatchObject({ extensions: { code: 'SESSION_EXPIRED' } });
    const after = await db.node.findUniqueOrThrow({ where: { id: nodeId } });
    expect(after.content).toBe(before.content);
    expect(after.updatedAt).toEqual(before.updatedAt);
    expect(await db.nodeRevision.count({ where: { nodeId } })).toBe(revisions);
    expect(enqueueSpy).not.toHaveBeenCalled();
  });
});
