/**
 * Task — a new node added to an already-ordered sibling list gets the next
 * `seq` (lands at the end). Covered on BOTH single-node create surfaces that
 * carry a seq: the GraphQL `upsertNode` resolver and the MCP `hadron_create_node`
 * tool, which share `nextSiblingSeq` (src/lib/nodeSeq.ts).
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { resolvers, type Context } from './resolvers.js';
import { createTestableMcpServer } from '../../../mcp/server.js';
import type { AuthContext } from '../../../middleware/auth.js';

vi.mock('../../../integrations/github/writeNodeToGit.js', () => ({
  writeNodeToGit: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../../../integrations/github/syncGraphFromGithub.js', () => ({
  syncGraphFromGithub: vi.fn().mockResolvedValue({ error: null }),
}));

let orgId: string;
let memoryId: string;
let memoryUrn: string;
let adminId: string;

function gqlCtx(): Context {
  return { db, roles: ['ADMIN'], userId: adminId, clientId: `user:${adminId}` };
}
function adminAuth(): AuthContext {
  return { userId: adminId, roles: ['ADMIN'], clientId: `user:${adminId}` };
}

async function seedSibling(loc: string, seq: number | null) {
  return db.node.create({ data: { id: generateId(), memoryId, loc, name: loc, tags: [], seq } });
}

beforeEach(async () => {
  await cleanDb(db);
  const org = await db.organization.create({
    data: { id: generateId(), name: 'seqa-org', urn: 'seqa-org' },
  });
  orgId = org.id;
  const admin = await db.user.create({
    data: { githubId: 9941, githubUsername: 'seqa-admin', roles: ['ADMIN'] },
  });
  adminId = admin.id;
  await db.orgMember.create({ data: { organizationId: orgId, userId: adminId, role: 'ADMIN' } });
  const memory = await resolvers.Mutation.createMemory({}, { orgId, name: 'seqmem' }, gqlCtx());
  memoryId = memory.id;
  // Fully-qualified memory URN (org::memory) for node-URN construction. The
  // stored urn uses a single colon (seqa-org:seqmem); hadron_create_node wants the
  // org::memory::loc form.
  memoryUrn = 'seqa-org::seqmem';
});

describe('upsertNode — auto-assign seq into an ordered sibling list', () => {
  it('assigns max(sibling seq)+1 when the list is ordered and no seq is given', async () => {
    await seedSibling('parent:a', 1);
    await seedSibling('parent:b', 2);
    const node = await resolvers.Mutation.upsertNode(
      null,
      { input: { memoryId, loc: 'parent:c', name: 'c' } },
      gqlCtx(),
    );
    expect(node.seq).toBe(3);
  });

  it('leaves seq null when the sibling list is unordered', async () => {
    await seedSibling('parent:a', null);
    const node = await resolvers.Mutation.upsertNode(
      null,
      { input: { memoryId, loc: 'parent:c', name: 'c' } },
      gqlCtx(),
    );
    expect(node.seq).toBeNull();
  });

  it('respects an explicit seq even when the list is ordered', async () => {
    await seedSibling('parent:a', 1);
    const node = await resolvers.Mutation.upsertNode(
      null,
      { input: { memoryId, loc: 'parent:c', name: 'c', seq: 99 } },
      gqlCtx(),
    );
    expect(node.seq).toBe(99);
  });

  it('does not re-assign seq when updating an existing node', async () => {
    await seedSibling('parent:a', 1);
    await seedSibling('parent:b', 2);
    // Upsert over an existing seq-bearing node with no seq → preserve it,
    // don't treat it as a fresh insert at the end.
    const node = await resolvers.Mutation.upsertNode(
      null,
      { input: { memoryId, loc: 'parent:a', name: 'renamed' } },
      gqlCtx(),
    );
    expect(node.seq).toBe(1);
  });
});

describe('hadron_create_node — mirrors the auto-seq rule (parity)', () => {
  it('assigns the next seq into an ordered sibling list', async () => {
    await seedSibling('parent:a', 1);
    await seedSibling('parent:b', 2);
    const srv = createTestableMcpServer(adminAuth());
    await srv.callToolText('hadron_create_node', { urn: `${memoryUrn}::parent:c`, name: 'c' });
    const created = await db.node.findUnique({ where: { loc_memoryId: { loc: 'parent:c', memoryId } } });
    expect(created?.seq).toBe(3);
  });

  it('respects an explicit seq', async () => {
    await seedSibling('parent:a', 1);
    const srv = createTestableMcpServer(adminAuth());
    await srv.callToolText('hadron_create_node', { urn: `${memoryUrn}::parent:c`, name: 'c', seq: 88 });
    const created = await db.node.findUnique({ where: { loc_memoryId: { loc: 'parent:c', memoryId } } });
    expect(created?.seq).toBe(88);
  });

  it('preserves an existing seq on update when omitted (parity with upsertNode)', async () => {
    await seedSibling('parent:a', 1);
    await seedSibling('parent:b', 2);
    const srv = createTestableMcpServer(adminAuth());
    await srv.callToolText('hadron_create_node', { urn: `${memoryUrn}::parent:a`, name: 'renamed' });
    const updated = await db.node.findUnique({ where: { loc_memoryId: { loc: 'parent:a', memoryId } } });
    expect(updated?.seq).toBe(1);
  });
});
