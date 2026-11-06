/**
 * #708 — `mergeUsers` releases the source user's #692 pool Principal in the merge
 * transaction. The source's handle is replaced by a random `merged-…` value, so the
 * original name is dead; its Principal is tombstoned (name reserved forever), the
 * user→principal link is kept, and the target's Principal is untouched.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { mergeUsers } from '../../../test/mergeConsent.js';
import {
  ensureUserPrincipal,
  mintPrincipal,
  RootNameTakenError,
} from '../../../lib/principal/mintPrincipal.js';

let source: { id: string };
let target: { id: string };

async function makeUser(handle: string): Promise<{ id: string }> {
  const user = await db.user.create({ data: { id: generateId(), handle, roles: ['READER'] } });
  await ensureUserPrincipal(db, user);
  return user;
}

const principalOf = async (userId: string) => {
  const user = await db.user.findUniqueOrThrow({ where: { id: userId } });
  return { user, principal: user.principalId ? await db.principal.findUniqueOrThrow({ where: { id: user.principalId } }) : null };
};

beforeEach(async () => {
  await cleanDb(db);
  source = await makeUser('pr-source');
  target = await makeUser('pr-target');
});

describe('mergeUsers — source principal release (#708)', () => {
  it('tombstones the source principal, keeps its link and name, leaves the target active', async () => {
    const before = await principalOf(source.id);
    expect(before.principal?.status).toBe('active');
    const targetBefore = await principalOf(target.id);

    await mergeUsers(db, { sourceUserId: source.id, targetUserId: target.id });

    const after = await principalOf(source.id);
    expect(after.user.principalId).toBe(before.user.principalId);
    expect(after.principal?.status).toBe('released');
    expect(after.principal?.releasedAt).toBeInstanceOf(Date);
    expect(after.principal?.name).toBe('pr-source');

    const targetAfter = await principalOf(target.id);
    expect(targetAfter.principal?.status).toBe('active');
    expect(targetAfter.principal?.releasedAt).toBeNull();
    expect(targetAfter.user.principalId).toBe(targetBefore.user.principalId);
  });

  it('keeps the original name reserved after the merge', async () => {
    await mergeUsers(db, { sourceUserId: source.id, targetUserId: target.id });
    await expect(mintPrincipal(db, { kind: 'user', name: 'pr-source' })).rejects.toBeInstanceOf(RootNameTakenError);
  });

  it('does not mint a principal for the merged-… placeholder handle', async () => {
    const count = await db.principal.count();
    await mergeUsers(db, { sourceUserId: source.id, targetUserId: target.id });
    expect(await db.principal.count()).toBe(count);
  });

  it('merges a source with no principal (legacy row) without error', async () => {
    const legacy = await db.user.create({ data: { id: generateId(), handle: 'pr-legacy', roles: ['READER'] } });
    await mergeUsers(db, { sourceUserId: legacy.id, targetUserId: target.id });
    expect((await principalOf(legacy.id)).principal).toBeNull();
  });

  it('leaves an already-released source principal untouched (no releasedAt rewrite)', async () => {
    const { user, principal } = await principalOf(source.id);
    const releasedAt = new Date('2026-01-01T00:00:00Z');
    await db.principal.update({ where: { id: principal!.id }, data: { status: 'released', releasedAt } });
    await mergeUsers(db, { sourceUserId: user.id, targetUserId: target.id });
    const after = await db.principal.findUniqueOrThrow({ where: { id: principal!.id } });
    expect(after.status).toBe('released');
    expect(after.releasedAt?.toISOString()).toBe(releasedAt.toISOString());
  });

  it('rolls the release back with the merge when a later write fails', async () => {
    const before = await principalOf(source.id);
    const targetBefore = await principalOf(target.id);
    // The final user_merges insert runs after the release; fault it to force the whole transaction to abort.
    const faulty = db.$extends({
      query: { userMerge: { create: () => { throw new Error('injected fault after release'); } } },
    }) as unknown as typeof db;

    await expect(mergeUsers(faulty, { sourceUserId: source.id, targetUserId: target.id }))
      .rejects.toThrow('injected fault after release');

    const after = await principalOf(source.id);
    expect(after.user.principalId).toBe(before.user.principalId);
    expect(after.user.handle).toBe('pr-source');
    expect(after.principal?.status).toBe('active');
    expect(after.principal?.releasedAt).toBeNull();
    expect(after.principal?.name).toBe('pr-source');
    expect((await principalOf(target.id)).principal).toEqual(targetBefore.principal);
    expect(await db.userMerge.count({ where: { sourceUserId: source.id } })).toBe(0);
  });
});
