/**
 * #2965 — cleanDb must clear invitation fixtures.
 *
 * `UserInvitation.sender` and `.organization` are `onDelete: SetNull`, so
 * deleting users and orgs left every invitation row behind, and its unique
 * `slug` stayed taken. A serial suite reusing one base then failed on the
 * second run with P2002 on the fixed slugs in
 * resolvers.invitationPreview.test.ts. Soft deletion (`deletedAt`) does not
 * release the slug either, so a soft-deleted fixture must go too.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { db } from '../integrations/db/client.js';
import { cleanDb } from './helpers.js';
import { generateId } from '../lib/id.js';

async function seedInvitations(): Promise<void> {
  const org = await db.organization.create({ data: {
    id: generateId(), name: 'Synthetic 2965 Org', urn: 'synthetic-2965-org',
  } });
  const sender = await db.user.create({ data: {
    githubId: 929651, githubUsername: 'synthetic-2965-sender', name: 'Synthetic Sender',
  } });
  const invitee = await db.user.create({ data: {
    githubId: 929652, githubUsername: 'synthetic-2965-invitee', name: 'Synthetic Invitee',
  } });
  const ordinary = await db.userInvitation.create({ data: {
    id: generateId(), slug: 'synthetic-2965-invite', senderUserId: sender.id,
    organizationId: org.id, memberRole: 'READER', maxActivations: 2,
  } });
  await db.userInvitationActivation.create({ data: {
    id: generateId(), invitationId: ordinary.id, userId: invitee.id,
  } });
  // A system invitation (no sender, no org), soft-deleted: nothing it
  // references cascades it away, and deletedAt keeps its slug taken.
  await db.userInvitation.create({ data: {
    id: generateId(), slug: 'synthetic-2965-system-invite', memberRole: 'READER',
    deletedAt: new Date(), deletedBy: 'synthetic-2965',
  } });
}

beforeEach(async () => {
  await cleanDb(db);
});

describe('#2965 cleanDb clears invitation fixtures', () => {
  it('leaves no ordinary or soft-deleted invitation and no activation behind', async () => {
    await seedInvitations();
    expect(await db.userInvitation.count()).toBe(2);
    expect(await db.userInvitationActivation.count()).toBe(1);

    await cleanDb(db);

    expect(await db.userInvitation.count()).toBe(0);
    expect(await db.userInvitationActivation.count()).toBe(0);
  });

  it('frees the fixed slugs, so the same fixtures can be created again (the reused-serial repro)', async () => {
    await seedInvitations();
    await cleanDb(db);
    await expect(seedInvitations()).resolves.toBeUndefined();
  });
});
