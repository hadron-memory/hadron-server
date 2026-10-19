import { WORKER_SIGNATURE_DEFAULTS } from '../../../lib/workerSignature.js';
/**
 * mergeUsers — consolidate a duplicate User into a surviving target.
 * Covers target-wins profile semantics, relationship transfer/collision,
 * identity/audit re-attribution, source tombstoning, refs, and admin guards.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { mergeUsers, approvedMergeProof } from '../../../test/mergeConsent.js';
import { orgMutations } from './resolvers.mutation.org.js';
import { resolveUserRef } from '../../../lib/entityRef/userRef.js';
import type { Context } from './resolvers.helpers.js';

let admin: { id: string };
let source: { id: string };
let target: { id: string };

function adminCtx(): Context {
  return { db, userId: admin.id, roles: ['ADMIN'] };
}

async function merge(sourceRef: string, targetRef: string, ctx = adminCtx()) {
  // Invalid refs still reach the production gate (which may refuse before
  // resolving them); valid refs mint consent for the actual requested pair.
  let consentProof = 'invalid-ref-proof';
  try {
    const [s, t] = await Promise.all([resolveUserRef(db, sourceRef), resolveUserRef(db, targetRef)]);
    consentProof = await approvedMergeProof(db, s.id, t.id, admin.id);
  } catch { /* The resolver owns the caller-facing refusal. */ }
  return orgMutations.mergeUsers(
    {},
    { input: { source: sourceRef, target: targetRef, consentProof } },
    ctx,
  );
}

beforeEach(async () => {
  await cleanDb(db);
  admin = await db.user.create({
    data: { handle: 'merge-admin', roles: ['ADMIN'] },
  });
  source = await db.user.create({
    data: {
      handle: 'merge-source',
      githubId: 7001,
      githubUsername: 'merge-source-gh',
      googleId: 'source-google-sub',
      identityProvider: 'GITHUB',
      name: 'Source Name',
      email: 'source@example.test',
      avatarUrl: 'https://example.test/source.png',
      roles: ['ADMIN'],
    },
  });
  target = await db.user.create({
    data: {
      handle: 'merge-target',
      githubId: 8001,
      name: 'Target Name',
      roles: ['READER'],
    },
  });
});

describe('Mutation.mergeUsers — identity and guards', () => {
  it('keeps target values, fills empty identity fields, and tombstones the source', async () => {
    const out = await merge('hrn:user:merge-source', target.id);

    expect(out).toMatchObject({
      id: target.id,
      handle: 'merge-target',
      githubId: 8001,
      githubUsername: null,
      googleId: 'source-google-sub',
      identityProvider: 'GITHUB',
      name: 'Target Name',
      email: 'source@example.test',
      avatarUrl: 'https://example.test/source.png',
      roles: ['READER', 'ADMIN'],
    });

    const tombstone = await db.user.findUniqueOrThrow({ where: { id: source.id } });
    expect(tombstone.deletedAt).not.toBeNull();
    expect(tombstone.deletedBy).toBe(admin.id);
    // handle is NOT NULL (spec 047): the tombstone gets a fresh random handle,
    // which RELEASES the original ('merge-source') for the target / reuse.
    expect(tombstone.handle).not.toBe('merge-source');
    expect(tombstone.handle).toMatch(/^merged-[0-9a-f]{16}$/);
    expect(tombstone).toMatchObject({
      githubId: null,
      githubUsername: null,
      googleId: null,
      email: null,
      externalAppId: null,
      externalId: null,
    });
  });

  it('refuses a self-merge at the operation layer, leaving the account intact', async () => {
    await expect(
      mergeUsers(db, { sourceUserId: source.id, targetUserId: source.id }),
    ).rejects.toThrow('source and target must be different');

    const intact = await db.user.findUniqueOrThrow({ where: { id: source.id } });
    expect(intact.deletedAt).toBeNull();
    expect(intact.email).toBe('source@example.test');
  });

  it('rejects a caller without platform admin authority and a same-user merge', async () => {
    await expect(
      merge(source.id, target.id, { db, userId: target.id, roles: ['READER'] }),
    ).rejects.toMatchObject({ extensions: { code: 'FORBIDDEN' } });

    await expect(merge(target.id, 'hrn:user:merge-target')).rejects.toMatchObject({
      extensions: { code: 'MERGE_SOURCE_EQUALS_TARGET', userId: target.id },
    });
  });

  it.each(['ADMIN', 'OWNER'] as const)(
    'refuses a live org %s merging two live members without platform authority (#1642)',
    async (role) => {
      const orgAdmin = await db.user.create({
        data: { handle: `merge-org-${role.toLowerCase()}`, roles: ['READER'] },
      });
      const org = await db.organization.create({
        data: {
          id: generateId(),
          name: 'Shared Merge Org',
          urn: `shared-merge-${role.toLowerCase()}`,
        },
      });
      await db.orgMember.createMany({
        data: [
          { organizationId: org.id, userId: orgAdmin.id, role },
          { organizationId: org.id, userId: source.id, role: 'READER' },
          { organizationId: org.id, userId: target.id, role: 'READER' },
        ],
      });

      await expect(merge(source.id, target.id, {
        db,
        userId: orgAdmin.id,
        roles: ['READER'],
      })).rejects.toMatchObject({ extensions: { code: 'FORBIDDEN' } });
      await expect(
        db.user.findUniqueOrThrow({ where: { id: source.id } }),
      ).resolves.toMatchObject({
        deletedAt: null,
        deletedBy: null,
      });
    },
  );

  it('refuses an org-admin merge without changing either account (#1642)', async () => {
    // source carries platform roles: ['ADMIN'] (beforeEach); target: ['READER'].
    const orgAdmin = await db.user.create({
      data: { handle: 'merge-org-noescalate', roles: ['READER'] },
    });
    const org = await db.organization.create({
      data: { id: generateId(), name: 'No-Escalate Org', urn: 'no-escalate-org' },
    });
    await db.orgMember.createMany({
      data: [
        { organizationId: org.id, userId: orgAdmin.id, role: 'ADMIN' },
        { organizationId: org.id, userId: source.id, role: 'READER' },
        { organizationId: org.id, userId: target.id, role: 'READER' },
      ],
    });

    await expect(merge(source.id, target.id, { db, userId: orgAdmin.id, roles: ['READER'] }))
      .rejects.toMatchObject({ extensions: { code: 'FORBIDDEN' } });
    expect(await db.user.findUniqueOrThrow({ where: { id: target.id } })).toMatchObject({ roles: ['READER'] });
    expect(await db.user.findUniqueOrThrow({ where: { id: source.id } })).toMatchObject({ deletedAt: null, roles: ['ADMIN'] });
  });

  it('lets a platform admin carry the source global roles onto the target', async () => {
    // Platform-admin path (adminCtx): union preserves the source's ADMIN.
    const out = await merge(source.id, target.id);
    expect(new Set(out.roles)).toEqual(new Set(['READER', 'ADMIN']));
  });

  it('refuses unauthenticated and ordinary-member callers before resolving account refs (#1642)', async () => {
    for (const ctx of [{ db, roles: [] }, { db, userId: target.id, roles: ['READER'] }] as Context[]) {
      await expect(merge('hrn:user:no-such-source', 'hrn:user:no-such-target', ctx))
        .rejects.toMatchObject({ message: 'Forbidden', extensions: { code: 'FORBIDDEN' } });
    }
  });

  it('rejects a shared-org member below ADMIN and an admin when the users do not share that org', async () => {
    const caller = await db.user.create({
      data: { handle: 'merge-org-caller', roles: ['READER'] },
    });
    const sharedOrg = await db.organization.create({
      data: {
        id: generateId(),
        name: 'Shared But Unadministered',
        urn: 'shared-unadministered',
      },
    });
    await db.orgMember.createMany({
      data: [
        { organizationId: sharedOrg.id, userId: caller.id, role: 'CONTRIBUTOR' },
        { organizationId: sharedOrg.id, userId: source.id, role: 'READER' },
        { organizationId: sharedOrg.id, userId: target.id, role: 'READER' },
      ],
    });
    const ctx: Context = { db, userId: caller.id, roles: ['READER'] };

    await expect(merge(source.id, target.id, ctx)).rejects.toMatchObject({ extensions: { code: 'FORBIDDEN' } });

    await db.orgMember.update({
      where: { organizationId_userId: { organizationId: sharedOrg.id, userId: caller.id } },
      data: { role: 'ADMIN' },
    });
    await db.orgMember.delete({
      where: { organizationId_userId: { organizationId: sharedOrg.id, userId: target.id } },
    });
    const targetOnlyOrg = await db.organization.create({
      data: { id: generateId(), name: 'Target Only', urn: 'merge-target-only' },
    });
    await db.orgMember.create({
      data: { organizationId: targetOnlyOrg.id, userId: target.id, role: 'READER' },
    });

    await expect(merge(source.id, target.id, ctx)).rejects.toThrow('Forbidden');
  });

  it('rejects revoked caller, source, and target memberships', async () => {
    const caller = await db.user.create({
      data: { handle: 'merge-revoked-caller', roles: ['READER'] },
    });
    const org = await db.organization.create({
      data: { id: generateId(), name: 'Revoked Merge Org', urn: 'revoked-merge-org' },
    });
    await db.orgMember.createMany({
      data: [
        {
          organizationId: org.id,
          userId: caller.id,
          role: 'ADMIN',
          deletedAt: new Date(),
        },
        { organizationId: org.id, userId: source.id, role: 'READER' },
        { organizationId: org.id, userId: target.id, role: 'READER' },
      ],
    });
    const ctx: Context = { db, userId: caller.id, roles: ['READER'] };

    await expect(merge(source.id, target.id, ctx)).rejects.toThrow('Forbidden');

    await db.orgMember.update({
      where: { organizationId_userId: { organizationId: org.id, userId: caller.id } },
      data: { deletedAt: null },
    });
    await db.orgMember.update({
      where: { organizationId_userId: { organizationId: org.id, userId: source.id } },
      data: { deletedAt: new Date() },
    });
    await expect(merge(source.id, target.id, ctx)).rejects.toThrow('Forbidden');

    await db.orgMember.update({
      where: { organizationId_userId: { organizationId: org.id, userId: source.id } },
      data: { deletedAt: null },
    });
    await db.orgMember.update({
      where: { organizationId_userId: { organizationId: org.id, userId: target.id } },
      data: { deletedAt: new Date() },
    });
    await expect(merge(source.id, target.id, ctx)).rejects.toThrow('Forbidden');
  });
});

describe('Mutation.mergeUsers — relationships', () => {
  it('moves source-only relationships and keeps target rows on composite collisions', async () => {
    const orgA = await db.organization.create({
      data: { id: generateId(), name: 'Merge A', urn: 'merge-a' },
    });
    const orgB = await db.organization.create({
      data: { id: generateId(), name: 'Merge B', urn: 'merge-b', createdBy: source.id },
    });
    const orgC = await db.organization.create({
      data: { id: generateId(), name: 'Merge C', urn: 'merge-c' },
    });
    const other = await db.user.create({ data: { handle: 'merge-other' } });

    await db.orgMember.createMany({
      data: [
        { organizationId: orgA.id, userId: target.id, role: 'READER' },
        { organizationId: orgA.id, userId: source.id, role: 'ADMIN' },
        { organizationId: orgB.id, userId: source.id, role: 'OWNER' },
        { organizationId: orgC.id, userId: target.id, role: 'READER' },
        {
          organizationId: orgC.id,
          userId: source.id,
          role: 'OWNER',
          deletedAt: new Date(),
        },
      ],
    });

    const appA = await db.app.create({
      data: { id: generateId(), organizationId: orgA.id, name: 'App A', urn: 'merge-a:app-a' },
    });
    const appB = await db.app.create({
      data: { id: generateId(), organizationId: orgB.id, name: 'App B', urn: 'merge-b:app-b' },
    });
    await db.appMember.createMany({
      data: [
        { appId: appA.id, userId: target.id, role: 'target-role' },
        { appId: appA.id, userId: source.id, role: 'source-role' },
        { appId: appB.id, userId: source.id, role: 'source-only' },
      ],
    });

    const agent = await db.agent.create({
      data: {
        id: generateId(),
        organizationId: orgA.id,
        urn: 'merge-a:agent',
        name: 'Agent',
        createdBy: source.id,
        editorLockUserId: source.id,
      },
    });
    await db.agentSubscription.createMany({
      data: [
        { userId: target.id, agentId: agent.id, revokedAt: new Date() },
        { userId: source.id, agentId: agent.id, activatedAt: new Date() },
      ],
    });

    const sourcePersonal = await db.memory.create({
      data: {
        id: generateId(),
        organizationId: orgB.id,
        userId: source.id,
        urn: 'merge-b:source-personal',
        name: 'Source personal',
        class: 'personal',
        createdBy: source.id,
      },
    });
    const targetPersonal = await db.memory.create({
      data: {
        id: generateId(),
        organizationId: orgA.id,
        userId: target.id,
        urn: 'merge-a:target-personal',
        name: 'Target personal',
        class: 'personal',
      },
    });
    const otherPersonal = await db.memory.create({
      data: {
        id: generateId(),
        organizationId: orgA.id,
        userId: other.id,
        urn: 'merge-a:other-personal',
        name: 'Other personal',
        class: 'personal',
      },
    });
    const group = await db.memory.create({
      data: {
        id: generateId(),
        organizationId: orgA.id,
        urn: 'merge-a:group',
        name: 'Group',
        class: 'group',
        visibility: 'GROUP',
      },
    });
    await db.memoryMember.createMany({
      data: [
        { memoryId: group.id, userId: target.id, role: 'reader' },
        { memoryId: group.id, userId: source.id, role: 'owner' },
      ],
    });
    await db.memoryShare.create({
      data: {
        memoryId: sourcePersonal.id,
        granteeId: other.id,
        grantorId: source.id,
        role: 'writer',
      },
    });
    await db.memoryShare.createMany({
      data: [
        {
          memoryId: otherPersonal.id,
          granteeId: target.id,
          grantorId: other.id,
          role: 'reader',
        },
        {
          memoryId: otherPersonal.id,
          granteeId: source.id,
          grantorId: other.id,
          role: 'writer',
        },
      ],
    });
    await db.memoryShare.create({
      data: {
        memoryId: targetPersonal.id,
        granteeId: source.id,
        grantorId: target.id,
        role: 'reader',
      },
    });
    await db.node.create({
      data: {
        id: generateId(),
        memoryId: sourcePersonal.id,
        loc: 'owned',
        name: 'Owned',
        createdBy: source.id,
      },
    });
    await db.session.create({
      data: { id: generateId(), userId: source.id, createdBy: source.id },
    });
    await db.userApiKey.create({
      data: {
        id: generateId(),
        userId: source.id,
        keyHash: 'merge-source-key-hash',
        keyPreview: 'hash',
        createdBy: source.id,
        oauthScopes: [],
      },
    });
    await db.pendingSetup.createMany({
      data: [
        { userId: target.id, appId: appA.id, rawKeyEncrypted: 'target-key' },
        { userId: source.id, appId: appB.id, rawKeyEncrypted: 'source-key' },
      ],
    });

    await merge(source.id, target.id);

    expect(
      await db.orgMember.findUnique({
        where: { organizationId_userId: { organizationId: orgA.id, userId: target.id } },
      }),
    ).toMatchObject({ role: 'ADMIN' });
    expect(
      await db.orgMember.findUnique({
        where: { organizationId_userId: { organizationId: orgB.id, userId: target.id } },
      }),
    ).toMatchObject({ role: 'OWNER' });
    expect(
      await db.orgMember.findUnique({
        where: { organizationId_userId: { organizationId: orgC.id, userId: target.id } },
      }),
    ).toMatchObject({ role: 'READER', deletedAt: null });
    expect(await db.orgMember.count({ where: { userId: source.id } })).toBe(0);
    expect(await db.organization.findUniqueOrThrow({ where: { id: orgB.id } })).toMatchObject({
      createdBy: target.id,
    });

    expect(
      await db.appMember.findUnique({
        where: { appId_userId: { appId: appA.id, userId: target.id } },
      }),
    ).toMatchObject({ role: 'target-role' });
    expect(
      await db.appMember.findUnique({
        where: { appId_userId: { appId: appB.id, userId: target.id } },
      }),
    ).toMatchObject({ role: 'source-only' });

    expect(
      await db.agentSubscription.findUnique({
        where: { userId_agentId: { userId: target.id, agentId: agent.id } },
      }),
    ).toMatchObject({ revokedAt: null, activatedAt: expect.any(Date) });
    expect(
      await db.memoryMember.findUnique({
        where: { memoryId_userId: { memoryId: group.id, userId: target.id } },
      }),
    ).toMatchObject({ role: 'owner' });

    expect(await db.memory.findUniqueOrThrow({ where: { id: sourcePersonal.id } })).toMatchObject({
      userId: target.id,
      createdBy: target.id,
    });
    expect(
      await db.memoryShare.findUnique({
        where: { memoryId_granteeId: { memoryId: sourcePersonal.id, granteeId: other.id } },
      }),
    ).toMatchObject({ grantorId: target.id, role: 'writer' });
    expect(
      await db.memoryShare.findUnique({
        where: { memoryId_granteeId: { memoryId: targetPersonal.id, granteeId: target.id } },
      }),
    ).toBeNull();
    expect(
      await db.memoryShare.findUnique({
        where: { memoryId_granteeId: { memoryId: otherPersonal.id, granteeId: target.id } },
      }),
    ).toMatchObject({ role: 'writer' });
    expect(await db.node.findFirstOrThrow({ where: { memoryId: sourcePersonal.id } })).toMatchObject({
      createdBy: target.id,
    });
    expect(await db.session.findFirstOrThrow({ where: { id: { not: '' } } })).toMatchObject({
      userId: target.id,
      createdBy: target.id,
    });
    expect(await db.userApiKey.findFirstOrThrow()).toMatchObject({
      userId: target.id,
      createdBy: target.id,
    });
    expect(await db.pendingSetup.count({ where: { userId: target.id } })).toBe(1);
    expect(await db.pendingSetup.count({ where: { userId: source.id } })).toBe(0);
    expect(await db.agent.findUniqueOrThrow({ where: { id: agent.id } })).toMatchObject({
      createdBy: target.id,
      editorLockUserId: target.id,
    });
  });
});

describe('Mutation.mergeUsers — worker holds (#1050)', () => {
  it('moves the source account\'s held names to the survivor', async () => {
    // The source User is SOFT-deleted, so `held_by_user_id`'s ON DELETE SET
    // NULL never fires. Without an explicit transfer the surviving account is
    // refused WORKER_HELD on names held by what is, by construction, the same
    // person (PR #1052 review, Codex P1).
    const org = await db.organization.create({
      data: { id: generateId(), name: 'wh-org', urn: `wh-${Date.now()}.com` },
    });
    const agent = await db.agent.create({
      data: { id: generateId(), organizationId: org.id, urn: `${org.urn}:a`, name: 'A' },
    });
    const app = await db.app.create({
      data: { id: generateId(), organizationId: org.id, name: 'App', urn: `${org.urn}:app` },
    });
    const held = await db.worker.create({
      data: { ...WORKER_SIGNATURE_DEFAULTS,
        appId: app.id, agentId: agent.id, name: 'Iris', slug: 'iris',
        heldByUserId: source.id, heldAt: new Date(),
      },
    });
    // A name held by somebody else must not move.
    const other = await db.user.create({ data: { handle: `wh-other-${Date.now()}` } });
    const foreign = await db.worker.create({
      data: { ...WORKER_SIGNATURE_DEFAULTS,
        appId: app.id, agentId: agent.id, name: 'Nadia', slug: 'nadia',
        heldByUserId: other.id, heldAt: new Date(),
      },
    });

    await merge(source.id, target.id);

    expect((await db.worker.findUniqueOrThrow({ where: { id: held.id } })).heldByUserId)
      .toBe(target.id);
    expect((await db.worker.findUniqueOrThrow({ where: { id: foreign.id } })).heldByUserId)
      .toBe(other.id);
  });
});

describe('Mutation.mergeUsers — node approvals (#1591)', () => {
  it('moves the live approval of record, and the revision copy, to the survivor', async () => {
    const org = await db.organization.create({ data: { id: generateId(), name: 'ap-org', urn: `ap-${Date.now()}.com` } });
    const memory = await db.memory.create({ data: {
      id: generateId(), organizationId: org.id, urn: `${org.urn}:m`, name: 'm', class: 'knowledge', visibility: 'ORGANIZATION',
    } });
    const approval = { approvedRevNo: 1, approvedAt: new Date(), approvalHash: 'a'.repeat(64) };
    const mine = await db.node.create({ data: {
      id: generateId(), memoryId: memory.id, loc: 'a', name: 'a', approvedBy: source.id, ...approval,
      mintedAt: new Date(), mintedBy: source.id, mintedRevNo: 1, mintedHash: 'a'.repeat(64),
    } });
    const theirs = await db.node.create({ data: { id: generateId(), memoryId: memory.id, loc: 'b', name: 'b', approvedBy: admin.id, ...approval } });
    const revision = await db.nodeRevision.create({ data: {
      id: generateId(), nodeId: mine.id, memoryId: memory.id, loc: 'a', name: 'a', approvedBy: source.id, revNo: 1,
    } });

    await merge(source.id, target.id);

    expect(await db.node.findUniqueOrThrow({ where: { id: mine.id } })).toMatchObject({ approvedBy: target.id, mintedBy: target.id });
    expect((await db.node.findUniqueOrThrow({ where: { id: theirs.id } })).approvedBy).toBe(admin.id);
    expect((await db.nodeRevision.findUniqueOrThrow({ where: { id: revision.id } })).approvedBy).toBe(target.id);
  });
});
