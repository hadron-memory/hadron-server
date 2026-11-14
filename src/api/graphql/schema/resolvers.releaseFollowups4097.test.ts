/**
 * #4097 — the follow-ups the #4089/#4100/#4109 seats deferred (hrn:node:hadronmemory.com:specs:cor:agt:120:02; release
 * authority Proposed as V87). Four parts:
 *  1. The id tiebreaker of the release boundary: rows of ONE transaction tie on (tx_id, created_at) — `now()` is fixed
 *     per transaction — so the event id decides there. The id generator does not order within a millisecond
 *     (findings:uuidv7-same-millisecond-order), and that is lawful: the serving ORDER BY and the release classification
 *     share the (tx_id, created_at, id) key, so whatever the id tail does, no change carrying an id follows that id's
 *     RELEASED change in the served order. Distinct transactions have distinct xid8s (database-assigned, monotonic —
 *     what lockTask's FOR UPDATE serializes), so outside one transaction the id never decides. No door writes a
 *     change-kind event and the release for one task in one transaction (the release door writes only the release), so
 *     these pins force the tie with explicit inserts, as the append-only trigger's INSERT arm allows.
 *  2. Two concurrent releases of one task: the loser answers TASK_EXTERNAL_ID_NONE, one event is written. Rides
 *     Proposed V87 (a task with no id refuses, changing nothing; a release records one event naming the id) — a
 *     reversal changes this pin, not the mechanism.
 *  3. The batch read `agentTasks(externalIds:)` windows on an explicit offset like any list (cor:api:120:04;
 *     cor:api:040:02: windowing the caller asked for is not truncation).
 *  4. N14: the changes read joins events to tasks App-tight. An event naming another App's task (task_id has no FK,
 *     so a forced or legacy row can do it) must not enter this App's feed — before the fix such a row survived the
 *     join, emitted the foreign task's external id, and hydrated to an undefined task mid-page; and a foreign RELEASED
 *     event naming this App's task must not move this App's release boundary off the foreign payload's id.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Prisma } from '../../../generated/prisma/index.js';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { resolvers, type Context } from './resolvers.js';

vi.mock('../../../integrations/github/writeNodeToGit.js', () => ({ writeNodeToGit: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../../../lib/bus/index.js', () => ({ getBusClient: vi.fn(async () => null) }));

const R = resolvers as any;
const M = R.Mutation;
const Q = R.Query;
let org: any, app: any, other: any, owner: any;
const ctx = (): Context => ({ db, userId: owner.id, roles: ['READER'] }) as Context;
const code = (value: string) => ({ extensions: { code: value } });

const X = 'https://github.com/hadron-memory/hadron-server/issues/1999';
const Y = 'https://github.com/hadron-memory/hadron-server/issues/2000';
const Z = 'https://github.com/hadron-memory/hadron-server/issues/2001';

const create = (input: Record<string, unknown>, appRef: string = app.id) =>
  M.createAgentTask({}, { input: { appRef, title: 'T', ...input } }, ctx());
const list = (args: Record<string, unknown>, appRef: string = app.id) =>
  Q.agentTasks(null, { appRef, ...args }, ctx());
const release = (taskId: string) => M.releaseAgentTaskExternalId({}, { taskId }, ctx());
const stored = (id: string) => db.agentTask.findUniqueOrThrow({ where: { id } });
const releaseEvents = (taskId: string) => db.agentTeamEvent.findMany({ where: { taskId, type: 'task.external-id-released' } });

/**
 * Wait until every transaction that began before this call has ended: take a fresh transaction id, then poll until the
 * snapshot's xmin is past it. The changed-since read serves a change only once its transaction, and every older one,
 * is final; xmin is cluster-wide, so another vitest worker's open transaction on its own clone can hold it back briefly.
 */
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

/** Two 32-hex ids sharing one millisecond prefix whose order is CHOSEN, not minted (findings:uuidv7-same-millisecond-order). */
function tieIds(): { low: string; high: string } {
  const ms = Date.now().toString(16).padStart(12, '0');
  return { low: `${ms}${'0'.repeat(16)}0001`, high: `${ms}${'0'.repeat(16)}0002` };
}

/**
 * An event row with an explicit id, stamped `now()` — fixed within a transaction, so two inserts in one $transaction
 * tie on created_at exactly as door-written rows do. `txId` forces a key (the append-only trigger's INSERT arm leaves
 * tx_id to the writer; nothing but the default fills it).
 */
const insertEvent = (id: string, type: string, taskId: string, payload: unknown, appId: string = app.id, txId?: string) =>
  db.$executeRaw`
    INSERT INTO agent_team_events (id, app_id, type, task_id, payload, created_at, tx_id)
    VALUES (${id}, ${appId}, ${type}, ${taskId}, ${JSON.stringify(payload)}::jsonb,
            now() AT TIME ZONE 'UTC', ${txId != null ? Prisma.sql`${txId}::xid8` : Prisma.sql`DEFAULT`})`;

/** The two rows' stamps, to assert the tie the scenario claims. */
const stamps = (ids: string[]) => db.$queryRaw<{ tx_id: string; created_at: Date }[]>`
  SELECT tx_id::text AS tx_id, created_at FROM agent_team_events WHERE id IN (${Prisma.join(ids)})`;

beforeEach(async () => {
  await cleanDb(db);
  org = await db.organization.create({ data: { name: 'Followups', urn: `followups4097-${generateId()}.test` } });
  owner = await db.user.create({ data: { handle: 'followups4097-owner' } });
  app = await db.app.create({ data: { organizationId: org.id, name: 'Followups', urn: `${org.urn}:followups` } });
  other = await db.app.create({ data: { organizationId: org.id, name: 'Other', urn: `${org.urn}:other4097` } });
  await db.appMember.create({ data: { appId: app.id, userId: owner.id, role: 'member' } });
  await db.appMember.create({ data: { appId: other.id, userId: owner.id, role: 'member' } });
});

// settle() may wait up to 10s for another transaction on the cluster to end, so the tests here get room for it.
describe('#4097 (1): the id tiebreaker decides only within one transaction (Axel\'s deferred #4109 cases)', { timeout: 15_000 }, () => {
  it('equal tx_id and equal created_at: a change whose id sorts before the release\'s id carries the released id', async () => {
    const t = await create({ externalId: X });
    const { low, high } = tieIds();
    await db.$transaction([
      db.$executeRaw`UPDATE agent_tasks SET external_id = NULL WHERE id = ${t.id}`,
      insertEvent(low, 'task.assigned', t.id, { type: 'task.assigned' }),
      insertEvent(high, 'task.external-id-released', t.id, { type: 'task.external-id-released', externalId: X }),
    ]);
    // The scenario itself: one transaction, one stamp.
    const rows = await stamps([low, high]);
    expect(new Set(rows.map((r) => r.tx_id)).size).toBe(1);
    expect(rows[0]!.created_at.getTime()).toBe(rows[1]!.created_at.getTime());
    const page = await changes();
    expect(served(page)).toEqual([['ASSIGNED', X], ['RELEASED', X]]);
  });

  it('equal tx_id and equal created_at: a change whose id sorts after the release\'s id is after the release, so it is left out', async () => {
    const t = await create({ externalId: X });
    const { low, high } = tieIds();
    await db.$transaction([
      db.$executeRaw`UPDATE agent_tasks SET external_id = NULL WHERE id = ${t.id}`,
      insertEvent(low, 'task.external-id-released', t.id, { type: 'task.external-id-released', externalId: X }),
      insertEvent(high, 'task.assigned', t.id, { type: 'task.assigned' }),
    ]);
    const rows = await stamps([low, high]);
    expect(new Set(rows.map((r) => r.tx_id)).size).toBe(1);
    expect(rows[0]!.created_at.getTime()).toBe(rows[1]!.created_at.getTime());
    const page = await changes();
    // Nothing carrying X follows X's RELEASED in the served order; the tied change after it carries no id at all.
    expect(served(page)).toEqual([['RELEASED', X]]);
  });

  it('legacy rows (tx_id 0): a change and the release both on 0 are judged by (created_at, id) the same way', async () => {
    const t = await create({ externalId: X });
    const { low, high } = tieIds();
    await db.$transaction([
      db.$executeRaw`UPDATE agent_tasks SET external_id = NULL WHERE id = ${t.id}`,
      insertEvent(low, 'task.external-id-released', t.id, { type: 'task.external-id-released', externalId: X }, app.id, '0'),
      insertEvent(high, 'task.assigned', t.id, { type: 'task.assigned' }, app.id, '0'),
    ]);
    const rows = await stamps([low, high]);
    expect(rows.map((r) => r.tx_id)).toEqual(['0', '0']);
    const page = await changes();
    expect(served(page)).toEqual([['RELEASED', X]]);
  });
});

describe('#4097 (2): two concurrent releases of one task (rides Proposed V87)', () => {
  it('exactly one wins; the loser refuses TASK_EXTERNAL_ID_NONE with nothing written; one event, no id left', async () => {
    const t = await create({ externalId: X });
    // Two calls in flight at once: both pass the unlocked pre-reads, both enter their transaction, and lockTask's
    // SELECT ... FOR UPDATE serializes them on the task row. The loser's re-read (a fresh statement under READ
    // COMMITTED) sees the winner's committed clear and refuses before writing anything.
    const results = await Promise.allSettled([release(t.id), release(t.id)]);
    const codes = results.map((r) => (r.status === 'fulfilled' ? 'ok' : r.reason?.extensions?.code));
    expect(codes.filter((c) => c === 'ok')).toHaveLength(1);
    expect(codes.filter((c) => c === 'TASK_EXTERNAL_ID_NONE')).toHaveLength(1);
    expect((await stored(t.id)).externalId).toBeNull();
    const events = await releaseEvents(t.id);
    expect(events).toHaveLength(1);
    expect(events[0]!.payload).toEqual({ externalId: X });
  });
});

describe('#4097 (3): the batch read windows on an explicit offset like any list (cor:api:120:04, cor:api:040:02)', () => {
  it('offset omitted answers every id; an explicit offset windows the batch (windowing, not truncation)', async () => {
    await create({ externalId: X });
    await create({ externalId: Y });
    await create({ externalId: Z });
    const every = await list({ externalIds: [X, Y, Z] });
    expect(every).toHaveLength(3);
    // The list orders (createdAt desc, id desc); the window is cut in that same order, whatever it is.
    expect(await list({ externalIds: [X, Y, Z], offset: 1 })).toEqual(every.slice(1));
    expect(await list({ externalIds: [X, Y, Z], offset: 0 })).toEqual(every);
  });
});

// settle() again: the changes read serves only committed-below-xmin rows.
describe('#4097 (4): the changes read joins events to tasks App-tight (N14)', { timeout: 15_000 }, () => {
  it('an event naming another App\'s task never enters this App\'s feed and never breaks the page', async () => {
    const mine = await create({ externalId: X });
    const foreign = await create({ externalId: Y }, other.id); // another App's task, holding Y
    // A forced row (task_id carries no FK): this App's event naming the foreign task.
    await insertEvent(generateId(), 'task.assigned', foreign.id, { type: 'task.assigned' });
    const page = await changes();
    // Before the fix the row survived the join on t.id alone, emitted the foreign task's Y, and hydrated to an
    // undefined task (the hydration filters appId), surfacing a broken change mid-page.
    expect(page.changes.map((ch: any) => ch.task != null)).not.toContain(false);
    expect(served(page)).not.toContain(['ASSIGNED', Y]);
    expect(served(page)).toEqual([]);
    expect((await stored(mine.id)).externalId).toBe(X);
  });

  it('a foreign RELEASED event naming this App\'s task never moves this App\'s release boundary', async () => {
    const t = await create({ externalId: X });
    await release(t.id); // this App's own release, on a real transaction id
    // A change of THIS App and a foreign RELEASED row (another App's id in its payload) naming the same task, both on
    // forced legacy keys below the real release. The LATERAL picks the release with the LOWEST (tx_id, created_at, id)
    // and before the fix had no app predicate, so the foreign row won: the change — sorted before it — emitted the
    // FOREIGN payload's id into this App's feed, and the real release itself sorted after it and was dropped.
    const { low, high } = tieIds();
    await db.$transaction([
      insertEvent(low, 'task.assigned', t.id, { type: 'task.assigned' }, app.id, '0'),
      insertEvent(high, 'task.external-id-released', t.id, { type: 'task.external-id-released', externalId: Y }, other.id, '0'),
    ]);
    const page = await changes();
    expect(served(page)).toEqual([['ASSIGNED', X], ['RELEASED', X]]);
    expect(JSON.stringify(served(page))).not.toContain(Y);
  });
});
