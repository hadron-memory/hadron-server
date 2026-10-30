import type { GraphQLError } from 'graphql';
import { beforeEach, describe, expect, it } from 'vitest';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { formatGraphQLError } from '../formatError.js';
import { resolvers, type Context } from './resolvers.js';

// #2867: every expected refusal of acceptInvitation is a typed GraphQLError.
// A plain Error is masked as INTERNAL_SERVER_ERROR (cor:api:260:01), which the
// CLI shows as exit 1 instead of the not-found exit 4.
const M = resolvers.Mutation as any;
const ctx = (userId?: string): Context => ({ db, userId, roles: ['READER'] }) as Context;

let senderId: string;
let inviteeId: string;
let orgId: string;

async function invite(extra: Record<string, unknown> = {}) {
  return db.userInvitation.create({
    data: {
      id: generateId(), slug: `refusal-${generateId()}`, senderUserId: senderId,
      organizationId: null, memberRole: 'READER', maxActivations: 1, createdBy: senderId,
      ...extra,
    },
  });
}

async function refusal(slug: string, userId: string | null = inviteeId) {
  try {
    await M.acceptInvitation(null, { slug }, ctx(userId ?? undefined));
  } catch (error: any) {
    return { code: error.extensions?.code, message: error.message, typed: error.name === 'GraphQLError' };
  }
  throw new Error('expected a refusal');
}

async function counts() {
  return {
    invitations: await db.userInvitation.count(),
    activations: await db.userInvitationActivation.count(),
    members: await db.orgMember.count(),
  };
}

beforeEach(async () => {
  await cleanDb(db);
  const users = await Promise.all([1, 2].map((n) => db.user.create({
    data: { id: generateId(), githubId: 286700 + n, githubUsername: `accept-refusal-${n}-${generateId()}` },
  })));
  [senderId, inviteeId] = users.map((u) => u.id);
  orgId = (await db.organization.create({
    data: { id: generateId(), urn: `refusal-${generateId()}`, name: 'Refusal org' },
  })).id;
});

describe('#2867 acceptInvitation refusals are typed', () => {
  it('an unknown slug is NOT_FOUND', async () => {
    const before = await counts();
    expect(await refusal('doesnotexist')).toEqual({
      code: 'NOT_FOUND', message: 'Invitation not found', typed: true,
    });
    expect(await counts()).toEqual(before);
  });

  it('an invitation id supplied as the slug is the same NOT_FOUND', async () => {
    const issued = await invite();
    expect((await refusal(issued.id)).code).toBe('NOT_FOUND');
    expect(await db.userInvitationActivation.count()).toBe(0);
  });

  it('a soft-deleted invitation is NOT_FOUND (the locked re-read)', async () => {
    const issued = await invite({ deletedAt: new Date(), deletedBy: senderId });
    expect(await refusal(issued.slug)).toMatchObject({ code: 'NOT_FOUND', message: 'Invitation not found' });
  });

  it('signed out is UNAUTHENTICATED', async () => {
    const issued = await invite();
    expect(await refusal(issued.slug, null)).toMatchObject({ code: 'UNAUTHENTICATED', typed: true });
  });

  it('an expired invitation is BAD_USER_INPUT and leaves no activation', async () => {
    const issued = await invite({ expiresAt: new Date(Date.now() - 60_000) });
    expect(await refusal(issued.slug)).toMatchObject({
      code: 'BAD_USER_INPUT', message: 'Invitation has expired',
    });
    expect(await db.userInvitationActivation.count()).toBe(0);
  });

  it('a used-up invitation is CONFLICT', async () => {
    const issued = await invite();
    const other = await db.user.create({ data: { id: generateId(), githubId: 286799, githubUsername: `other-${generateId()}` } });
    await db.userInvitationActivation.create({ data: { id: generateId(), invitationId: issued.id, userId: other.id } });
    expect(await refusal(issued.slug)).toMatchObject({
      code: 'CONFLICT', message: 'Invitation has reached its maximum number of uses',
    });
    expect(await db.userInvitationActivation.count()).toBe(1);
  });

  it('accepting twice is CONFLICT', async () => {
    const issued = await invite({ maxActivations: 5 });
    expect(await M.acceptInvitation(null, { slug: issued.slug }, ctx(inviteeId))).toBe(true);
    expect(await refusal(issued.slug)).toMatchObject({
      code: 'CONFLICT', message: 'You have already accepted this invitation',
    });
    expect(await db.userInvitationActivation.count()).toBe(1);
  });

  it('control: a deleted issuer is the existing typed FORBIDDEN from the anchor gate', async () => {
    const issued = await invite({ organizationId: orgId });
    await db.user.update({ where: { id: senderId }, data: { deletedAt: new Date() } });
    expect(await refusal(issued.slug)).toMatchObject({
      code: 'FORBIDDEN', message: 'Forbidden', typed: true,
    });
    expect(await db.userInvitationActivation.count()).toBe(0);
    expect(await db.orgMember.count({ where: { userId: inviteeId } })).toBe(0);
  });

  it('a revoked org invitation (issuer lost ADMIN) is BAD_USER_INPUT', async () => {
    const issued = await invite({ organizationId: orgId });
    await db.orgMember.create({ data: { id: generateId(), organizationId: orgId, userId: senderId, role: 'CONTRIBUTOR' } });
    expect(await refusal(issued.slug)).toMatchObject({ code: 'BAD_USER_INPUT', message: 'Invitation has been revoked' });
  });

  it('through the response formatter the unknown slug keeps its code and message', async () => {
    let thrown: unknown;
    try { await M.acceptInvitation(null, { slug: 'doesnotexist' }, ctx(inviteeId)); } catch (e) { thrown = e; }
    const error = thrown as GraphQLError;
    const formatted = formatGraphQLError(
      { message: error.message, extensions: { ...error.extensions }, path: ['acceptInvitation'] },
      error,
    );
    expect(formatted.message).toBe('Invitation not found');
    expect(formatted.extensions?.code).toBe('NOT_FOUND');
  });

  it('control: a valid slug still accepts', async () => {
    const issued = await invite();
    expect(await M.acceptInvitation(null, { slug: issued.slug }, ctx(inviteeId))).toBe(true);
    expect(await db.userInvitationActivation.count({ where: { invitationId: issued.id } })).toBe(1);
  });
});
