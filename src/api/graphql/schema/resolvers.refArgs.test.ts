/**
 * #764 — access mutations accept an entity *ref* (id / URN / handle / email)
 * everywhere they previously took a raw PK. Two layers:
 *
 *   1. resolveRefArg unit tests — the shared helper's contract: mutual
 *      exclusion, required, uniform NOT_FOUND mapping, ambiguity passthrough,
 *      and that BOTH the new xRef and the deprecated xId route through the
 *      resolver (so id-named args that already accepted URNs keep doing so).
 *   2. End-to-end on addOrgMember — a handle, an email, and an hrn:user URN all
 *      resolve the same grantee; orgRef accepts the org slug; the deprecated
 *      userId still works.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { resolvers, type Context } from './resolvers.js';
import { resolveRefArg } from './resolvers.helpers.js';
import { UserNotFoundError, AmbiguousUserRefError } from '../../../lib/entityRef/errors.js';

const M = resolvers.Mutation as any;
const ctx = (userId: string): Context => ({ db, userId, roles: ['READER'] });

describe('resolveRefArg (unit)', () => {
  const ok = async (_db: unknown, ref: string) => ({ id: `id-for-${ref}` });

  it('resolves the ref arg through the resolver', async () => {
    expect(await resolveRefArg(db, ok, { ref: 'holger', label: 'user' })).toBe('id-for-holger');
  });

  it('resolves the DEPRECATED id arg through the resolver too (URN-accepting args keep working)', async () => {
    expect(await resolveRefArg(db, ok, { id: 'acme.com', label: 'org' })).toBe('id-for-acme.com');
  });

  it('rejects supplying both ref and id', async () => {
    await expect(
      resolveRefArg(db, ok, { ref: 'a', id: 'b', label: 'user' }),
    ).rejects.toThrow(/Pass either userRef or userId, not both/);
  });

  it('rejects supplying neither', async () => {
    await expect(resolveRefArg(db, ok, { label: 'org' })).rejects.toThrow(/A org is required/);
  });

  it('maps an entity NotFound to a uniform NOT_FOUND', async () => {
    const missing = async (_db: unknown, ref: string): Promise<{ id: string }> => {
      throw new UserNotFoundError(ref);
    };
    await expect(
      resolveRefArg(db, missing, { ref: 'ghost', label: 'user' }),
    ).rejects.toThrow(/No match for userRef "ghost"/);
  });

  it('maps AmbiguousUserRefError to BAD_USER_INPUT with guidance', async () => {
    const ambiguous = async (_db: unknown, ref: string): Promise<{ id: string }> => {
      throw new AmbiguousUserRefError(ref);
    };
    await expect(
      resolveRefArg(db, ambiguous, { ref: 'Alice@x.com', label: 'user' }),
    ).rejects.toThrow(/matches more than one account/);
  });
});

describe('#764 addOrgMember accepts refs end-to-end', () => {
  let org: { id: string; urn: string };
  let owner: { id: string };
  let target: { id: string; handle: string; email: string };

  beforeEach(async () => {
    await cleanDb(db);
    const slug = `refargs-org-${generateId().slice(-8)}`;
    org = await db.organization.create({
      data: { id: generateId(), name: 'refargs-org', urn: slug },
    });
    owner = await db.user.create({
      data: { id: generateId(), githubId: 49101, githubUsername: `ra-owner-${generateId().slice(-8)}` },
    });
    await db.orgMember.create({
      data: { id: generateId(), organizationId: org.id, userId: owner.id, role: 'OWNER' },
    });
    const handle = `ratarget${generateId().slice(-8)}`.toLowerCase();
    const email = `${handle}@example.com`;
    target = {
      ...(await db.user.create({ data: { id: generateId(), handle, email } })),
      handle,
      email,
    };
  });

  const isMember = async () =>
    !!(await db.orgMember.findFirst({
      where: { organizationId: org.id, userId: target.id, deletedAt: null },
    }));

  it('resolves the grantee by handle', async () => {
    await M.addOrgMember(null, { orgId: org.id, userRef: target.handle, role: 'READER' }, ctx(owner.id));
    expect(await isMember()).toBe(true);
  });

  it('resolves the grantee by email', async () => {
    await M.addOrgMember(null, { orgId: org.id, userRef: target.email, role: 'READER' }, ctx(owner.id));
    expect(await isMember()).toBe(true);
  });

  it('resolves the grantee by hrn:user URN and the org by slug', async () => {
    await M.addOrgMember(
      null,
      { orgRef: org.urn, userRef: `hrn:user:${target.handle}`, role: 'READER' },
      ctx(owner.id),
    );
    expect(await isMember()).toBe(true);
  });

  it('still accepts the deprecated userId', async () => {
    await M.addOrgMember(null, { orgId: org.id, userId: target.id, role: 'READER' }, ctx(owner.id));
    expect(await isMember()).toBe(true);
  });

  it('rejects an unknown grantee ref with NOT_FOUND (after the auth gate)', async () => {
    await expect(
      M.addOrgMember(null, { orgId: org.id, userRef: 'nobody-here', role: 'READER' }, ctx(owner.id)),
    ).rejects.toThrow(/No match for userRef/);
    expect(await isMember()).toBe(false);
  });

  it('rejects supplying both userRef and userId', async () => {
    await expect(
      M.addOrgMember(
        null,
        { orgId: org.id, userRef: target.handle, userId: target.id, role: 'READER' },
        ctx(owner.id),
      ),
    ).rejects.toThrow(/not both/);
  });
});
