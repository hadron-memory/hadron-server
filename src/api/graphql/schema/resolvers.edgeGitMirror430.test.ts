import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { generateDataKey } from '../../../lib/crypto.js';
import { encryptNodeFieldsWithKey } from '../../../lib/nodeCrypto.js';
import { sessionKeyCache } from '../../../lib/sessionKeyCache.js';
import { clearNodeWrittenLocalHandlers, registerNodeWrittenLocalHandler } from '../../../lib/events/nodeWritten.js';
import { handleNodeWrittenForGit } from '../../../integrations/github/nodeWrittenSubscriber.js';
import { writeNodeToGit } from '../../../integrations/github/writeNodeToGit.js';
import { resolvers, type Context } from './resolvers.js';
import { addEdge } from '../../../mcp/server.js';

vi.mock('../../../integrations/github/writeNodeToGit.js', () => ({
  writeNodeToGit: vi.fn(async () => {}),
}));

const mirror = vi.mocked(writeNodeToGit);
const M = resolvers.Mutation as unknown as Record<string, (...args: unknown[]) => Promise<any>>;

let context: Context;
let sourceId: string;
let targetId: string;
let memoryId: string;

beforeEach(async () => {
  vi.clearAllMocks();
  clearNodeWrittenLocalHandlers();
  await cleanDb(db);
  const org = await db.organization.create({
    data: { id: generateId(), name: 'edge-mirror-org', urn: 'edge-mirror-org' },
  });
  const user = await db.user.create({
    data: { githubId: 430, githubUsername: 'edge-mirror-owner', roles: ['ADMIN'] },
  });
  await db.orgMember.create({
    data: { organizationId: org.id, userId: user.id, role: 'ADMIN' },
  });
  const memory = await db.memory.create({
    data: {
      id: generateId(), organizationId: org.id, name: 'mirror', urn: 'edge-mirror-org:mirror',
      class: 'knowledge', source: 'git@github.com:edge-mirror-org/mirror.git',
    },
  });
  memoryId = memory.id;
  const source = await db.node.create({
    data: { id: generateId(), memoryId, loc: 'source', name: 'Source', tags: [] },
  });
  const target = await db.node.create({
    data: { id: generateId(), memoryId, loc: 'target', name: 'Target', tags: [] },
  });
  sourceId = source.id;
  targetId = target.id;
  context = { db, roles: ['ADMIN'], userId: user.id, clientId: `user:${user.id}` } as Context;
  registerNodeWrittenLocalHandler('edge-mirror-test', (event) => handleNodeWrittenForGit(db, event));
});

afterEach(() => {
  clearNodeWrittenLocalHandlers();
  sessionKeyCache.evict('edge-mirror-encrypted');
});

describe('#430 edge writes mirror their source node', () => {
  it('mirrors GraphQL create, update, and delete after the committed edge change', async () => {
    const edge = await M.createEdge({}, { sourceRef: sourceId, targetRef: targetId, name: 'uses' }, context);
    await vi.waitFor(() => expect(mirror).toHaveBeenCalledTimes(1));
    expect(mirror.mock.lastCall?.[0]).toMatchObject({
      id: sourceId,
      outgoingEdges: [{ id: edge.id, name: 'uses' }],
    });

    await M.updateEdge({}, { edgeRef: edge.id, description: 'updated' }, context);
    await vi.waitFor(() => expect(mirror).toHaveBeenCalledTimes(2));
    expect(mirror.mock.lastCall?.[0]).toMatchObject({
      id: sourceId,
      outgoingEdges: [{ id: edge.id, description: 'updated' }],
    });

    await M.deleteEdge({}, { edgeRef: edge.id }, context);
    await vi.waitFor(() => expect(mirror).toHaveBeenCalledTimes(3));
    expect(mirror.mock.lastCall?.[0]).toMatchObject({ id: sourceId, outgoingEdges: [] });
    expect(mirror.mock.calls.every((call) => call[3] === memoryId)).toBe(true);
  });

  it('mirrors the source when the standalone MCP create-edge helper writes an edge', async () => {
    const result = await addEdge({
      sourceUrn: sourceId,
      targetUrn: targetId,
      name: 'cites',
      auth: { userId: context.userId, roles: ['ADMIN'], clientId: context.clientId },
    });
    expect(result).not.toHaveProperty('error');
    await vi.waitFor(() => expect(mirror).toHaveBeenCalledTimes(1));
    expect(mirror.mock.lastCall?.[0]).toMatchObject({
      id: sourceId,
      outgoingEdges: [{ name: 'cites' }],
    });
  });

  it('never exports an encrypted source, even with a warm session key (R206)', async () => {
    const key = generateDataKey();
    sessionKeyCache.set('edge-mirror-encrypted', memoryId, key);
    await db.memory.update({
      where: { id: memoryId },
      data: { class: 'private', userId: context.userId, isEncrypted: true },
    });
    await db.node.update({
      where: { id: sourceId },
      data: { content: encryptNodeFieldsWithKey({ content: 'source secret' }, key).content },
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await M.createEdge({}, { sourceRef: sourceId, targetRef: targetId, name: 'uses' }, context);
    await new Promise(resolve => setTimeout(resolve, 100));
    expect(mirror).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/ENCRYPTED_GIT_SYNC_UNAVAILABLE/));
    warn.mockRestore();
  });
});
