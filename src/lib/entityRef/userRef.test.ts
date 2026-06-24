import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { PrismaClient } from '../../generated/prisma/index.js';
import { resolveUserRef } from './userRef.js';
import { UserNotFoundError } from './errors.js';

const db = new PrismaClient();

let gid = 950000;

beforeAll(async () => {
  await db.$connect();
});

afterAll(async () => {
  await db.$disconnect();
});

beforeEach(async () => {
  await db.user.deleteMany({ where: { handle: { startsWith: 'userref-test-' } } });
});

describe('resolveUserRef', () => {
  it('resolves an ID-shaped reference', async () => {
    const u = await db.user.create({
      data: { githubId: gid++, handle: 'userref-test-id' },
    });
    expect(await resolveUserRef(db, u.id)).toEqual({ id: u.id });
  });

  it('resolves a hrn:user:<handle> URN', async () => {
    const u = await db.user.create({
      data: { githubId: gid++, handle: 'userref-test-handle' },
    });
    expect(await resolveUserRef(db, 'hrn:user:userref-test-handle')).toEqual({ id: u.id });
  });

  it('resolves the legacy urn:user: prefix', async () => {
    const u = await db.user.create({
      data: { githubId: gid++, handle: 'userref-test-legacy' },
    });
    expect(await resolveUserRef(db, 'urn:user:userref-test-legacy')).toEqual({ id: u.id });
  });

  it('throws UserNotFoundError on an unknown handle', async () => {
    await expect(resolveUserRef(db, 'hrn:user:userref-test-nobody')).rejects.toBeInstanceOf(
      UserNotFoundError,
    );
  });

  it('throws UserNotFoundError for a soft-deleted user', async () => {
    const u = await db.user.create({
      data: { githubId: gid++, handle: 'userref-test-gone', deletedAt: new Date() },
    });
    await expect(resolveUserRef(db, 'hrn:user:userref-test-gone')).rejects.toBeInstanceOf(
      UserNotFoundError,
    );
    expect(u.deletedAt).not.toBeNull();
  });

  it('accepts a bare handle (a user URN is a single segment, like an org)', async () => {
    const u = await db.user.create({
      data: { githubId: gid++, handle: 'userref-test-bare' },
    });
    expect(await resolveUserRef(db, 'userref-test-bare')).toEqual({ id: u.id });
  });
});
