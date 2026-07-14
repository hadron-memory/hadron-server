/**
 * updateMyProfile — handle is lowercase-canonical and URN-validated on write
 * (#325). Legacy rows are grandfathered; this covers the write path.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { resolvers, type Context } from './resolvers.js';

let user: { id: string };

function meCtx(): Context {
  return { db, userId: user.id, roles: ['READER'] };
}

beforeEach(async () => {
  await cleanDb(db);
  user = await db.user.create({
    data: { id: generateId(), githubId: 55001, githubUsername: 'profile-test' },
  });
});

describe('Mutation.updateMyProfile — handle normalization (#325)', () => {
  it('lowercases the handle on write', async () => {
    await resolvers.Mutation.updateMyProfile({}, { handle: 'NewHandle' }, meCtx());
    expect((await db.user.findUnique({ where: { id: user.id } }))?.handle).toBe('newhandle');
  });

  it('rejects an illegal (non-URN-atom) handle', async () => {
    await db.user.update({ where: { id: user.id }, data: { handle: 'keep' } });
    await expect(
      resolvers.Mutation.updateMyProfile({}, { handle: 'bad handle!' }, meCtx()),
    ).rejects.toThrow();
    // unchanged
    expect((await db.user.findUnique({ where: { id: user.id } }))?.handle).toBe('keep');
  });

  it('rejects a reserved-word handle', async () => {
    await expect(
      resolvers.Mutation.updateMyProfile({}, { handle: 'memory' }, meCtx()),
    ).rejects.toThrow();
  });

  // spec 047: handle is NOT NULL — it can no longer be cleared.
  it('rejects an empty-string handle (cannot clear)', async () => {
    await db.user.update({ where: { id: user.id }, data: { handle: 'keep' } });
    await expect(
      resolvers.Mutation.updateMyProfile({}, { handle: '' }, meCtx()),
    ).rejects.toThrow(/required/);
    expect((await db.user.findUnique({ where: { id: user.id } }))?.handle).toBe('keep');
  });

  it('rejects an explicit null handle (cannot clear)', async () => {
    await db.user.update({ where: { id: user.id }, data: { handle: 'keep' } });
    await expect(
      resolvers.Mutation.updateMyProfile({}, { handle: null }, meCtx()),
    ).rejects.toThrow(/required/);
    expect((await db.user.findUnique({ where: { id: user.id } }))?.handle).toBe('keep');
  });

  it('leaves the handle untouched when not provided', async () => {
    await db.user.update({ where: { id: user.id }, data: { handle: 'stable' } });
    await resolvers.Mutation.updateMyProfile({}, { name: 'New Name' }, meCtx());
    const row = await db.user.findUnique({ where: { id: user.id } });
    expect(row?.handle).toBe('stable');
    expect(row?.name).toBe('New Name');
  });
});
