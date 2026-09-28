/**
 * #1360 review — `isMemoryReadableFresh` answers from the database, never from a
 * request memo. Pinned against seeded STALE memos (both the outer read cache and
 * the nested App-derived one) for a user who has no access at all, beside the
 * cached check as the control that the memos really were stale.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { type Context, isMemoryReadableCached, isMemoryReadableFresh } from './resolvers.helpers.js';

let memoryId: string;
let userId: string;

beforeEach(async () => {
  await cleanDb(db);
  const org = await db.organization.create({ data: { id: generateId(), name: 'acme', urn: 'acme.com' } });
  memoryId = (await db.memory.create({
    data: { id: generateId(), organizationId: org.id, urn: 'acme.com:kb', name: 'kb', class: 'knowledge', visibility: 'ORGANIZATION' },
  })).id;
  userId = (await db.user.create({ data: { githubId: 72001, githubUsername: 'stranger' } })).id;
});

const staleCtx = (): Context =>
  ({
    db,
    roles: [],
    userId,
    memoryReadCache: new Map([[memoryId, Promise.resolve(true)]]),
    appDerivedMemoryIdCache: Promise.resolve([memoryId]),
  }) as unknown as Context;

describe('isMemoryReadableFresh', () => {
  it('control: the cached check believes the seeded memo', async () => {
    expect(await isMemoryReadableCached(staleCtx(), memoryId)).toBe(true);
  });

  it('ignores a stale outer memo AND a stale App-derived memo, and replaces the outer one', async () => {
    const ctx = staleCtx();
    ctx.memoryReadCache!.delete(memoryId);
    // Only the nested App-derived memo claims access now: bypassing just the
    // outer cache would still answer true.
    expect(await isMemoryReadableFresh(ctx, memoryId)).toBe(false);
    expect(await isMemoryReadableCached(ctx, memoryId)).toBe(false);
  });

  it('with both memos stale, still answers from the database', async () => {
    const ctx = staleCtx();
    expect(await isMemoryReadableFresh(ctx, memoryId)).toBe(false);
    expect(await ctx.memoryReadCache!.get(memoryId)).toBe(false);
  });
});
