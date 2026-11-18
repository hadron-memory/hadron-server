/**
 * #2573 — updateMemory refuses a class/visibility mismatch with the typed
 * INVALID_GROUP_MEMORY_VISIBILITY (the code createMemory already uses,
 * hrn:node:hadronmemory.com:specs 023 FR-024) before any write, instead of
 * letting chk_memory_group_visibility surface as INTERNAL_SERVER_ERROR.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { GraphQLError } from 'graphql';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { resolvers, type Context } from './resolvers.js';

interface Fixture {
  orgId: string;
  ownerUserId: string;
  ctx: Context;
}

async function setup(): Promise<Fixture> {
  const org = await db.organization.create({
    data: { id: generateId(), name: 'org-2573', urn: 'org-2573' },
  });
  const owner = await db.user.create({
    data: { id: generateId(), handle: 'owner-2573', githubId: 92573 },
  });
  await db.orgMember.create({
    data: { id: generateId(), organizationId: org.id, userId: owner.id, role: 'OWNER' },
  });
  return { orgId: org.id, ownerUserId: owner.id, ctx: { db, userId: owner.id, roles: ['ADMIN'] } };
}

async function create(fx: Fixture, name: string, memoryClass: 'knowledge' | 'group', visibility?: string) {
  return (await resolvers.Mutation.createMemory(
    {},
    { orgId: fx.orgId, name, memoryClass, ...(visibility ? { visibility } : {}) },
    fx.ctx,
  )) as { id: string };
}

async function refusal(p: Promise<unknown>): Promise<GraphQLError> {
  try {
    await p;
  } catch (e) {
    expect(e).toBeInstanceOf(GraphQLError);
    return e as GraphQLError;
  }
  throw new Error('expected a refusal');
}

describe('#2573 updateMemory class/visibility guard', () => {
  let fx: Fixture;
  beforeEach(async () => {
    await cleanDb(db);
    fx = await setup();
  });

  it('refuses visibility=GROUP on a knowledge-class memory and leaves the row unchanged', async () => {
    const m = await create(fx, 'k1', 'knowledge', 'ORGANIZATION');
    const err = await refusal(
      resolvers.Mutation.updateMemory({}, { id: m.id, visibility: 'GROUP' }, fx.ctx),
    );
    expect(err.extensions?.code).toBe('INVALID_GROUP_MEMORY_VISIBILITY');
    const row = await db.memory.findUniqueOrThrow({ where: { id: m.id } });
    expect(row.visibility).toBe('ORGANIZATION');
  });

  it('refuses a non-GROUP visibility on a group-class memory and leaves the row unchanged', async () => {
    const m = await create(fx, 'g1', 'group');
    const err = await refusal(
      resolvers.Mutation.updateMemory({}, { id: m.id, visibility: 'ORGANIZATION' }, fx.ctx),
    );
    expect(err.extensions?.code).toBe('INVALID_GROUP_MEMORY_VISIBILITY');
    const row = await db.memory.findUniqueOrThrow({ where: { id: m.id } });
    expect(row.visibility).toBe('GROUP');
  });

  it('refuses before any other field of the same call is written', async () => {
    const m = await create(fx, 'k2', 'knowledge', 'ORGANIZATION');
    await refusal(
      resolvers.Mutation.updateMemory(
        {},
        { id: m.id, visibility: 'GROUP', shortDescription: 'changed' },
        fx.ctx,
      ),
    );
    const row = await db.memory.findUniqueOrThrow({ where: { id: m.id } });
    expect(row.shortDescription).not.toBe('changed');
  });

  it('still accepts a valid change on a knowledge memory (ORGANIZATION -> PUBLIC)', async () => {
    const m = await create(fx, 'k3', 'knowledge', 'ORGANIZATION');
    const out = (await resolvers.Mutation.updateMemory(
      {},
      { id: m.id, visibility: 'PUBLIC' },
      fx.ctx,
    )) as { visibility: string };
    expect(out.visibility).toBe('PUBLIC');
  });

  it('still accepts visibility=GROUP restated on a group-class memory', async () => {
    const m = await create(fx, 'g2', 'group');
    const out = (await resolvers.Mutation.updateMemory(
      {},
      { id: m.id, visibility: 'GROUP', shortDescription: 'ok' },
      fx.ctx,
    )) as { visibility: string };
    expect(out.visibility).toBe('GROUP');
  });
});
