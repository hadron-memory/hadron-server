/**
 * #3473: the same-App `pr.frozen` head lookup must have its own bounded index. Before it, the freezer query
 * (resolvers.prProtocol.ts freezersAtHeadSql) could use only `(type)` or `(app_id, created_at)` and read every
 * event of the type or the App; a profile at 1.6M rows took a parallel seq scan, 17k buffers, ~124 ms.
 * The readiness negative-verdict lookups already reach their rows through `(task_id, type)` and are NOT indexed here.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it } from 'vitest';
import { db } from '../../../integrations/db/client.js';
import { Prisma } from '../../../generated/prisma/index.js';
import { cleanDb, createDbWorkerAttribution } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { freezersAtHeadSql } from './resolvers.prProtocol.js';

const INDEX = 'agent_team_events_pr_frozen_head_idx';
const migrationSql = () => readFileSync(fileURLToPath(new URL('../../../../prisma/migrations/20261105010000_pr_frozen_head_index/migration.sql', import.meta.url)), 'utf8');
const H = 'a'.repeat(40), H2 = 'b'.repeat(40);
let appA: string, appB: string;
const indexDef = async (tx: Prisma.TransactionClient) =>
  (await tx.$queryRaw<{ d: string }[]>`SELECT indexdef AS d FROM pg_indexes WHERE indexname = ${INDEX}`)[0]?.d ?? null;
async function event(appId: string, type: string, payload: object, actor: { actorWorkerId?: string; actorUserId?: string } = {}) {
  return db.agentTeamEvent.create({ data: { appId, type, payload, ...actor } });
}
/** DDL is transactional: run `work`, hand back its result, and roll everything back so no test leaves the index dropped. */
async function rolledBack<T>(work: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
  const out: { value?: T } = {};
  await db.$transaction(async tx => { out.value = await work(tx); throw new Error('rollback'); }).catch(e => { if ((e as Error).message !== 'rollback') throw e; });
  return out.value as T;
}
async function freezers(tx: Prisma.TransactionClient, appId: string, head: string) {
  const rows = await tx.$queryRaw<{ workerId: string | null; userId: string | null }[]>(freezersAtHeadSql(appId, head));
  return rows.map(r => `${r.workerId ?? '-'}/${r.userId ?? '-'}`).sort();
}

beforeEach(async () => {
  await cleanDb(db);
  const org = await db.organization.create({ data: { name: 'Index', urn: `index-${generateId()}.test` } });
  [appA, appB] = (await Promise.all(['a', 'b'].map(n => db.app.create({ data: { organizationId: org.id, name: n, urn: `${org.urn}:${n}` } })))).map(a => a.id);
});

describe('#3473 pr.frozen head index', () => {
  it('the freezer query is served by the dedicated partial expression index', async () => {
    await event(appA, 'pr.frozen', { head: H });
    const plan = await db.$transaction(async tx => {
      // Small tables prefer a seq scan whatever is indexed; this asks which INDEX the planner reaches for.
      await tx.$executeRaw`SET LOCAL enable_seqscan = off`;
      const rows = await tx.$queryRaw<{ 'QUERY PLAN': unknown }[]>(Prisma.sql`EXPLAIN (FORMAT JSON) ${freezersAtHeadSql(appA, H)}`);
      return JSON.stringify(rows);
    });
    expect(plan).toContain(INDEX);
    // Not merely a scan of that index: the Index Cond must constrain both the App and the head expression.
    const cond = [...plan.matchAll(/"Index Cond":"([^"]*)"/g)].map(m => m[1]).join(' ');
    expect(cond).toMatch(/app_id/);
    expect(cond).toMatch(/payload/);
  });

  it('is a partial index on pr.frozen rows only, keyed by App and head', async () => {
    const def = await db.$transaction(indexDef);
    expect(def).not.toBeNull();
    expect(def).toMatch(/\(app_id, \(\(payload ->> 'head'::text\)\)\)/);
    expect(def).toMatch(/WHERE \(type = 'pr\.frozen'::text\)/);
  });

  it('the index changes no answer: same freezers with and without it, across Apps, heads and actor kinds', async () => {
    await event(appA, 'pr.frozen', { head: H }, { actorUserId: 'u1' });
    await event(appA, 'pr.frozen', { head: H }, { actorUserId: 'u1' });
    await event(appA, 'pr.frozen', { head: H2 }, { actorUserId: 'u2' });
    await event(appA, 'review.verdict', { head: H, verdict: 'APPROVE' }, { actorUserId: 'u3' });
    await event(appB, 'pr.frozen', { head: H }, { actorUserId: 'u4' });
    await event(appA, 'pr.frozen', {}, { actorUserId: 'u5' });
    const expected = ['-/u1'];
    const withIndex = await db.$transaction(async tx => [await freezers(tx, appA, H), await freezers(tx, appA, H2), await freezers(tx, appB, H)]);
    const without = await rolledBack(async tx => {
      await tx.$executeRawUnsafe(`DROP INDEX ${INDEX}`);
      return [await freezers(tx, appA, H), await freezers(tx, appA, H2), await freezers(tx, appB, H)];
    });
    expect(withIndex).toEqual(without);
    expect(withIndex).toEqual([expected, ['-/u2'], ['-/u4']]);
  });

  it('answers the same for worker actors: worker ids returned, duplicates collapse, the user id is suppressed', async () => {
    const user = await db.user.create({ data: { email: `w-${generateId()}@index.test` } });
    const workerId = generateId();
    await createDbWorkerAttribution(db, user.id, workerId);
    const w = await db.worker.findUniqueOrThrow({ where: { id: workerId } });
    await event(w.appId, 'pr.frozen', { head: H }, { actorWorkerId: workerId, actorUserId: user.id });
    await event(w.appId, 'pr.frozen', { head: H }, { actorWorkerId: workerId, actorUserId: user.id });
    const withIndex = await db.$transaction(tx => freezers(tx, w.appId, H));
    const without = await rolledBack(async tx => { await tx.$executeRawUnsafe(`DROP INDEX ${INDEX}`); return freezers(tx, w.appId, H); });
    expect(withIndex).toEqual([`${workerId}/-`]);
    expect(without).toEqual(withIndex);
  });

  it('the migration is ONE CONCURRENTLY statement that rebuilds the very index post-push builds, idempotently, outside a transaction', async () => {
    const sql = migrationSql();
    expect(sql).toMatch(/CREATE INDEX CONCURRENTLY IF NOT EXISTS "agent_team_events_pr_frozen_head_idx"/);
    // One statement: prisma migrate deploy runs a single statement outside a transaction (CONCURRENTLY needs that).
    expect(sql.replace(/--.*$/gm, '').split(';').filter(x => x.trim()).length).toBe(1);
    await event(appA, 'pr.frozen', { head: H }, { actorUserId: 'u1' });
    const before = await db.$transaction(indexDef);
    expect(before).not.toBeNull();
    // Autocommit, as migrate deploy runs it. The per-worker clone is this file's alone and the index is rebuilt below.
    await db.$executeRawUnsafe(`DROP INDEX ${INDEX}`);
    try {
      await db.$executeRawUnsafe(sql);
      expect(await db.$transaction(indexDef)).toBe(before);
      await db.$executeRawUnsafe(sql);
      expect(await db.$transaction(indexDef)).toBe(before);
      const [valid] = await db.$queryRaw<{ v: boolean }[]>`SELECT indisvalid AS v FROM pg_index WHERE indexrelid = ${INDEX}::regclass`;
      expect(valid.v).toBe(true);
    } finally {
      await db.$executeRawUnsafe(`CREATE INDEX IF NOT EXISTS ${INDEX} ON agent_team_events (app_id, ((payload ->> 'head'))) WHERE type = 'pr.frozen'`);
    }
  });
});
