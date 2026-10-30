/**
 * #2819 — a memory create/clone/extract onto a URN a live memory already holds
 * is the typed CONFLICT (the code the CLI maps to exit 5), not a plain Error
 * that surfaces as INTERNAL_SERVER_ERROR. Oracle rule: the response is the same
 * whether or not the caller can see the holder; only the code changed, the
 * message and shape are what the plain Error already disclosed.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { GraphQLError } from 'graphql';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { resolvers, type Context } from './resolvers.js';

const M = resolvers.Mutation as any;

interface Fixture {
  orgId: string;
  orgUrn: string;
  ownerId: string;
  memberId: string;
  ownerCtx: Context;
  memberCtx: Context;
}

async function setup(): Promise<Fixture> {
  const org = await db.organization.create({
    data: { id: generateId(), name: 'org-2819', urn: 'org-2819' },
  });
  const owner = await db.user.create({ data: { id: generateId(), handle: 'owner-2819', githubId: 92819 } });
  const member = await db.user.create({ data: { id: generateId(), handle: 'member-2819', githubId: 92820 } });
  await db.orgMember.create({
    data: { id: generateId(), organizationId: org.id, userId: owner.id, role: 'OWNER' },
  });
  await db.orgMember.create({
    data: { id: generateId(), organizationId: org.id, userId: member.id, role: 'ADMIN' },
  });
  return {
    orgId: org.id,
    orgUrn: org.urn,
    ownerId: owner.id,
    memberId: member.id,
    ownerCtx: { db, userId: owner.id, roles: ['ADMIN'] },
    memberCtx: { db, userId: member.id },
  };
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

describe('#2819 memory URN conflict', () => {
  let fx: Fixture;
  beforeEach(async () => {
    await cleanDb(db);
    fx = await setup();
  });

  it('a. createMemory twice (same org + name): CONFLICT with the unchanged message', async () => {
    await M.createMemory({}, { orgId: fx.orgId, name: 'probe', memoryClass: 'knowledge' }, fx.ownerCtx);
    const err = await refusal(
      M.createMemory({}, { orgId: fx.orgId, name: 'probe', memoryClass: 'knowledge' }, fx.ownerCtx),
    );
    expect(err.extensions?.code).toBe('CONFLICT');
    expect(err.message).toBe('A memory with URN "org-2819:probe" already exists');
  });

  it('b. createMemory twice on the user-owned path: CONFLICT', async () => {
    const args = { name: 'mine', memoryClass: 'personal' };
    await M.createMemory({}, args, fx.ownerCtx);
    const err = await refusal(M.createMemory({}, args, fx.ownerCtx));
    expect(err.extensions?.code).toBe('CONFLICT');
    expect(err.message).toBe('A memory with URN "owner-2819:mine" already exists');
  });

  it('cloneMemory onto an existing memory URN: CONFLICT', async () => {
    const src = await M.createMemory({}, { orgId: fx.orgId, name: 'src', memoryClass: 'knowledge' }, fx.ownerCtx);
    await M.createMemory({}, { orgId: fx.orgId, name: 'taken', memoryClass: 'knowledge' }, fx.ownerCtx);
    const err = await refusal(
      M.cloneMemory({}, { ref: src.id, targetUrn: 'hrn:mem:org-2819:taken' }, fx.ownerCtx),
    );
    expect(err.extensions?.code).toBe('CONFLICT');
    expect(err.message).toBe('A memory with URN "org-2819:taken" already exists');
  });

  it('c. extractParentNodeToMemory onto an existing memory URN: CONFLICT', async () => {
    const src = await M.createMemory({}, { orgId: fx.orgId, name: 'esrc', memoryClass: 'knowledge' }, fx.ownerCtx);
    await M.createMemory({}, { orgId: fx.orgId, name: 'etaken', memoryClass: 'knowledge' }, fx.ownerCtx);
    const parent = await db.node.create({
      data: { id: generateId(), memoryId: src.id, loc: 'parent', name: 'parent', nodeType: 'info' } as never,
    });
    const err = await refusal(
      M.extractParentNodeToMemory(
        {},
        { parentRef: parent.id, targetUrn: 'hrn:mem:org-2819:etaken' },
        fx.ownerCtx,
      ),
    );
    expect(err.extensions?.code).toBe('CONFLICT');
    expect(err.message).toBe('A memory with URN "org-2819:etaken" already exists');
  });

  it('d. oracle: a holder the caller can see and one they cannot answer identically', async () => {
    // Visible to the member: an org-visible knowledge memory.
    await M.createMemory(
      {},
      { orgId: fx.orgId, name: 'seen', memoryClass: 'knowledge', visibility: 'ORGANIZATION' },
      fx.ownerCtx,
    );
    // Not visible to the member: the owner's private-class memory at a URN
    // under the org root, written directly (the member has no read on it).
    await db.memory.create({
      data: {
        id: generateId(),
        urn: 'org-2819:hidden',
        name: 'hidden',
        class: 'private',
        userId: fx.ownerId,
        organizationId: fx.orgId,
      } as never,
    });
    const seen = await refusal(
      M.createMemory({}, { orgId: fx.orgId, name: 'seen', memoryClass: 'knowledge' }, fx.memberCtx),
    );
    const hidden = await refusal(
      M.createMemory({}, { orgId: fx.orgId, name: 'hidden', memoryClass: 'knowledge' }, fx.memberCtx),
    );
    expect(seen.extensions?.code).toBe('CONFLICT');
    expect(hidden.extensions?.code).toBe('CONFLICT');
    expect(Object.keys(hidden.extensions ?? {}).sort()).toEqual(Object.keys(seen.extensions ?? {}).sort());
    expect(hidden.message.replace('hidden', 'X')).toBe(seen.message.replace('seen', 'X'));
  });

  it('e. a soft-deleted memory at the URN is still reclaimed', async () => {
    const first = await M.createMemory({}, { orgId: fx.orgId, name: 'gone', memoryClass: 'knowledge' }, fx.ownerCtx);
    await db.memory.update({ where: { id: first.id }, data: { deletedAt: new Date() } });
    const again = await M.createMemory({}, { orgId: fx.orgId, name: 'gone', memoryClass: 'knowledge' }, fx.ownerCtx);
    expect(again.urn).toBe('org-2819:gone');
  });
});
