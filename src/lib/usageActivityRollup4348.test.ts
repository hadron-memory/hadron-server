/** #4348: an honest `alreadyComplete`, and the rollup job's command-line entry (relative path, symlink, unknown command). */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../integrations/db/client.js';
import { backfillUsageActivityRollup } from '../jobs/usageActivityRollup.js';
import { cleanDb } from '../test/helpers.js';
import { generateId } from './id.js';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

const naive = (d: Date) => d.toISOString().replace('Z', '');
const T0 = Date.UTC(2026, 8, 20, 10, 7, 33, 123);
const DAY = 86_400_000;
const ROOT = new URL('../..', import.meta.url).pathname.replace(/\/$/, '');
const TSX = join(ROOT, 'node_modules/.bin/tsx');

async function seed() {
  await db.$executeRaw`UPDATE usage_activity_rollup_state SET complete = false, applies_from = ${naive(new Date(T0 + 60_000))}::timestamp WHERE id = 1`;
  const memoryId = generateId();
  await db.usageEvent.createMany({
    data: Array.from({ length: 6 }, (_, i) => ({ id: generateId(), type: 'read', userId: null, memoryId, createdAt: new Date(T0 - i * DAY) })),
  });
}

const run = (args: string[], cwd = ROOT) =>
  spawnSync(TSX, args, { cwd, env: process.env, encoding: 'utf8', timeout: 50_000 });

describe('backfillUsageActivityRollup alreadyComplete (#4348 item 1)', () => {
  beforeEach(async () => { await cleanDb(db); await db.$executeRaw`TRUNCATE usage_activity_cells`; });
  // Leave the state row as a fresh deploy would, for the next file on this worker's clone.
  afterAll(async () => {
    await cleanDb(db);
    await db.$executeRaw`TRUNCATE usage_activity_cells`;
    await db.$executeRaw`INSERT INTO usage_activity_rollup_state (id, applies_from, complete) VALUES (1, hadron_usage_cell((now() AT TIME ZONE 'UTC')::timestamp) + interval '15 minutes', false)
      ON CONFLICT (id) DO UPDATE SET applies_from = EXCLUDED.applies_from, complete = false`;
  });

  it('is false when this run wrote chunks and a concurrent run completed the backfill between two of them', async () => {
    await seed();
    let rival: Awaited<ReturnType<typeof backfillUsageActivityRollup>> | undefined;
    const result = await backfillUsageActivityRollup(db, {
      chunkCells: 96,
      afterChunk: async (i) => { if (i === 1) rival = await backfillUsageActivityRollup(db); },
    });
    expect(rival?.alreadyComplete).toBe(false); // the rival really did the completing
    expect(result.chunks).toBeGreaterThan(0);
    expect(result.alreadyComplete).toBe(false);
  });

  it('stays true when the backfill was already complete and nothing ran', async () => {
    await seed();
    await backfillUsageActivityRollup(db);
    expect(await backfillUsageActivityRollup(db)).toEqual({ alreadyComplete: true, chunks: 0, cellsWritten: 0 });
  });
});

describe('usageActivityRollup.ts as a command (#4348 items 2 and 3)', () => {
  it('`drift` started by a RELATIVE path prints its JSON line', () => {
    const r = run(['src/jobs/usageActivityRollup.ts', 'drift']);
    expect(r.stderr).toBe('');
    expect(JSON.parse(r.stdout.trim())).toMatchObject({ total: expect.any(Number), rows: expect.any(Array) });
    expect(r.status).toBe(0);
  });
  it('`drift` started through a SYMLINK prints its JSON line', () => {
    const dir = mkdtempSync(join(tmpdir(), 'rollup4348-'));
    try {
      const link = join(dir, 'rollup.ts');
      symlinkSync(join(ROOT, 'src/jobs/usageActivityRollup.ts'), link);
      const r = run([link, 'drift']);
      expect(JSON.parse(r.stdout.trim())).toMatchObject({ total: expect.any(Number) });
      expect(r.status).toBe(0);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  it('an unknown command exits non-zero with the usage line on stderr', () => {
    const r = run(['src/jobs/usageActivityRollup.ts', 'nope']);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain('usage: tsx src/jobs/usageActivityRollup.ts backfill|drift');
    expect(r.stdout).toBe('');
  });
  it('no command exits non-zero with the usage line on stderr', () => {
    const r = run(['src/jobs/usageActivityRollup.ts']);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain('usage: tsx src/jobs/usageActivityRollup.ts backfill|drift');
  });
});
