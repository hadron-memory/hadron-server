/**
 * #1544 — concurrent owner removals or demotions must never leave an org with
 * zero live OWNERs.
 *
 * The last-owner guard is count-then-act. Before the fix, removeOrgMember and
 * updateOrgMember ran the count and the write as separate READ COMMITTED
 * statements, so two admins acting on the org's two owners at once each counted
 * two owners and both committed (write skew). The fix runs each in one
 * SERIALIZABLE transaction, matching deleteUser, so Postgres aborts one side
 * and its retry re-decides on the winner's committed state.
 *
 * Staging: a third transaction holds both owner rows `FOR SHARE`. Both calls
 * read and count freely, then block on their own write. The barrier waits until
 * both are blocked, which proves both counted two owners, and only then releases
 * them. Without the fix both writes commit; that is the mutation control.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { resolvers, type Context } from './resolvers.js';
import { deleteUserAccount } from '../../../controller/operations/deleteUser.js';
import { waitForLockWaitersOfType } from '../../../test/lockWait.js';

const M = resolvers.Mutation as any;

let org: { id: string };
let admin: { id: string };
let ownerA: { id: string };
let ownerB: { id: string };

const ctx = (userId: string): Context => ({ db, userId, roles: ['READER'] }) as Context;

const liveOwners = () =>
  db.orgMember.count({ where: { organizationId: org.id, role: 'OWNER', deletedAt: null } });

/**
 * Holds both owner rows `FOR SHARE` until the returned `release` is called.
 * Reads pass this lock; each racing call's write to an owner row waits on it.
 */
async function holdOwnerRows(): Promise<{ release: () => void; done: Promise<unknown> }> {
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  let locked!: () => void;
  const isLocked = new Promise<void>((r) => { locked = r; });
  const done = db.$transaction(async (tx) => {
    await tx.$queryRaw`
      SELECT user_id FROM org_members
      WHERE organization_id = ${org.id} AND role = 'OWNER' AND deleted_at IS NULL
      FOR SHARE`;
    locked();
    await gate;
  }, { timeout: 20_000 });
  await isLocked;
  return { release, done };
}

/**
 * Runs two owner-lowering operations against the held rows, releases them once
 * both are blocked on their writes, and returns both outcomes.
 */
async function race(
  first: () => Promise<unknown>,
  second: () => Promise<unknown>,
): Promise<PromiseSettledResult<unknown>[]> {
  const holder = await holdOwnerRows();
  const outcomes = Promise.allSettled([first(), second()]);
  // Both calls have counted two live owners and are now waiting to write.
  await waitForLockWaitersOfType(db, 'transactionid', 2);
  holder.release();
  await holder.done;
  return outcomes;
}

beforeEach(async () => {
  await cleanDb(db);
  org = await db.organization.create({
    data: { id: generateId(), name: 'two-owner-org', urn: `two-owner-org-${generateId().slice(-8)}` },
  });
  const mk = (n: number) => db.user.create({
    data: { id: generateId(), githubId: 154400 + n, githubUsername: `lo-${n}-${generateId().slice(-8)}` },
  });
  [admin, ownerA, ownerB] = await Promise.all([mk(1), mk(2), mk(3)]);
  await db.orgMember.createMany({
    data: [
      { id: generateId(), organizationId: org.id, userId: admin.id, role: 'ADMIN' },
      { id: generateId(), organizationId: org.id, userId: ownerA.id, role: 'OWNER' },
      { id: generateId(), organizationId: org.id, userId: ownerB.id, role: 'OWNER' },
    ],
  });
});

/** Exactly one call won, and the other was refused by the last-owner guard. */
function expectOneRefusedAsLastOwner(outcomes: PromiseSettledResult<unknown>[]): void {
  const refused = outcomes.filter((o): o is PromiseRejectedResult => o.status === 'rejected');
  expect(outcomes.filter((o) => o.status === 'fulfilled')).toHaveLength(1);
  expect(refused).toHaveLength(1);
  expect(String(refused[0].reason)).toMatch(/last owner/);
}

describe('#1544 — the last-owner guard holds under concurrency', () => {
  it('two concurrent removeOrgMember calls on the two owners: one wins, one is refused', async () => {
    const outcomes = await race(
      () => M.removeOrgMember(null, { orgId: org.id, userId: ownerA.id }, ctx(admin.id)),
      () => M.removeOrgMember(null, { orgId: org.id, userId: ownerB.id }, ctx(admin.id)),
    );
    expectOneRefusedAsLastOwner(outcomes);
    expect(await liveOwners()).toBe(1);
  });

  it('two concurrent updateOrgMember demotions of the two owners: one wins, one is refused', async () => {
    const outcomes = await race(
      () => M.updateOrgMember(null, { orgId: org.id, userId: ownerA.id, role: 'ADMIN' }, ctx(admin.id)),
      () => M.updateOrgMember(null, { orgId: org.id, userId: ownerB.id, role: 'ADMIN' }, ctx(admin.id)),
    );
    expectOneRefusedAsLastOwner(outcomes);
    expect(await liveOwners()).toBe(1);
  });

  it('a removal racing a demotion: one wins, one is refused', async () => {
    const outcomes = await race(
      () => M.removeOrgMember(null, { orgId: org.id, userId: ownerA.id }, ctx(admin.id)),
      () => M.updateOrgMember(null, { orgId: org.id, userId: ownerB.id, role: 'ADMIN' }, ctx(admin.id)),
    );
    expectOneRefusedAsLastOwner(outcomes);
    expect(await liveOwners()).toBe(1);
  });

  it('a removal racing the other owner deleting their account (deleteUser, also SERIALIZABLE)', async () => {
    const outcomes = await race(
      () => M.removeOrgMember(null, { orgId: org.id, userId: ownerA.id }, ctx(admin.id)),
      () => deleteUserAccount(db, { targetUserId: ownerB.id, actorUserId: ownerB.id }),
    );
    const refused = outcomes.filter((o): o is PromiseRejectedResult => o.status === 'rejected');
    expect(outcomes.filter((o) => o.status === 'fulfilled')).toHaveLength(1);
    expect(refused).toHaveLength(1);
    // Whichever side lost, it lost to the guard: removeOrgMember's last-owner
    // error or deleteUser's SoleOrgOwnerError.
    expect(String(refused[0].reason)).toMatch(/last owner|only active owner/);
    expect(await liveOwners()).toBe(1);
  });

  it('CONTROL: sequential calls still remove a non-last owner and refuse the last one', async () => {
    expect(await M.removeOrgMember(null, { orgId: org.id, userId: ownerA.id }, ctx(admin.id))).toBe(true);
    await expect(
      M.removeOrgMember(null, { orgId: org.id, userId: ownerB.id }, ctx(admin.id)),
    ).rejects.toThrow('Cannot remove the last owner of an organization');
    await expect(
      M.updateOrgMember(null, { orgId: org.id, userId: ownerB.id, role: 'ADMIN' }, ctx(admin.id)),
    ).rejects.toThrow('Cannot demote the last owner of an organization');
    expect(await liveOwners()).toBe(1);
  });
});
