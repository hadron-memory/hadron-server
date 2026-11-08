/**
 * #1327: a rejected gate read is not an answer. The request memos behind the
 * memory-read gate must not keep a rejection, or a one-shot fault replays
 * through every later ask in the request (a saved rule's non-null state field
 * then fails the whole mutation). Each eviction below has its own pin.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';

vi.mock('../../../mcp/access-control.js', async (orig) => ({
  ...(await orig<typeof import('../../../mcp/access-control.js')>()),
  getPrincipalAppMemoryAccess: vi.fn(),
}));

import { getPrincipalAppMemoryAccess } from '../../../mcp/access-control.js';
import { type Context, getAccessibleMemoryIds, isMemoryReadableCached, isMemoryReadableFresh } from './resolvers.helpers.js';

const FAULT = new Error('one-shot fault');
let memoryId: string;
let userId: string;

beforeEach(async () => {
  await cleanDb(db);
  const org = await db.organization.create({ data: { id: generateId(), name: 'acme', urn: 'acme.com' } });
  memoryId = (await db.memory.create({
    data: { id: generateId(), organizationId: org.id, urn: 'acme.com:kb', name: 'kb', class: 'knowledge', visibility: 'ORGANIZATION' },
  })).id;
  userId = (await db.user.create({ data: { githubId: 72011, githubUsername: 'stranger1327' } })).id;
});
afterEach(() => { vi.restoreAllMocks(); vi.mocked(getPrincipalAppMemoryAccess).mockReset(); });

const ctxFor = (): Context => ({ db, roles: [], userId, appId: generateId() }) as unknown as Context;

describe('#1327 — a rejected gate read is evicted, never replayed', () => {
  it('appDerivedMemoryIdCache: a one-shot fold fault rejects once, then the same request asks again', async () => {
    vi.mocked(getPrincipalAppMemoryAccess)
      .mockRejectedValueOnce(FAULT)
      .mockResolvedValue(new Map([[memoryId, 'read']]));
    const ctx = ctxFor();
    await expect(getAccessibleMemoryIds(ctx, memoryId)).rejects.toBe(FAULT);
    expect(ctx.appDerivedMemoryIdCache).toBeUndefined();
    await expect(getAccessibleMemoryIds(ctx, memoryId)).resolves.toEqual([memoryId]);
    expect(getPrincipalAppMemoryAccess).toHaveBeenCalledTimes(2);
  });

  it('isMemoryReadableCached: a one-shot rejection is not replayed to the next ask', async () => {
    vi.mocked(getPrincipalAppMemoryAccess)
      .mockRejectedValueOnce(FAULT)
      .mockResolvedValue(new Map([[memoryId, 'read']]));
    const ctx = ctxFor();
    await expect(isMemoryReadableCached(ctx, memoryId)).rejects.toBe(FAULT);
    expect(ctx.memoryReadCache?.has(memoryId)).toBe(false);
    await expect(isMemoryReadableCached(ctx, memoryId)).resolves.toBe(true);
  });

  it('isMemoryReadableFresh: a rejected fresh answer does not replace the memo with a rejection', async () => {
    vi.mocked(getPrincipalAppMemoryAccess).mockRejectedValueOnce(FAULT).mockResolvedValue(new Map([[memoryId, 'read']]));
    const ctx = ctxFor();
    await expect(isMemoryReadableFresh(ctx, memoryId)).rejects.toBe(FAULT);
    expect(ctx.memoryReadCache?.has(memoryId)).toBe(false);
    await expect(isMemoryReadableCached(ctx, memoryId)).resolves.toBe(true);
  });

  it('control: a persistent fault still reaches the asker every time (fails closed, nothing invented)', async () => {
    vi.mocked(getPrincipalAppMemoryAccess).mockRejectedValue(FAULT);
    const ctx = ctxFor();
    await expect(isMemoryReadableCached(ctx, memoryId)).rejects.toBe(FAULT);
    await expect(isMemoryReadableCached(ctx, memoryId)).rejects.toBe(FAULT);
  });
});
