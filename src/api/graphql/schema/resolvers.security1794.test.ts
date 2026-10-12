/** Restricted #1794 regression. Keep diagnostic detail in the restricted nodes. */
import { beforeEach, describe, expect, it } from 'vitest';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { resolvers, type Context } from './resolvers.js';

beforeEach(async () => { await cleanDb(db); });

describe('restricted #1794 profile boundary', () => {
  it.each([null, 'current@security1794.test'])('refuses a new address without changing any profile field (existing %s)', async email => {
    const user = await db.user.create({ data: { handle: 'security1794-user', name: 'Original', email, roles: ['READER'] } });
    const ctx: Context = { db, userId: user.id, roles: ['READER'] };
    await expect(resolvers.Mutation.updateMyProfile({}, { email: 'other@security1794.test', name: 'Changed', handle: 'changed-name' }, ctx))
      .rejects.toMatchObject({ extensions: { code: 'BAD_USER_INPUT' } });
    const saved = await db.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(saved.email).toBe(email);
    expect(saved.name).toBe('Original');
    expect(saved.handle).toBe(user.handle);
  });

  it('preserves ordinary name changes when no address is supplied', async () => {
    const user = await db.user.create({ data: { handle: 'security1794-user', email: 'current@security1794.test', roles: ['READER'] } });
    const result = await resolvers.Mutation.updateMyProfile({}, { name: 'Changed' }, { db, userId: user.id, roles: ['READER'] });
    expect(result.name).toBe('Changed');
    expect(result.email).toBe(user.email);
  });

  it('permits resubmitting the unchanged address without establishing new identity', async () => {
    const user = await db.user.create({ data: { handle: 'security1794-user', email: 'current@security1794.test', roles: ['READER'] } });
    const result = await resolvers.Mutation.updateMyProfile({}, { name: 'Changed', email: user.email! }, { db, userId: user.id, roles: ['READER'] });
    expect(result.name).toBe('Changed');
    expect(result.email).toBe(user.email);
  });
  it.each([' current@security1794.test ', 'CURRENT@SECURITY1794.TEST'])('accepts an equivalent legacy form value %s without rewriting it', async email => {
    const stored = ' Current@Security1794.test ';
    const user = await db.user.create({ data: { handle: 'security1794-user', email: stored, roles: ['READER'] } });
    const result = await resolvers.Mutation.updateMyProfile({}, { name: 'Changed', email }, { db, userId: user.id, roles: ['READER'] });
    expect(result.name).toBe('Changed');
    expect(result.email).toBe(stored);
  });

  it.each([null, '', '  '])('refuses clearing an existing value with %s', async email => {
    const user = await db.user.create({ data: { handle: 'security1794-user', email: 'current@security1794.test', roles: ['READER'] } });
    await expect(resolvers.Mutation.updateMyProfile({}, { email, name: 'Changed' }, { db, userId: user.id, roles: ['READER'] }))
      .rejects.toMatchObject({ extensions: { code: 'BAD_USER_INPUT' } });
    const saved = await db.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(saved.email).toBe(user.email);
    expect(saved.name).toBeNull();
  });

  it.each([null, '', '  '])('treats absent legacy form value %s as a no-op', async email => {
    const user = await db.user.create({ data: { handle: 'security1794-user', roles: ['READER'] } });
    const result = await resolvers.Mutation.updateMyProfile({}, { name: 'Changed', email }, { db, userId: user.id, roles: ['READER'] });
    expect(result.email).toBeNull();
    expect(result.name).toBe('Changed');
  });

});
