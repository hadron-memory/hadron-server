/**
 * #5074: a person's `user` quota counters go with the person. Account deletion removes them (and leaves others'); an
 * account merge removes the merged-away person's and keeps the survivor's.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { db } from '../../integrations/db/client.js';
import { cleanDb } from '../../test/helpers.js';
import { generateId } from '../../lib/id.js';
import { approvedMergeProof } from '../../test/mergeConsent.js';
import { setQuotaLimit } from '../../jobs/appRuns.js';
import { deleteUserAccount } from './deleteUser.js';
import { mergeUsers } from './mergeUsers.js';

let a: { id: string }, b: { id: string }, admin: { id: string };
const mk = (h: string, roles: string[] = []) => db.user.create({ data: { handle: `uq5074-${h}-${generateId().slice(-5)}`, roles: roles as never } });
const has = async (id: string) => (await db.quotaCounter.count({ where: { scopeKind: 'user', scopeId: id } })) > 0;

beforeEach(async () => {
  await cleanDb(db);
  [a, b, admin] = await Promise.all([mk('a'), mk('b'), mk('adm', ['ADMIN'])]);
  await setQuotaLimit(db, 'user', a.id, 'run.execute', 3);
  await setQuotaLimit(db, 'user', b.id, 'run.execute', 4);
});

describe('#5074 user counters and the account lifecycle', () => {
  it('deleteUserAccount removes the person user rows and leaves another person\'s', async () => {
    await deleteUserAccount(db, { targetUserId: a.id, actorUserId: a.id });
    expect(await has(a.id)).toBe(false);
    expect(await has(b.id)).toBe(true);
  });

  it('mergeUsers removes the merged-away person user rows and keeps the survivor\'s', async () => {
    const consentProof = await approvedMergeProof(db, a.id, b.id, admin.id);
    await mergeUsers(db, { sourceUserId: a.id, targetUserId: b.id, actorUserId: admin.id, consentProof });
    expect(await has(a.id)).toBe(false);
    const kept = await db.quotaCounter.findFirstOrThrow({ where: { scopeKind: 'user', scopeId: b.id, action: 'run.execute' } });
    expect(kept.limit).toBe(4);
  });
});
