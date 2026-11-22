/**
 * #4845 (cor:dmo:050:11, "an unfinished census refuses and never admits"): pins for the mutants of #4809 that survived its
 * reviews. Unit pins drive `miscastHasReferences` with a recording fake db (every census statement is armed with what is
 * left of the one budget; a P2028 and a statement timeout are both an unfinished census; the timeout classifier is
 * anchored); integration pins make a MODEL query the cancelled statement and pin the self-bookkeeping exemption under the
 * one-pass JSON scan.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import pg from 'pg';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { sessionKeyCache } from '../../../lib/sessionKeyCache.js';
import { WORKER_SIGNATURE_DEFAULTS } from '../../../lib/workerSignature.js';
import { Prisma } from '../../../generated/prisma/index.js';
import { miscastHasReferences, WorkerCensusIncompleteError } from '../../../lib/workerMiscastRepair.js';
import { resolvers, type Context } from './resolvers.js';
vi.mock('../../../integrations/github/writeNodeToGit.js', () => ({ writeNodeToGit: vi.fn().mockResolvedValue(undefined) }));
const M = resolvers.Mutation as any;
const Q = resolvers.Query as any;

// ---- unit: a recording fake db --------------------------------------------------------------------------------------------
type Ev = 'setting' | 'arm' | 'restore' | 'stmt';
const endedSession = (id: string) => ({ id, endedAt: new Date(), prNumber: null, summary: null, plan: null, outcome: null, outcomeRef: null,
  outcomeMeta: null, inputTokens: null, outputTokens: null, turnCount: null, errorCount: null, launchOperationId: null });
function fakeDb(opts: { sessions?: number; throwOn?: (n: number) => unknown } = {}) {
  const events: Ev[] = [];
  let stmts = 0;
  const stmt = (): void => { stmts += 1; events.push('stmt'); const e = opts.throwOn?.(stmts); if (e) throw e; };
  const sessions = Array.from({ length: opts.sessions ?? 1 }, (_, i) => endedSession(`s${i}`));
  const raw = async (q: unknown, ...values: unknown[]): Promise<unknown[]> => {
    const text = Array.isArray(q) ? (q as string[]).join('?') : (q as { sql?: string; strings?: string[] }).sql ?? (q as { strings?: string[] }).strings?.join('?') ?? '';
    if (/current_setting/.test(text)) { events.push('setting'); return [{ previous: '0' }]; }
    if (/set_config/.test(text)) { events.push(values[0] === '0' ? 'restore' : 'arm'); return []; }
    stmt();
    if (/created_at AS "createdAt" FROM workers/.test(text)) return [{ createdAt: new Date() }];
    if (/FROM nodes\s+WHERE data \? '__enc'/.test(text)) return [];
    if (/SELECT t\.id FROM tickers/.test(text)) return [];
    return [{ present: false }];
  };
  const model = { count: async () => { stmt(); return 0; }, findMany: async () => { stmt(); return sessions; } };
  const db = { $queryRaw: raw, session: model, node: model, asset: model } as any;
  return { db, events };
}
const worker = { id: 'w-4845', memoryId: 'm-4845', heldByUserId: null };

describe('#4845 miscastHasReferences, driven with a recording db', () => {
  it('every census statement is armed with the remaining budget right before it runs (JSON-column statements included)', async () => {
    const { db: fake, events } = fakeDb({ sessions: 2 });
    expect(await miscastHasReferences(fake, worker)).toBe(false);
    expect(events[0]).toBe('setting');
    expect(events.at(-1)).toBe('restore');
    const body = events.slice(1, -1);
    expect(body.filter((e) => e === 'stmt').length).toBeGreaterThan(20); // the inventory, the JSON columns, the tail
    body.forEach((e, i) => { if (e === 'stmt') expect(body[i - 1], `statement #${i} runs unarmed`).toBe('arm'); });
  });

  it('a P2028 raised by any census statement is an unfinished census, never an admit and never a bare error', async () => {
    const p2028 = new Prisma.PrismaClientKnownRequestError('Transaction already closed', { code: 'P2028', clientVersion: 'test' });
    for (const n of [1, 5, 30]) {
      const { db: fake } = fakeDb({ throwOn: (k) => (k === n ? p2028 : undefined) });
      await expect(miscastHasReferences(fake, worker), `statement ${n}`).rejects.toBeInstanceOf(WorkerCensusIncompleteError);
    }
  });

  it('only a real statement timeout is an unfinished census: SQLSTATE 57014 or its message, anchored', async () => {
    const cases: Array<[unknown, boolean]> = [
      [Object.assign(new Error('raw query failed'), { meta: { code: '57014' } }), true],
      [new Error('ERROR: canceling statement due to statement timeout'), true],
      [new Error('Raw query failed. Code: `57014`. Message: `canceling statement`'), true],
      [new Error('connection 157014 reset'), false], // the number inside a longer one is not the SQLSTATE
      [new Error('a statement timeout setting was read'), false], // not the cancellation text
      [new Error('boom'), false],
    ];
    for (const [err, mapped] of cases) {
      const { db: fake } = fakeDb({ throwOn: (k) => (k === 3 ? err : undefined) });
      const outcome = await miscastHasReferences(fake, worker).then(() => 'resolved', (e) => e);
      if (mapped) expect(outcome, String((err as Error).message)).toBeInstanceOf(WorkerCensusIncompleteError);
      else expect(outcome, String((err as Error).message)).toBe(err);
    }
  });
});

// ---- integration ----------------------------------------------------------------------------------------------------------
let f: any;
const ctx = (): Context => ({ db, userId: f.holder.id, roles: ['READER'] });
const remove = () => M.deleteWorker({}, { workerRef: f.target.id, confirmNoExternalAttribution: true }, ctx());
const preview = () => Q.deleteWorkerPreview({}, { workerRef: f.target.id }, ctx());
async function refusal(p: Promise<unknown>) {
  try { await p; } catch (e: any) { return e; }
  throw new Error('expected a refusal');
}
beforeEach(async () => {
  await cleanDb(db);
  const holder = await db.user.create({ data: { handle: 'pins4845-holder', roles: ['READER'] } });
  const org = await db.organization.create({ data: { name: 'Pins', urn: 'pins4845.test' } });
  await db.orgMember.create({ data: { organizationId: org.id, userId: holder.id, role: 'ADMIN' } });
  const app = await db.app.create({ data: { organizationId: org.id, name: 'Team', urn: 'pins4845.test:team' } });
  f = { holder, org, app };
  const agent = await M.createAgent({}, { orgRef: org.id, name: 'Role', personaRole: 'server-engineer' }, ctx());
  await db.appAgent.create({ data: { appId: app.id, agentId: agent.id } });
  const caller = await db.worker.create({ data: { ...WORKER_SIGNATURE_DEFAULTS, appId: app.id, agentId: agent.id, name: 'Caller', slug: 'caller', heldByUserId: holder.id } });
  const target = await M.castWorker({}, { appRef: app.id, agentRef: agent.id, name: 'Miscast' }, ctx());
  f = { ...f, agent, caller, target };
});
afterEach(() => { sessionKeyCache.clear(); delete process.env.WORKER_CENSUS_TIMEOUT_MS; });

describe('#4845 a MODEL query is the cancelled statement', () => {
  // Locking `assets` makes the census tail's `asset.count` (a model query, not a raw one) the one statement that overruns.
  // `sessions` is deliberately NOT locked: `session.findMany` would be cancelled instead and prove a different path.
  it.each([['deleteWorker', remove], ['deleteWorkerPreview', preview]] as const)(
    '%s: Postgres cancels asset.count near the budget, WORKER_CENSUS_INCOMPLETE', async (_n, call) => {
      expect((await db.worker.findUnique({ where: { id: f.target.id } }))?.memoryId).toBeTruthy(); // the tail reaches asset.count
      process.env.WORKER_CENSUS_TIMEOUT_MS = '1500';
      const holder = new pg.Client({ connectionString: process.env.DATABASE_URL });
      await holder.connect();
      try {
        await holder.query('BEGIN');
        await holder.query('LOCK TABLE assets IN ACCESS EXCLUSIVE MODE');
        const started = Date.now();
        const e = await refusal(call());
        const elapsed = Date.now() - started;
        expect(e.extensions?.code).toBe('WORKER_CENSUS_INCOMPLETE');
        expect(elapsed).toBeGreaterThanOrEqual(1000); // the bound ended it, not an immediate error
        expect(elapsed).toBeLessThan(10_000);
        expect(await db.worker.findUnique({ where: { id: f.target.id } })).not.toBeNull();
      } finally { await holder.query('ROLLBACK').catch(() => {}); await holder.end(); }
    }, 60_000);
});

describe('#4845 the agent_team_events self-bookkeeping exemption under the one-pass JSON scan', () => {
  const event = (data: Record<string, unknown>) => db.agentTeamEvent.create({ data: { appId: f.app.id, type: 'worker.cast', payload: { workerId: f.target.id }, ...data } as any });

  it('an event that is the worker\'s OWN bookkeeping and names it in its payload does not count', async () => {
    await event({ subjectWorkerId: f.target.id });
    const rows = await db.$queryRaw<Array<{ n: bigint }>>`SELECT count(*) AS n FROM agent_team_events WHERE payload @> ${JSON.stringify({ workerId: f.target.id })}::jsonb`;
    expect(Number(rows[0].n)).toBeGreaterThan(0); // the row is there for the JSON pass to find
    expect(await preview()).toEqual({ workerId: f.target.id, attestationRequired: true });
    expect(await remove()).toBe(true);
  });

  it.each([
    ['another event type', () => ({ type: 'task.created' })],
    ['a cast event whose subject is another worker', () => ({ subjectWorkerId: f.caller.id })],
  ])('%s that names the worker in its payload still refuses WORKER_IN_USE', async (_n, data) => {
    await event(data());
    expect((await refusal(preview())).extensions?.code).toBe('WORKER_IN_USE');
    expect((await refusal(remove())).extensions?.code).toBe('WORKER_IN_USE');
  });
});
