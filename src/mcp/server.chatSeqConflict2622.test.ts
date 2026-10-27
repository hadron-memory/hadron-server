/**
 * #2622 (Gizelle LOCAL P2): MCP `hadron_create_node` / `hadron_update_node`
 * write through INLINE Prisma calls, not `writeNodeCore` — so the first #992
 * head mapped the typed refusal at the GraphQL doors and left these two
 * surfaces raising the raw P2002 (surfacing as an internal error). A caller
 * of the surface agents actually drive must get the same named refusal the
 * GraphQL surface gives, and the refused write must leave the row untouched.
 *
 * The move half of the finding (GraphQL moveNode → nodeMoveOps.moveWithResult)
 * is pinned in src/lib/chatSeqUnique.test.ts with the constraint matrix.
 *
 * Test harness: `createTestableMcpServer` drives the real production closure
 * (auth + Prisma + the registered tool) without an HTTP transport — same as
 * server.createNodeLiveCollision1181.test.ts.
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

let admin: { id: string };
let memory: { id: string; urn: string };

const adminAuth = (): AuthContext => ({
  userId: admin.id,
  roles: ['ADMIN'],
  clientId: `user:${admin.id}`,
});

/** A canonical-shaped chat-message row, placed by the storage class the
 * constraint exists for (direct writes the allocator never saw). */
async function seedChatMessage(loc: string, seq: number) {
  const id = generateId();
  await db.node.create({
    data: {
      id, memoryId: memory.id, loc, name: loc.split(':').pop()!,
      nodeType: 'chat-message', content: 'seeded', seq, createdBy: admin.id,
    },
  });
  return id;
}

beforeEach(async () => {
  await cleanDb(db);
  const org = await db.organization.create({
    data: { id: generateId(), name: 'csq-mcp-org', urn: `csq-mcp-${Date.now()}.com` },
  });
  admin = await db.user.create({
    data: { githubId: 26221, githubUsername: `csq-mcp-admin-${Date.now()}`, roles: ['ADMIN'] },
  });
  await db.orgMember.create({ data: { organizationId: org.id, userId: admin.id, role: 'ADMIN' } });
  memory = await resolvers.Mutation.createMemory(
    {},
    { orgId: org.id, name: 'csq-mcp' },
    { db, roles: ['ADMIN'], userId: admin.id } as Context,
  );
});

describe('MCP node tools — the #992 typed refusal reaches the real writers (#2622)', () => {
  it('hadron_create_node refuses a colliding (chat, seq) as [chat_message_seq_conflict], writing nothing', async () => {
    await seedChatMessage('qa:messages:001-first', 1);
    const srv = createTestableMcpServer(adminAuth());
    const text = await srv.callToolText('hadron_create_node', {
      urn: `urn:node:${memory.urn}:qa:messages:001-collide`,
      name: 'collide',
      nodeType: 'chat-message',
      seq: 1,
      content: 'duplicate seq',
    });

    expect(text).toContain('[chat_message_seq_conflict]');
    // A refusal that still wrote the row would satisfy a message-only assert.
    expect(await db.node.findFirst({ where: { memoryId: memory.id, loc: 'qa:messages:001-collide' } })).toBeNull();
  });

  it('hadron_update_node refuses moving an existing message INTO collision, leaving the row untouched', async () => {
    await seedChatMessage('qa:messages:001-first', 1);
    const victim = await seedChatMessage('qa:messages:002-second', 2);
    const srv = createTestableMcpServer(adminAuth());
    const text = await srv.callToolText('hadron_update_node', {
      urn: `urn:node:${memory.urn}:qa:messages:002-second`,
      seq: 1,
      content: 'now colliding',
    });

    expect(text).toContain('[chat_message_seq_conflict]');
    const row = await db.node.findUniqueOrThrow({ where: { id: victim } });
    expect(row.seq).toBe(2);
    expect(row.content).toBe('seeded');
  });
});
