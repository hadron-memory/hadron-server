import { describe, it, expect, vi } from 'vitest';
import { Prisma, type PrismaClient } from '../generated/prisma/index.js';
import { runSerializable, isSerializationFailure } from './serializableTxn.js';

function serializationError(): Prisma.PrismaClientKnownRequestError {
  return new Prisma.PrismaClientKnownRequestError(
    'Transaction failed due to a write conflict or a deadlock. Please retry your transaction.',
    { code: 'P2034', clientVersion: 'test' },
  );
}

describe('isSerializationFailure', () => {
  it('recognizes the P2034 known-request error', () => {
    expect(isSerializationFailure(serializationError())).toBe(true);
  });

  it('recognizes a raw SQLSTATE 40001/40P01 on an unknown-request error', () => {
    const e40001 = new Prisma.PrismaClientUnknownRequestError(
      'could not serialize access due to read/write dependencies (SQLSTATE 40001)',
      { clientVersion: 'test' },
    );
    const eDeadlock = new Prisma.PrismaClientUnknownRequestError(
      'deadlock detected (SQLSTATE 40P01)',
      { clientVersion: 'test' },
    );
    expect(isSerializationFailure(e40001)).toBe(true);
    expect(isSerializationFailure(eDeadlock)).toBe(true);
  });

  it('does not treat unrelated errors as retryable', () => {
    expect(isSerializationFailure(new Error('nope'))).toBe(false);
    expect(
      isSerializationFailure(
        new Prisma.PrismaClientKnownRequestError('not found', {
          code: 'P2025',
          clientVersion: 'test',
        }),
      ),
    ).toBe(false);
  });
});

describe('runSerializable', () => {
  it('runs at SERIALIZABLE isolation and returns the result on first success', async () => {
    const $transaction = vi.fn(async (fn: (tx: unknown) => Promise<unknown>, opts: unknown) => {
      expect((opts as { isolationLevel?: unknown }).isolationLevel).toBe(
        Prisma.TransactionIsolationLevel.Serializable,
      );
      return fn({});
    });
    const db = { $transaction } as unknown as PrismaClient;

    const out = await runSerializable(db, async () => 'ok');
    expect(out).toBe('ok');
    expect($transaction).toHaveBeenCalledTimes(1);
  });

  it('retries the whole transaction on a serialization failure, then succeeds', async () => {
    let calls = 0;
    const $transaction = vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => {
      calls += 1;
      if (calls === 1) throw serializationError();
      return fn({});
    });
    const db = { $transaction } as unknown as PrismaClient;

    const out = await runSerializable(db, async () => 42);
    expect(out).toBe(42);
    expect(calls).toBe(2);
  });

  it('gives up after maxAttempts and rethrows the serialization failure', async () => {
    const $transaction = vi.fn(async () => {
      throw serializationError();
    });
    const db = { $transaction } as unknown as PrismaClient;

    await expect(runSerializable(db, async () => 'x', { maxAttempts: 3 })).rejects.toMatchObject({
      code: 'P2034',
    });
    expect($transaction).toHaveBeenCalledTimes(3);
  });

  it('does not retry a non-serialization error (typed errors propagate as-is)', async () => {
    const boom = new Prisma.PrismaClientKnownRequestError('not found', {
      code: 'P2025',
      clientVersion: 'test',
    });
    const $transaction = vi.fn(async () => {
      throw boom;
    });
    const db = { $transaction } as unknown as PrismaClient;

    await expect(runSerializable(db, async () => 'x')).rejects.toBe(boom);
    expect($transaction).toHaveBeenCalledTimes(1);
  });
});
