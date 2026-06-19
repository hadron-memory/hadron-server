/**
 * Node.isRunnable GraphQL integration coverage. Drives the `upsertNode`
 * mutation directly through the resolver layer (mirrors
 * src/test/integration/node-abstract.test.ts).
 *
 * What this file pins:
 *
 *   - `upsertNode(input: { isRunnable })` create-mode persists the flag
 *     and returns it on the result object.
 *   - Update-mode replaces the value when a new boolean is supplied, and
 *     omitting the key preserves the existing value (Prisma's
 *     "undefined → leave column untouched" semantic).
 *
 * The portal node-detail edit form (hadron-portal #322) writes this flag
 * through the same NodeInput field, so this is the server-side contract
 * that backs that UI.
 *
 * Constitution refinement I — graph-touching mutation, integration test
 * against the real `hadron_test` DB (pinned by vitest.config.ts).
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { db } from '../../integrations/db/client.js';
import { cleanDb } from '../helpers.js';
import { resolvers, type Context } from '../../api/graphql/schema/resolvers.js';
import { generateId } from '../../lib/id.js';

// upsertNode fires writeNodeToGit asynchronously; pin to a no-op so the
// test doesn't try to push to a real remote.
vi.mock('../../integrations/github/writeNodeToGit.js', () => ({
  writeNodeToGit: vi.fn().mockResolvedValue(undefined),
}));

interface Fixture {
  ctx: Context;
  memory: { id: string; urn: string };
}

let fx: Fixture;

beforeEach(async () => {
  await cleanDb(db);

  const org = await db.organization.create({
    data: { id: generateId(), name: 'gq-run-org', urn: 'gq-run-org' },
  });
  const admin = await db.user.create({
    data: { githubId: 9811, githubUsername: 'gq-run-admin', roles: ['ADMIN'] },
  });
  await db.orgMember.create({
    data: { organizationId: org.id, userId: admin.id, role: 'ADMIN' },
  });

  const ctx: Context = {
    db,
    roles: ['ADMIN'],
    userId: admin.id,
    clientId: `user:${admin.id}`,
  };
  const memory = await resolvers.Mutation.createMemory(
    {},
    { orgId: org.id, name: 'gqmem' },
    ctx,
  );

  fx = { ctx, memory };
});

async function upsertNode(input: Record<string, unknown>) {
  return resolvers.Mutation.upsertNode(
    {},
    { input: { memoryId: fx.memory.id, ...input } as never },
    fx.ctx,
  );
}

async function persistedIsRunnable(loc: string): Promise<boolean | null> {
  const node = await db.node.findFirst({
    where: { loc, memoryId: fx.memory.id, deletedAt: null },
    select: { isRunnable: true },
  });
  return node?.isRunnable ?? null;
}

describe('upsertNode — isRunnable', () => {
  it('persists isRunnable: true on create and returns it on the result', async () => {
    const node = await upsertNode({ loc: 'r1', name: 'r1', isRunnable: true });
    expect(node.isRunnable).toBe(true);
    expect(await persistedIsRunnable('r1')).toBe(true);
  });

  it('persists isRunnable: false on create', async () => {
    const node = await upsertNode({ loc: 'r2', name: 'r2', isRunnable: false });
    expect(node.isRunnable).toBe(false);
    expect(await persistedIsRunnable('r2')).toBe(false);
  });

  it('replaces the value on update when a new boolean is supplied', async () => {
    await upsertNode({ loc: 'r3', name: 'r3', isRunnable: true });
    await upsertNode({ loc: 'r3', name: 'r3', isRunnable: false });
    expect(await persistedIsRunnable('r3')).toBe(false);
  });

  it('omitting the isRunnable key preserves the existing value', async () => {
    await upsertNode({ loc: 'r4', name: 'r4', isRunnable: true });
    await upsertNode({ loc: 'r4', name: 'r4-renamed' });
    expect(await persistedIsRunnable('r4')).toBe(true);
  });
});
