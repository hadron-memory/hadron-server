import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { PrismaClient } from '../../generated/prisma/index.js';
import { resolveMemoryRef } from './memoryRef.js';
import { MemoryNotFoundError } from './errors.js';

const db = new PrismaClient();

let orgId: string;

beforeAll(async () => {
  await db.$connect();
});

afterAll(async () => {
  await db.$disconnect();
});

beforeEach(async () => {
  await db.memory.deleteMany({ where: { name: { startsWith: 'memref-test-' } } });
  await db.organization.deleteMany({ where: { name: { startsWith: 'memref-test-' } } });
  const org = await db.organization.create({
    data: { name: 'memref-test-org', urn: `memref-test-org-${Date.now()}` },
  });
  orgId = org.id;
});

describe('resolveMemoryRef', () => {
  it('resolves an ID-shaped reference to the row', async () => {
    const memory = await db.memory.create({
      data: {
        organizationId: orgId,
        urn: `${orgId}:memref-test-mem-id`,
        name: 'memref-test-mem-id',
        class: 'knowledge',
      },
    });
    const result = await resolveMemoryRef(db, memory.id);
    expect(result).toEqual({ id: memory.id });
  });

  it('resolves a bare URN-shaped reference to the row', async () => {
    const memory = await db.memory.create({
      data: {
        organizationId: orgId,
        urn: `${orgId}:memref-test-mem-urn`,
        name: 'memref-test-mem-urn',
        class: 'knowledge',
      },
    });
    const result = await resolveMemoryRef(db, memory.urn);
    expect(result).toEqual({ id: memory.id });
  });

  it('resolves a prefixed URN-shaped reference to the row (urn:memory: prefix stripped)', async () => {
    const memory = await db.memory.create({
      data: {
        organizationId: orgId,
        urn: `${orgId}:memref-test-mem-prefixed`,
        name: 'memref-test-mem-prefixed',
        class: 'knowledge',
      },
    });
    const result = await resolveMemoryRef(db, `urn:memory:${memory.urn}`);
    expect(result).toEqual({ id: memory.id });
  });

  it('throws MemoryNotFoundError on an ID miss', async () => {
    await expect(resolveMemoryRef(db, 'not-a-real-id')).rejects.toBeInstanceOf(
      MemoryNotFoundError,
    );
  });

  it('throws MemoryNotFoundError on a bare URN miss', async () => {
    await expect(resolveMemoryRef(db, 'no-such-org:no-such-memory')).rejects.toBeInstanceOf(
      MemoryNotFoundError,
    );
  });

  it('throws MemoryNotFoundError on a prefixed URN miss', async () => {
    await expect(
      resolveMemoryRef(db, 'urn:memory:no-such-org:no-such-memory'),
    ).rejects.toBeInstanceOf(MemoryNotFoundError);
  });

  it('throws MemoryNotFoundError for a soft-deleted memory', async () => {
    const memory = await db.memory.create({
      data: {
        organizationId: orgId,
        urn: `${orgId}:memref-test-mem-deleted`,
        name: 'memref-test-mem-deleted',
        class: 'knowledge',
        deletedAt: new Date(),
      },
    });
    await expect(resolveMemoryRef(db, memory.id)).rejects.toBeInstanceOf(
      MemoryNotFoundError,
    );
    await expect(resolveMemoryRef(db, memory.urn)).rejects.toBeInstanceOf(
      MemoryNotFoundError,
    );
  });

  it('resolves a soft-deleted memory when includeDeleted is true', async () => {
    const memory = await db.memory.create({
      data: {
        organizationId: orgId,
        urn: `${orgId}:memref-test-mem-deleted-included`,
        name: 'memref-test-mem-deleted-included',
        class: 'knowledge',
        deletedAt: new Date(),
      },
    });
    await expect(
      resolveMemoryRef(db, memory.id, { includeDeleted: true }),
    ).resolves.toEqual({ id: memory.id });
    await expect(
      resolveMemoryRef(db, memory.urn, { includeDeleted: true }),
    ).resolves.toEqual({ id: memory.id });
  });

  it('still throws MemoryNotFoundError on a real miss when includeDeleted is true', async () => {
    await expect(
      resolveMemoryRef(db, 'no-such-org:no-such-memory', { includeDeleted: true }),
    ).rejects.toBeInstanceOf(MemoryNotFoundError);
  });
});
