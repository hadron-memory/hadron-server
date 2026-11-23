/** #3571: the operator tool around reconcileSyncingStatus: usage, a missing URL, and counts-only output. */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../../src/integrations/db/client.js';
import { cleanDb } from '../../src/test/helpers.js';
import { main } from './reconcile-syncing-status.js';

// #4731: a controllable PrismaClient for the tool's own client only (the shared `db` is built before any flag is set).
const faults = vi.hoisted(() => ({ construct: false, disconnect: false, transaction: false }));
vi.mock('../../src/generated/prisma/index.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../src/generated/prisma/index.js')>();
  class FaultyPrismaClient extends real.PrismaClient {
    constructor(...args: ConstructorParameters<typeof real.PrismaClient>) {
      if (faults.construct) throw new Error('constructor failed for host 10.1.2.3:5432');
      super(...args);
    }
    override async $disconnect(): Promise<void> {
      if (faults.disconnect) throw new Error('disconnect failed for host 10.1.2.3:5432');
      return super.$disconnect();
    }
    // @ts-expect-error - a test double for one failing row transaction
    override $transaction(...args: unknown[]): Promise<unknown> {
      if (faults.transaction) return Promise.reject(Object.assign(new Error('row failed for host 10.1.2.3:5432'), { code: '57014' }));
      return (super.$transaction as (...a: unknown[]) => Promise<unknown>)(...args);
    }
  }
  return { ...real, PrismaClient: FaultyPrismaClient };
});

const run = async (argv: string[], env: NodeJS.ProcessEnv = process.env) => {
  const lines: string[] = [];
  const code = await main(argv, { env, log: (l) => lines.push(l) });
  return { code, lines };
};

beforeEach(async () => {
  faults.construct = false; faults.disconnect = false; faults.transaction = false;
  await cleanDb(db);
});

describe('#3571 scripts/db/reconcile-syncing-status.ts', () => {
  it('refuses unknown arguments and a missing DATABASE_URL with exit 2', async () => {
    expect(await run(['--force'])).toEqual({ code: 2, lines: ['db.syncing_status_reconcile.usage: [--apply]'] });
    expect(await run(['--apply', 'x'])).toMatchObject({ code: 2 });
    expect(await run([], {})).toEqual({ code: 2, lines: ['db.syncing_status_reconcile.database_url_missing'] });
  });

  it('a failure exits 1 and names its class, never its message or the URL (#4719 BLIND P2-1)', async () => {
    // Nothing listens on port 1: the connect fails before any query, and nothing is written.
    const url = 'postgresql://nobody:secret-password@127.0.0.1:1/nowhere';
    const out = await run([], { DATABASE_URL: url });
    expect(out.code).toBe(1);
    expect(out.lines).toHaveLength(1);
    expect(out.lines[0]).toMatch(/^db\.syncing_status_reconcile\.failed error=\w+( code=\w+)?$/);
    expect(out.lines[0]).not.toContain('secret-password');
    expect(out.lines[0]).not.toContain('127.0.0.1');
  }, 30_000);

  it('dry run and apply print counts only, never an id', async () => {
    const org = await db.organization.create({ data: { name: 'rs-tool', urn: 'rs-tool.test' } });
    const m = await db.memory.create({ data: { organizationId: org.id, class: 'knowledge', name: 'tool', urn: 'rs-tool.test:tool',
      source: 'https://github.com/x/y', syncStatus: 'SYNCING' } });
    const dry = await run([]);
    expect(dry).toEqual({ code: 0, lines: ['db.syncing_status_reconcile dry_run candidates=1 uncovered=0 (pass --apply to reconcile)'] });
    const applied = await run(['--apply']);
    expect(applied).toEqual({ code: 0, lines: ['db.syncing_status_reconcile ok candidates=1 reconciled=1 held=0 ineligible=0 uncovered=0 failed=0'] });
    expect(applied.lines.join(' ')).not.toContain(m.id);
    expect((await db.memory.findUniqueOrThrow({ where: { id: m.id } })).syncStatus).toBe('PENDING');
  });

  it('a PrismaClient that cannot be constructed exits 1 with a class-only line, never the message (#4731)', async () => {
    faults.construct = true;
    const out = await run([], { DATABASE_URL: process.env.DATABASE_URL });
    expect(out.code).toBe(1);
    expect(out.lines).toEqual(['db.syncing_status_reconcile.failed error=Error']);
    expect(out.lines.join(' ')).not.toContain('10.1.2.3');
  });

  it('a disconnect that rejects never replaces the result: an applied run still exits 0 with its counts (#4731)', async () => {
    const org = await db.organization.create({ data: { name: 'rs-disc', urn: 'rs-disc.test' } });
    await db.memory.create({ data: { organizationId: org.id, class: 'knowledge', name: 'disc', urn: 'rs-disc.test:disc', source: 'https://github.com/x/y', syncStatus: 'SYNCING' } });
    faults.disconnect = true;
    const out = await run(['--apply']);
    expect(out.code).toBe(0);
    expect(out.lines).toEqual(['db.syncing_status_reconcile ok candidates=1 reconciled=1 held=0 ineligible=0 uncovered=0 failed=0']);
  });

  it('a row that fails is counted, the line says incomplete, and the exit is 1 (re-run is safe) (#4731)', async () => {
    const org = await db.organization.create({ data: { name: 'rs-fail', urn: 'rs-fail.test' } });
    const m = await db.memory.create({ data: { organizationId: org.id, class: 'knowledge', name: 'fail', urn: 'rs-fail.test:fail', source: 'https://github.com/x/y', syncStatus: 'SYNCING' } });
    faults.transaction = true;
    const out = await run(['--apply']);
    expect(out.code).toBe(1);
    expect(out.lines).toEqual(['db.syncing_status_reconcile incomplete candidates=1 reconciled=0 held=0 ineligible=0 uncovered=0 failed=1']);
    expect(out.lines.join(' ')).not.toContain('10.1.2.3');
    expect((await db.memory.findUniqueOrThrow({ where: { id: m.id } })).syncStatus).toBe('SYNCING'); // left exactly as it was
  });
});
