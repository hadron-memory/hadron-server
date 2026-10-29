/**
 * Integration tests for the memory-subscription mutation trio.
 *
 * createMemorySubscription / updateMemorySubscription / deleteMemorySubscription
 * had zero existing test coverage. Added as part of spec
 * 007-entity-id-or-urn (which widens memoryId AND orgId to accept ID
 * or URN); tests cover both the existing ID-input behavior and the
 * new URN-input paths.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { resolvers, type Context } from './resolvers.js';

let ownerOrg: { id: string; urn: string };
let subscriberOrg: { id: string; urn: string };
let publicMemory: { id: string; urn: string };
let privateMemory: { id: string; urn: string };
let ownerAdminUser: { id: string };
let subscriberAdminUser: { id: string };

function adminCtx(userId: string): Context {
  return { db, userId, roles: ['ADMIN'] };
}

function readerCtx(userId: string): Context {
  return { db, userId, roles: ['READER'] };
}

beforeEach(async () => {
  await cleanDb(db);

  ownerOrg = await db.organization.create({
    data: {
      id: generateId(),
      name: 'sub-test-owner',
      urn: `sub-test-owner-${Date.now()}`,
    },
  });
  subscriberOrg = await db.organization.create({
    data: {
      id: generateId(),
      name: 'sub-test-subscriber',
      urn: `sub-test-subscriber-${Date.now()}`,
    },
  });

  ownerAdminUser = await db.user.create({
    data: { id: generateId(), githubId: 9601, githubUsername: 'sub-owner-admin', roles: ['READER'] },
  });
  subscriberAdminUser = await db.user.create({
    data: { id: generateId(), githubId: 9602, githubUsername: 'sub-subscriber-admin', roles: ['READER'] },
  });

  await db.orgMember.create({
    data: { id: generateId(), organizationId: ownerOrg.id, userId: ownerAdminUser.id, role: 'ADMIN' },
  });
  await db.orgMember.create({
    data: { id: generateId(), organizationId: subscriberOrg.id, userId: subscriberAdminUser.id, role: 'ADMIN' },
  });

  publicMemory = await db.memory.create({
    data: {
      id: generateId(),
      organizationId: ownerOrg.id,
      urn: `${ownerOrg.urn}:public-mem`,
      name: 'public-mem',
      class: 'knowledge',
      visibility: 'PUBLIC',
    },
  });
  privateMemory = await db.memory.create({
    data: {
      id: generateId(),
      organizationId: ownerOrg.id,
      urn: `${ownerOrg.urn}:private-mem`,
      name: 'private-mem',
      class: 'knowledge',
      visibility: 'ORGANIZATION',
    },
  });
});

// ---------------------------------------------------------------------------
// createMemorySubscription
// ---------------------------------------------------------------------------

describe('createMemorySubscription', () => {
  it('subscriber-org admin can create a subscription to a PUBLIC memory (input by ID)', async () => {
    const sub = await resolvers.Mutation.createMemorySubscription(
      null,
      { memoryId: publicMemory.id, orgId: subscriberOrg.id, role: 'READER' },
      adminCtx(subscriberAdminUser.id),
    );
    expect(sub.memoryId).toBe(publicMemory.id);
    expect(sub.organizationId).toBe(subscriberOrg.id);
    expect(sub.role).toBe('READER');
  });

  // 007-entity-id-or-urn: memoryId + orgId both accept ID or URN.
  it('accepts URNs for both memoryId and orgId', async () => {
    const sub = await resolvers.Mutation.createMemorySubscription(
      null,
      { memoryId: publicMemory.urn, orgId: subscriberOrg.urn, role: 'READER' },
      adminCtx(subscriberAdminUser.id),
    );
    expect(sub.memoryId).toBe(publicMemory.id);
    expect(sub.organizationId).toBe(subscriberOrg.id);
  });

  it('accepts prefixed URNs for both memoryId and orgId', async () => {
    const sub = await resolvers.Mutation.createMemorySubscription(
      null,
      {
        memoryId: `urn:memory:${publicMemory.urn}`,
        orgId: `urn:org:${subscriberOrg.urn}`,
        role: 'READER',
      },
      adminCtx(subscriberAdminUser.id),
    );
    expect(sub.memoryId).toBe(publicMemory.id);
    expect(sub.organizationId).toBe(subscriberOrg.id);
  });

  it('rejects subscription to a PRIVATE memory', async () => {
    await expect(
      resolvers.Mutation.createMemorySubscription(
        null,
        { memoryId: privateMemory.id, orgId: subscriberOrg.id, role: 'READER' },
        adminCtx(subscriberAdminUser.id),
      ),
    ).rejects.toMatchObject({ extensions: { code: 'SUBSCRIPTION_REQUIRES_PUBLIC_MEMORY' } });
  });

  it('rejects when subscriber-org admin role is missing', async () => {
    const reader = await db.user.create({
      data: { id: generateId(), githubId: 9603, githubUsername: 'sub-reader', roles: ['READER'] },
    });
    await db.orgMember.create({
      data: { id: generateId(), organizationId: subscriberOrg.id, userId: reader.id, role: 'READER' },
    });
    await expect(
      resolvers.Mutation.createMemorySubscription(
        null,
        { memoryId: publicMemory.id, orgId: subscriberOrg.id, role: 'READER' },
        readerCtx(reader.id),
      ),
    ).rejects.toThrow();
  });

  it('rejects when owner-org tries to self-subscribe', async () => {
    await expect(
      resolvers.Mutation.createMemorySubscription(
        null,
        { memoryId: publicMemory.id, orgId: ownerOrg.id, role: 'READER' },
        adminCtx(ownerAdminUser.id),
      ),
    ).rejects.toMatchObject({ extensions: { code: 'OWNER_ORG_CANNOT_SUBSCRIBE' } });
  });

  // #2572: the typed codes sit behind the hidden-memory refusal (#1381): a
  // caller who cannot open the memory gets the not-found miss, never a code
  // that would confirm the memory exists.
  it('a caller who cannot open a non-public memory gets not-found, not the typed code', async () => {
    const outsider = await db.user.create({
      data: { id: generateId(), githubId: 9604, githubUsername: 'sub-outsider', roles: ['READER'] },
    });
    const err = await resolvers.Mutation.createMemorySubscription(
      null,
      { memoryId: privateMemory.id, orgId: subscriberOrg.id, role: 'READER' },
      readerCtx(outsider.id),
    ).then(() => null, (e: unknown) => e);
    expect(err).not.toBeNull();
    expect((err as { extensions?: { code?: string } }).extensions?.code).not.toMatch(
      /SUBSCRIPTION_REQUIRES_PUBLIC_MEMORY|OWNER_ORG_CANNOT_SUBSCRIBE/,
    );
  });

  // #2572 (local review P2): the in-transaction re-checks are the sites a race
  // reaches. The request-context read is served a stale row once, after the
  // real row changed, so only the transaction's own re-read can refuse.
  function staleMemoryOnce(realDb: typeof db, change: () => Promise<unknown>): Context['db'] {
    let served = false;
    return new Proxy(realDb, {
      get(target, prop, receiver) {
        const value = Reflect.get(target, prop, receiver);
        if (prop !== 'memory') return typeof value === 'function' ? value.bind(target) : value;
        return new Proxy(value, {
          get(mTarget, mProp) {
            const member = Reflect.get(mTarget, mProp);
            if (mProp !== 'findUniqueOrThrow' || served) {
              return typeof member === 'function' ? member.bind(mTarget) : member;
            }
            return async (args: unknown) => {
              const stale = await member.call(mTarget, args);
              served = true;
              await change();
              return stale;
            };
          },
        });
      },
    }) as Context['db'];
  }

  it('in-transaction re-check: memory made non-public after the first read is refused with the typed code', async () => {
    // Still able to open the memory once it is ORGANIZATION-visible (hidden-first
    // would answer not-found otherwise), so only the typed refusal can fire.
    await db.orgMember.create({
      data: { id: generateId(), organizationId: ownerOrg.id, userId: subscriberAdminUser.id, role: 'READER' },
    });
    const ctx = {
      ...adminCtx(subscriberAdminUser.id),
      db: staleMemoryOnce(db, () => db.memory.update({ where: { id: publicMemory.id }, data: { visibility: 'ORGANIZATION' } })),
    };
    await expect(
      resolvers.Mutation.createMemorySubscription(null, { memoryId: publicMemory.id, orgId: subscriberOrg.id, role: 'READER' }, ctx),
    ).rejects.toMatchObject({
      message: 'Only public memories can be subscribed to by other organizations',
      extensions: { code: 'SUBSCRIPTION_REQUIRES_PUBLIC_MEMORY' },
    });
  });

  it('in-transaction re-check: memory moved to the subscriber org after the first read is refused with the typed code', async () => {
    const ctx = {
      ...adminCtx(subscriberAdminUser.id),
      db: staleMemoryOnce(db, () => db.memory.update({ where: { id: publicMemory.id }, data: { organizationId: subscriberOrg.id } })),
    };
    await expect(
      resolvers.Mutation.createMemorySubscription(null, { memoryId: publicMemory.id, orgId: subscriberOrg.id, role: 'READER' }, ctx),
    ).rejects.toMatchObject({
      message: 'Owner organization has implicit access and cannot subscribe',
      extensions: { code: 'OWNER_ORG_CANNOT_SUBSCRIBE' },
    });
  });

  it('a duplicate subscription (unique violation) stays a server fault, not a typed refusal', async () => {
    const args = { memoryId: publicMemory.id, orgId: subscriberOrg.id, role: 'READER' };
    await resolvers.Mutation.createMemorySubscription(null, args, adminCtx(subscriberAdminUser.id));
    const err = await resolvers.Mutation.createMemorySubscription(null, args, adminCtx(subscriberAdminUser.id))
      .then(() => null, (e: unknown) => e);
    expect(err).not.toBeNull();
    expect((err as { extensions?: { code?: string } }).extensions?.code ?? '').not.toMatch(
      /SUBSCRIPTION_REQUIRES_PUBLIC_MEMORY|OWNER_ORG_CANNOT_SUBSCRIBE|NOT_FOUND/,
    );
  });

  // #764: the shared resolveRefArg helper maps every entity-ref miss to the
  // uniform NOT_FOUND ("No match for <label>Ref …"), matching granteeRef —
  // superseding the old per-entity MEMORY_NOT_FOUND / ORGANIZATION_NOT_FOUND.
  it('rejects unknown memory ref with a uniform NOT_FOUND', async () => {
    await expect(
      resolvers.Mutation.createMemorySubscription(
        null,
        // 25-char cuid-shaped string that doesn't exist in DB.
        { memoryId: 'cnonexistentnonexistent12', orgId: subscriberOrg.id, role: 'READER' },
        adminCtx(subscriberAdminUser.id),
      ),
    ).rejects.toThrow(/No match for memoryRef/);
  });

  it('rejects unknown org ref with a uniform NOT_FOUND', async () => {
    await expect(
      resolvers.Mutation.createMemorySubscription(
        null,
        // URN-shaped string that doesn't exist in DB.
        { memoryId: publicMemory.id, orgId: 'no-such-org-urn', role: 'READER' },
        adminCtx(subscriberAdminUser.id),
      ),
    ).rejects.toThrow(/No match for orgRef/);
  });
});

// ---------------------------------------------------------------------------
// updateMemorySubscription
// ---------------------------------------------------------------------------

describe('updateMemorySubscription', () => {
  beforeEach(async () => {
    // Seed an existing subscription so update has something to operate on.
    await db.memorySubscription.create({
      data: {
        id: generateId(),
        memoryId: publicMemory.id,
        organizationId: subscriberOrg.id,
        role: 'READER',
      },
    });
  });

  it('owner-org admin can update the role (input by ID)', async () => {
    const sub = await resolvers.Mutation.updateMemorySubscription(
      null,
      { memoryId: publicMemory.id, orgId: subscriberOrg.id, role: 'CONTRIBUTOR' },
      adminCtx(ownerAdminUser.id),
    );
    expect(sub.role).toBe('CONTRIBUTOR');
  });

  it('accepts URNs for both memoryId and orgId', async () => {
    const sub = await resolvers.Mutation.updateMemorySubscription(
      null,
      { memoryId: publicMemory.urn, orgId: subscriberOrg.urn, role: 'CONTRIBUTOR' },
      adminCtx(ownerAdminUser.id),
    );
    expect(sub.role).toBe('CONTRIBUTOR');
  });
});

// ---------------------------------------------------------------------------
// deleteMemorySubscription
// ---------------------------------------------------------------------------

describe('deleteMemorySubscription', () => {
  beforeEach(async () => {
    await db.memorySubscription.create({
      data: {
        id: generateId(),
        memoryId: publicMemory.id,
        organizationId: subscriberOrg.id,
        role: 'READER',
      },
    });
  });

  it('owner-org admin can delete (input by ID)', async () => {
    const result = await resolvers.Mutation.deleteMemorySubscription(
      null,
      { memoryId: publicMemory.id, orgId: subscriberOrg.id },
      adminCtx(ownerAdminUser.id),
    );
    expect(result).toBe(true);
    const after = await db.memorySubscription.findMany({
      where: { memoryId: publicMemory.id, organizationId: subscriberOrg.id },
    });
    expect(after).toHaveLength(0);
  });

  it('subscriber-org admin can also delete (either side admin gates)', async () => {
    const result = await resolvers.Mutation.deleteMemorySubscription(
      null,
      { memoryId: publicMemory.id, orgId: subscriberOrg.id },
      adminCtx(subscriberAdminUser.id),
    );
    expect(result).toBe(true);
  });

  it('accepts URNs for both memoryId and orgId', async () => {
    const result = await resolvers.Mutation.deleteMemorySubscription(
      null,
      { memoryId: publicMemory.urn, orgId: subscriberOrg.urn },
      adminCtx(ownerAdminUser.id),
    );
    expect(result).toBe(true);
  });

  it('rejects when caller is admin of neither org', async () => {
    const stranger = await db.user.create({
      data: { id: generateId(), githubId: 9604, githubUsername: 'sub-stranger', roles: ['READER'] },
    });
    await expect(
      resolvers.Mutation.deleteMemorySubscription(
        null,
        { memoryId: publicMemory.id, orgId: subscriberOrg.id },
        readerCtx(stranger.id),
      ),
    ).rejects.toThrow(/Forbidden/);
  });
});
