/** #3571: the operator tool around reconcileSyncingStatus: usage, a missing URL, and counts-only output. */
import { beforeEach, describe, expect, it } from 'vitest';
import { db } from '../../src/integrations/db/client.js';
import { cleanDb } from '../../src/test/helpers.js';
import { main } from './reconcile-syncing-status.js';

const run = async (argv: string[], env: NodeJS.ProcessEnv = process.env) => {
  const lines: string[] = [];
  const code = await main(argv, { env, log: (l) => lines.push(l) });
  return { code, lines };
};

beforeEach(async () => {
  await cleanDb(db);
});

describe('#3571 scripts/db/reconcile-syncing-status.ts', () => {
  it('refuses unknown arguments and a missing DATABASE_URL with exit 2', async () => {
    expect(await run(['--force'])).toEqual({ code: 2, lines: ['db.syncing_status_reconcile.usage: [--apply]'] });
    expect(await run(['--apply', 'x'])).toMatchObject({ code: 2 });
    expect(await run([], {})).toEqual({ code: 2, lines: ['db.syncing_status_reconcile.database_url_missing'] });
  });

  it('dry run and apply print counts only, never an id', async () => {
    const org = await db.organization.create({ data: { name: 'rs-tool', urn: 'rs-tool.test' } });
    const m = await db.memory.create({ data: { organizationId: org.id, class: 'knowledge', name: 'tool', urn: 'rs-tool.test:tool',
      source: 'https://github.com/x/y', syncStatus: 'SYNCING' } });
    const dry = await run([]);
    expect(dry).toEqual({ code: 0, lines: ['db.syncing_status_reconcile dry_run candidates=1 uncovered=0 (pass --apply to reconcile)'] });
    const applied = await run(['--apply']);
    expect(applied).toEqual({ code: 0, lines: ['db.syncing_status_reconcile ok candidates=1 reconciled=1 held=0 ineligible=0 uncovered=0'] });
    expect(applied.lines.join(' ')).not.toContain(m.id);
    expect((await db.memory.findUniqueOrThrow({ where: { id: m.id } })).syncStatus).toBe('PENDING');
  });
});
