/** S12: explicit reporting choice, legacy omission, and permanent-mint atomicity. */
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { setS7AvailableForTest } from '../../../lib/tickers/s7Availability.js';
import { WORKER_SIGNATURE_DEFAULTS } from '../../../lib/workerSignature.js';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { resolvers, type Context } from './resolvers.js';

const M = resolvers.Mutation as any;
const Q = resolvers.Query as any;
const W = resolvers.Worker as any;
let app: { id: string }; let agent: { id: string }; let user: { id: string };
const ctx = (): Context => ({ db, userId: user.id, roles: ['READER'] });
const args = (choice: Record<string, unknown> = {}) => ({ appRef: app.id, agentRef: agent.id, name: 'Newcomer', ...choice });
beforeEach(async () => {
  await cleanDb(db);
  user = await db.user.create({ data: { githubId: 2028001, githubUsername: 's12-owner' } });
  const org = await db.organization.create({ data: { name: 'S12', urn: `s12-${generateId()}.com` } });
  await db.orgMember.create({ data: { organizationId: org.id, userId: user.id, role: 'ADMIN' } });
  agent = await M.createAgent({}, { orgId: org.id, name: 'S12 agent' }, ctx());
  app = await db.app.create({ data: { organizationId: org.id, name: 'S12 app', urn: `s12-${generateId()}:team` } });
  await db.appAgent.create({ data: { appId: app.id, agentId: agent.id } });
});
afterEach(() => { vi.unstubAllEnvs(); setS7AvailableForTest(false); });

describe('S12 cast choice', () => {
  it('records explicit no-team and returns the same placement in preview', async () => {
    const preview = await Q.castWorkerPreview({}, args({ noTeam: true }), ctx());
    expect(preview.teamPlacement).toBe('NO_TEAM');
    expect(await db.worker.count()).toBe(0);
    const worker = await M.castWorker({}, args({ noTeam: true }), ctx());
    const row = await db.worker.findUniqueOrThrow({ where: { id: worker.id } });
    expect((row as any).explicitNoTeam).toBe(true);
    expect(row.reportsToWorkerId).toBeNull();
    expect(await W.teamPlacement(row, {}, ctx())).toBe('NO_TEAM');
    expect(await db.agentTeamEvent.count({ where: { subjectWorkerId: row.id, type: 'worker.reports-to' } })).toBe(1);
  });
  it('keeps true legacy omission UNSET while default OFF, with no choice event', async () => {
    const worker = await M.castWorker({}, args(), ctx());
    const row = await db.worker.findUniqueOrThrow({ where: { id: worker.id } });
    expect(await W.teamPlacement(row, {}, ctx())).toBe('UNSET');
    expect(await db.agentTeamEvent.count({ where: { subjectWorkerId: row.id } })).toBe(0);
  });
  for (const required of [false, true]) {
    for (const choice of [{ noTeam: null }, { noTeam: false }, { reportsTo: null }, { reportsTo: ' ' }]) {
      it(`refuses explicit invalid ${JSON.stringify(choice)} with enforcement ${required}`, async () => {
        vi.stubEnv('CAST_REPORTING_CHOICE_REQUIRED', String(required));
        for (const operation of [M.castWorker, Q.castWorkerPreview]) {
          await expect(operation({}, args(choice), ctx())).rejects.toMatchObject({
            message: 'reportsTo must be a non-empty worker reference, or noTeam must be true.',
            extensions: { code: 'WORKER_TEAM_CHOICE_INVALID' },
          });
        }
        expect(await db.worker.count()).toBe(0);
      });
    }
    it(`both supplied dominates invalid values with enforcement ${required}`, async () => {
      vi.stubEnv('CAST_REPORTING_CHOICE_REQUIRED', String(required));
      for (const operation of [M.castWorker, Q.castWorkerPreview]) {
        await expect(operation({}, args({ reportsTo: null, noTeam: null }), ctx())).rejects.toMatchObject({
          message: 'Supply reportsTo or noTeam, never both.', extensions: { code: 'WORKER_TEAM_CHOICE_CONFLICT' },
        });
      }
      expect(await db.worker.count()).toBe(0);
    });
  }
  it('requires choice only when enforcement is ON', async () => {
    vi.stubEnv('CAST_REPORTING_CHOICE_REQUIRED', 'true');
    for (const operation of [M.castWorker, Q.castWorkerPreview]) {
      await expect(operation({}, args(), ctx())).rejects.toMatchObject({
        message: 'Choose reportsTo or noTeam: true when casting a worker.', extensions: { code: 'WORKER_TEAM_CHOICE_REQUIRED' },
      });
    }
    expect(await db.worker.count()).toBe(0);
  });
});

// Executable schema pins distinguish omitted variables from explicit literal nulls.
import { ApolloServer } from '@apollo/server';
import { typeDefs } from './typeDefs.js';
import { formatGraphQLError } from '../formatError.js';
import { createTestableMcpServer } from '../../../mcp/server.js';
import { writeReportsTo } from '../../../lib/workerReportsTo.js';
import { eventActor } from '../../../lib/agentTasks/events.js';
import { readFileSync } from 'node:fs';
const server = new ApolloServer<Context>({ typeDefs, resolvers, formatError: formatGraphQLError });
async function wire(operation: 'castWorker' | 'castWorkerPreview', choice: Record<string, unknown>, literal = '') {
  const query = `${operation === 'castWorker' ? 'mutation' : 'query'}($app:ID!,$agent:ID!,$name:String,$reports:ID,$none:Boolean) {
    ${operation}(appRef:$app,agentRef:$agent,name:$name,${literal || 'reportsTo:$reports,noTeam:$none'}) { teamPlacement reportsToWorkerId }
  }`;
  // Literal pins omit variable definitions that would be unused.
  const actualQuery = literal ? query.replace(',$reports:ID,$none:Boolean', '') : query;
  const result = await server.executeOperation({ query: actualQuery, variables: { app: app.id, agent: agent.id, name: 'Wire', ...choice } }, { contextValue: ctx() });
  if (result.body.kind !== 'single') throw new Error('Expected single result');
  return result.body.singleResult;
}
for (const required of [false, true]) {
  describe(`S12 real transports enforcement ${required}`, () => {
    it('shares fixed invalid/conflict envelopes and creates nothing', async () => {
      vi.stubEnv('CAST_REPORTING_CHOICE_REQUIRED', String(required));
      const cases: Array<[Record<string, unknown>, string, string]> = [
        [{ reports: null }, 'INVALID', 'reportsTo must be a non-empty worker reference, or noTeam must be true.'],
        [{ reports: '' }, 'INVALID', 'reportsTo must be a non-empty worker reference, or noTeam must be true.'],
        [{ none: false }, 'INVALID', 'reportsTo must be a non-empty worker reference, or noTeam must be true.'],
        [{ none: null }, 'INVALID', 'reportsTo must be a non-empty worker reference, or noTeam must be true.'],
        [{ reports: null, none: null }, 'CONFLICT', 'Supply reportsTo or noTeam, never both.'],
        [{ reports: 'secret-foreign-name', none: false }, 'CONFLICT', 'Supply reportsTo or noTeam, never both.'],
        [{ reports: null, none: true }, 'CONFLICT', 'Supply reportsTo or noTeam, never both.'],
      ];
      const mcp = createTestableMcpServer({ userId: user.id, roles: ['READER'], appId: app.id, clientId: `user:${user.id}` });
      for (const [input, suffix, message] of cases) {
        for (const op of ['castWorker', 'castWorkerPreview'] as const) {
          expect((await wire(op, input)).errors?.[0]).toMatchObject({ message, extensions: { code: `WORKER_TEAM_CHOICE_${suffix}` } });
        }
        const choice = { ...('reports' in input ? { reportsTo: input.reports } : {}), ...('none' in input ? { noTeam: input.none } : {}) };
        expect(await mcp.callToolText('hadron_cast_worker', { app: app.id, agent: agent.id, name: 'Wire', ...choice }))
          .toBe(`Error: [WORKER_TEAM_CHOICE_${suffix}] ${message}`);
      }
      const literal = await wire('castWorker', {}, 'reportsTo:null');
      expect(literal.errors?.[0].extensions?.code).toBe('WORKER_TEAM_CHOICE_INVALID');
      expect(await db.worker.count()).toBe(0);
      expect(await db.agentTeamEvent.count()).toBe(0);
    });
    it('preserves actual old GraphQL/MCP request omission', async () => {
      vi.stubEnv('CAST_REPORTING_CHOICE_REQUIRED', String(required));
      const result = await wire('castWorkerPreview', {});
      if (required) expect(result.errors?.[0].extensions?.code).toBe('WORKER_TEAM_CHOICE_REQUIRED');
      else expect(result.data?.castWorkerPreview).toMatchObject({ teamPlacement: 'UNSET' });
      const mcp = createTestableMcpServer({ userId: user.id, roles: ['READER'], appId: app.id, clientId: `user:${user.id}` });
      const text = await mcp.callToolText('hadron_cast_worker', { agent: agent.id, name: 'Old MCP' });
      expect(text).toContain(required ? '[WORKER_TEAM_CHOICE_REQUIRED]' : 'Team placement: UNSET');
      expect(await db.worker.count()).toBe(required ? 0 : 1);
    });
  });
}

describe('S12 lifecycle and invariant', () => {
  it('legacy null and reporting pointers retain intent; explicit clears are attributable and idempotent', async () => {
    const head = await M.castWorker({}, args({ name: 'Head' }), ctx());
    const worker = await M.castWorker({}, args(), ctx());
    await db.$transaction(tx => writeReportsTo(tx, { workerId: worker.id, appId: app.id, to: null, actor: eventActor(user.id), setBy: 'app-manager' }));
    await db.$transaction(tx => writeReportsTo(tx, { workerId: worker.id, appId: app.id, to: null, actor: eventActor(user.id), setBy: 'app-manager' }));
    expect(await db.agentTeamEvent.count({ where: { subjectWorkerId: worker.id } })).toBe(1);
    await M.setWorkerReportsTo({}, { workerRef: worker.id, reportsTo: head.id }, ctx());
    let row = await db.worker.findUniqueOrThrow({ where: { id: worker.id } });
    expect((row as any).explicitNoTeam).toBe(false);
    expect(await W.teamPlacement(row, {}, ctx())).toBe('REPORTS_TO');
    await M.setWorkerReportsTo({}, { workerRef: worker.id, reportsTo: null }, ctx());
    row = await db.worker.findUniqueOrThrow({ where: { id: worker.id } });
    expect(await W.teamPlacement(row, {}, ctx())).toBe('NO_TEAM');
    await M.retireWorker({}, { workerRef: worker.id }, ctx());
    row = await db.worker.findUniqueOrThrow({ where: { id: worker.id } });
    expect(await W.teamPlacement(row, {}, ctx())).toBe('UNSET');
  });
  it('CHECK rejects contradictory marker with real23514, and replay retains both legal states', async () => {
    const head = await M.castWorker({}, args({ name: 'Head' }), ctx());
    const worker = await M.castWorker({}, args({ noTeam: true }), ctx());
    await expect(db.$executeRaw`UPDATE workers SET reports_to_worker_id = ${head.id} WHERE id = ${worker.id}`).rejects.toMatchObject({ meta: { code: '23514' } });
    const source = readFileSync('prisma/worker-team-choice-invariants.sql', 'utf8');
    await db.$transaction(async tx => {
      for (const statement of source.replace(/--[^\n]*/g, '').split(';').filter(s => s.trim())) await tx.$executeRawUnsafe(statement);
    });
    expect((await db.worker.findUniqueOrThrow({ where: { id: worker.id } }) as any).explicitNoTeam).toBe(true);
    expect(await W.teamPlacement(await db.worker.findUniqueOrThrow({ where: { id: head.id } }), {}, ctx())).toBe('UNSET');
  });
  it('masks placement to null for an unauthorized viewer', async () => {
    const worker = await M.castWorker({}, args({ noTeam: true }), ctx());
    const stranger = await db.user.create({ data: { githubId: 2028002, githubUsername: 's12-stranger' } });
    expect(await W.teamPlacement(worker, {}, { db, userId: stranger.id, roles: ['READER'] })).toBeNull();
  });
});

describe('S12 DARK boundary and atomic S8 join', () => {
  it('fails closed for head casts if future standby becomes available', async () => {
    const head = await M.castWorker({}, args({ name: 'Head' }), ctx());
    vi.stubEnv('CAST_REPORTING_CHOICE_REQUIRED', 'true');
    setS7AvailableForTest(true);
    for (const operation of [M.castWorker, Q.castWorkerPreview]) {
      await expect(operation({}, args({ reportsTo: head.id }), ctx())).rejects.toMatchObject({ extensions: { code: 'WORKER_REPORTING_CAST_UNAVAILABLE' } });
    }
    expect(await db.worker.count()).toBe(1);
    expect(await db.agentTeamEvent.count()).toBe(0);
  });
  it('conceals foreign/missing/malformed head identities after the manager gate', async () => {
    const other = await db.app.create({ data: { ownerUserId: user.id, name: 'Other', urn: `s12-${generateId()}:other` } });
    const foreign = await db.worker.create({ data: { ...WORKER_SIGNATURE_DEFAULTS, appId: other.id, agentId: agent.id, name: 'Foreign', slug: 'foreign' } });
    for (const ref of [foreign.id, foreign.name, generateId(), 'hrn:worker:bad', 'Missing']) {
      for (const operation of [M.castWorker, Q.castWorkerPreview]) {
        await expect(operation({}, args({ reportsTo: ref }), ctx())).rejects.toMatchObject({ message: 'Worker not found in this App.', extensions: { code: 'WORKER_NOT_FOUND' } });
      }
    }
    expect(await db.worker.count({ where: { appId: app.id } })).toBe(0);
  });
  it('staffing alone permits no-team but never grants head placement authority', async () => {
    const member = await db.user.create({ data: { githubId: 2028003, githubUsername: 's12-member' } });
    await db.appMember.create({ data: { appId: app.id, userId: member.id, role: 'member' } });
    const c = { ...ctx(), userId: member.id };
    await expect(M.castWorker({}, args({ reportsTo: 'Missing' }), c)).rejects.toMatchObject({ extensions: { code: 'WORKER_REPORTS_TO_FORBIDDEN' } });
    const made = await M.castWorker({}, args({ noTeam: true }), c);
    expect(await W.teamPlacement(made, {}, c)).toBe('NO_TEAM');
  });
  it('rolls back worker, event, first ticker and subscription on a late template failure; retry keeps the name', async () => {
    for (const name of ['A', 'B']) await db.agentTickerTemplate.create({ data: { agentId: agent.id, name, cadenceSeconds: 600, reasons: ['read-team-channel'] } });
    let n = 0;
    const failing = db.$extends({ query: { ticker: { async create({ args, query }) {
      if (++n === 2) throw new Error('injected second ticker failure');
      return query(args);
    } } } });
    await expect(M.castWorker({}, args({ noTeam: true }), { ...ctx(), db: failing })).rejects.toThrow('injected second ticker failure');
    expect(n).toBe(2);
    expect(await db.worker.count()).toBe(0);
    expect(await db.agentTeamEvent.count()).toBe(0);
    expect(await db.ticker.count()).toBe(0);
    expect(await db.tickerSubscription.count()).toBe(0);
    const made = await M.castWorker({}, args({ noTeam: true }), ctx());
    expect(made.name).toBe('Newcomer');
    expect(await db.ticker.count()).toBe(2);
    expect(await db.tickerSubscription.count()).toBe(2);
  });
  it('rolls back a marker event failure, before memory provisioning', async () => {
    const failing = db.$extends({ query: { agentTeamEvent: { async create() { throw new Error('injected choice event failure'); } } } });
    const memories = await db.memory.count();
    await expect(M.castWorker({}, args({ noTeam: true }), { ...ctx(), db: failing })).rejects.toThrow('injected choice event failure');
    expect(await db.worker.count()).toBe(0);
    expect(await db.memory.count()).toBe(memories);
    const made = await M.castWorker({}, args({ noTeam: true }), ctx());
    expect(made.name).toBe('Newcomer');
  });
});

import { lockAuthorityAnchors } from '../../../lib/auth/authorityAnchors.js';
import { observeTransactionBackend, waitForAdvisoryWaiter } from '../../../test/advisoryWaiter.js';

describe('S12 deciding transaction fences', () => {
  it('a revocation winning the authority anchor causes fresh refusal with no mint', async () => {
    const owner = await db.app.findUniqueOrThrow({ where: { id: app.id } });
    let release!: () => void;
    let ready!: () => void;
    const held = new Promise<void>(r => { release = r; });
    const started = new Promise<void>(r => { ready = r; });
    const revoker = db.$transaction(async tx => {
      await lockAuthorityAnchors(tx, [{ kind: 'org', id: owner.organizationId! }], 'exclusive');
      await tx.orgMember.update({ where: { organizationId_userId: { organizationId: owner.organizationId!, userId: user.id } }, data: { role: 'READER' } });
      ready(); await held;
    }, { timeout: 30000 });
    await started;
    const observed = observeTransactionBackend(db);
    const casting = M.castWorker({}, args({ noTeam: true }), { ...ctx(), db: observed.db });
    const result = casting.then(() => null, (e: any) => e.extensions?.code);
    try {
      const pid = await observed.backendFor(casting);
      await waitForAdvisoryWaiter(db, { pid, key: { form: 'int-pair', first: 'authorization:org', second: owner.organizationId! } }, 2500);
    } finally { release(); await revoker; }
    expect(await result).toBe('FORBIDDEN');
    expect(await db.worker.count()).toBe(0);
    expect(await db.agentTeamEvent.count()).toBe(0);
  });
  it('a cast winning the authority anchor holds it through event/ticker commit', async () => {
    const owner = await db.app.findUniqueOrThrow({ where: { id: app.id } });
    let release!: () => void; let ready!: () => void;
    const held = new Promise<void>(r => { release = r; });
    const started = new Promise<void>(r => { ready = r; });
    const paused = db.$extends({ query: { agentTeamEvent: { async create({ args, query }) {
      const row = await query(args); ready(); await held; return row;
    } } } });
    const casting = M.castWorker({}, args({ noTeam: true }), { ...ctx(), db: paused });
    await started;
    const observed = observeTransactionBackend(db);
    const revoking = observed.db.$transaction(async tx => {
      await lockAuthorityAnchors(tx, [{ kind: 'org', id: owner.organizationId! }], 'exclusive');
      await tx.orgMember.update({ where: { organizationId_userId: { organizationId: owner.organizationId!, userId: user.id } }, data: { role: 'READER' } });
    });
    try {
      const pid = await observed.backendFor(revoking);
      await waitForAdvisoryWaiter(db, { pid, key: { form: 'int-pair', first: 'authorization:org', second: owner.organizationId! } }, 2500);
      expect(await db.worker.count()).toBe(0); // uncommitted birth is invisible
    } finally { release(); }
    await casting; await revoking;
    expect(await db.worker.count()).toBe(1);
    expect(await db.agentTeamEvent.count()).toBe(1);
  });
  it('dual casts serialize before the App row upgrade and only one name is minted', async () => {
    const result = await Promise.allSettled([M.castWorker({}, args({ noTeam: true }), ctx()), M.castWorker({}, args({ noTeam: true }), ctx())]);
    expect(result.filter(r => r.status === 'fulfilled')).toHaveLength(1);
    expect(result.find(r => r.status === 'rejected')).toMatchObject({ reason: { extensions: { code: 'WORKER_NAME_TAKEN' } } });
    expect(await db.worker.count()).toBe(1);
    expect(await db.agentTeamEvent.count()).toBe(1);
  });
  it('shared reporting graph is never upgraded after the new Worker exists', async () => {
    // Hold exclusive graph; the cast must wait before inserting the worker.
    const { lockAppReportsTo } = await import('../../../lib/workerReportsTo.js');
    let release!: () => void; let ready!: () => void;
    const held = new Promise<void>(r => { release = r; }); const started = new Promise<void>(r => { ready = r; });
    const holder = db.$transaction(async tx => { await lockAppReportsTo(tx, app.id); ready(); await held; }, { timeout: 30000 });
    await started;
    let created = false;
    const tracked = db.$extends({ query: { worker: { async create({ args, query }) { created = true; return query(args); } } } });
    const observed = observeTransactionBackend(tracked as unknown as typeof db);
    const casting = M.castWorker({}, args({ noTeam: true }), { ...ctx(), db: observed.db });
    try {
      const pid = await observed.backendFor(casting);
      await waitForAdvisoryWaiter(db, { pid, key: { form: 'hashed-bigint', value: `worker-reports-to:${app.id}` } });
      expect(created).toBe(false);
      expect(await db.worker.count()).toBe(0);
    } finally { release(); await holder; }
    await casting;
  });
});

it('migration preserves legacy pointers and null UNSET without backfilled events', async () => {
  const head = await M.castWorker({}, args({ name: 'Legacy head' }), ctx());
  const child = await db.worker.create({ data: { ...WORKER_SIGNATURE_DEFAULTS, appId: app.id, agentId: agent.id, name: 'Legacy child', slug: 'legacy-child', reportsToWorkerId: head.id } });
  const migration = readFileSync('prisma/migrations/20261026030000_worker_team_choice/migration.sql', 'utf8');
  await db.$transaction(async tx => {
    await tx.$executeRawUnsafe('ALTER TABLE workers DROP COLUMN explicit_no_team');
    for (const statement of migration.split(';').filter(s => s.trim())) await tx.$executeRawUnsafe(statement);
    const rows = await tx.worker.findMany({ where: { id: { in: [head.id, child.id] } } });
    expect(rows.find(w => w.id === head.id)).toMatchObject({ reportsToWorkerId: null, explicitNoTeam: false });
    expect(rows.find(w => w.id === child.id)).toMatchObject({ reportsToWorkerId: head.id, explicitNoTeam: false });
    expect(await tx.agentTeamEvent.count()).toBe(0);
  });
});

it('does not disguise an infrastructure failure resolving a head as not-found', async () => {
  const failing = db.$extends({ query: { worker: { async findFirst() { throw new Error('synthetic database outage'); } } } });
  for (const operation of [M.castWorker, Q.castWorkerPreview]) {
    await expect(operation({}, args({ reportsTo: generateId() }), { ...ctx(), db: failing })).rejects.toThrow('synthetic database outage');
  }
});

it('round-trips roster placement and masks it under the shared working-state gate', async () => {
  const none = await M.castWorker({}, args({ noTeam: true }), ctx());
  const unset = await M.castWorker({}, args({ name: 'Unset' }), ctx());
  const roster = await Q.teamRoster({}, { appRef: app.id }, ctx());
  expect(roster.workers.find((w: any) => w.workerId === none.id).teamPlacement).toBe('NO_TEAM');
  expect(roster.workers.find((w: any) => w.workerId === unset.id).teamPlacement).toBe('UNSET');
  const gate = await import('./resolvers.worker.js');
  const spy = vi.spyOn(gate, 'maySeeWorkerInternals').mockResolvedValue(false);
  try {
    const masked = await Q.teamRoster({}, { appRef: app.id }, ctx());
    expect(masked.workers.every((w: any) => w.teamPlacement === null)).toBe(true);
  } finally { spy.mockRestore(); }
});

it('bind naming a head replaces explicit no-team through the shared reporting writer', async () => {
  const head = await M.castWorker({}, args({ name: 'Head' }), ctx());
  const worker = await M.castWorker({}, args({ noTeam: true }), ctx());
  await M.startSession({}, { input: { id: generateId(), workerRef: worker.id, reportsTo: head.id } }, ctx());
  const row = await db.worker.findUniqueOrThrow({ where: { id: worker.id } });
  expect(row.reportsToWorkerId).toBe(head.id);
  expect((row as any).explicitNoTeam).toBe(false);
  expect(await W.teamPlacement(row, {}, ctx())).toBe('REPORTS_TO');
});

it('a marker-only clear cannot bypass the existing setter authorization', async () => {
  const worker = await M.castWorker({}, args(), ctx());
  const member = await db.user.create({ data: { githubId: 2028004, githubUsername: 's12-reader' } });
  await db.appMember.create({ data: { appId: app.id, userId: member.id, role: 'member' } });
  await expect(M.setWorkerReportsTo({}, { workerRef: worker.id, reportsTo: null }, { ...ctx(), userId: member.id })).rejects.toMatchObject({ extensions: { code: 'WORKER_REPORTS_TO_FORBIDDEN' } });
  expect(await db.agentTeamEvent.count()).toBe(0);
  expect((await db.worker.findUniqueOrThrow({ where: { id: worker.id } }) as any).explicitNoTeam).toBe(false);
});

describe('S12 head casts while standby is inert (Ada36559)', () => {
  for (const required of [false, true]) {
    it(`records a selected live head atomically with enforcement ${required}`, async () => {
      const head = await M.castWorker({}, args({ name: 'Head' }), ctx());
      vi.stubEnv('CAST_REPORTING_CHOICE_REQUIRED', String(required));
      const preview = await Q.castWorkerPreview({}, args({ reportsTo: head.id }), ctx());
      expect(preview).toMatchObject({ teamPlacement: 'REPORTS_TO', reportsToWorkerId: head.id });
      expect(await db.worker.count()).toBe(1);
      const made = await M.castWorker({}, args({ reportsTo: head.id }), ctx());
      expect(made).toMatchObject({ reportsToWorkerId: head.id, explicitNoTeam: false });
      expect(await W.teamPlacement(made, {}, ctx())).toBe('REPORTS_TO');
      expect(await db.agentTeamEvent.findMany({ where: { subjectWorkerId: made.id } })).toMatchObject([
        { type: 'worker.reports-to', payload: { from: null, to: head.id, setBy: 'cast' } },
      ]);
    });
  }
  it('resolves the same head by ID, URN and same-App name', async () => {
    const head = await M.castWorker({}, args({ name: 'Head' }), ctx());
    const urn = await W.urn(head, {}, ctx());
    for (const [i, ref] of [head.id, urn, 'Head'].entries()) {
      const made = await M.castWorker({}, args({ reportsTo: ref, name: `Report${i}` }), ctx());
      expect(made.reportsToWorkerId).toBe(head.id);
    }
  });
  it('refuses retired heads in preview and cast with no partial Worker or event', async () => {
    const head = await M.castWorker({}, args({ name: 'Head' }), ctx());
    await M.retireWorker({}, { workerRef: head.id }, ctx());
    for (const operation of [M.castWorker, Q.castWorkerPreview]) {
      await expect(operation({}, args({ reportsTo: head.id }), ctx())).rejects.toMatchObject({ extensions: { code: 'WORKER_REPORTS_TO_RETIRED' } });
    }
    expect(await db.worker.count()).toBe(1);
    expect(await db.agentTeamEvent.count()).toBe(0);
  });
});

it('a head cast enters existing S6 team stop coverage atomically', async () => {
  const { lockStopFence } = await import('../../../lib/stopSignals/state.js');
  const { setStopSignal } = await import('../../../lib/stopSignals/lifecycle.js');
  const head = await M.castWorker({}, args({ name: 'Head' }), ctx());
  const signal = await db.$transaction(async tx => {
    await lockStopFence(tx, app.id, 'exclusive');
    return setStopSignal(tx, { appId: app.id, level: 'pause', scope: 'team', targetWorkerId: head.id, targetHostRegistrationId: null, until: null,
      by: { userId: user.id, actor: { userId: user.id, workerId: null, agentId: null } } }, new Date());
  });
  const made = await M.castWorker({}, args({ reportsTo: head.id }), ctx());
  expect(await db.teamStopCoverage.count({ where: { signalId: signal.id, workerId: made.id, leftAt: null } })).toBe(1);
  expect(await db.agentTeamEvent.count({ where: { subjectWorkerId: made.id, type: 'worker.reports-to' } })).toBe(1);
});

it('returns selected head identity through GraphQL and delegated MCP receipts', async () => {
  const head = await M.castWorker({}, args({ name: 'Head' }), ctx());
  expect((await wire('castWorkerPreview', { reports: head.id })).data?.castWorkerPreview).toMatchObject({ teamPlacement: 'REPORTS_TO', reportsToWorkerId: head.id });
  expect((await wire('castWorker', { reports: head.id })).data?.castWorker).toMatchObject({ teamPlacement: 'REPORTS_TO', reportsToWorkerId: head.id });
  const mcp = createTestableMcpServer({ userId: user.id, roles: ['READER'], appId: app.id, clientId: `user:${user.id}` });
  const receipt = await mcp.callToolText('hadron_cast_worker', { agent: agent.id, name: 'McpReport', reportsTo: head.id });
  expect(receipt).toContain('Team placement: REPORTS_TO');
  expect(receipt).toContain(`Reports to worker: ${head.id}`);
});

it('a late template failure rolls back reporting and S6 coverage/notices together', async () => {
  const { lockStopFence } = await import('../../../lib/stopSignals/state.js');
  const { setStopSignal } = await import('../../../lib/stopSignals/lifecycle.js');
  const head = await M.castWorker({}, args({ name: 'Head' }), ctx());
  await db.$transaction(async tx => {
    await lockStopFence(tx, app.id, 'exclusive');
    await setStopSignal(tx, { appId: app.id, level: 'pause', scope: 'team', targetWorkerId: head.id, targetHostRegistrationId: null, until: null,
      by: { userId: user.id, actor: { userId: user.id, workerId: null, agentId: null } } }, new Date());
  });
  for (const name of ['A', 'B']) await db.agentTickerTemplate.create({ data: { agentId: agent.id, name, cadenceSeconds: 600, reasons: ['read-team-channel'] } });
  const events = await db.agentTeamEvent.count();
  const coverage = await db.teamStopCoverage.count();
  let n = 0;
  const failing = db.$extends({ query: { ticker: { async create({ args, query }) {
    if (++n === 2) throw new Error('late head ticker failure');
    return query(args);
  } } } });
  await expect(M.castWorker({}, args({ reportsTo: head.id }), { ...ctx(), db: failing })).rejects.toThrow('late head ticker failure');
  expect(n).toBe(2);
  expect(await db.worker.count()).toBe(1);
  expect(await db.agentTeamEvent.count()).toBe(events);
  expect(await db.teamStopCoverage.count()).toBe(coverage);
  expect(await db.ticker.count()).toBe(0);
  expect(await db.tickerSubscription.count()).toBe(0);
  await expect(M.castWorker({}, args({ reportsTo: head.id }), ctx())).resolves.toMatchObject({ name: 'Newcomer', reportsToWorkerId: head.id });
});

it('retirement winning the shared App anchor refuses the later head cast without residue', async () => {
  const head = await M.castWorker({}, args({ name: 'Head' }), ctx());
  let release!: () => void; let ready!: () => void;
  const held = new Promise<void>(r => { release = r; }); const started = new Promise<void>(r => { ready = r; });
  const paused = db.$extends({ query: { worker: { async updateMany({ args, query }) { const row = await query(args); ready(); await held; return row; } } } });
  const retiring = M.retireWorker({}, { workerRef: head.id }, { ...ctx(), db: paused });
  await started;
  const observed = observeTransactionBackend(db);
  const casting = M.castWorker({}, args({ reportsTo: head.id }), { ...ctx(), db: observed.db });
  const result = casting.then(() => null, (e: any) => e.extensions?.code);
  try {
    const pid = await observed.backendFor(casting);
    await waitForAdvisoryWaiter(db, { pid, key: { form: 'int-pair', first: 'authorization:app', second: app.id } }, 2500);
  } finally { release(); await retiring; }
  expect(await result).toBe('WORKER_REPORTS_TO_RETIRED');
  expect(await db.worker.count()).toBe(1);
  expect(await db.agentTeamEvent.count()).toBe(0);
});

it('cast winning the App anchor commits first; later head retirement preserves the historical line', async () => {
  const head = await M.castWorker({}, args({ name: 'Head' }), ctx());
  let release!: () => void; let ready!: () => void;
  const held = new Promise<void>(r => { release = r; }); const started = new Promise<void>(r => { ready = r; });
  const paused = db.$extends({ query: { agentTeamEvent: { async create({ args, query }) { const row = await query(args); ready(); await held; return row; } } } });
  const casting = M.castWorker({}, args({ reportsTo: head.id }), { ...ctx(), db: paused });
  await started;
  const observed = observeTransactionBackend(db);
  const retiring = M.retireWorker({}, { workerRef: head.id }, { ...ctx(), db: observed.db });
  try {
    const pid = await observed.backendFor(retiring);
    await waitForAdvisoryWaiter(db, { pid, key: { form: 'int-pair', first: 'authorization:app', second: app.id } }, 2500);
  } finally { release(); }
  const made = await casting; await retiring;
  const row = await db.worker.findUniqueOrThrow({ where: { id: made.id } });
  expect(row.reportsToWorkerId).toBe(head.id);
  expect(await W.reportsToRetired(row, {}, ctx())).toBe(true);
});

it('an empty template set is fenced through cast commit; an editor adds only to future casts', async () => {
  let release!: () => void; let ready!: () => void;
  const held = new Promise<void>(r => { release = r; }); const started = new Promise<void>(r => { ready = r; });
  const paused = db.$extends({ query: { agentTeamEvent: { async create({ args, query }) { const row = await query(args); ready(); await held; return row; } } } });
  const casting = M.castWorker({}, args({ noTeam: true }), { ...ctx(), db: paused });
  await started;
  const observed = observeTransactionBackend(db);
  const editing = M.createAgentTickerTemplate({}, { agentRef: agent.id, input: { name: 'Later', cadenceSeconds: 600 } }, { ...ctx(), db: observed.db });
  try {
    const pid = await observed.backendFor(editing);
    await waitForAdvisoryWaiter(db, { pid, key: { form: 'int-pair', first: 'authorization:agent', second: agent.id } }, 2500);
  } finally { release(); }
  const made = await casting; await editing;
  expect(await db.ticker.count({ where: { generatedForWorkerId: made.id } })).toBe(0);
  const future = await M.castWorker({}, args({ name: 'Future', noTeam: true }), ctx());
  expect(await db.ticker.count({ where: { generatedForWorkerId: future.id } })).toBe(1);
});

it('public self-leave cannot commit between the deciding membership read and the permanent cast', async () => {
  const member = await db.user.create({ data: { githubId: 2028005, githubUsername: 's12-leaver' } });
  await db.appMember.create({ data: { appId: app.id, userId: member.id, role: 'member' } });
  const memberCtx = { ...ctx(), userId: member.id };
  let release!: () => void; let ready!: () => void;
  const held = new Promise<void>(r => { release = r; }); const started = new Promise<void>(r => { ready = r; });
  const paused = db.$extends({ query: { worker: { async create({ args, query }) { ready(); await held; return query(args); } } } });
  const casting = M.castWorker({}, args({ noTeam: true }), { ...memberCtx, db: paused });
  await started;
  const observed = observeTransactionBackend(db);
  let left = false;
  const leaving = observed.db.$transaction(tx => M.leaveApp({}, { appId: app.id }, { ...memberCtx, db: tx }));
  const outcome = leaving.then(value => { left = true; return { value }; }, error => { left = true; return { error }; });
  try {
    const pid = await observed.backendFor(leaving);
    const deadline = Date.now() + 2500;
    for (;;) {
      const [row] = await db.$queryRaw<Array<{ waiting: boolean; query: string }>>`
        SELECT wait_event_type = 'Lock' AS waiting, query FROM pg_stat_activity
        WHERE pid = ${pid} AND datname = current_database()`;
      if (row?.waiting && /DELETE.*app_members/s.test(row.query)) break;
      if (left) throw new Error('leaveApp committed before the in-flight cast: membership was not held');
      if (Date.now() > deadline) throw new Error('public leave never waited on the membership row');
      await new Promise(r => setTimeout(r, 10));
    }
    expect(left).toBe(false);
  } finally { release(); await casting; await outcome; }
  expect(await db.worker.count()).toBe(1);
  expect(await db.appMember.findUnique({ where: { appId_userId: { appId: app.id, userId: member.id } } })).toBeNull();
});

it('self-leave winning its row lock is rechecked after the cast waits, with no mint', async () => {
  const member = await db.user.create({ data: { githubId: 2028006, githubUsername: 's12-leaver-first' } });
  await db.appMember.create({ data: { appId: app.id, userId: member.id, role: 'member' } });
  const memberCtx = { ...ctx(), userId: member.id };
  let release!: () => void; let ready!: () => void;
  const held = new Promise<void>(r => { release = r; }); const started = new Promise<void>(r => { ready = r; });
  const leaving = db.$transaction(async tx => {
    await M.leaveApp({}, { appId: app.id }, { ...memberCtx, db: tx }); ready(); await held;
  }, { timeout: 30000 });
  await started;
  const observed = observeTransactionBackend(db);
  let finished = false;
  const casting = M.castWorker({}, args({ noTeam: true }), { ...memberCtx, db: observed.db });
  const outcome = casting.then(() => { finished = true; return 'CAST'; }, (e: any) => { finished = true; return e.extensions?.code; });
  try {
    const pid = await observed.backendFor(casting);
    const deadline = Date.now() + 2500;
    for (;;) {
      const [row] = await db.$queryRaw<Array<{ waiting: boolean; query: string }>>`
        SELECT wait_event_type = 'Lock' AS waiting, query FROM pg_stat_activity
        WHERE pid = ${pid} AND datname = current_database()`;
      if (row?.waiting && /app_members.*FOR SHARE/s.test(row.query)) break;
      if (finished) throw new Error('cast bypassed the membership row held by self-leave');
      if (Date.now() > deadline) throw new Error('cast never waited for the deciding membership');
      await new Promise(r => setTimeout(r, 10));
    }
  } finally { release(); await leaving; await outcome; }
  expect(await outcome).toBe('FORBIDDEN');
  expect(await db.worker.count()).toBe(0);
  expect(await db.agentTeamEvent.count()).toBe(0);
});

for (const model of ['app', 'agent', 'appAgent'] as const) {
  it(`returns a typed retryable refusal when ${model} ownership changes after anchor planning`, async () => {
    const changedOwner = user.id;
    // Inject only the deciding read, after the real transaction acquired its locks.
    // Planning and all other authorization reads use the actual database.
    const wrapped = new Proxy(db, { get(target, key) {
      if (key !== '$transaction') return Reflect.get(target, key);
      return (callback: any, options: any) => target.$transaction(async tx => callback(new Proxy(tx, {
        get(client, field) {
          const value = Reflect.get(client, field);
          if (field !== model) return typeof value === 'function' ? value.bind(client) : value;
          return new Proxy(value, { get(delegate, method) {
            if (model === 'appAgent' && method === 'findUnique') return async (query: any) => {
              const row = await delegate.findUnique(query);
              return { ...row, agent: { ...row.agent, id: changedOwner } };
            };
            if (method !== 'findUniqueOrThrow') return Reflect.get(delegate, method);
            return async (query: any) => ({ ...await delegate.findUniqueOrThrow(query), ownerUserId: changedOwner });
          } });
        },
      })), options);
    } });
    await expect(M.castWorker({}, args({ noTeam: true }), { ...ctx(), db: wrapped })).rejects.toMatchObject({
      message: 'The cast target changed; retry the cast.',
      extensions: { code: 'CAST_TARGET_CHANGED', retryable: true },
    });
    expect(await db.worker.count()).toBe(0);
    expect(await db.agentTeamEvent.count()).toBe(0);
    expect(await db.ticker.count()).toBe(0);
  });
}

it('an omitted or null reporting choice at bind preserves legacy UNSET without a choice event', async () => {
  for (const input of [{}, { reportsTo: null }]) {
    const worker = await M.castWorker({}, args({ name: `Bind${Object.keys(input).length}` }), ctx());
    await M.startSession({}, { input: { workerRef: worker.id, ...input } }, ctx());
    const row = await db.worker.findUniqueOrThrow({ where: { id: worker.id } });
    expect(row.explicitNoTeam).toBe(false);
    expect(row.reportsToWorkerId).toBeNull();
    expect(await db.agentTeamEvent.count({ where: { subjectWorkerId: row.id, type: 'worker.reports-to' } })).toBe(0);
  }
});

it('the delegated MCP list distinguishes stored NO_TEAM from legacy UNSET', async () => {
  await M.castWorker({}, args({ name: 'Explicit', noTeam: true }), ctx());
  await M.castWorker({}, args({ name: 'Legacy' }), ctx());
  const mcp = createTestableMcpServer({ userId: user.id, roles: ['READER'], appId: app.id, clientId: `user:${user.id}` });
  const text = await mcp.callToolText('hadron_list_workers', {});
  expect(text.split('\n').find(line => line.includes('Explicit'))).toContain('team placement NO_TEAM');
  expect(text.split('\n').find(line => line.includes('Legacy'))).toContain('team placement UNSET');
});

import { lockStopFence } from '../../../lib/stopSignals/state.js';
import { advisoryWaiterPresent } from '../../../test/advisoryWaiter.js';
for (const choice of [{}, { noTeam: true }]) {
  it(`a cast without a reporting head does not wait for an unrelated stop fence: ${JSON.stringify(choice)}`, async () => {
    let release!: () => void; let ready!: () => void;
    const held = new Promise<void>(r => { release = r; });
    const started = new Promise<void>(r => { ready = r; });
    const blocker = db.$transaction(async tx => {
      await lockStopFence(tx, app.id, 'exclusive'); ready(); await held;
    }, { timeout: 30000 });
    await started;
    const observed = observeTransactionBackend(db);
    let finished = false;
    const casting = M.castWorker({}, args(choice), { ...ctx(), db: observed.db });
    const result = casting.then((value: any) => { finished = true; return value; }, (error: unknown) => { finished = true; throw error; });
    try {
      const pid = await observed.backendFor(casting);
      const deadline = Date.now() + 5000;
      while (!finished) {
        if (await advisoryWaiterPresent(db, { pid, key: { form: 'hashed-bigint', value: `stop-signals:${app.id}` } })) {
          throw new Error('no-head cast waited on the unrelated stop fence');
        }
        if (Date.now() > deadline) throw new Error('no-head cast did not finish while the stop fence was held');
        await new Promise(r => setTimeout(r, 25));
      }
      expect((await result).id).toBeTruthy();
    } finally { release(); await blocker; await result; }
  });
}
