/**
 * #4107 (hrn:node:hadronmemory.com:specs:cor:agt:120, the bullet "The changed-since read never skips a change",
 * Proposed): agentTaskExternalIdChanges decides whether a change carries a released id in the read's OWN order,
 * `(tx_id, created_at, id)`, the key it serves and pages by. Before the fix it judged the release boundary on
 * `(created_at, id)`, a writer-stamped time, so the two orders could disagree: a change written after the release with
 * an older stamp kept the released id and was served AFTER the RELEASED change (Belinda's blind N1 on #4100), and a
 * change written before the release with a newer stamp lost the id although it was served before it.
 *
 * The rule each test holds: in the served order, no change carrying an external id follows that id's RELEASED change,
 * and every change served before it carries the id.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Client } from 'pg';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { resolvers, type Context } from './resolvers.js';

vi.mock('../../../integrations/github/writeNodeToGit.js', () => ({ writeNodeToGit: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../../../lib/bus/index.js', () => ({ getBusClient: vi.fn(async () => null) }));

const R = resolvers as any;
const M = R.Mutation;
const Q = R.Query;
let app: any, owner: any;
const ctx = (): Context => ({ db, userId: owner.id, roles: ['READER'] }) as Context;
const X = 'https://github.com/hadron-memory/hadron-server/issues/1999';

/** Wait until every transaction that began before this call has ended (see the #4084 tests: xmin is cluster-wide). */
async function settle(): Promise<void> {
  const [{ x }] = await db.$queryRaw<{ x: string }[]>`SELECT pg_current_xact_id()::text AS x`;
  for (let i = 0; i < 200; i++) {
    const [{ done }] = await db.$queryRaw<{ done: boolean }[]>`
      SELECT pg_snapshot_xmin(pg_current_snapshot()) > ${x}::xid8 AS done`;
    if (done) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error('settle: an older transaction stayed open for 10s');
}
const changes = async (args: Record<string, unknown> = {}) => {
  await settle();
  return Q.agentTaskExternalIdChanges(null, { appRef: app.id, ...args }, ctx());
};
const served = (page: any) => page.changes.map((ch: any) => [ch.kind, ch.externalId]);
const create = () => M.createAgentTask({}, { input: { appRef: app.id, title: 'T', externalId: X } }, ctx());
const release = (taskId: string) => M.releaseAgentTaskExternalId({}, { taskId }, ctx());
/** An assignment event on the task, stamped `offset` from the database clock (appendTaskEvent's createdAt allows it). */
const stampedAssignment = (taskId: string, offset: string) => db.$executeRaw`
  INSERT INTO agent_team_events (id, app_id, type, task_id, payload, created_at)
  VALUES (${generateId()}, ${app.id}, 'task.assigned', ${taskId}, '{"type":"task.assigned"}'::jsonb,
          (clock_timestamp() AT TIME ZONE 'UTC') + ${offset}::interval)`;

/** The rule, on any served sequence: nothing carrying X after X's RELEASED. */
function expectNothingAfterRelease(rows: [string, string][]) {
  const at = rows.findIndex(([kind]) => kind === 'RELEASED');
  expect(at).toBeGreaterThanOrEqual(0);
  expect(rows.slice(at + 1).filter(([, id]) => id === X)).toEqual([]);
}

beforeEach(async () => {
  await cleanDb(db);
  const org = await db.organization.create({ data: { name: 'Boundary', urn: `boundary4107-${generateId()}.test` } });
  owner = await db.user.create({ data: { handle: 'boundary4107-owner' } });
  app = await db.app.create({ data: { organizationId: org.id, name: 'Boundary', urn: `${org.urn}:boundary` } });
  await db.appMember.create({ data: { appId: app.id, userId: owner.id, role: 'member' } });
});

describe('#4107: the release boundary is judged on the serving key (tx_id, created_at, id)', { timeout: 15_000 }, () => {
  it('a change written after the release with an older stamp carries no id, so nothing with X follows RELEASED (N1)', async () => {
    const t = await create();
    await release(t.id);
    await stampedAssignment(t.id, '-1 hour');
    const rows = served(await changes());
    expectNothingAfterRelease(rows);
    expect(rows).toEqual([['RELEASED', X]]);
  });

  it('a change written before the release with a newer stamp still carries X and is served before RELEASED', async () => {
    const t = await create();
    await stampedAssignment(t.id, '1 hour');
    await release(t.id);
    const rows = served(await changes());
    expect(rows).toEqual([['ASSIGNED', X], ['RELEASED', X]]);
  });

  it('the cursor taken at RELEASED is the end of X: a later backdated change never appears after it', async () => {
    const t = await create();
    await release(t.id);
    const first = await changes();
    expect(served(first)).toEqual([['RELEASED', X]]);
    await stampedAssignment(t.id, '-1 hour');
    expect(served(await changes({ after: first.changes[0].cursor }))).toEqual([]);
  });

  it('a change sharing the release\'s tx_id (same transaction, or a legacy 0) is judged by (created_at, id) next', async () => {
    const t = await create();
    // One transaction writes the release and then a change stamped after it: equal tx_id, so the stamp decides,
    // exactly as it decides the served order.
    await db.$transaction([
      db.$executeRaw`UPDATE agent_tasks SET external_id = NULL WHERE id = ${t.id}`,
      db.$executeRaw`
        INSERT INTO agent_team_events (id, app_id, type, task_id, payload, created_at)
        VALUES (${generateId()}, ${app.id}, 'task.external-id-released', ${t.id},
                ${JSON.stringify({ type: 'task.external-id-released', externalId: X })}::jsonb, clock_timestamp() AT TIME ZONE 'UTC')`,
      stampedAssignment(t.id, '1 hour'),
    ]);
    const [{ n }] = await db.$queryRaw<{ n: number }[]>`
      SELECT count(DISTINCT tx_id)::int AS n FROM agent_team_events WHERE task_id = ${t.id} AND type IN ('task.external-id-released', 'task.assigned')`;
    expect(n).toBe(1);
    const rows = served(await changes());
    expectNothingAfterRelease(rows);
    expect(rows).toEqual([['RELEASED', X]]);
  });

  it('a transaction that began before the release but writes after it sorts after it (tx_id is taken at the first write)', async () => {
    const t = await create();
    const pg = new Client({ connectionString: process.env.DATABASE_URL });
    await pg.connect();
    let late: string;
    try {
      await pg.query('BEGIN');
      // A read takes no transaction id: the hypothesis the gate asked the pin to confirm.
      const before = await pg.query('SELECT pg_current_xact_id_if_assigned()::text AS x');
      expect(before.rows[0].x).toBeNull();
      await release(t.id);
      await pg.query(
        `INSERT INTO agent_team_events (id, app_id, type, task_id, payload, created_at)
         VALUES ($1, $2, 'task.assigned', $3, '{"type":"task.assigned"}', (clock_timestamp() AT TIME ZONE 'UTC') - interval '1 hour')`,
        [generateId(), app.id, t.id]);
      late = (await pg.query('SELECT pg_current_xact_id()::text AS x')).rows[0].x;
      await pg.query('COMMIT');
    } finally {
      await pg.end();
    }
    const [{ rel }] = await db.$queryRaw<{ rel: string }[]>`
      SELECT tx_id::text AS rel FROM agent_team_events WHERE task_id = ${t.id} AND type = 'task.external-id-released'`;
    expect(BigInt(late!)).toBeGreaterThan(BigInt(rel));
    const rows = served(await changes());
    expectNothingAfterRelease(rows);
    expect(rows).toEqual([['RELEASED', X]]);
  });
});
