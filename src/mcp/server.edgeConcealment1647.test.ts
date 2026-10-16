/**
 * #1647 (cor:api:140:03): hadron_get_node and hadron_get_next_node conceal an edge whose far endpoint lives in a
 * memory the caller cannot read, as if it were absent; endpoints the caller can read keep their projection.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { db } from '../integrations/db/client.js';
import { cleanDb } from '../test/helpers.js';
import { generateId } from '../lib/id.js';
import { createTestableMcpServer } from './server.js';

vi.mock('../integrations/github/writeNodeToGit.js', () => ({ writeNodeToGit: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../integrations/github/syncGraphFromGithub.js', () => ({ syncGraphFromGithub: vi.fn().mockResolvedValue({ error: null }) }));

let bob: { id: string };
let near: { id: string };
let ownFar: { id: string };
let secretNode: { id: string };
let ownFarNode: { id: string };

beforeEach(async () => {
  await cleanDb(db);
  const sfx = generateId().slice(-8);
  bob = await db.user.create({ data: { id: generateId(), handle: `bob1647-${sfx}`, githubUsername: `bob1647-${sfx}`, roles: ['READER'] } });
  const alice = await db.user.create({ data: { id: generateId(), handle: `alice1647-${sfx}`, githubUsername: `alice1647-${sfx}`, roles: ['READER'] } });
  const mem = (name: string, userId: string) =>
    db.memory.create({ data: { id: generateId(), ownerUserId: userId, userId, class: 'personal', name, urn: `c1647.test:${name}` } });
  near = await mem('near', bob.id);
  ownFar = await mem('ownfar', bob.id);
  const secret = await mem('secret', alice.id);
  const parent = await db.node.create({ data: { memoryId: near.id, loc: 'p', name: 'Parent' } });
  const child = await db.node.create({ data: { memoryId: near.id, loc: 'p:c1', name: 'Child', seq: 1 } });
  secretNode = await db.node.create({ data: { memoryId: secret.id, loc: 'hidden', name: 'Hidden Alice Node' } });
  ownFarNode = await db.node.create({ data: { memoryId: ownFar.id, loc: 'visible', name: 'Visible Bob Node' } });
  await db.edge.create({ data: { memoryId: near.id, sourceId: child.id, targetId: secretNode.id, name: 'leaks', loc: 'p:c1:leaks:hidden' } });
  await db.edge.create({ data: { memoryId: near.id, sourceId: child.id, targetId: ownFarNode.id, name: 'ok', loc: 'p:c1:ok:visible' } });
  await db.edge.create({ data: { memoryId: secret.id, sourceId: secretNode.id, targetId: child.id, name: 'back', loc: 'hidden:back:p:c1' } });
  void parent;
});

const srv = () => createTestableMcpServer({ userId: bob.id, roles: ['READER'], clientId: `user:${bob.id}` });

describe('far-endpoint concealment (#1647)', () => {
  it('hadron_get_node hides the unreadable far endpoint (both directions) and keeps the readable one', async () => {
    const out = await srv().callToolText('hadron_get_node', { urn: 'hrn:node:c1647.test:near:p:c1' });
    expect(out).toContain('Child');
    expect(out).toContain('Visible Bob Node');
    expect(out).not.toContain('Hidden Alice Node');
    expect(out).not.toContain(secretNode.id);
  });

  it('hadron_get_next_node hides it too', async () => {
    const out = await srv().callToolText('hadron_get_next_node', { parent: 'hrn:node:c1647.test:near:p' });
    expect(out).toContain('Child');
    expect(out).toContain('Visible Bob Node');
    expect(out).not.toContain('Hidden Alice Node');
    expect(out).not.toContain(secretNode.id);
  });
});

describe('cross-memory cascade needs write authority over the other holding (#1647)', () => {
  async function carolEdgeIntoBob() {
    const carol = await db.user.create({ data: { id: generateId(), handle: `carol1647-${generateId().slice(-6)}`, roles: ['READER'] } });
    const cm = await db.memory.create({ data: { id: generateId(), ownerUserId: carol.id, userId: carol.id, class: 'personal', name: 'carol', urn: 'c1647.test:carol' } });
    const cn = await db.node.create({ data: { memoryId: cm.id, loc: 'mine', name: 'Carol Node' } });
    const bobNode = await db.node.findFirstOrThrow({ where: { loc: 'p:c1' } });
    const edge = await db.edge.create({ data: { memoryId: cm.id, sourceId: cn.id, targetId: bobNode.id, name: 'points', loc: 'mine:points:p:c1' } });
    return { edge, bobNode };
  }

  it('MCP hadron_delete_node refuses a hard delete + cascade that would remove an edge held by another user, atomically', async () => {
    const { edge, bobNode } = await carolEdgeIntoBob();
    const out = await srv().callToolText('hadron_delete_node', {
      urn: 'hrn:node:c1647.test:near:p:c1', hard: true, cascadeCrossMemoryEdges: true,
    });
    expect(out).toContain('Nothing was deleted');
    expect(await db.edge.findUnique({ where: { id: edge.id } })).not.toBeNull();
    expect(await db.node.findUnique({ where: { id: bobNode.id } })).not.toBeNull();
  });

  it('GraphQL deleteNode refuses the same, atomically', async () => {
    const { resolvers } = await import('../api/graphql/schema/resolvers.js');
    const { edge, bobNode } = await carolEdgeIntoBob();
    await expect(
      (resolvers.Mutation as any).deleteNode({}, { nodeRef: bobNode.id, hard: true, cascadeCrossMemoryEdges: true },
        { db, userId: bob.id, roles: ['READER'] }),
    ).rejects.toThrow();
    expect(await db.edge.findUnique({ where: { id: edge.id } })).not.toBeNull();
    expect(await db.node.findUnique({ where: { id: bobNode.id } })).not.toBeNull();
  });
});
