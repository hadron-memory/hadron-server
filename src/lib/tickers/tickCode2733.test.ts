import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { db } from '../../integrations/db/client.js';
import { tickerSlugBase } from './tickerSlug.js';
import { TASK_WARNING_CODES } from '../../api/graphql/schema/resolvers.taskWarnings.js';
import * as teamEvents from '../agentTasks/events.js';

const migration = readFileSync(new URL('../../../prisma/migrations/20261030021000_ticker_tick_code/migration.sql', import.meta.url), 'utf8');
const statements = migration.replace(/--[^\n]*/g, '').split(';').map(s => s.trim()).filter(Boolean);

it('backfills all four legacy shapes and exactly matches JS slug derivation, independent of database locale', async () => {
  const names = ['Flow Lab', 'Acme', '  Multiple   Spaces  ', 'Juno Knowledge', 'under_score-and-dash', 'v1.2.3', 'Trailing punctuation!!!', '--leading-dashes', 'MiXeD CaSe 123', 'System', 'a'.repeat(100), 'x'.repeat(63) + '---tail', '', '   ', '!!!', '---', '...', '\t\nName\r', 'İX', 'Kelvin', 'éX', 'İ'.repeat(40)];
  await db.$transaction(async tx => {
    // Session-local tables shadow the real ones: the actual migration runs without changing the checkout's schema.
    await tx.$executeRawUnsafe('CREATE TEMP TABLE tickers (id text, slug text, source_template_id text) ON COMMIT DROP');
    await tx.$executeRawUnsafe('CREATE TEMP TABLE agent_ticker_templates (id text, name text, deleted_at timestamp) ON COMMIT DROP');
    await tx.$executeRaw`INSERT INTO tickers VALUES ('hand', 'permanent-2', NULL), ('gone', 'orphan', 'gone'), ('deleted', 'copy-deleted', 'deleted')`;
    await tx.$executeRaw`INSERT INTO agent_ticker_templates VALUES ('deleted', 'Removed Template', now())`;
    for (const [i, name] of names.entries()) {
      const id = 'n' + i;
      await tx.$executeRaw`INSERT INTO agent_ticker_templates VALUES (${id}, ${name}, NULL)`;
      await tx.$executeRaw`INSERT INTO tickers VALUES (${id}, 'generated-copy', ${id})`;
    }
    for (const sql of statements) await tx.$executeRawUnsafe(sql);
    const rows = await tx.$queryRaw<Array<{ id: string; tick_code: string }>>`SELECT id, tick_code FROM tickers`;
    const codes = new Map(rows.map(r => [r.id, r.tick_code]));
    expect(codes.get('hand')).toBe('tick.permanent-2');
    expect(codes.get('gone')).toBe('tick.orphan');
    expect(codes.get('deleted')).toBe('tick.removed-template');
    names.forEach((name, i) => expect(codes.get('n' + i), JSON.stringify(name)).toBe('tick.' + tickerSlugBase(name)));
    const constraints = await tx.$queryRaw<Array<{ conname: string }>>`SELECT conname FROM pg_constraint WHERE conrelid = 'pg_temp.tickers'::regclass`;
    expect(constraints.some(c => c.conname === 'tickers_tick_code_shape')).toBe(true);
  });
});

it('reserves tick. outside the warning code list and mirrors the CHECK in post-push and the test harness', () => {
  expect(TASK_WARNING_CODES.some(c => c.startsWith('tick.'))).toBe(false);
  const eventTypes = Object.entries(teamEvents).filter(([key, value]) => key.endsWith('_EVENT_TYPES') && Array.isArray(value)).flatMap(([, value]) => value as readonly string[]);
  expect(eventTypes.some(c => c.startsWith('tick.'))).toBe(false);
  expect(TASK_WARNING_CODES.at(-1)).toBe('ticker.code.unmapped');
  const source = readFileSync(new URL('../../../prisma/ticker-tick-code-invariants.sql', import.meta.url), 'utf8');
  const check = "CHECK (tick_code LIKE 'tick.%' AND length(tick_code) > 5)";
  expect(source).toContain(check);
  expect(migration).toContain(check);
  expect(readFileSync(new URL('../../../prisma/post-push.sql', import.meta.url), 'utf8')).toContain('\\ir ticker-tick-code-invariants.sql');
  expect(readFileSync(new URL('../../test/globalSetup.ts', import.meta.url), 'utf8')).toContain('ticker-tick-code-invariants.sql');
});

it('backfills existing push-managed databases idempotently without changing an already stored code', async () => {
  const prePush = readFileSync(new URL('../../../prisma/ticker-tick-code-pre-push.sql', import.meta.url), 'utf8');
  expect(readFileSync(new URL('../../../prisma/pre-push.sql', import.meta.url), 'utf8')).toContain('\\ir ticker-tick-code-pre-push.sql');
  await db.$transaction(async tx => {
    await tx.$executeRawUnsafe('CREATE TEMP TABLE tickers (id text, slug text, source_template_id text) ON COMMIT DROP');
    await tx.$executeRawUnsafe('CREATE TEMP TABLE agent_ticker_templates (id text, name text, deleted_at timestamp) ON COMMIT DROP');
    await tx.$executeRaw`INSERT INTO tickers VALUES ('hand', 'original', NULL), ('generated', 'copy', 'template'), ('deleted', 'copy2', 'deleted'), ('gone', 'orphan', 'missing')`;
    await tx.$executeRaw`INSERT INTO agent_ticker_templates VALUES ('template', 'İX', NULL), ('deleted', 'Removed!', now())`;
    await tx.$executeRawUnsafe(prePush);
    const rows = () => tx.$queryRaw<Array<{ id: string; tick_code: string }>>`SELECT id, tick_code FROM tickers ORDER BY id`;
    expect(await rows()).toEqual([{ id: 'deleted', tick_code: 'tick.removed' }, { id: 'generated', tick_code: 'tick.i-x' }, { id: 'gone', tick_code: 'tick.orphan' }, { id: 'hand', tick_code: 'tick.original' }]);
    await tx.$executeRaw`UPDATE tickers SET slug = 'renamed' WHERE id = 'hand'`;
    await tx.$executeRaw`UPDATE agent_ticker_templates SET name = 'New name'`;
    await tx.$executeRawUnsafe(prePush);
    expect((await rows()).find(r => r.id === 'hand')?.tick_code).toBe('tick.original');
    expect((await rows()).find(r => r.id === 'generated')?.tick_code).toBe('tick.i-x');
  });
});
