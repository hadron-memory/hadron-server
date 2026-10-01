/**
 * Tests for ensureAgentSubscription idempotency. Verifies SC-006 +
 * spec FR-002 — concurrent first-contacts converge on a single row.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { waitForLockWaitersOfType } from '../../test/lockWait.js';
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

  // The four tests below force the catch path deterministically. The
  // SC-006 concurrent test above flushes the real race, but in any given
  // run the race may not actually fire — these tests guarantee a future
  // refactor can't silently delete or weaken the catch.

  // #1581 review (Atilla): startChat now provisions INSIDE its chat
  // transaction. Under the old upsert-and-catch, the losing concurrent first
  // contact caught P2002 and its transaction was left aborted (25P02), so
  // the chat's next statement failed. Staged deterministically: tx A inserts
  // and holds, tx B's insert blocks on A's uncommitted key, then A commits.
  it('a concurrent first contact inside a transaction leaves that transaction usable (no 25P02)', async () => {
    let releaseA!: () => void;
    const holdA = new Promise<void>((r) => { releaseA = r; });
    let aInserted!: () => void;
    const aDone = new Promise<void>((r) => { aInserted = r; });
    const txA = db.$transaction(async (tx) => {
      await ensureAgentSubscription(tx, userId, agentId);
      aInserted();
      await holdA;
    }, { timeout: 20_000 });
    await aDone;
    const txB = db.$transaction(async (tx) => {
      await ensureAgentSubscription(tx, userId, agentId);
      // The statement after the helper must still run: the transaction is live.
      const [{ ok }] = await tx.$queryRaw<Array<{ ok: number }>>`SELECT 1 AS ok`;
      return ok;
    }, { timeout: 20_000 });
    await waitForLockWaitersOfType(db, 'transactionid', 1);
    releaseA();
    await txA;
    await expect(txB).resolves.toBe(1);
    expect(await db.agentSubscription.count({ where: { userId, agentId } })).toBe(1);
  });

  // #1581 review: the helper is now one INSERT … ON CONFLICT (user_id,
  // agent_id) DO NOTHING, so these run against the real database instead of a
  // mocked upsert, and pin the same contract.
  it('still raises a foreign-key violation (an unknown user)', async () => {
    await expect(ensureAgentSubscription(db, 'no-such-user-1581', agentId)).rejects.toBeTruthy();
  });

  it('still raises a conflict on a DIFFERENT unique constraint (only the composite PK is absorbed)', async () => {
    const other = await db.user.create({ data: { githubId: 158199, githubUsername: 'other-1581' } });
    await ensureAgentSubscription(db, userId, agentId);
    // A stand-in for a future unique field: one subscription per Agent.
    await db.$executeRawUnsafe('CREATE UNIQUE INDEX tmp_1581_one_sub_per_agent ON agent_subscriptions (agent_id)');
    try {
      await expect(ensureAgentSubscription(db, other.id, agentId)).rejects.toBeTruthy();
    } finally {
      await db.$executeRawUnsafe('DROP INDEX IF EXISTS tmp_1581_one_sub_per_agent');
    }
  });
});
