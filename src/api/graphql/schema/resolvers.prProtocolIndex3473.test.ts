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
import { cleanDb } from '../../../test/helpers.js';
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
    const without = await db.$transaction(async tx => {
      await tx.$executeRawUnsafe(`DROP INDEX ${INDEX}`);
      return [await freezers(tx, appA, H), await freezers(tx, appA, H2), await freezers(tx, appB, H)];
    });
    expect(withIndex).toEqual(without);
    expect(withIndex).toEqual([expected, ['-/u2'], ['-/u4']]);
  });

  it('the migration rebuilds the very index post-push builds, and is idempotent on a populated table', async () => {
    await event(appA, 'pr.frozen', { head: H }, { actorUserId: 'u1' });
    const [before, afterDrop, again] = await db.$transaction(async tx => {
      const built = await indexDef(tx);
      await tx.$executeRawUnsafe(`DROP INDEX ${INDEX}`);
      await tx.$executeRawUnsafe(migrationSql());
      const rebuilt = await indexDef(tx);
      await tx.$executeRawUnsafe(migrationSql());
      return [built, rebuilt, await indexDef(tx)];
    });
    expect(before).not.toBeNull();
    expect(afterDrop).toBe(before);
    expect(again).toBe(before);
  });
});
