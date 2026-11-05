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
