/**
 * #1619 — a recursive hard delete runs in one interactive transaction. Prisma's
 * default interactive-transaction timeout (5 s) is too tight for a subtree whose
 * FK cascades (edges, revisions, derived rows) take longer, so the transaction
 * expired partway ("Transaction already closed") and nothing was deleted. The
 * delete must run under an explicit, generous timeout like its sibling bulk
 * mutations.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { resolvers, type Context } from './resolvers.js';
import { generateId } from '../../../lib/id.js';
import { createTestableMcpServer } from '../../../mcp/server.js';
import type { AuthContext } from '../../../middleware/auth.js';

let admin: { id: string };
let mem: { id: string };

const ctx = (): Context => ({ db, roles: ['ADMIN'], userId: admin.id }) as Context;

beforeEach(async () => {
  await cleanDb(db);
  const org = await db.organization.create({ data: { id: generateId(), name: 'tx-org', urn: 'tx-org' } });
  admin = await db.user.create({ data: { githubId: 16190, githubUsername: 'tx-admin', handle: 'tx-admin', roles: ['ADMIN'] } });
  await db.orgMember.create({ data: { organizationId: org.id, userId: admin.id, role: 'ADMIN' } });
  mem = await db.memory.create({
    data: { id: generateId(), organizationId: org.id, urn: 'tx-org:m', name: 'm', class: 'knowledge' },
    select: { id: true },
  });
});

const MIN_TIMEOUT_MS = 120_000;

async function seedSubtree() {
  const parent = await db.node.create({ data: { id: generateId(), memoryId: mem.id, loc: 'big', name: 'big' } });
  for (let i = 0; i < 25; i++) {
    await db.node.create({ data: { id: generateId(), memoryId: mem.id, loc: `big:c${i}`, name: `c${i}` } });
  }
  return parent;
}

/** Timeout option of every interactive transaction the call opened (undefined = Prisma's 5s default). */
function timeouts(spy: { mock: { calls: unknown[][] } }) {
  return spy.mock.calls.map((c) => (c[1] as { timeout?: number } | undefined)?.timeout);
}

describe('#1619 — recursive delete transaction timeout', () => {
  it.each([
    ['hard recursive', { hard: true, recursive: true }],
    ['soft recursive', { recursive: true }],
  ])('GraphQL deleteNode %s runs under >= 120s', async (_n, args) => {
    const parent = await seedSubtree();
    const spy = vi.spyOn(db, '$transaction');
    try {
      await resolvers.Mutation.deleteNode({}, { nodeRef: parent.id, ...args }, ctx());
      const t = timeouts(spy);
      expect(t.length).toBeGreaterThan(0);
      for (const v of t) expect(v).toBeGreaterThanOrEqual(MIN_TIMEOUT_MS);
      expect(await db.node.count({ where: { memoryId: mem.id, deletedAt: null } })).toBe(0);
    } finally {
      spy.mockRestore();
    }
  });

  it.each([
    ['hard recursive', { hard: true, recursive: true }],
    ['soft recursive', { recursive: true }],
  ])('MCP hadron_delete_node %s runs under >= 120s', async (_n, args) => {
    await seedSubtree();
    const spy = vi.spyOn(db, '$transaction');
    try {
      const text = await createTestableMcpServer({
        userId: admin.id, roles: ['ADMIN'], clientId: `user:${admin.id}`,
      } as AuthContext).callToolText('hadron_delete_node', { urn: 'hrn:node:tx-org:m:big', ...args });
      expect(text).not.toMatch(/refused|not found|error/i);
      const t = timeouts(spy);
      expect(t.length).toBeGreaterThan(0);
      for (const v of t) expect(v).toBeGreaterThanOrEqual(MIN_TIMEOUT_MS);
      expect(await db.node.count({ where: { memoryId: mem.id, deletedAt: null } })).toBe(0);
    } finally {
      spy.mockRestore();
    }
  });
});
