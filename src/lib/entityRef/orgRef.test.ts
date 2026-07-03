import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { PrismaClient } from '../../generated/prisma/index.js';
import { resolveOrgRef } from './orgRef.js';
import { OrganizationNotFoundError, UrnNotQualifiedError } from './errors.js';

const db = new PrismaClient();

beforeAll(async () => {
  await db.$connect();
});

afterAll(async () => {
  await db.$disconnect();
});

beforeEach(async () => {
  await db.organization.deleteMany({ where: { name: { startsWith: 'orgref-test-' } } });
});

describe('resolveOrgRef', () => {
  it('resolves an ID-shaped reference', async () => {
    const org = await db.organization.create({
      data: { name: 'orgref-test-org-id', urn: `orgref-test-org-id-${Date.now()}` },
    });
    expect(await resolveOrgRef(db, org.id)).toEqual({ id: org.id });
  });

  it('resolves a URN-shaped reference', async () => {
    const org = await db.organization.create({
      data: { name: 'orgref-test-org-urn', urn: `orgref-test-org-urn-${Date.now()}:slug` },
    });
    expect(await resolveOrgRef(db, org.urn)).toEqual({ id: org.id });
  });

  it('resolves a prefixed URN', async () => {
    const org = await db.organization.create({
      data: { name: 'orgref-test-org-pref', urn: `orgref-test-org-pref-${Date.now()}:slug` },
    });
    expect(await resolveOrgRef(db, `urn:org:${org.urn}`)).toEqual({ id: org.id });
  });

  it('throws OrganizationNotFoundError on miss (ID)', async () => {
    await expect(resolveOrgRef(db, 'not-a-real-id')).rejects.toBeInstanceOf(
      OrganizationNotFoundError,
    );
  });

  it('throws OrganizationNotFoundError on miss (URN)', async () => {
    await expect(resolveOrgRef(db, 'no-such-org:slug')).rejects.toBeInstanceOf(
      OrganizationNotFoundError,
    );
  });

  it('throws OrganizationNotFoundError for a soft-deleted org', async () => {
    const org = await db.organization.create({
      data: {
        name: 'orgref-test-org-deleted',
        urn: `orgref-test-org-deleted-${Date.now()}:slug`,
        deletedAt: new Date(),
      },
    });
    await expect(resolveOrgRef(db, org.id)).rejects.toBeInstanceOf(OrganizationNotFoundError);
    await expect(resolveOrgRef(db, org.urn)).rejects.toBeInstanceOf(OrganizationNotFoundError);
  });

  // ===================================================================
  // spec 022 — API-boundary URN qualification (FR-001, FR-002, FR-019)
  // ===================================================================

  it('rejects empty input as UrnNotQualifiedError', async () => {
    await expect(resolveOrgRef(db, '')).rejects.toBeInstanceOf(UrnNotQualifiedError);
  });

  it('rejects urn:memory: prefix (wrong type) as UrnNotQualifiedError', async () => {
    await expect(resolveOrgRef(db, 'urn:memory:foo::bar')).rejects.toBeInstanceOf(
      UrnNotQualifiedError,
    );
  });

  it('excludes a soft-deleted org by default; includeDeleted opts in', async () => {
    const org = await db.organization.create({
      data: { name: 'orgref-test-org-deleted', urn: `orgref-test-org-deleted-${Date.now()}:slug`, deletedAt: new Date() },
    });
    await expect(resolveOrgRef(db, org.id)).rejects.toBeInstanceOf(OrganizationNotFoundError);
    await expect(resolveOrgRef(db, org.id, { includeDeleted: true })).resolves.toEqual({ id: org.id });
  });
});
