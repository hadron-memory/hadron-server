/**
 * Unit tests for the v2 memory-resolution helper (spec 006).
 *
 * Exercises the (user, agent) → memory function for the three cases:
 * unique writable memory (resolved), zero writable memories, and
 * multiple writable memories (ambiguity error).
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { PrismaClient } from '../../generated/prisma/index.js';
import { resolveAgentWritableMemory } from './memoryResolution.js';

const db = new PrismaClient();

let orgId: string;
let userId: string;

async function makeMemory(name: string) {
  return db.memory.create({
    data: {
      organizationId: orgId,
      urn: `${orgId}:resolve-test-${name}`,
      name: `resolve-test-${name}`,
      class: 'knowledge',
    },
  });
}

async function makeAgent(name: string, memoryRoles: Array<{ memoryId: string; role: 'read' | 'read-write' }>) {
  return db.agent.create({
    data: {
      organizationId: orgId,
      urn: `${orgId}:resolve-test-agent-${name}`,
      name: `resolve-test-agent-${name}`,
      memoryItems: {
        create: memoryRoles,
      },
    },
  });
}

beforeAll(async () => {
  await db.$connect();
});

afterAll(async () => {
  await db.$disconnect();
});

beforeEach(async () => {
  // Clean test data
  await db.agentMemoryItem.deleteMany({});
  await db.agent.deleteMany({ where: { name: { startsWith: 'resolve-test-' } } });
  await db.memory.deleteMany({ where: { name: { startsWith: 'resolve-test-' } } });
  await db.user.deleteMany({ where: { handle: { startsWith: 'resolve-test-' } } });
  await db.organization.deleteMany({ where: { name: { startsWith: 'resolve-test-' } } });
  const org = await db.organization.create({
    data: {
      name: 'resolve-test-org',
      urn: `resolve-test-org-${Date.now()}`,
    },
  });
  orgId = org.id;
  const user = await db.user.create({
    data: { handle: `resolve-test-user-${Date.now()}` },
  });
  userId = user.id;
});

describe('resolveAgentWritableMemory', () => {
  it('returns ok with the single writable memory when there is exactly one', async () => {
    const memory = await makeMemory('single');
    const agent = await makeAgent('single', [
      { memoryId: memory.id, role: 'read-write' },
    ]);

    const result = await resolveAgentWritableMemory(db, userId, agent.urn);
    expect(result).toEqual({ ok: true, memoryId: memory.id });
  });

  it('returns AMBIGUOUS_MEMORY_TARGET with candidates when there are multiple', async () => {
    const m1 = await makeMemory('multi-1');
    const m2 = await makeMemory('multi-2');
    const agent = await makeAgent('multi', [
      { memoryId: m1.id, role: 'read-write' },
      { memoryId: m2.id, role: 'read-write' },
    ]);

    const result = await resolveAgentWritableMemory(db, userId, agent.urn);
    expect(result.ok).toBe(false);
    if (result.ok === false) {
      expect(result.reason).toBe('AMBIGUOUS_MEMORY_TARGET');
      if (result.reason === 'AMBIGUOUS_MEMORY_TARGET') {
        expect(result.candidates).toHaveLength(2);
        const ids = result.candidates.map((c) => c.id).sort();
        expect(ids).toEqual([m1.id, m2.id].sort());
      }
    }
  });

  it('returns NO_WRITABLE_MEMORY when the agent has zero writable memories', async () => {
    const memory = await makeMemory('readonly');
    const agent = await makeAgent('zero', [
      { memoryId: memory.id, role: 'read' }, // read-only, not writable
    ]);

    const result = await resolveAgentWritableMemory(db, userId, agent.urn);
    expect(result).toEqual({ ok: false, reason: 'NO_WRITABLE_MEMORY' });
  });

  it('returns NO_WRITABLE_MEMORY when the agent has no attached memories at all', async () => {
    const agent = await makeAgent('empty', []);

    const result = await resolveAgentWritableMemory(db, userId, agent.urn);
    expect(result).toEqual({ ok: false, reason: 'NO_WRITABLE_MEMORY' });
  });

  it('returns NO_WRITABLE_MEMORY for an unknown agent urn', async () => {
    const result = await resolveAgentWritableMemory(db, userId, 'nonexistent:agent');
    expect(result).toEqual({ ok: false, reason: 'NO_WRITABLE_MEMORY' });
  });

  it('excludes soft-deleted memories from the writable set', async () => {
    const m1 = await makeMemory('soft-1');
    const m2 = await makeMemory('soft-2');
    // Soft-delete m2.
    await db.memory.update({ where: { id: m2.id }, data: { deletedAt: new Date() } });
    const agent = await makeAgent('soft', [
      { memoryId: m1.id, role: 'read-write' },
      { memoryId: m2.id, role: 'read-write' },
    ]);

    const result = await resolveAgentWritableMemory(db, userId, agent.urn);
    expect(result).toEqual({ ok: true, memoryId: m1.id });
  });
});
