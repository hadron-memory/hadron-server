/**
 * Tests for ensureAgentSubscription idempotency. Verifies SC-006 +
 * spec FR-002 — concurrent first-contacts converge on a single row.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { db } from '../../integrations/db/client.js';
import { Prisma } from '../../generated/prisma/index.js';
import { cleanDb } from '../../test/helpers.js';
import { generateId } from '../../lib/id.js';
import { ensureAgentSubscription } from './ensureAgentSubscription.js';

let userId: string;
let agentId: string;

beforeEach(async () => {
  await cleanDb(db);
  const org = await db.organization.create({
    data: { id: generateId(), name: 'eas-org', urn: 'eas-org' },
  });
  const user = await db.user.create({ data: { id: generateId(), githubId: 51001 } });
  const agent = await db.agent.create({
    data: { id: generateId(), organizationId: org.id, urn: `${org.urn}:a`, name: 'a' },
  });
  userId = user.id;
  agentId = agent.id;
});

describe('ensureAgentSubscription', () => {
  it('creates a single row with activatedAt set on first call', async () => {
    await ensureAgentSubscription(db, userId, agentId);
    const sub = await db.agentSubscription.findUniqueOrThrow({
      where: { userId_agentId: { userId, agentId } },
    });
    expect(sub.activatedAt).not.toBeNull();
    expect(sub.revokedAt).toBeNull();
    expect(sub.expiresAt).toBeNull();
  });

  it('is idempotent under repeated sequential calls', async () => {
    await ensureAgentSubscription(db, userId, agentId);
    await ensureAgentSubscription(db, userId, agentId);
    await ensureAgentSubscription(db, userId, agentId);
    const count = await db.agentSubscription.count({ where: { userId, agentId } });
    expect(count).toBe(1);
  });

  it('is idempotent under concurrent first-contacts (SC-006)', async () => {
    const N = 10;
    await Promise.all(Array.from({ length: N }, () => ensureAgentSubscription(db, userId, agentId)));
    const count = await db.agentSubscription.count({ where: { userId, agentId } });
    expect(count).toBe(1);
  });

  it('does not modify an existing subscription on subsequent calls (e.g. preserves revokedAt)', async () => {
    await ensureAgentSubscription(db, userId, agentId);
    const revokedAt = new Date('2026-01-01T00:00:00Z');
    await db.agentSubscription.update({
      where: { userId_agentId: { userId, agentId } },
      data: { revokedAt },
    });
    await ensureAgentSubscription(db, userId, agentId);
    const sub = await db.agentSubscription.findUniqueOrThrow({
      where: { userId_agentId: { userId, agentId } },
    });
    // The upsert's `update: {}` clause is a no-op — revokedAt stays.
    expect(sub.revokedAt).toEqual(revokedAt);
  });

  // The four tests below force the catch path deterministically. The
  // SC-006 concurrent test above flushes the real race, but in any given
  // run the race may not actually fire — these tests guarantee a future
  // refactor can't silently delete or weaken the catch.

  it('treats a P2002 on the (userId, agentId) composite PK as success', async () => {
    const spy = vi.spyOn(db.agentSubscription, 'upsert').mockRejectedValueOnce(
      new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
        code: 'P2002',
        clientVersion: '6.19.2',
        meta: { target: ['userId', 'agentId'] },
      }),
    );
    await expect(ensureAgentSubscription(db, userId, agentId)).resolves.toBeUndefined();
    spy.mockRestore();
  });

  it('treats a P2002 with snake_case target on the same composite PK as success', async () => {
    const spy = vi.spyOn(db.agentSubscription, 'upsert').mockRejectedValueOnce(
      new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
        code: 'P2002',
        clientVersion: '6.19.2',
        meta: { target: ['user_id', 'agent_id'] },
      }),
    );
    await expect(ensureAgentSubscription(db, userId, agentId)).resolves.toBeUndefined();
    spy.mockRestore();
  });

  it('re-throws non-P2002 Prisma errors (e.g. P2003 FK violation)', async () => {
    const spy = vi.spyOn(db.agentSubscription, 'upsert').mockRejectedValueOnce(
      new Prisma.PrismaClientKnownRequestError('Foreign key constraint failed', {
        code: 'P2003',
        clientVersion: '6.19.2',
        meta: { field_name: 'AgentSubscription_userId_fkey' },
      }),
    );
    await expect(ensureAgentSubscription(db, userId, agentId)).rejects.toMatchObject({
      code: 'P2003',
    });
    spy.mockRestore();
  });

  it('re-throws P2002 from an unrelated unique constraint (defensive against future @unique fields)', async () => {
    const spy = vi.spyOn(db.agentSubscription, 'upsert').mockRejectedValueOnce(
      new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
        code: 'P2002',
        clientVersion: '6.19.2',
        meta: { target: ['stripeSubscriptionId'] },
      }),
    );
    await expect(ensureAgentSubscription(db, userId, agentId)).rejects.toMatchObject({
      code: 'P2002',
    });
    spy.mockRestore();
  });
});
