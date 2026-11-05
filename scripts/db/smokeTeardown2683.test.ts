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
