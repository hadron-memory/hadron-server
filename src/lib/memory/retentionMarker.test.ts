import { describe, expect, it, vi } from 'vitest';
import {
  RELEASE_MARKER_KEY,
  readReleaseMarker,
  writeReleaseMarkerIfMissing,
} from './retentionMarker.js';

type FakeRow = {
  key: string;
  value: unknown;
  createdAt: Date;
  updatedAt: Date | null;
};

function makeFakeDb(rows: FakeRow[]) {
  const findUnique = vi.fn(async ({ where }: { where: { key: string } }) => {
    return rows.find((r) => r.key === where.key) ?? null;
  });
  const upsert = vi.fn(
    async ({ where, create }: { where: { key: string }; create: FakeRow }) => {
      const existing = rows.find((r) => r.key === where.key);
      if (existing) return existing;
      const row: FakeRow = {
        key: create.key,
        value: create.value,
        createdAt: new Date(),
        updatedAt: null,
      };
      rows.push(row);
      return row;
    },
  );
  return {
    systemConfig: { findUnique, upsert },
    findUnique,
    upsert,
    rows,
  };
}

describe('readReleaseMarker', () => {
  it('returns null when no row exists', async () => {
    const db = makeFakeDb([]);
    expect(await readReleaseMarker(db as never)).toBeNull();
  });

  it('returns the parsed Date when value is well-shaped', async () => {
    const db = makeFakeDb([
      {
        key: RELEASE_MARKER_KEY,
        value: { deployedAt: '2026-05-07T12:00:00.000Z' },
        createdAt: new Date(),
        updatedAt: null,
      },
    ]);
    const result = await readReleaseMarker(db as never);
    expect(result).toEqual(new Date('2026-05-07T12:00:00.000Z'));
  });

  it('returns null when value is malformed (no deployedAt key)', async () => {
    const db = makeFakeDb([
      {
        key: RELEASE_MARKER_KEY,
        value: { unrelated: 'field' },
        createdAt: new Date(),
        updatedAt: null,
      },
    ]);
    expect(await readReleaseMarker(db as never)).toBeNull();
  });

  it('returns null when deployedAt is not parseable', async () => {
    const db = makeFakeDb([
      {
        key: RELEASE_MARKER_KEY,
        value: { deployedAt: 'not-a-date' },
        createdAt: new Date(),
        updatedAt: null,
      },
    ]);
    expect(await readReleaseMarker(db as never)).toBeNull();
  });
});

describe('writeReleaseMarkerIfMissing', () => {
  it('creates the row when missing and returns the deployedAt', async () => {
    const db = makeFakeDb([]);
    const deployedAt = new Date('2026-05-07T12:00:00.000Z');
    const result = await writeReleaseMarkerIfMissing(db as never, deployedAt);
    expect(result).toEqual(deployedAt);
    expect(db.upsert).toHaveBeenCalledTimes(1);
    expect(db.rows[0].key).toBe(RELEASE_MARKER_KEY);
  });

  it('preserves an existing row and does not overwrite (idempotent)', async () => {
    const original = new Date('2026-05-07T12:00:00.000Z');
    const db = makeFakeDb([
      {
        key: RELEASE_MARKER_KEY,
        value: { deployedAt: original.toISOString() },
        createdAt: new Date(),
        updatedAt: null,
      },
    ]);
    const later = new Date('2026-06-15T12:00:00.000Z');
    const result = await writeReleaseMarkerIfMissing(db as never, later);
    expect(result).toEqual(original);
    // upsert should NOT be called when read returns a row.
    expect(db.upsert).not.toHaveBeenCalled();
  });
});
