/**
 * #4809 (cor:dmo:050:11): the deleteWorker reference census is bounded, runs once inside the SERIALIZABLE
 * transaction, and an unfinished census FAILS CLOSED with its own code (never admits, never WORKER_IN_USE).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { sessionKeyCache } from '../../../lib/sessionKeyCache.js';
import { WORKER_SIGNATURE_DEFAULTS } from '../../../lib/workerSignature.js';
import pg from 'pg';
import { workerCensusTimeoutMs } from '../../../lib/workerMiscastRepair.js';
import { resolvers, type Context } from './resolvers.js';
vi.mock('../../../integrations/github/writeNodeToGit.js', () => ({ writeNodeToGit: vi.fn().mockResolvedValue(undefined) }));
const M = resolvers.Mutation as any;
const Q = resolvers.Query as any;
let f: any;
const ctx = (): Context => ({ db, userId: f.holder.id, roles: ['READER'] });
const remove = () => M.deleteWorker({}, { workerRef: f.target.id, confirmNoExternalAttribution: true }, ctx());
const preview = () => Q.deleteWorkerPreview({}, { workerRef: f.target.id }, ctx());
async function refusal(p: Promise<unknown>) {
  try { await p; } catch (e: any) { return e; }
  throw new Error('expected a refusal');
}
const snapshot = async () => ({
  worker: await db.worker.findUnique({ where: { id: f.target.id } }),
  sessions: await db.session.count({ where: { workerId: f.target.id } }),
  events: await db.agentTeamEvent.count({ where: { appId: f.app.id } }),
  fences: await db.$queryRaw`SELECT subject_id, version FROM worker_reference_fences ORDER BY subject_id`,
});
const SESSIONS = 60;
const NODES = 40_000;

beforeEach(async () => {
  await cleanDb(db);
  const holder = await db.user.create({ data: { handle: 'census-holder', roles: ['READER'] } });
  const org = await db.organization.create({ data: { name: 'Census', urn: 'census4809.test' } });
  await db.orgMember.create({ data: { organizationId: org.id, userId: holder.id, role: 'ADMIN' } });
  const app = await db.app.create({ data: { organizationId: org.id, name: 'Team', urn: 'census4809.test:team' } });
  f = { holder, org, app };
  const agent = await M.createAgent({}, { orgRef: org.id, name: 'Role', personaRole: 'server-engineer' }, ctx());
  await db.appAgent.create({ data: { appId: app.id, agentId: agent.id } });
  const caller = await db.worker.create({ data: { ...WORKER_SIGNATURE_DEFAULTS, appId: app.id, agentId: agent.id, name: 'Caller', slug: 'caller', heldByUserId: holder.id } });
  const target = await M.castWorker({}, { appRef: app.id, agentRef: agent.id, name: 'Miscast' }, ctx());
  const memory = await db.memory.create({ data: { class: 'knowledge', appId: app.id, organizationId: org.id, name: 'Other', urn: 'census4809.test:other' } });
  f = { ...f, agent, caller, target, memory };
});
afterEach(() => { sessionKeyCache.clear(); delete process.env.WORKER_CENSUS_TIMEOUT_MS; });

/** Many ended, empty bindings (each adds an identity to the JSON scans) and many nodes carrying JSON. */
async function seedLargeApp() {
  await db.$executeRaw`INSERT INTO sessions (id, app_id, agent_id, worker_id, user_id, tool, started_at, ended_at, updated_at)
    SELECT 'cs4809-' || i, ${f.app.id}, ${f.agent.id}, ${f.target.id}, ${f.holder.id}, 'vitest', now(), now(), now() FROM generate_series(1, ${SESSIONS}) i`;
  await db.$executeRaw`INSERT INTO nodes (id, memory_id, loc, name, node_type, data, properties, created_at, updated_at)
    SELECT 'cn4809-' || i, ${f.memory.id}, 'bulk:n' || lpad(i::text, 6, '0'), 'bulk', 'info',
      jsonb_build_object('a', repeat('x', 40), 'b', jsonb_build_array(1, 2, 3, jsonb_build_object('c', 'y', 'd', jsonb_build_array('p', 'q', 'r'))), 'e', jsonb_build_object('f', 'z', 'g', jsonb_build_array('s', 't'))),
      jsonb_build_object('k', 'v', 'l', jsonb_build_array('m', 'n', 'o')), now(), now()
    FROM generate_series(1, ${NODES}) i`;
}

describe('#4809 bounded worker census', () => {
  it('deleteWorker on a large App completes (main: P2028 at the 5s default transaction timeout)', async () => {
    await seedLargeApp();
    expect(await remove()).toBe(true);
    expect(await db.worker.findUnique({ where: { id: f.target.id } })).toBeNull();
  }, 120_000);

  it('deleteWorkerPreview on a large App answers like the delete', async () => {
    await seedLargeApp();
    expect(await preview()).toEqual({ workerId: f.target.id, attestationRequired: true });
  }, 120_000);

  it.each([['deleteWorker', remove], ['deleteWorkerPreview', preview]] as const)(
    '%s: an exceeded bound refuses WORKER_CENSUS_INCOMPLETE, not WORKER_IN_USE, and changes nothing',
    async (_name, call) => {
      await seedLargeApp();
      process.env.WORKER_CENSUS_TIMEOUT_MS = '1';
      const before = await snapshot();
      const e = await refusal(call());
      expect(e.extensions?.code).toBe('WORKER_CENSUS_INCOMPLETE');
      expect(e.extensions?.workerId).toBe(f.target.id);
      expect(await snapshot()).toEqual(before);
    }, 120_000);

  it('an invalid bound value falls back to the default instead of disabling it', async () => {
    for (const bad of ['0', '-5', '1.5', 'abc', '']) {
      process.env.WORKER_CENSUS_TIMEOUT_MS = bad;
      expect(await remove().then(() => 'deleted', (e: any) => e.extensions?.code)).toBe('deleted');
      await recastTarget();
    }
  });

  it('workerCensusTimeoutMs: only a positive integer counts', () => {
    expect(workerCensusTimeoutMs({ WORKER_CENSUS_TIMEOUT_MS: '250' } as any)).toBe(250);
    for (const bad of ['0', '-5', '1.5', 'abc', '', undefined]) expect(workerCensusTimeoutMs({ WORKER_CENSUS_TIMEOUT_MS: bad } as any)).toBe(20_000);
  });

  // BLIND P2-3 (#4820): the 1 ms case trips the JS deadline whether or not Postgres cancels anything. Here the JS deadline has
  // NOT passed: a lock held on one census table by another connection makes a SINGLE statement overrun, so only the transaction-local
  // statement_timeout can end it, near the budget and far from the door's transaction backstop (budget + 20 s).
  it.each([['deleteWorker', remove], ['deleteWorkerPreview', preview]] as const)(
    '%s: ONE blocked statement is cancelled by Postgres near the budget, WORKER_CENSUS_INCOMPLETE, nothing changed', async (_n, call) => {
      process.env.WORKER_CENSUS_TIMEOUT_MS = '1500';
      const holder = new pg.Client({ connectionString: process.env.DATABASE_URL });
      await holder.connect();
      try {
        await holder.query('BEGIN');
        await holder.query('LOCK TABLE comment_meta IN ACCESS EXCLUSIVE MODE');
        const before = await snapshot();
        const started = Date.now();
        const e = await refusal(call());
        const elapsed = Date.now() - started;
        expect(e.extensions?.code).toBe('WORKER_CENSUS_INCOMPLETE');
        expect(elapsed).toBeLessThan(10_000); // the transaction backstop is 21.5 s
        expect(await snapshot()).toEqual(before);
      } finally { await holder.query('ROLLBACK').catch(() => {}); await holder.end(); }
    }, 60_000);

  it('the worker id itself anywhere in a JSON column refuses WORKER_IN_USE', async () => {
    await db.node.create({ data: { id: 'refw4809', memoryId: f.memory.id, loc: 'ref:w', name: 'ref', data: { who: [f.target.id] } } });
    expect((await refusal(remove())).extensions?.code).toBe('WORKER_IN_USE');
  });

  it('every identity is counted: a session id anywhere in a JSON column still refuses WORKER_IN_USE', async () => {
    await db.$executeRaw`INSERT INTO sessions (id, app_id, agent_id, worker_id, user_id, tool, started_at, ended_at, updated_at)
      SELECT 'cs4809-' || i, ${f.app.id}, ${f.agent.id}, ${f.target.id}, ${f.holder.id}, 'vitest', now(), now(), now() FROM generate_series(1, 5) i`;
    await db.node.create({ data: { id: 'ref4809', memoryId: f.memory.id, loc: 'ref:one', name: 'ref', data: { deep: [{ x: ['cs4809-4'] }] } } });
    const e = await refusal(remove());
    expect(e.extensions?.code).toBe('WORKER_IN_USE');
    expect((await refusal(preview())).extensions?.code).toBe('WORKER_IN_USE');
  });
});

async function recastTarget() {
  const target = await M.castWorker({}, { appRef: f.app.id, agentRef: f.agent.id, name: `Miscast${generateId().slice(-4)}` }, ctx());
  f = { ...f, target };
}
