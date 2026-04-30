/**
 * Tests for ensureAgentSubscription idempotency. Verifies SC-006 +
 * spec FR-002 — concurrent first-contacts converge on a single row.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { db } from '../../integrations/db/client.js';
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
});
