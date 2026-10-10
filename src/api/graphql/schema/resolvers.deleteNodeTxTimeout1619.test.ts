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

describe('#1619 — deleteNode transaction timeout', () => {
  it.each([
    ['hard recursive', { hard: true, recursive: true }],
    ['soft recursive', { recursive: true }],
  ])('%s delete runs under an explicit timeout above the 5s default', async (_n, args) => {
    const parent = await db.node.create({ data: { id: generateId(), memoryId: mem.id, loc: 'big', name: 'big' } });
    for (let i = 0; i < 25; i++) {
      await db.node.create({ data: { id: generateId(), memoryId: mem.id, loc: `big:c${i}`, name: `c${i}` } });
    }
    const spy = vi.spyOn(db, '$transaction');
    try {
      await resolvers.Mutation.deleteNode({}, { nodeRef: parent.id, ...args }, ctx());
      const opts = spy.mock.calls.map((c) => c[1] as { timeout?: number } | undefined);
      expect(opts.length).toBeGreaterThan(0);
      for (const o of opts) expect(o?.timeout ?? 5_000).toBeGreaterThan(5_000);
      expect(await db.node.count({ where: { memoryId: mem.id, deletedAt: null } })).toBe(0);
    } finally {
      spy.mockRestore();
    }
  });
});
