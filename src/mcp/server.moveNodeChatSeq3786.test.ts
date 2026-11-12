/**
 * #3786 (Charles QA F1, filed from #3776's stamped QA matrix): MCP
 * `hadron_move_node` was the one #992 writer door that never typed its
 * refusal. `hadron_create_node` / `hadron_update_node` answer the named
 * refusal (pinned in server.chatSeqConflict2622.test.ts — where the V13
 * [seq_protected] pre-write gate usually fires first) and GraphQL `moveNode`
 * answers CHAT_MESSAGE_SEQ_CONFLICT (src/lib/chatSeqUnique.test.ts), but a
 * move rebasing a seq-bearing chat-message into a taken (chat, seq) escaped
 * as the raw P2002 → `[INTERNAL_SERVER_ERROR] Internal server error`, while
 * the write itself was correctly refused (atomic, source unmoved).
 *
 * Unlike the create/update doors there is no pre-write gate on a move (V13
 * gates seq-NAMING writes; a move preserves seq and changes the chat), so the
 * REAL constraint error fires end-to-end through the production handler —
 * no error injection needed. Red-first on main: before the catch-branch fix
 * this test failed with the internal-error text.
 *
 * Test harness: `createTestableMcpServer` drives the real production closure
 * (auth + Prisma + the registered tool) without an HTTP transport — same as
 * server.chatSeqConflict2622.test.ts.
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

/** A canonical-shaped chat-message row, placed by direct writes the
 * allocator never saw — the storage class the constraint exists for. */
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
    data: { id: generateId(), name: 'csq-move-org', urn: `csq-move-${Date.now()}.com` },
  });
  admin = await db.user.create({
    data: { githubId: 37861, githubUsername: `csq-move-admin-${Date.now()}`, roles: ['ADMIN'] },
  });
  await db.orgMember.create({ data: { organizationId: org.id, userId: admin.id, role: 'ADMIN' } });
  memory = await resolvers.Mutation.createMemory(
    {},
    { orgId: org.id, name: 'csq-move' },
    { db, roles: ['ADMIN'], userId: admin.id } as Context,
  );
});

describe('MCP hadron_move_node — the #992 typed refusal (#3786)', () => {
  it('refuses rebasing a seq-bearing message into a taken (chat, seq) as [chat_message_seq_conflict], source untouched', async () => {
    // Chat `qa` holds seq 1; chat `qb` holds its own seq 1. The target loc in
    // `qa` is FREE, so no urn-exists refusal — the only collision is the
    // #992 (chat, seq) index, firing inside moveNodeSubtree's write.
    await seedChatMessage('qa:messages:001-first', 1);
    const moverId = await seedChatMessage('qb:messages:001-x', 1);
    const srv = createTestableMcpServer(adminAuth());
    const text = await srv.callToolText('hadron_move_node', {
      urn: `urn:node:${memory.urn}:qb:messages:001-x`,
      targetUrn: `urn:node:${memory.urn}:qa:messages:001-moved`,
    });

    expect(text).toContain('[chat_message_seq_conflict]');
    expect(text).toContain('A chat message with this sequence number already exists in this chat.');
    // Neither the raw Prisma shape nor the internal-error leak the defect showed.
    expect(text).not.toMatch(/P2002|nodes_chat_message_seq_unique_idx|Unique constraint|INTERNAL_SERVER_ERROR/i);
    // The refused move is atomic: the source row is exactly where it was and
    // nothing occupies the target loc.
    const row = await db.node.findUniqueOrThrow({ where: { id: moverId } });
    expect(row.loc).toBe('qb:messages:001-x');
    expect(row.seq).toBe(1);
    expect(await db.node.findFirst({ where: { memoryId: memory.id, loc: 'qa:messages:001-moved' } })).toBeNull();
  });

  it('leaves a NON-colliding seq-bearing move alone (negative control: the branch must not over-catch)', async () => {
    // Same door, same seq-bearing mover — but the destination chat holds
    // nothing, so the #992 index never fires and the fix's branch must stay
    // silent: the move succeeds exactly as before the fix.
    await seedChatMessage('qb:messages:001-x', 1);
    const srv = createTestableMcpServer(adminAuth());
    const text = await srv.callToolText('hadron_move_node', {
      urn: `urn:node:${memory.urn}:qb:messages:001-x`,
      targetUrn: `urn:node:${memory.urn}:qc:messages:001-x`,
    });

    expect(text).toContain('Moved "');
    expect(text).not.toContain('[chat_message_seq_conflict]');
    expect(text).not.toMatch(/P2002|INTERNAL_SERVER_ERROR/i);
    const row = await db.node.findFirstOrThrow({ where: { memoryId: memory.id, nodeType: 'chat-message' } });
    expect(row.loc).toBe('qc:messages:001-x');
    expect(row.seq).toBe(1); // the move preserves seq; only the chat changed
    expect(await db.node.findFirst({ where: { memoryId: memory.id, loc: 'qb:messages:001-x' } })).toBeNull();
  });

  it('types the refusal when a SUBTREE member hits the taken (chat, seq) — the whole move rolls back', async () => {
    // A two-row subtree: the ROOT's own slot in the destination is free
    // (('qa', 2) — qa only holds seq 1), so the root's write lands and the
    // constraint fires on the CHILD's rebase. This is the case that proves
    // the typed catch wraps moveNodeSubtree's WHOLE transaction: the refusal
    // is named AND every already-written row of the subtree rolls back.
    await seedChatMessage('qa:messages:001-first', 1);
    const parentId = await seedChatMessage('qb:messages:002-parent', 2);
    const childId = await seedChatMessage('qb:messages:002-parent:m1', 1);
    const srv = createTestableMcpServer(adminAuth());
    const text = await srv.callToolText('hadron_move_node', {
      urn: `urn:node:${memory.urn}:qb:messages:002-parent`,
      targetUrn: `urn:node:${memory.urn}:qa:messages:009-parent`,
    });

    expect(text).toContain('[chat_message_seq_conflict]');
    expect(text).toContain('A chat message with this sequence number already exists in this chat.');
    expect(text).not.toMatch(/P2002|nodes_chat_message_seq_unique_idx|Unique constraint|INTERNAL_SERVER_ERROR/i);
    // Atomic across the subtree: parent and child exactly where they were,
    // nothing at the destination — not even the root, whose own write had
    // already succeeded inside the aborted transaction.
    const parent = await db.node.findUniqueOrThrow({ where: { id: parentId } });
    expect(parent.loc).toBe('qb:messages:002-parent');
    expect(parent.seq).toBe(2);
    const child = await db.node.findUniqueOrThrow({ where: { id: childId } });
    expect(child.loc).toBe('qb:messages:002-parent:m1');
    expect(child.seq).toBe(1);
    expect(await db.node.findFirst({
      where: { memoryId: memory.id, loc: { startsWith: 'qa:messages:009-parent' } },
    })).toBeNull();
  });
});
