import { beforeEach, describe, expect, it } from 'vitest';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { waitForLockWaiters } from '../../../test/lockWait.js';
import { formatGraphQLError } from '../formatError.js';
import { resolvers, type Context } from './resolvers.js';

// #2871: the four expected org-member refusals are typed GraphQLErrors. A plain
// Error (or Prisma's findUniqueOrThrow miss) is masked as INTERNAL_SERVER_ERROR
// (cor:api:260:01), which the CLI shows as exit 1 instead of 5 (conflict) / 4.
const M = resolvers.Mutation as any;
const ctx = (userId: string): Context => ({ db, userId, roles: ['READER'] }) as Context;

let orgId: string;
let ownerId: string;
let strangerId: string;

async function refusal(run: () => Promise<unknown>) {
  try {
    await run();
  } catch (error: any) {
    return { code: error.extensions?.code, message: error.message, error };
  }
  throw new Error('expected a refusal');
}

const snapshot = () => db.orgMember.findMany({ orderBy: { id: 'asc' } });

beforeEach(async () => {
  await cleanDb(db);
  const users = await Promise.all([1, 2].map((n) => db.user.create({
    data: { id: generateId(), githubId: 287100 + n, githubUsername: `member-refusal-${n}-${generateId()}` },
  })));
  [ownerId, strangerId] = users.map((u) => u.id);
  orgId = (await db.organization.create({
    data: { id: generateId(), urn: `member-refusal-${generateId()}`, name: 'Member refusal org' },
  })).id;
  await db.orgMember.create({ data: { id: generateId(), organizationId: orgId, userId: ownerId, role: 'OWNER' } });
});

describe('#2871 org-member refusals are typed', () => {
  it('adding a live member is CONFLICT and changes nothing', async () => {
    const before = await snapshot();
    expect(await refusal(() => M.addOrgMember(null, { orgId, userId: ownerId, role: 'READER' }, ctx(ownerId))))
      .toMatchObject({ code: 'CONFLICT', message: 'User is already a member of this organization' });
    expect(await snapshot()).toEqual(before);
  });

  it('demoting the last live owner is CONFLICT and changes nothing', async () => {
    const before = await snapshot();
    expect(await refusal(() => M.updateOrgMember(null, { orgId, userId: ownerId, role: 'ADMIN' }, ctx(ownerId))))
      .toMatchObject({ code: 'CONFLICT', message: 'Cannot demote the last owner of an organization' });
    expect(await snapshot()).toEqual(before);
  });

  it('removing the last live owner is CONFLICT and changes nothing', async () => {
    const before = await snapshot();
    expect(await refusal(() => M.removeOrgMember(null, { orgId, userId: ownerId }, ctx(ownerId))))
      .toMatchObject({ code: 'CONFLICT', message: 'Cannot remove the last owner of an organization' });
    expect(await snapshot()).toEqual(before);
  });

  it('updating a never-member is NOT_FOUND', async () => {
    const before = await snapshot();
    expect(await refusal(() => M.updateOrgMember(null, { orgId, userId: strangerId, role: 'READER' }, ctx(ownerId))))
      .toMatchObject({ code: 'NOT_FOUND', message: 'User is not a member of this organization' });
    expect(await snapshot()).toEqual(before);
  });

  it('removing a never-member is NOT_FOUND and changes nothing', async () => {
    const before = await snapshot();
    expect(await refusal(() => M.removeOrgMember(null, { orgId, userId: strangerId }, ctx(ownerId))))
      .toMatchObject({ code: 'NOT_FOUND', message: 'User is not a member of this organization' });
    expect(await snapshot()).toEqual(before);
  });

  it('through the response formatter a refusal keeps its code and message', async () => {
    const { error } = await refusal(() => M.removeOrgMember(null, { orgId, userId: strangerId }, ctx(ownerId)));
    const formatted = formatGraphQLError(
      { message: error.message, extensions: { ...error.extensions }, path: ['removeOrgMember'] }, error,
    );
    expect(formatted.extensions?.code).toBe('NOT_FOUND');
    expect(formatted.message).toBe('User is not a member of this organization');
  });

  // #2876: both interleave pins assert FORBIDDEN exactly, not merely "not
  // NOT_FOUND", so a masked internal error (a P2010-wrapped 40001 escaping the
  // retry) fails them too; and each runs against a live-member target as well
  // as a never-member, so the refusal can't come from the target's absence.
  const interleaves = ['updateOrgMember', 'removeOrgMember'].flatMap(
    (mutation) => (['never-member', 'live member'] as const).map((target) => [mutation, target] as const),
  );
  const targetId = async (target: 'never-member' | 'live member') => {
    if (target === 'never-member') return strangerId;
    await db.orgMember.create({ data: { id: generateId(), organizationId: orgId, userId: strangerId, role: 'READER' } });
    return strangerId;
  };
  const targetRow = () => db.orgMember.findFirst({ where: { organizationId: orgId, userId: strangerId } });

  it.each(interleaves)('%s (%s target): a caller whose admin role is revoked while queued gets FORBIDDEN', async (mutation, target) => {
    // The typed NOT_FOUND must not be thrown before the caller's live authority
    // is re-established: otherwise a just-revoked admin learns that the target
    // is absent from the org. The caller waits on the anchor while the revoke
    // commits, so its locking read raises 40001 (P2010 from $queryRaw), which
    // must be retried into the in-transaction FORBIDDEN (#2876).
    const adminId = (await db.user.create({
      data: { id: generateId(), githubId: 287190, githubUsername: `revoked-admin-${generateId()}` },
    })).id;
    await db.orgMember.create({ data: { id: generateId(), organizationId: orgId, userId: adminId, role: 'ADMIN' } });
    const userId = await targetId(target);
    const before = await targetRow();
    let release!: () => void;
    let held!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const locked = new Promise<void>((resolve) => { held = resolve; });
    const revoker = db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM organizations WHERE id = ${orgId} FOR UPDATE`;
      held();
      await gate;
      await tx.orgMember.updateMany({
        where: { organizationId: orgId, userId: adminId }, data: { deletedAt: new Date() },
      });
    }, { timeout: 20_000 });
    await locked;
    let outcome: Promise<{ code?: string; message: string }> | undefined;
    try {
      outcome = refusal(() => M[mutation](null, { orgId, userId, role: 'ADMIN' }, ctx(adminId)));
      await waitForLockWaiters(db, 1);
      release();
      await revoker;
      const result = await outcome;
      expect(result.code).toBe('FORBIDDEN');
      expect(result.message).not.toMatch(/not a member/);
      expect(await targetRow()).toEqual(before);
    } finally {
      release();
      await Promise.allSettled([revoker, outcome]);
    }
  });

  it.each(interleaves)('%s (%s target): an admin revoked after the pre-check but before the transaction gets FORBIDDEN', async (mutation, target) => {
    // Unqueued interleave: the revoke commits between the resolver's pre-check
    // and the transaction. The miss must follow the in-transaction authorize,
    // and with a live target only that re-check refuses: removeOrgMember's
    // afterLock reads the caller's row without raising when it is gone (#2876).
    const adminId = (await db.user.create({
      data: { id: generateId(), githubId: 287191, githubUsername: `revoked-admin-${generateId()}` },
    })).id;
    await db.orgMember.create({ data: { id: generateId(), organizationId: orgId, userId: adminId, role: 'ADMIN' } });
    const userId = await targetId(target);
    const before = await targetRow();
    let revoked = false;
    const revokeOnce = async () => {
      if (revoked) return;
      revoked = true;
      await db.orgMember.updateMany({
        where: { organizationId: orgId, userId: adminId }, data: { deletedAt: new Date() },
      });
    };
    const userDelegate = new Proxy((db as any).user, {
      get(target, prop) {
        const value = target[prop];
        return typeof value === 'function'
          ? async (...args: unknown[]) => { await revokeOnce(); return value.apply(target, args); }
          : value;
      },
    });
    const racing = new Proxy(db as any, {
      get(target, prop) {
        if (prop === 'user') return userDelegate;
        const value = target[prop];
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    const result = await refusal(() => M[mutation](
      null, { orgId, userRef: userId, role: 'ADMIN' }, { ...ctx(adminId), db: racing } as Context,
    ));
    expect(revoked).toBe(true);
    expect(result.code).toBe('FORBIDDEN');
    expect(result.message).not.toMatch(/not a member/);
    expect(await targetRow()).toEqual(before);
  });

  it('controls: add, change role, remove, and a repeat removal of a revoked row all succeed', async () => {
    expect((await M.addOrgMember(null, { orgId, userId: strangerId, role: 'READER' }, ctx(ownerId))).role).toBe('READER');
    expect((await M.updateOrgMember(null, { orgId, userId: strangerId, role: 'CONTRIBUTOR' }, ctx(ownerId))).role)
      .toBe('CONTRIBUTOR');
    expect(await M.removeOrgMember(null, { orgId, userId: strangerId }, ctx(ownerId))).toBe(true);
    expect(await M.removeOrgMember(null, { orgId, userId: strangerId }, ctx(ownerId))).toBe(true);
    expect(await db.orgMember.count({ where: { organizationId: orgId, deletedAt: null } })).toBe(1);
  });

  it('control: the revoked row stays distinct from a never-member (update refuses it as NOT_FOUND)', async () => {
    await M.addOrgMember(null, { orgId, userId: strangerId, role: 'READER' }, ctx(ownerId));
    await M.removeOrgMember(null, { orgId, userId: strangerId }, ctx(ownerId));
    expect((await refusal(() => M.updateOrgMember(null, { orgId, userId: strangerId, role: 'ADMIN' }, ctx(ownerId)))).code)
      .toBe('NOT_FOUND');
  });
});
