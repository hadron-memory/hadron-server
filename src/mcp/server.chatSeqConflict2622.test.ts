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

// Main's #2987 (V13) gate refuses a message seq write at these two doors BEFORE the
// #992 constraint can fire, so the refusal here is [seq_protected]; the typed
// CHAT_MESSAGE_SEQ_CONFLICT is pinned at the doors V13 leaves open (clone, move) in
// src/lib/chatSeqUnique.test.ts. What this file still pins: no raw P2002 and no write.
describe('MCP node tools — the #992 typed refusal reaches the real writers (#2622)', () => {
  it('hadron_create_node refuses a colliding (chat, seq) as [seq_protected], writing nothing', async () => {
    await seedChatMessage('qa:messages:001-first', 1);
    const srv = createTestableMcpServer(adminAuth());
    const text = await srv.callToolText('hadron_create_node', {
      urn: `urn:node:${memory.urn}:qa:messages:001-collide`,
      name: 'collide',
      nodeType: 'chat-message',
      seq: 1,
      content: 'duplicate seq',
    });

    expect(text).toContain('[seq_protected]');
    // A refusal that still wrote the row would satisfy a message-only assert.
    expect(await db.node.findFirst({ where: { memoryId: memory.id, loc: 'qa:messages:001-collide' } })).toBeNull();
  });

  it('hadron_update_node refuses a seq-naming update of an existing message pre-write, leaving the row untouched', async () => {
    await seedChatMessage('qa:messages:001-first', 1);
    const victim = await seedChatMessage('qa:messages:002-second', 2);
    const srv = createTestableMcpServer(adminAuth());
    const text = await srv.callToolText('hadron_update_node', {
      urn: `urn:node:${memory.urn}:qa:messages:002-second`,
      seq: 1,
      content: 'now colliding',
    });

    expect(text).toContain('[seq_protected]');
    const row = await db.node.findUniqueOrThrow({ where: { id: victim } });
    expect(row.seq).toBe(2);
    expect(row.content).toBe('seeded');
  });

  // Diego BLIND P3: the two tests above stop at the V13 gate, so neither runs the
  // inline catch branches. Provoke the REAL constraint error (a raw colliding
  // insert with the index live), then raise exactly that error at the write
  // boundary of each tool and assert the named refusal, no raw diagnostics.
  async function realConstraintError(): Promise<unknown> {
    await seedChatMessage('qa:messages:001-first', 1);
    try {
      await seedChatMessage('qa:messages:001-dupe', 1);
    } catch (e) {
      await db.node.deleteMany({ where: { memoryId: memory.id, loc: 'qa:messages:001-dupe' } });
      return e;
    }
    throw new Error('the #992 constraint did not fire');
  }

  it('hadron_create_node maps the real constraint error to [chat_message_seq_conflict] (catch branch)', async () => {
    const err = await realConstraintError();
    const spy = vi.spyOn(db, '$transaction').mockRejectedValueOnce(err as Error);
    try {
      const srv = createTestableMcpServer(adminAuth());
      const text = await srv.callToolText('hadron_create_node', {
        urn: `urn:node:${memory.urn}:qa:messages:003-x`,
        name: 'x', nodeType: 'note', content: 'c',
      });
      expect(text).toContain('[chat_message_seq_conflict]');
      expect(text).not.toMatch(/P2002|nodes_chat_message_seq_unique_idx|Unique constraint/i);
    } finally {
      spy.mockRestore();
    }
    expect(await db.node.findFirst({ where: { memoryId: memory.id, loc: 'qa:messages:003-x' } })).toBeNull();
  });

  it('hadron_update_node maps the real constraint error to [chat_message_seq_conflict] (catch branch), row untouched', async () => {
    const err = await realConstraintError();
    const victim = await seedChatMessage('qa:messages:002-second', 2);
    const spy = vi.spyOn(db, '$transaction').mockRejectedValueOnce(err as Error);
    try {
      const srv = createTestableMcpServer(adminAuth());
      const text = await srv.callToolText('hadron_update_node', {
        urn: `urn:node:${memory.urn}:qa:messages:002-second`,
        content: 'edited',
      });
      expect(text).toContain('[chat_message_seq_conflict]');
      expect(text).not.toMatch(/P2002|nodes_chat_message_seq_unique_idx|Unique constraint/i);
    } finally {
      spy.mockRestore();
    }
    expect((await db.node.findUniqueOrThrow({ where: { id: victim } })).content).toBe('seeded');
  });

  // Ralion §10 P3-1: the REACHABLE route into the MCP create catch — a seq-less
  // chat-message create is given the soft-deleted top seq by nextSiblingSeq.
  it('hadron_create_node refuses a seq-less create handed a soft-deleted top seq, as [chat_message_seq_conflict]', async () => {
    await seedChatMessage('qa:messages:003-live', 3);
    const id = await seedChatMessage('qa:messages:004-gone', 4);
    await db.node.update({ where: { id }, data: { deletedAt: new Date() } });
    const srv = createTestableMcpServer(adminAuth());
    const text = await srv.callToolText('hadron_create_node', {
      urn: `urn:node:${memory.urn}:qa:messages:006-next`,
      name: '006-next', nodeType: 'chat-message', content: 'next',
    });
    expect(text).toContain('[chat_message_seq_conflict]');
    expect(text).not.toMatch(/P2002|Unique constraint/i);
    expect(await db.node.findFirst({ where: { memoryId: memory.id, loc: 'qa:messages:006-next' } })).toBeNull();
  });
});
