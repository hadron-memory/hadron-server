/**
 * #2896 — the write gate's narrow catch. Only the gate's own FORBIDDEN is a refusal; any other failure (a database
 * fault inside the gate) must surface as a fault, never be answered as "Forbidden" (the caller would stop retrying a
 * report that was never judged) and never reach the write.
 */
import { describe, it, expect, vi } from 'vitest';
import { GraphQLError } from 'graphql';

const gate = vi.hoisted(() => ({ requireSessionWriteAccess: vi.fn() }));
vi.mock('../api/graphql/schema/resolvers.helpers.js', () => gate);

import { recordSessionOutcome } from './sessionOutcome.js';

const target = { appId: 'a', userId: 'u', launchOperationId: null, memoryId: null, deletedAt: null };
const stub = () => {
  const update = vi.fn();
  const db = { session: { findUnique: vi.fn().mockResolvedValue(target), update } };
  return { db: db as never, update };
};
const ctx = async () => ({ userId: 'u', roles: ['READER'] }) as never;

describe('recordSessionOutcome — the gate catch is narrow', () => {
  it('answers the gate’s FORBIDDEN as forbidden, and writes nothing', async () => {
    gate.requireSessionWriteAccess.mockRejectedValueOnce(new GraphQLError('Forbidden', { extensions: { code: 'FORBIDDEN' } }));
    const { db, update } = stub();
    expect(await recordSessionOutcome(db, ctx, { sessionId: 's', outcome: 0.5 })).toEqual({ kind: 'forbidden' });
    expect(update).not.toHaveBeenCalled();
  });

  it('rethrows any other failure of the gate, and writes nothing', async () => {
    const fault = new Error('connection reset');
    gate.requireSessionWriteAccess.mockRejectedValueOnce(fault);
    const { db, update } = stub();
    await expect(recordSessionOutcome(db, ctx, { sessionId: 's', outcome: 0.5 })).rejects.toBe(fault);
    expect(update).not.toHaveBeenCalled();
  });
});
