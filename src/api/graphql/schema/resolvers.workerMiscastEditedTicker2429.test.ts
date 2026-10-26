/** #2429 (cor:dmo:050:11): a generated ticker edited after the cast blocks the miscast repair; an ended own subscription does not. */
import pg from 'pg';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { resolvers, type Context } from './resolvers.js';

vi.mock('../../../integrations/github/writeNodeToGit.js', () => ({ writeNodeToGit: vi.fn() }));
vi.mock('../../../integrations/github/syncGraphFromGithub.js', () => ({ syncGraphFromGithub: vi.fn() }));
const M = resolvers.Mutation as any;
let ctx: Context;
let appId: string;
let agentId: string;

beforeEach(async () => {
  await cleanDb(db);
  const org = await db.organization.create({ data: { id: generateId(), name: 'Edited', urn: 'edited2429.com' } });
  const admin = await db.user.create({ data: { id: generateId(), githubId: 242900, githubUsername: 'edited-admin' } });
  await db.orgMember.create({ data: { organizationId: org.id, userId: admin.id, role: 'ADMIN' } });
  ctx = { db, userId: admin.id, roles: ['READER'] };
  agentId = (await M.createAgent({}, { orgId: org.id, name: 'Coordinator role' }, ctx)).id;
  appId = (await db.app.create({ data: { id: generateId(), organizationId: org.id, name: 'Edited team', urn: `${org.urn}:team` } })).id;
  await db.appAgent.create({ data: { appId, agentId } });
  await M.createAgentTickerTemplate({}, { agentRef: agentId, input: { name: 'Base tick', cadenceSeconds: 600 } }, ctx);
});

const castMiscast = async () => {
  const worker = await M.castWorker({}, { appRef: appId, agentRef: agentId, name: 'Miscast' }, ctx);
  const ticker = await db.ticker.findFirstOrThrow({ where: { generatedForWorkerId: worker.id } });
  return { worker, ticker };
};
const repair = (workerId: string) => M.deleteWorker({}, { workerRef: workerId, confirmNoExternalAttribution: true }, ctx);
const refusal = (p: Promise<unknown>) => p.then(() => null, (e) => e?.extensions?.code ?? String(e));
const edit = (tickerId: string, input: Record<string, unknown>) => M.updateTicker({}, { ref: tickerId, input }, ctx);

describe('#2429 edited generated ticker', () => {
  it('a pristine generated ticker has no edit mark and the repair removes it with the worker', async () => {
    const { worker, ticker } = await castMiscast();
    expect(ticker.editedAt).toBeNull();
    expect(await repair(worker.id)).toBe(true);
    expect(await db.worker.findUnique({ where: { id: worker.id } })).toBeNull();
    expect(await db.ticker.count({ where: { id: ticker.id } })).toBe(0);
  });

  it('an edit (a real change) marks the ticker and blocks the repair', async () => {
    const { worker, ticker } = await castMiscast();
    await edit(ticker.id, { cadenceSeconds: 900 });
    expect((await db.ticker.findUniqueOrThrow({ where: { id: ticker.id } })).editedAt).not.toBeNull();
    expect(await refusal(repair(worker.id))).toBe('WORKER_IN_USE');
    expect(await db.worker.findUnique({ where: { id: worker.id } })).not.toBeNull();
    expect(await db.ticker.count({ where: { id: ticker.id } })).toBe(1);
  });

  it('a no-op edit (the values end up unchanged) also marks and blocks', async () => {
    const { worker, ticker } = await castMiscast();
    await edit(ticker.id, { cadenceSeconds: ticker.cadenceSeconds, enabled: ticker.enabled });
    expect((await db.ticker.findUniqueOrThrow({ where: { id: ticker.id } })).editedAt).not.toBeNull();
    expect(await refusal(repair(worker.id))).toBe('WORKER_IN_USE');
  });

  it('an edit of a ticker that is not generated leaves editedAt null', async () => {
    const { worker } = await castMiscast();
    const plain = await M.createTicker({}, { appRef: appId, input: { name: 'Plain', cadenceSeconds: 600 } }, ctx);
    await edit(plain.id, { cadenceSeconds: 900 });
    expect((await db.ticker.findUniqueOrThrow({ where: { id: plain.id } })).editedAt).toBeNull();
    expect(await repair(worker.id)).toBe(true);
  });

  it('an ended own subscription still repairs', async () => {
    const { worker, ticker } = await castMiscast();
    await db.tickerSubscription.updateMany({ where: { tickerId: ticker.id, workerId: worker.id }, data: { endedAt: new Date(), endedReason: 'UNSUBSCRIBED' } });
    expect(await repair(worker.id)).toBe(true);
    expect(await db.worker.findUnique({ where: { id: worker.id } })).toBeNull();
  });

  it('the edit mark does not widen the census: a pristine sibling generated ticker of another worker is unaffected', async () => {
    const { ticker } = await castMiscast();
    const other = await M.castWorker({}, { appRef: appId, agentRef: agentId, name: 'Other' }, ctx);
    await edit(ticker.id, { cadenceSeconds: 900 });
    expect(await repair(other.id)).toBe(true);
  });
});

describe('#2429 migration backfill', () => {
  const MIGRATION = 'prisma/migrations/20261026170000_ticker_edited_at/migration.sql';
  it('marks an old edited generated row and leaves an old untouched one null', async () => {
    const edited = await castMiscast();
    const untouched = await M.castWorker({}, { appRef: appId, agentRef: agentId, name: 'Untouched' }, ctx);
    const untouchedTicker = await db.ticker.findFirstOrThrow({ where: { generatedForWorkerId: untouched.id } });
    await db.$executeRaw`UPDATE tickers SET edited_at = NULL, updated_at = created_at + INTERVAL '2 hours', updated_by = 'someone-else' WHERE id = ${edited.ticker.id}`;
    // A non-edit write to updated_at (same stamp as the cast, however late) must not mark the row.
    const bookkept = await M.castWorker({}, { appRef: appId, agentRef: agentId, name: 'Bookkept' }, ctx);
    const bookkeptTicker = await db.ticker.findFirstOrThrow({ where: { generatedForWorkerId: bookkept.id } });
    await db.$executeRaw`UPDATE tickers SET edited_at = NULL, updated_at = created_at + INTERVAL '2 hours' WHERE id = ${bookkeptTicker.id}`;
    await db.$executeRaw`UPDATE tickers SET edited_at = NULL, updated_at = created_at + INTERVAL '10 seconds' WHERE id = ${untouchedTicker.id}`;
    const { readFileSync } = await import('node:fs');
    const sql = readFileSync(MIGRATION, 'utf8').split('\n').filter((l) => !l.startsWith('--')).join('\n')
      .split(';').map((x) => x.trim()).filter((x) => x.startsWith('UPDATE'));
    expect(sql).toHaveLength(1);
    await db.$executeRawUnsafe(sql[0]);
    expect((await db.ticker.findUniqueOrThrow({ where: { id: edited.ticker.id } })).editedAt).not.toBeNull();
    expect((await db.ticker.findUniqueOrThrow({ where: { id: untouchedTicker.id } })).editedAt).toBeNull();
    expect((await db.ticker.findUniqueOrThrow({ where: { id: bookkeptTicker.id } })).editedAt).toBeNull();
    expect(await refusal(repair(edited.worker.id))).toBe('WORKER_IN_USE');
    expect(await repair(untouched.id)).toBe(true);
    expect(await repair(bookkept.id)).toBe(true);
  });
});

describe('#2429 edit vs repair interleave', () => {
  it('an edit committed after the repair took its snapshot aborts the repair: nothing is deleted, the edit stands', async () => {
    const { worker, ticker } = await castMiscast();
    const holder = new pg.Client({ connectionString: process.env.DATABASE_URL });
    await holder.connect();
    try {
      await holder.query('BEGIN');
      await holder.query('SELECT id FROM tickers WHERE id = $1 FOR UPDATE', [ticker.id]);
      const repairing = refusal(repair(worker.id));
      // The repair has its snapshot (edited_at still NULL) and waits on the ticker row at its delete.
      for (let i = 0; i < 100; i++) {
        const [{ waiting }] = await db.$queryRaw<Array<{ waiting: boolean }>>`
          SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE datname = current_database()
            AND wait_event_type = 'Lock' AND query LIKE '%tickers%') AS waiting`;
        if (waiting) break;
        await new Promise((r) => setTimeout(r, 50));
      }
      await holder.query('UPDATE tickers SET edited_at = now() WHERE id = $1', [ticker.id]);
      await holder.query('COMMIT');
      expect(await repairing).toBe('WORKER_IN_USE');
    } finally {
      await holder.end();
    }
    expect(await db.worker.findUnique({ where: { id: worker.id } })).not.toBeNull();
    expect((await db.ticker.findUniqueOrThrow({ where: { id: ticker.id } })).editedAt).not.toBeNull();
  });
});
