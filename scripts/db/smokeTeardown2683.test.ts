import { expect, it } from 'vitest';
import { timedCleanupStep } from './smokeTeardown.js';

it('logs the exact owned resources and active step before waiting, then elapsed time', async () => {
  const lines: string[] = [];
  let now = 10;
  let release!: () => void;
  const wait = new Promise<void>((resolve) => { release = resolve; });
  const step = timedCleanupStep('drop-database', { database: 'smk_db_test', roles: ['smk_owner_test', 'smk_serve_test'] },
    () => wait, (line) => lines.push(line), () => now);
  expect(lines.map((line) => JSON.parse(line))).toEqual([{ event: 'serve-role-smoke.cleanup', step: 'drop-database', state: 'started', database: 'smk_db_test', roles: ['smk_owner_test', 'smk_serve_test'] }]);
  now = 125;
  release();
  await step;
  expect(JSON.parse(lines[1])).toMatchObject({ step: 'drop-database', state: 'finished', elapsedMs: 115 });
});

it('records failure timing without swallowing or logging the error payload', async () => {
  const lines: string[] = [];
  const error = new Error('secret connection string');
  await expect(timedCleanupStep('connect', { database: 'owned', roles: ['owner', 'serve'] },
    async () => { throw error; }, (line) => lines.push(line))).rejects.toBe(error);
  expect(lines).toHaveLength(2);
  expect(JSON.parse(lines[1])).toMatchObject({ step: 'connect', state: 'failed' });
  expect(lines.join('')).not.toContain(error.message);
});

it('drops exactly this invocation’s database and two roles, never enumerating or dropping prefix siblings', async () => {
  const { cleanupOwnedSmokeFixture } = await import('./smokeTeardown.js');
  const calls: string[] = [];
  const client = {
    connect: async () => { calls.push('connect'); },
    query: async (sql: string) => { calls.push(sql); },
    end: async () => { calls.push('close'); },
  };
  const lines: string[] = [];
  await cleanupOwnedSmokeFixture(client, {
    database: 'smk_db_thisrun', roles: ['smk_owner_thisrun', 'smk_serve_thisrun'],
  }, (line) => lines.push(line));
  expect(calls).toEqual([
    'connect', 'DROP DATABASE IF EXISTS "smk_db_thisrun" WITH (FORCE)',
    'DROP ROLE IF EXISTS "smk_owner_thisrun"', 'DROP ROLE IF EXISTS "smk_serve_thisrun"', 'close',
  ]);
  expect(lines.map((line) => JSON.parse(line).step)).toEqual([
    'connect', 'connect', 'drop-database', 'drop-database', 'drop-owner-role', 'drop-owner-role',
    'drop-serve-role', 'drop-serve-role', 'close', 'close',
  ]);
});

it('closes the connected client when an owned drop fails and preserves that error', async () => {
  const { cleanupOwnedSmokeFixture } = await import('./smokeTeardown.js');
  const error = new Error('drop blocked');
  const calls: string[] = [];
  await expect(cleanupOwnedSmokeFixture({
    connect: async () => { calls.push('connect'); },
    query: async (sql: string) => { calls.push(sql); throw error; },
    end: async () => { calls.push('close'); },
  }, { database: 'owned', roles: ['owner', 'serve'] }, () => {})).rejects.toBe(error);
  expect(calls).toEqual(['connect', 'DROP DATABASE IF EXISTS "owned" WITH (FORCE)', 'close']);
});

// #3877: the 30s recurrence logged `drop-database started` and nothing after, with no wait event captured.
// While the owned DROP is still pending past slowAfterMs, a snapshot from a SECOND connection is logged so the
// next recurrence names what the backend waited on. The 30s hook budget is not touched by any of this.
const OWNED = { database: 'smk_db_slow', roles: ['smk_owner_slow', 'smk_serve_slow'] } as const;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function hangingClient(release: Promise<void>) {
  return {
    connect: async () => {},
    query: async (sql: string) => { if (sql.startsWith('DROP DATABASE')) await release; },
    end: async () => {},
  };
}

it('#3877: snapshots a still-pending drop-database once, after slowAfterMs, and logs it as one line', async () => {
  const { cleanupOwnedSmokeFixture } = await import('./smokeTeardown.js');
  let release!: () => void;
  const wait = new Promise<void>((r) => { release = r; });
  const lines: string[] = [];
  let snapshots = 0;
  const done = cleanupOwnedSmokeFixture(hangingClient(wait), OWNED, (l) => lines.push(l), {
    slowAfterMs: 20,
    snapshot: async () => { snapshots += 1; return { dropper: { wait_event: 'CheckpointDone' } }; },
  });
  await sleep(80);
  expect(snapshots).toBe(1);
  const slow = lines.map((l) => JSON.parse(l)).filter((l) => l.event === 'serve-role-smoke.cleanup.slow');
  expect(slow).toHaveLength(1);
  expect(slow[0]).toMatchObject({ step: 'drop-database', database: 'smk_db_slow', snapshot: { dropper: { wait_event: 'CheckpointDone' } } });
  release();
  await done;
  expect(snapshots).toBe(1);
});

it('#3877: a drop that finishes inside slowAfterMs takes no snapshot', async () => {
  const { cleanupOwnedSmokeFixture } = await import('./smokeTeardown.js');
  let snapshots = 0;
  await cleanupOwnedSmokeFixture(hangingClient(Promise.resolve()), OWNED, () => {}, {
    slowAfterMs: 50,
    snapshot: async () => { snapshots += 1; return {}; },
  });
  await sleep(100);
  expect(snapshots).toBe(0);
});

it('#3877: a failing or hanging snapshot never fails the cleanup and is reported as an error line', async () => {
  const { cleanupOwnedSmokeFixture } = await import('./smokeTeardown.js');
  let release!: () => void;
  const wait = new Promise<void>((r) => { release = r; });
  const lines: string[] = [];
  const done = cleanupOwnedSmokeFixture(hangingClient(wait), OWNED, (l) => lines.push(l), {
    slowAfterMs: 10,
    snapshot: async () => { throw new Error('probe connect refused'); },
  });
  await sleep(60);
  release();
  await expect(done).resolves.toBeUndefined();
  const slow = lines.map((l) => JSON.parse(l)).find((l) => l.event === 'serve-role-smoke.cleanup.slow');
  expect(slow).toMatchObject({ step: 'drop-database', snapshotError: 'probe connect refused' });
});
