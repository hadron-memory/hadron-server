import { beforeEach, describe, expect, it } from 'vitest';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
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
