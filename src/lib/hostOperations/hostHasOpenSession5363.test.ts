/**
 * #5363: `hostHasOpenSession` ran under the App's EXCLUSIVE anchor and judged every open worker session of the App one by one (each hand-started
 * session a registration-join query). It now asks for the candidates that could match, still judged by `sessionRunsOn` (gate decision Q4, the
 * one predicate). A differential pin: the old full scan, kept here as the oracle, and the new path agree on every case below; plus the cost
 * claim (the number of queries no longer grows with the App's unrelated open sessions) and a `force` control.
 *
 * Why the filter is a SUPERSET (blind F1): `sessionRunsOn` returns `session.launchHostId === hostId` for a host-launched session and reads NO
 * registration for it (agentlessEnd.ts, its first line), so a session launched elsewhere can never match, whatever is registered where; and a
 * hand-started one matches only when the worker's sole LIVE registration is this host, so the worker has a registration here with
 * `lost_at IS NULL` (live = not lost AND within the lapse window; a stale one stays a candidate and the predicate applies the window). The cases
 * below include the host-launched sessions whose registrations point the other way.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Prisma } from '../../generated/prisma/index.js';
import { db } from '../../integrations/db/client.js';
import { cleanDb } from '../../test/helpers.js';
import { generateId } from '../id.js';
import { WORKER_SIGNATURE_DEFAULTS } from '../workerSignature.js';
import { hostHasOpenSession } from './teamHosts.js';
import { sessionRunsOn } from './agentlessEnd.js';

// The judge is counted, not replaced: `sessionRunsOn` still decides (Q4); how often it is asked is the cost under the anchor.
vi.mock('./agentlessEnd.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('./agentlessEnd.js')>();
  return { ...real, sessionRunsOn: vi.fn(real.sessionRunsOn) };
});

vi.mock('../../integrations/github/writeNodeToGit.js', () => ({ writeNodeToGit: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../bus/index.js', () => ({ getBusClient: vi.fn(async () => null) }));

const HOST = 'mac1', OTHER = 'mac2';
const CHECK_INS = 2, POLL = 60;
let appId: string, agentId: string, holderId: string;

/** The pre-#5363 path, kept verbatim as the oracle: every open worker session of the App, one `sessionRunsOn` each. */
async function oracle(tx: Prisma.TransactionClient, at: { appId: string; hostId: string; now: Date; checkIns: number }): Promise<boolean> {
  const open = await tx.session.findMany({
    where: { appId: at.appId, workerId: { not: null }, endedAt: null, deletedAt: null },
    select: { workerId: true, launchHostId: true }, orderBy: { id: 'asc' },
  });
  for (const s of open) {
    if (await sessionRunsOn(tx, { appId: at.appId, workerId: s.workerId!, hostId: at.hostId, now: at.now, checkIns: at.checkIns }, s)) return true;
  }
  return false;
}
const now = () => new Date();
async function both(hostId = HOST): Promise<{ old: boolean; fresh: boolean }> {
  return db.$transaction(async (tx) => {
    const at = { appId, hostId, now: now(), checkIns: CHECK_INS };
    return { old: await oracle(tx, at), fresh: await hostHasOpenSession(tx, at) };
  });
}

let n = 0;
async function worker(): Promise<string> {
  n += 1;
  return (await db.worker.create({ data: { ...WORKER_SIGNATURE_DEFAULTS, appId, agentId, name: `W${n}`, slug: `w${n}`, heldByUserId: holderId, heldAt: new Date() }, select: { id: true } })).id;
}
/** A registration of `hostId` listing `workerIds`; fresh by default, `ageSeconds` old, or lost. */
async function register(hostId: string, workerIds: string[], over: { ageSeconds?: number; lost?: boolean } = {}) {
  // One registration per (App, host): later calls list more workers on it (its freshness is set by the first).
  const existing = await db.hostRegistration.findUnique({ where: { appId_hostId: { appId, hostId } } });
  if (existing && (over.ageSeconds !== undefined || over.lost)) throw new Error('register(): ageSeconds / lost apply only to the first call for a host');
  const reg = existing ?? await db.hostRegistration.create({ data: {
    appId, hostId, label: hostId, pollIntervalSeconds: POLL,
    refreshedAt: new Date(Date.now() - (over.ageSeconds ?? 0) * 1000), ...(over.lost ? { lostAt: new Date() } : {}),
  } });
  for (const workerId of workerIds) await db.hostRegistrationWorker.create({ data: { registrationId: reg.id, workerId, family: 'claude' } });
}
async function handStarted(workerId: string | null, over: Record<string, unknown> = {}) {
  return db.session.create({ data: { id: generateId(), appId, agentId, workerId, userId: holderId, tool: 'vitest', ...over } });
}
async function launched(workerId: string, hostId: string, over: Record<string, unknown> = {}) {
  const op = await db.hostOperation.create({ data: {
    id: generateId(), appId, hostId, type: 'worker.start', args: { workerId, worktree: 'w', family: 'claude' }, workerId,
    issuedBy: 'platform', holdUserId: holderId, holdAt: new Date(), status: 'succeeded', finishedAt: new Date(),
  } });
  return db.session.create({ data: { id: generateId(), appId, agentId, workerId, userId: holderId, tool: 'vitest',
    launchHostId: hostId, launchOperationId: op.id, launchIssuedBy: 'platform', ...over } });
}

beforeEach(async () => {
  await cleanDb(db);
  n = 0;
  const org = await db.organization.create({ data: { name: 'Open', urn: `open5363-${Math.floor(Math.random() * 1e6)}.example` } });
  holderId = (await db.user.create({ data: { email: `${generateId()}@s7.test` } })).id;
  agentId = (await db.agent.create({ data: { organizationId: org.id, name: 'A', urn: `${org.urn}:agent` } })).id;
  appId = (await db.app.create({ data: { organizationId: org.id, name: 'App', urn: `${org.urn}:app` } })).id;
});

describe('#5363 the old full scan and the narrowed path agree (differential)', () => {
  const cases: Array<[string, boolean, () => Promise<void>]> = [
    ['a host-launched session on THIS host', true, async () => { const w = await worker(); await launched(w, HOST); }],
    ['a host-launched session on ANOTHER host', false, async () => { const w = await worker(); await launched(w, OTHER); }],
    ['a hand-started session whose worker has a SOLE live registration on this host', true, async () => { const w = await worker(); await register(HOST, [w]); await handStarted(w); }],
    ['a hand-started session whose worker has a sole live registration on ANOTHER host', false, async () => { const w = await worker(); await register(OTHER, [w]); await handStarted(w); }],
    ['a hand-started session whose worker has live registrations on this host AND another (not sole)', false, async () => { const w = await worker(); await register(HOST, [w]); await register(OTHER, [w]); await handStarted(w); }],
    ['a hand-started session whose worker has NO registration', false, async () => { const w = await worker(); await handStarted(w); }],
    ['a hand-started session whose worker\'s registration on this host is STALE (outside the lapse window)', false, async () => {
      const w = await worker(); await register(HOST, [w], { ageSeconds: POLL * CHECK_INS * 10 }); await handStarted(w); }],
    ['a hand-started session whose worker\'s registration on this host is LOST', false, async () => { const w = await worker(); await register(HOST, [w], { lost: true }); await handStarted(w); }],
    ['a stale registration on this host plus a live sole one on another host: the other host runs it, this one does not', false, async () => {
      const w = await worker(); await register(HOST, [w], { ageSeconds: POLL * CHECK_INS * 10 }); await register(OTHER, [w]); await handStarted(w); }],
    ['an ENDED session that would match', false, async () => { const w = await worker(); await launched(w, HOST, { endedAt: new Date() }); }],
    ['a DELETED session that would match', false, async () => { const w = await worker(); await register(HOST, [w]); await handStarted(w, { deletedAt: new Date() }); }],
    ['a WORKERLESS session', false, async () => { await handStarted(null); }],
    ['one matching hand-started session among unrelated ones', true, async () => {
      const a = await worker(), b = await worker(), c = await worker();
      await register(OTHER, [a]); await handStarted(a); await handStarted(b); await launched(c, OTHER);
      const d = await worker(); await register(HOST, [d]); await handStarted(d); }],
    ['a session launched ELSEWHERE whose worker is registered ONLY HERE (the registration is not read for a host-launched session)', false, async () => {
      const w = await worker(); await register(HOST, [w]); await launched(w, OTHER); }],
    ['a session launched HERE whose worker is registered only ELSEWHERE', true, async () => {
      const w = await worker(); await register(OTHER, [w]); await launched(w, HOST); }],
    ['a session launched HERE whose registration here is LOST and whose worker is live sole on another host', true, async () => {
      const w = await worker(); await register(HOST, [w], { lost: true }); await register(OTHER, [w]); await launched(w, HOST); }],
    ['a session launched ELSEWHERE whose registration here is LOST and whose worker is live sole on that other host', false, async () => {
      const w = await worker(); await register(HOST, [w], { lost: true }); await register(OTHER, [w]); await launched(w, OTHER); }],
    ['two candidate workers here: the first is not sole (registered elsewhere too), the second is sole here', true, async () => {
      const a = await worker(), b = await worker();
      await register(HOST, [a, b]); await register(OTHER, [a]); await handStarted(a); await handStarted(b); }],
    ['no sessions at all', false, async () => {}],
  ];
  for (const [name, expected, build] of cases) {
    it(`${name}: ${expected}`, async () => {
      await build();
      const out = await both();
      expect(out.old, 'the oracle').toBe(expected);
      expect(out.fresh, 'the narrowed path').toBe(expected);
    });
  }

  it('another App\'s registration of the same host id, and its open session, do not count here', async () => {
    const org = await db.organization.findFirstOrThrow();
    const other = await db.app.create({ data: { organizationId: org.id, name: 'Other', urn: `${org.urn}:other` } });
    const w = (await db.worker.create({ data: { ...WORKER_SIGNATURE_DEFAULTS, appId: other.id, agentId, name: 'Elsewhere', slug: 'elsewhere', heldByUserId: holderId, heldAt: new Date() }, select: { id: true } })).id;
    const reg = await db.hostRegistration.create({ data: { appId: other.id, hostId: HOST, label: HOST, pollIntervalSeconds: POLL, refreshedAt: new Date() } });
    await db.hostRegistrationWorker.create({ data: { registrationId: reg.id, workerId: w, family: 'claude' } });
    await db.session.create({ data: { id: generateId(), appId: other.id, agentId, workerId: w, userId: holderId, tool: 'vitest' } });
    expect(await both()).toEqual({ old: false, fresh: false });
  });

  it('the answer is per host: the same state read for the other host', async () => {
    const w = await worker(); await register(OTHER, [w]); await handStarted(w);
    expect(await both(OTHER)).toEqual({ old: true, fresh: true });
    expect(await both(HOST)).toEqual({ old: false, fresh: false });
  });
});

// The exact numbers below ARE the contract (how often the one predicate is asked under the exclusive anchor), not an incidental count.
describe('#5363 the cost no longer grows with the App\'s unrelated open sessions', () => {
  const judged = vi.mocked(sessionRunsOn);
  const at = () => ({ appId, hostId: HOST, now: now(), checkIns: CHECK_INS });
  /** How many times each path asks the one predicate. */
  async function asks(): Promise<{ old: number; fresh: number }> {
    judged.mockClear();
    await db.$transaction((tx) => oracle(tx, at()));
    const old = judged.mock.calls.length;
    judged.mockClear();
    await db.$transaction((tx) => hostHasOpenSession(tx, at()));
    return { old, fresh: judged.mock.calls.length };
  }

  it('twelve unrelated open sessions (workers registered on another host, and launches elsewhere): the old scan judges 12, the new path none', async () => {
    for (let i = 0; i < 6; i += 1) { const w = await worker(); await register(OTHER, [w]); await handStarted(w); }
    for (let i = 0; i < 6; i += 1) { const w = await worker(); await launched(w, OTHER); }
    expect(await asks()).toEqual({ old: 12, fresh: 0 });
  });

  it('five open hand-started sessions of ONE worker that is registered here AND elsewhere (not sole): judged once, not five times', async () => {
    const w = await worker(); await register(HOST, [w]); await register(OTHER, [w]);
    for (let i = 0; i < 5; i += 1) await handStarted(w);
    expect(await asks()).toEqual({ old: 5, fresh: 1 });
  });

  it('a matching session is still found when it sits behind many unrelated ones', async () => {
    for (let i = 0; i < 8; i += 1) { const w = await worker(); await register(OTHER, [w]); await handStarted(w); }
    const m = await worker(); await register(HOST, [m]); await handStarted(m);
    const out = await asks();
    expect(out.fresh).toBe(1);
    expect(await both()).toEqual({ old: true, fresh: true });
  });
});
