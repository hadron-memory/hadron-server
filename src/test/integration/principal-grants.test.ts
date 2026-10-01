/**
 * Grant model (design:grant-model P2a/P2b) — integration tests.
 *
 * The two promises under test:
 *   1. BEHAVIOR PRESERVED: with no PrincipalGrant rows, the requireOrgAction
 *      gate reproduces the requireOrgRole(ADMIN) decisions it replaced on
 *      createMemory / cloneMemory / deleteMemory.
 *   2. THE NEW CAPABILITY: a live, in-scope grant lets a specific non-admin
 *      member perform a specific action; revocation and expiry take it away.
 *
 * Plus the CRUD authorization: org-ADMIN-only, interactive-only management;
 * member-pinned listing (self-audit never gated).
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { db } from '../../integrations/db/client.js';
import { cleanDb } from '../helpers.js';
import { resolvers, type Context } from '../../api/graphql/schema/resolvers.js';
import { generateId } from '../../lib/id.js';
import { waitForLockWaitersOfType } from '../lockWait.js';

let org: { id: string; urn: string };
let orgAdmin: { id: string };
let contributor: { id: string };
let reader: { id: string };

/** Org-ADMIN member WITHOUT platform roles (the common org operator). */
function orgAdminCtx(): Context {
  return { db, roles: [], userId: orgAdmin.id } as unknown as Context;
}
function contributorCtx(): Context {
  return { db, roles: [], userId: contributor.id } as unknown as Context;
}
function readerCtx(): Context {
  return { db, roles: [], userId: reader.id } as unknown as Context;
}

beforeEach(async () => {
  await cleanDb(db);
  org = await db.organization.create({
    data: { id: generateId(), name: 'org-a', urn: 'org-a' },
  });
  orgAdmin = await db.user.create({
    data: { githubId: 9101, githubUsername: 'org-admin', roles: [] },
  });
  contributor = await db.user.create({
    data: { githubId: 9102, githubUsername: 'contrib', roles: [] },
  });
  reader = await db.user.create({
    data: { githubId: 9103, githubUsername: 'reader', roles: [] },
  });
  await db.orgMember.createMany({
    data: [
      { organizationId: org.id, userId: orgAdmin.id, role: 'ADMIN' },
      { organizationId: org.id, userId: contributor.id, role: 'CONTRIBUTOR' },
      { organizationId: org.id, userId: reader.id, role: 'READER' },
    ],
  });
});

describe('#1551 principal-grant authority fence', () => {
  it('admin removal waits for an in-flight principal grant to commit', async () => {
    const owner = await db.user.create({ data: {
      id: generateId(), githubId: 1551101, githubUsername: `grant-owner-${generateId()}`,
    } });
    await db.orgMember.create({ data: {
      id: generateId(), organizationId: org.id, userId: owner.id, role: 'OWNER',
    } });
    let release!: () => void;
    let held!: () => void;
    const holdGate = new Promise<void>((resolve) => { release = resolve; });
    const locked = new Promise<void>((resolve) => { held = resolve; });
    const holder = db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM organizations WHERE id = ${org.id} FOR UPDATE`;
      held();
      await holdGate;
    }, { timeout: 20_000 });
    await locked;

    const grant = resolvers.Mutation.createPrincipalGrant(null, {
      orgRef: org.id, userRef: contributor.id, actions: ['memory.clone'],
    }, orgAdminCtx());
    try {
      await waitForLockWaitersOfType(db, 'transactionid', 1);
      let removed = false;
      const removal = resolvers.Mutation.removeOrgMember(null, {
        orgId: org.id, userId: orgAdmin.id,
      }, { db, userId: owner.id, roles: [] } as Context)
        .then((value: unknown) => { removed = true; return value; });
      await waitForLockWaitersOfType(db, 'advisory', 1);
      expect(removed).toBe(false);
      release();
      await holder;
      await grant;
      await removal;
      expect(await db.principalGrant.count({ where: {
        organizationId: org.id, principalId: contributor.id, deletedAt: null,
      } })).toBe(1);
      expect((await db.orgMember.findUniqueOrThrow({ where: {
        organizationId_userId: { organizationId: org.id, userId: orgAdmin.id },
      } })).deletedAt).not.toBeNull();
    } finally {
      release();
      await Promise.allSettled([holder, grant]);
    }
  });
});

async function createKnowledgeMemory(urn = 'org-a:km') {
  return db.memory.create({
    data: {
      id: generateId(),
      organizationId: org.id,
      urn,
      name: urn.split(':').pop()!,
      class: 'knowledge',
      visibility: 'ORGANIZATION',
    },
  });
}

async function grantActions(
  userId: string,
  actions: string[],
  overrides: Record<string, unknown> = {},
) {
  return db.principalGrant.create({
    data: {
      id: generateId(),
      principalType: 'USER',
      principalId: userId,
      organizationId: org.id,
      actions,
      ...overrides,
    },
  });
}

// ---------------------------------------------------------------------------
// Gate: behavior preserved without grant rows
// ---------------------------------------------------------------------------

describe('requireOrgAction — no grant rows (transcription check)', () => {
  it('CONTRIBUTOR still cannot clone / create / delete', async () => {
    const mem = await createKnowledgeMemory();
    await expect(
      resolvers.Mutation.cloneMemory({}, { ref: mem.id, targetUrn: 'org-a::km-2' }, contributorCtx()),
    ).rejects.toThrow('Forbidden');
    await expect(
      resolvers.Mutation.createMemory({}, { orgId: org.id, name: 'new-mem' }, contributorCtx()),
    ).rejects.toThrow('Forbidden');
    await expect(
      resolvers.Mutation.deleteMemory({}, { id: mem.id }, contributorCtx()),
    ).rejects.toThrow('Forbidden');
  });

  it('org ADMIN (no platform role) still can clone / create / delete', async () => {
    const mem = await createKnowledgeMemory();
    const clone = await resolvers.Mutation.cloneMemory(
      {},
      { ref: mem.id, targetUrn: 'org-a::km-clone' },
      orgAdminCtx(),
    );
    expect(clone.urn).toBe('org-a:km-clone');
    const created = await resolvers.Mutation.createMemory(
      {},
      { orgId: org.id, name: 'made-by-admin' },
      orgAdminCtx(),
    );
    expect(created.id).toBeTruthy();
    await expect(
      resolvers.Mutation.deleteMemory({}, { id: mem.id }, orgAdminCtx()),
    ).resolves.toBeTruthy();
  });

  it('a revoked membership does not authorize even with a live grant', async () => {
    const mem = await createKnowledgeMemory();
    await grantActions(contributor.id, ['memory.clone']);
    await db.orgMember.update({
      where: { organizationId_userId: { organizationId: org.id, userId: contributor.id } },
      data: { deletedAt: new Date() },
    });
    // A grant is an exception ON TOP of membership, never a substitute:
    // revoking the membership instantly cuts every capability, the grant
    // included (findings:revoked-membership-auth-gates). #1316: a revoked
    // member is an outsider who cannot open the record either, so the refusal
    // is the missing-memory answer rather than a Forbidden confirming it.
    await expect(
      resolvers.Mutation.cloneMemory({}, { ref: mem.id, targetUrn: 'org-a::km-3' }, contributorCtx()),
    ).rejects.toThrow(`MEMORY_NOT_FOUND: ${mem.id}`);
    expect(await db.memory.findFirst({ where: { urn: 'org-a:km-3' } })).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Gate: the new capability
// ---------------------------------------------------------------------------

describe('requireOrgAction — individual grants', () => {
  it('a memory.clone grant lets a CONTRIBUTOR clone (and nothing else)', async () => {
    const mem = await createKnowledgeMemory();
    await grantActions(contributor.id, ['memory.clone']);
    const clone = await resolvers.Mutation.cloneMemory(
      {},
      { ref: mem.id, targetUrn: 'org-a::km-clone' },
      contributorCtx(),
    );
    expect(clone.urn).toBe('org-a:km-clone');
    await expect(
      resolvers.Mutation.deleteMemory({}, { id: mem.id }, contributorCtx()),
    ).rejects.toThrow('Forbidden');
  });

  it('works for a READER too (grants are role-independent)', async () => {
    await grantActions(reader.id, ['memory.create']);
    const created = await resolvers.Mutation.createMemory(
      {},
      { orgId: org.id, name: 'reader-made' },
      readerCtx(),
    );
    expect(created.id).toBeTruthy();
  });

  it('a wildcard grant (memory.*) covers the whole family', async () => {
    const mem = await createKnowledgeMemory();
    await grantActions(contributor.id, ['memory.*']);
    await expect(
      resolvers.Mutation.deleteMemory({}, { id: mem.id }, contributorCtx()),
    ).resolves.toBeTruthy();
  });

  it('an expired grant does not authorize; a perpetual one does', async () => {
    const mem = await createKnowledgeMemory();
    await grantActions(contributor.id, ['memory.clone'], {
      expiresAt: new Date(Date.now() - 60_000),
    });
    await expect(
      resolvers.Mutation.cloneMemory({}, { ref: mem.id, targetUrn: 'org-a::x' }, contributorCtx()),
    ).rejects.toThrow('Forbidden');
    await grantActions(contributor.id, ['memory.clone'], { expiresAt: null });
    const clone = await resolvers.Mutation.cloneMemory(
      {},
      { ref: mem.id, targetUrn: 'org-a::y' },
      contributorCtx(),
    );
    expect(clone.urn).toBe('org-a:y');
  });

  it('a revoked (soft-deleted) grant does not authorize', async () => {
    const mem = await createKnowledgeMemory();
    const grant = await grantActions(contributor.id, ['memory.clone']);
    await db.principalGrant.update({
      where: { id: grant.id },
      data: { deletedAt: new Date() },
    });
    await expect(
      resolvers.Mutation.cloneMemory({}, { ref: mem.id, targetUrn: 'org-a::z' }, contributorCtx()),
    ).rejects.toThrow('Forbidden');
  });

  it('a grant in org A does not authorize in org B (org-scoped)', async () => {
    const orgB = await db.organization.create({
      data: { id: generateId(), name: 'org-b', urn: 'org-b' },
    });
    await db.orgMember.create({
      data: { organizationId: orgB.id, userId: contributor.id, role: 'CONTRIBUTOR' },
    });
    const memB = await db.memory.create({
      data: {
        id: generateId(),
        organizationId: orgB.id,
        urn: 'org-b:km',
        name: 'km',
        class: 'knowledge',
        visibility: 'ORGANIZATION',
      },
    });
    await grantActions(contributor.id, ['memory.clone']); // org A only
    await expect(
      resolvers.Mutation.cloneMemory({}, { ref: memB.id, targetUrn: 'org-b::km-2' }, contributorCtx()),
    ).rejects.toThrow('Forbidden');
  });
});

// ---------------------------------------------------------------------------
// CRUD authorization
// ---------------------------------------------------------------------------

describe('principalGrant CRUD', () => {
  it('org ADMIN creates a grant; the grantee then holds it', async () => {
    const grant = await resolvers.Mutation.createPrincipalGrant(
      {},
      { orgRef: org.urn, userRef: contributor.id, actions: ['memory.clone'] },
      orgAdminCtx(),
    );
    expect(grant.principalId).toBe(contributor.id);
    expect(grant.actions).toEqual(['memory.clone']);
    expect(grant.organizationUrn).toBe('org-a');
  });

  it('a CONTRIBUTOR cannot create grants', async () => {
    await expect(
      resolvers.Mutation.createPrincipalGrant(
        {},
        { orgRef: org.urn, userRef: reader.id, actions: ['memory.clone'] },
        contributorCtx(),
      ),
    ).rejects.toThrow('Forbidden');
  });

  it('an App-key / on-behalf-of context cannot manage grants (self-bootstrap guard)', async () => {
    const appCtx = { db, roles: [], userId: orgAdmin.id, appId: 'some-app' } as unknown as Context;
    await expect(
      resolvers.Mutation.createPrincipalGrant(
        {},
        { orgRef: org.urn, userRef: contributor.id, actions: ['memory.clone'] },
        appCtx,
      ),
    ).rejects.toThrow('Forbidden');
    await expect(
      resolvers.Mutation.revokePrincipalGrant({}, { ref: 'whatever' }, appCtx),
    ).rejects.toThrow('Forbidden');
  });

  it('rejects a non-member grantee and malformed action entries', async () => {
    const outsider = await db.user.create({
      data: { githubId: 9104, githubUsername: 'outsider', roles: [] },
    });
    await expect(
      resolvers.Mutation.createPrincipalGrant(
        {},
        { orgRef: org.urn, userRef: outsider.id, actions: ['memory.clone'] },
        orgAdminCtx(),
      ),
    ).rejects.toThrow('member of the organization');
    await expect(
      resolvers.Mutation.createPrincipalGrant(
        {},
        { orgRef: org.urn, userRef: contributor.id, actions: ['Memory.Clone!'] },
        orgAdminCtx(),
      ),
    ).rejects.toThrow('Invalid action entry');
  });

  it('revoke is org-ADMIN-only and takes effect at the gate', async () => {
    const mem = await createKnowledgeMemory();
    const grant = await resolvers.Mutation.createPrincipalGrant(
      {},
      { orgRef: org.urn, userRef: contributor.id, actions: ['memory.clone'] },
      orgAdminCtx(),
    );
    // Non-admin revoke: indistinguishable from not-found.
    await expect(
      resolvers.Mutation.revokePrincipalGrant({}, { ref: grant.id }, contributorCtx()),
    ).rejects.toThrow('Grant not found');
    // Admin revoke works, and the capability is gone.
    await expect(
      resolvers.Mutation.revokePrincipalGrant({}, { ref: grant.id }, orgAdminCtx()),
    ).resolves.toBe(true);
    await expect(
      resolvers.Mutation.cloneMemory({}, { ref: mem.id, targetUrn: 'org-a::k2' }, contributorCtx()),
    ).rejects.toThrow('Forbidden');
  });

  it('listing: members see their own; an org admin passing orgRef sees all', async () => {
    await grantActions(contributor.id, ['memory.clone']);
    await grantActions(reader.id, ['memory.create']);

    const own = await resolvers.Query.principalGrants({}, {}, contributorCtx());
    expect(own.total).toBe(1);
    expect(own.items[0].principalId).toBe(contributor.id);

    const all = await resolvers.Query.principalGrants({}, { orgRef: org.urn }, orgAdminCtx());
    expect(all.total).toBe(2);

    // Non-admin with orgRef stays pinned to their own grants.
    const pinned = await resolvers.Query.principalGrants({}, { orgRef: org.urn }, readerCtx());
    expect(pinned.total).toBe(1);
    expect(pinned.items[0].principalId).toBe(reader.id);

    // Unresolvable orgRef: empty page, never an error (no oracle).
    const none = await resolvers.Query.principalGrants({}, { orgRef: 'no-such-org' }, readerCtx());
    expect(none).toEqual({ items: [], total: 0 });
  });

  it('find-one: grantee or org admin; anyone else gets null', async () => {
    const grant = await grantActions(contributor.id, ['memory.clone']);
    const asGrantee = await resolvers.Query.principalGrant({}, { ref: grant.id }, contributorCtx());
    expect(asGrantee?.id).toBe(grant.id);
    const asAdmin = await resolvers.Query.principalGrant({}, { ref: grant.id }, orgAdminCtx());
    expect(asAdmin?.id).toBe(grant.id);
    const asReader = await resolvers.Query.principalGrant({}, { ref: grant.id }, readerCtx());
    expect(asReader).toBeNull();
  });
});
