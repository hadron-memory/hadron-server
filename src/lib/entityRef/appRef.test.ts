import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { PrismaClient } from '../../generated/prisma/index.js';
import { resolveAppRef } from './appRef.js';
import { AppNotFoundError } from './errors.js';

const db = new PrismaClient();

let orgId: string;

beforeAll(async () => {
  await db.$connect();
});

afterAll(async () => {
  await db.$disconnect();
});

beforeEach(async () => {
  await db.app.deleteMany({ where: { name: { startsWith: 'appref-test-' } } });
  await db.organization.deleteMany({ where: { name: { startsWith: 'appref-test-' } } });
  const org = await db.organization.create({
    data: { name: 'appref-test-org', urn: `appref-test-org-${Date.now()}` },
  });
  orgId = org.id;
});

describe('resolveAppRef', () => {
  it('resolves an ID-shaped reference', async () => {
    const app = await db.app.create({
      data: {
        organizationId: orgId,
        urn: `${orgId}:appref-test-app-id`,
        name: 'appref-test-app-id',
      },
    });
    expect(await resolveAppRef(db, app.id)).toEqual({ id: app.id });
  });

  it('resolves a bare URN', async () => {
    const app = await db.app.create({
      data: {
        organizationId: orgId,
        urn: `${orgId}:appref-test-app-urn`,
        name: 'appref-test-app-urn',
      },
    });
    expect(await resolveAppRef(db, app.urn)).toEqual({ id: app.id });
  });

  it('resolves a prefixed URN (urn:app: prefix stripped)', async () => {
    const app = await db.app.create({
      data: {
        organizationId: orgId,
        urn: `${orgId}:appref-test-app-prefixed`,
        name: 'appref-test-app-prefixed',
      },
    });
    expect(await resolveAppRef(db, `urn:app:${app.urn}`)).toEqual({ id: app.id });
  });

  it('throws AppNotFoundError on miss (ID)', async () => {
    await expect(resolveAppRef(db, 'not-a-real-id')).rejects.toBeInstanceOf(AppNotFoundError);
  });

  it('throws AppNotFoundError on miss (URN)', async () => {
    await expect(resolveAppRef(db, 'no-such-org:no-such-app')).rejects.toBeInstanceOf(
      AppNotFoundError,
    );
  });

  it('throws AppNotFoundError for a soft-deleted app', async () => {
    const app = await db.app.create({
      data: {
        organizationId: orgId,
        urn: `${orgId}:appref-test-app-deleted`,
        name: 'appref-test-app-deleted',
        deletedAt: new Date(),
      },
    });
    await expect(resolveAppRef(db, app.id)).rejects.toBeInstanceOf(AppNotFoundError);
    await expect(resolveAppRef(db, app.urn)).rejects.toBeInstanceOf(AppNotFoundError);
  });
});
