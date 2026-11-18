/**
 * #4455 — the team read's interactive transaction is bounded: a 5 s budget and an explicit
 * pool maxWait, with a typed retryable refusal when the budget runs out.
 *
 * The incident (#4380): `withRosterAppRead`'s RepeatableRead transaction with a 20 s timeout
 * was the P2028 incident's steady holder — 840 real "Transaction already closed … 20000 ms"
 * errors against 8 pool-wait victims since 11-17 15h (Hugo, message classes only). Each
 * roster/composition/utilization call held one of prod's ~9 pool connections for up to 20 s
 * while its serialized statements ran. No client waits that long anyway: the CLI times out at
 * 30 s and the portal at 8 s (portal#2238), so the 20 s budget only starved everyone else.
 *
 * These pins are red on main (8cccdcbb2): the options pin sees `timeout: 20_000` and no
 * `maxWait`, and the budget pin's 6 s projection completes inside main's 20 s budget instead
 * of surfacing a refusal. The differential case is green on main by design — the fix must not
 * change any answer (cor:agt:050:22), only the budget.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { serveEveryAgent } from '../../../test/servedBootPrompt.js';
import { resolvers, type Context } from './resolvers.js';
import { withRosterAppRead } from './resolvers.agentTaskMatching.js';
import { WORKER_SIGNATURE_DEFAULTS } from '../../../lib/workerSignature.js';

vi.mock('../../../integrations/github/writeNodeToGit.js', () => ({
  writeNodeToGit: vi.fn().mockResolvedValue(undefined),
}));

const M = resolvers.Mutation as any;
const Q = resolvers.Query as any;
const ago = (minutes: number) => new Date(Date.now() - minutes * 60_000);
const ctx = (userId?: string): Context => ({ db, userId, roles: ['READER'] });

let app: { id: string };
let admin: { id: string };
let mia: { id: string };
let agentId: string;
const w: Record<string, { id: string }> = {};

beforeEach(async () => {
  await cleanDb(db);
  const n = Math.floor(Math.random() * 1_000_000);
  const org = await db.organization.create({ data: { name: 'Budget', urn: `budget-${n}.example` } });
  admin = await db.user.create({ data: { githubId: 640_000 + n, githubUsername: `bu-admin-${n}`, roles: ['READER'] } });
  mia = await db.user.create({ data: { githubId: 650_000 + n, githubUsername: `bu-mia-${n}`, roles: ['READER'] } });
  await db.orgMember.create({ data: { organizationId: org.id, userId: admin.id, role: 'ADMIN' } });
  const agent = await M.createAgent({}, { orgId: org.id, name: 'Team Agent' }, ctx(admin.id));
  agentId = agent.id;
  app = await db.app.create({ data: { organizationId: org.id, name: 'Team', urn: `budget-${n}.example:team` }, select: { id: true } });
  await db.appMember.create({ data: { appId: app.id, userId: mia.id, role: 'member' } });
  for (const name of ['Anne', 'Rook', 'Kit']) {
    w[name] = await db.worker.create({
      data: { ...WORKER_SIGNATURE_DEFAULTS, appId: app.id, agentId, name, slug: name.toLowerCase(), role: 'engineer', heldByUserId: mia.id },
      select: { id: true },
    });
  }
  await serveEveryAgent(db); // #2712: binds are served the Agent's boot prompt
});

const bind = (name: string, family: string | null, minutesAgo = 0) =>
  db.session.create({
    data: { appId: app.id, workerId: w[name].id, agentId, family, startedAt: ago(minutesAgo), updatedAt: ago(minutesAgo) },
  });

describe('#4455: the bounded team-read budget', () => {
  it('withRosterAppRead asks Prisma for a 5 s transaction budget and an explicit 2 s pool maxWait (pin)', async () => {
    // $transaction is fully mocked, so nothing reaches the store: this pins only the OPTIONS —
    // the acceptance is "a test fails if the timeout exceeds 5 000 ms, or if maxWait is unset".
    const spy = vi.spyOn(db, '$transaction').mockImplementation(async () => 'pin' as never);
    try {
      await withRosterAppRead(ctx(mia.id), 'app-ref-unread', async () => 'projected');
      expect(spy).toHaveBeenCalledTimes(1);
      expect(spy.mock.calls[0]![1]).toEqual({
        isolationLevel: 'RepeatableRead',
        timeout: 5_000,
        maxWait: 2_000,
      });
    } finally {
      spy.mockRestore();
    }
  });

  it('a projection that overruns the budget surfaces a typed retryable refusal, not a raw P2028 (pin)', async () => {
    // 6 s of work inside the read: main's 20 s budget lets it finish (this pin is red because
    // the promise resolves), the 5 s budget aborts it and the refusal must be typed TEAM_READ_BUSY.
    // The test timeout is generous so the RED run fails on the assertion, not on vitest's clock.
    await expect(
      withRosterAppRead(ctx(mia.id), app.id, async (readCtx) => {
        // $executeRaw, not $queryRaw: pg_sleep returns void, which $queryRaw refuses to deserialize (P2010) —
        // the budget abort must be the only reason this projection fails.
        await readCtx.db.$executeRaw`SELECT pg_sleep(6)`;
        return 'overran the budget';
      }),
    ).rejects.toMatchObject({ extensions: { code: 'TEAM_READ_BUSY', retryable: true } });
  }, 25_000);
});

describe('#4455: differential — roster, composition and utilization answer the same for the same seed', () => {
  it('the three callers of withRosterAppRead stay mutually coherent (green on main; the fix changes only the budget)', async () => {
    await bind('Anne', 'glm');
    await bind('Rook', 'codex', 30); // a QUIET codex binding
    // Kit stays unbound (NOT_LAUNCHABLE).
    const roster = await Q.teamRoster({}, { appRef: app.id }, ctx(mia.id));
    const composition = await Q.teamComposition({}, { appRef: app.id }, ctx(mia.id));
    const utilization = await Q.teamUtilization({}, { appRef: app.id }, ctx(mia.id));

    expect(roster.workers.map((e: { name: string }) => e.name).sort()).toEqual(['Anne', 'Kit', 'Rook']);
    // Composition partitions the SAME roster rows: every lane's workers are roster rows, each once.
    const lanes = composition.lanes as Array<{ workers: Array<{ worker: { name: string } }> }>;
    const laneWorkers = lanes.flatMap((l) => l.workers.map((x) => x.worker.name));
    expect(laneWorkers.sort()).toEqual(['Anne', 'Kit', 'Rook']);
    // Utilization counts the same bound families the roster rows carry.
    expect(roster.workers.find((e: { name: string }) => e.name === 'Anne')).toMatchObject({ bound: true, family: 'glm' });
    expect(roster.workers.find((e: { name: string }) => e.name === 'Rook')).toMatchObject({ bound: true, family: 'codex' });
    expect(utilization).toMatchObject({ appId: app.id, windowHours: 24 });
    // Utilization counts the same bound families the roster rows carry (V2 combinations).
    const combos = utilization.combinations as Array<{ family: string; eligibleWorkers: number }>;
    const byFamily = new Map(combos.map((c) => [c.family, c.eligibleWorkers]));
    expect(byFamily.get('glm')).toBe(1);
    expect(byFamily.get('codex')).toBe(1);
  });
});
