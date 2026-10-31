import { WORKER_SIGNATURE_DEFAULTS } from '../workerSignature.js';
/**
 * #2252 Slice D1 — `minTier` in the matcher (cor:agt:060:06, :04; gate: Xan, issue comment 6548306958).
 *
 * A task may name a MINIMUM tier (`low` < `mid` < `high`). Eligible = today's role/family/exclusion/free filters AND
 * tier >= minTier; the LOWEST sufficient tier wins, then `compareRank`; with no minimum the cheapest KNOWN tier goes
 * first and an unknown tier last. An unknown tier (an unbound worker included) is never eligible under a minimum.
 * A tier never admits a worker the role, family, exclusion or name rule keeps out. There is no `maxTier` anywhere.
 *
 * Cast: Baloo / Liam / Rook are reviewers bound as claude on opus (high) / sonnet (mid) / haiku (low) unless a test
 * says otherwise; Kit is a reviewer whose model the platform mapping doesn't know (unknown tier).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Prisma } from '../../generated/prisma/index.js';
import { db } from '../../integrations/db/client.js';
import { cleanDb } from '../../test/helpers.js';
import { generateId } from '../id.js';
import { anchorNow, lockStopFence } from '../stopSignals/state.js';
import { setStopSignal } from '../stopSignals/lifecycle.js';
import { resolvers, type Context } from '../../api/graphql/schema/resolvers.js';
import { __matcherTesting, matchQueuedTasks, parseRequirements, recordStopHolds } from './matcher.js';
import { registerHost } from './hosts.js';

const M = resolvers.Mutation as any;

const DAY = '2026-10-31';
const at = (hhmm: string): Date => new Date(`${DAY}T${hhmm}:00Z`);
const OPUS = 'claude-opus-5-5';
const SONNET = 'claude-sonnet-5-5';
const HAIKU = 'claude-haiku-5-5';

const ctx = (userId?: string): Context => ({ db, userId, roles: ['READER'] });

let app: { id: string };
let agentId: string;
let mia: { id: string };
let baloo: { id: string };
let liam: { id: string };
let rook: { id: string };
let kit: { id: string };
let anne: { id: string };

beforeEach(async () => {
  await cleanDb(db);
  const n = Math.floor(Math.random() * 1_000_000);
  const org = await db.organization.create({ data: { name: 'Tier', urn: `tier-${n}.example` } });
  const admin = await db.user.create({ data: { githubId: 800_000 + n, githubUsername: `tr-admin-${n}`, roles: ['READER'] } });
  mia = await db.user.create({ data: { githubId: 900_000 + n, githubUsername: `tr-mia-${n}`, roles: ['READER'] } });
  await db.orgMember.create({ data: { organizationId: org.id, userId: admin.id, role: 'ADMIN' } });
  agentId = (await M.createAgent({}, { orgId: org.id, name: 'Team Agent' }, ctx(admin.id))).id;
  app = await db.app.create({ data: { organizationId: org.id, name: 'Team', urn: `tier-${n}.example:team` }, select: { id: true } });
  await db.appMember.create({ data: { appId: app.id, userId: mia.id, role: 'member' } });
  const worker = (name: string, role: string) =>
    db.worker.create({ data: { ...WORKER_SIGNATURE_DEFAULTS, appId: app.id, agentId, name, slug: name.toLowerCase(), role, heldByUserId: mia.id }, select: { id: true } });
  baloo = await worker('Baloo', 'reviewer');
  liam = await worker('Liam', 'reviewer');
  rook = await worker('Rook', 'reviewer');
  kit = await worker('Kit', 'reviewer');
  anne = await worker('Anne', 'engineer');
});

afterEach(() => {
  delete process.env.DISABLE_TASK_MATCHER;
});

async function bind(w: { id: string }, family: string, llmModel: string | null, t: Date = at('11:00')) {
  return db.session.create({
    data: { id: generateId(), appId: app.id, workerId: w.id, agentId, family, llmModel, startedAt: t, updatedAt: t },
    select: { id: true },
  });
}

function queued(requirements: Prisma.InputJsonObject | null, extra: Record<string, unknown> = {}) {
  return db.agentTask.create({
    data: { appId: app.id, title: 'Review', ownerUserId: mia.id, createdAt: at('10:00'), ...(requirements ? { requirements } : {}), ...extra },
    select: { id: true, appId: true, requirements: true, closeSessionWhenDone: true, createdByWorkerId: true },
  });
}

async function lastAssigned(w: { id: string }, t: string) {
  await db.agentTeamEvent.create({
    data: { appId: app.id, type: 'task.assigned', subjectWorkerId: w.id, createdAt: at(t), payload: { assignee: { workerId: w.id } } },
  });
}

const busy = (w: { id: string }) =>
  db.agentTask.create({ data: { appId: app.id, title: 'Busy', ownerUserId: mia.id, assigneeWorkerId: w.id, assignedAt: at('10:30'), createdAt: at('10:30') } });
const assigneeOf = async (taskId: string) =>
  (await db.agentTask.findUniqueOrThrow({ where: { id: taskId }, select: { assigneeWorkerId: true } })).assigneeWorkerId;
const run = () => matchQueuedTasks(db, at('11:01'), { appId: app.id });

describe('#2252 D1 parseRequirements — minTier, and fail closed', () => {
  it('reads a valid minTier and nothing else changes', () => {
    for (const tier of ['low', 'mid', 'high'] as const) {
      expect(parseRequirements({ role: 'reviewer', minTier: tier })).toMatchObject({ role: 'reviewer', minTier: tier });
      expect(parseRequirements({ minTier: tier }).invalid).toBeUndefined();
    }
    expect(parseRequirements({ role: 'reviewer' }).minTier).toBeUndefined();
    expect(parseRequirements({ minTier: null }).invalid).toBeUndefined();
  });

  it('a malformed minTier is invalid, never "no bound"', () => {
    for (const bad of ['medium', 'HIGH', 'Mid', '', ' high', 5, true, ['mid'], { tier: 'mid' }]) {
      expect(parseRequirements({ minTier: bad as never }).invalid, JSON.stringify(bad)).toBe(true);
    }
  });

  it('a stored maxTier key is invalid whatever it holds, never "no bound"', () => {
    for (const v of ['high', 'low', null, 3]) {
      expect(parseRequirements({ minTier: 'mid', maxTier: v as never }).invalid, String(v)).toBe(true);
    }
    expect(parseRequirements({ maxTier: 'high' }).invalid).toBe(true);
  });
});

describe('#2252 D1 matching under a minTier (S4–S7)', () => {
  it('S4: the lowest SUFFICIENT tier wins; a lower tier is never used', async () => {
    await bind(baloo, 'claude', OPUS);
    await bind(liam, 'claude', SONNET);
    await bind(rook, 'claude', HAIKU);
    const t = await queued({ role: 'reviewer', minTier: 'mid' });
    expect(await run()).toEqual([{ taskId: t.id, workerId: liam.id, family: 'claude' }]);
  });

  it('S4: with no free mid worker, a free high one takes it at once (go up, never wait)', async () => {
    await bind(baloo, 'claude', OPUS);
    await bind(liam, 'claude', SONNET);
    await busy(liam);
    const t = await queued({ role: 'reviewer', minTier: 'mid' });
    await run();
    expect(await assigneeOf(t.id)).toBe(baloo.id);
  });

  it('a task never goes below its minimum: only a low worker is free, minTier mid, the task stays queued', async () => {
    await bind(rook, 'claude', HAIKU);
    const t = await queued({ role: 'reviewer', minTier: 'mid' });
    expect(await run()).toEqual([]);
    expect(await assigneeOf(t.id)).toBeNull();
  });

  it('ties inside the lowest sufficient tier go to compareRank (least recently assigned)', async () => {
    await bind(baloo, 'claude', SONNET);
    await bind(liam, 'claude', SONNET);
    await lastAssigned(baloo, '09:00');
    await lastAssigned(liam, '08:00');
    const t = await queued({ role: 'reviewer', minTier: 'mid' });
    await run();
    expect(await assigneeOf(t.id)).toBe(liam.id);
  });

  it('S5: an unknown model is never eligible under a minTier', async () => {
    await bind(kit, 'glm', 'glm-4.6');
    const t = await queued({ role: 'reviewer', minTier: 'low' });
    expect(await run()).toEqual([]);
    expect(await assigneeOf(t.id)).toBeNull();
  });

  it('a bound worker that reported no model counts as unknown under a minTier', async () => {
    await bind(kit, 'claude', null);
    const t = await queued({ role: 'reviewer', minTier: 'low' });
    expect(await run()).toEqual([]);
    expect(await assigneeOf(t.id)).toBeNull();
  });

  it('an UNBOUND launchable worker counts as unknown: ineligible under a minTier, still matched without one', async () => {
    await registerHost(db, { appId: app.id, hostId: 'h1', label: 'h1', pollIntervalSeconds: 60, workers: [{ workerId: baloo.id, family: 'claude', worktrees: ['repo/worker'] }] }, at('11:00'));
    const bounded = await queued({ role: 'reviewer', minTier: 'low' });
    expect(await run()).toEqual([]);
    expect(await assigneeOf(bounded.id)).toBeNull();
    await db.agentTask.delete({ where: { id: bounded.id } });
    const free = await queued({ role: 'reviewer' });
    expect(await run()).toEqual([{ taskId: free.id, workerId: baloo.id, family: 'claude' }]);
  });

  it('S6: a tier never admits what the family rule keeps out', async () => {
    await bind(baloo, 'claude', OPUS);
    const t = await queued({ role: 'reviewer', familyNotIn: ['claude'], minTier: 'mid' });
    expect(await run()).toEqual([]);
    expect(await assigneeOf(t.id)).toBeNull();
  });

  it('a tier never admits what the role, an exclusion or familyIn keeps out', async () => {
    await bind(anne, 'claude', OPUS);
    await bind(baloo, 'claude', OPUS);
    await bind(rook, 'claude', HAIKU);
    const wrongRole = await queued({ role: 'reviewer', minTier: 'mid', excludeWorkerIds: [baloo.id] });
    expect(await run()).toEqual([]);
    expect(await assigneeOf(wrongRole.id)).toBeNull();
    await db.agentTask.delete({ where: { id: wrongRole.id } });
    const wrongFamily = await queued({ role: 'reviewer', familyIn: ['codex'], minTier: 'low' });
    expect(await run()).toEqual([]);
    expect(await assigneeOf(wrongFamily.id)).toBeNull();
  });

  it('S7: with no minimum the cheapest KNOWN tier goes first and an unknown one last', async () => {
    await bind(baloo, 'claude', HAIKU);
    await bind(liam, 'claude', OPUS);
    await bind(kit, 'glm', 'glm-4.6');
    await lastAssigned(baloo, '10:59');
    const first = await queued({ role: 'reviewer' });
    const second = await queued({ role: 'reviewer' }, { createdAt: at('10:01') });
    const third = await queued({ role: 'reviewer' }, { createdAt: at('10:02') });
    await run();
    expect(await assigneeOf(first.id)).toBe(baloo.id);
    expect(await assigneeOf(second.id)).toBe(liam.id);
    expect(await assigneeOf(third.id)).toBe(kit.id);
  });

  it('a task with no minTier among workers of one known tier is unchanged: rank decides', async () => {
    await bind(baloo, 'claude', SONNET);
    await bind(liam, 'claude', SONNET);
    await lastAssigned(baloo, '08:00');
    await lastAssigned(liam, '09:00');
    const t = await queued({ role: 'reviewer' });
    await run();
    expect(await assigneeOf(t.id)).toBe(baloo.id);
  });
});

describe('#2252 D1 the stop-hold fence', () => {
  it('a stopped worker the minTier rules out makes no decisive stop hold', async () => {
    await bind(rook, 'claude', HAIKU);
    const t = await queued({ role: 'reviewer', minTier: 'high' });
    const now = at('11:01');
    await db.$transaction(async (tx) => {
      await lockStopFence(tx, app.id, 'exclusive');
      await setStopSignal(tx, { appId: app.id, level: 'pause', scope: 'team', targetWorkerId: rook.id, targetHostRegistrationId: null, until: new Date(now.getTime() + 60_000), by: { userId: mia.id, actor: { userId: mia.id, workerId: null, agentId: null } } }, now);
    });
    await recordStopHolds(db, app.id, now);
    expect(await db.agentTaskStopHold.count({ where: { taskId: t.id, endedAt: null } })).toBe(0);
  });

  it('control: the same stopped worker as the only tier-sufficient one still makes the hold', async () => {
    await bind(rook, 'claude', OPUS);
    const t = await queued({ role: 'reviewer', minTier: 'high' });
    const now = at('11:01');
    await db.$transaction(async (tx) => {
      await lockStopFence(tx, app.id, 'exclusive');
      await setStopSignal(tx, { appId: app.id, level: 'pause', scope: 'team', targetWorkerId: rook.id, targetHostRegistrationId: null, until: new Date(now.getTime() + 60_000), by: { userId: mia.id, actor: { userId: mia.id, workerId: null, agentId: null } } }, now);
    });
    await recordStopHolds(db, app.id, now);
    expect(await db.agentTaskStopHold.count({ where: { taskId: t.id, endedAt: null } })).toBe(1);
  });
});

describe('#2252 D1 the assignment transaction re-checks the hard bound', () => {
  const claimOf = (t: Awaited<ReturnType<typeof queued>>) => ({ ...t, appId: app.id });

  it('a worker whose model dropped below the minimum after the snapshot is refused on the deciding row', async () => {
    const s = await bind(baloo, 'claude', OPUS);
    const t = await queued({ role: 'reviewer', minTier: 'mid' });
    await db.session.update({ where: { id: s.id }, data: { llmModel: HAIKU } });
    expect(await __matcherTesting.tryAssign(db, claimOf(t), baloo.id, 'claude', at('11:01'), {}, anchorNow())).toBe('worker-not-free');
    expect(await assigneeOf(t.id)).toBeNull();
  });

  it('a model refresh that holds the session row while the assignment waits is seen: lower tier refused', async () => {
    const s = await bind(baloo, 'claude', OPUS);
    const t = await queued({ role: 'reviewer', minTier: 'mid' });
    let assigning!: Promise<string>;
    await db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM sessions WHERE id = ${s.id} FOR UPDATE`;
      assigning = __matcherTesting.tryAssign(db, claimOf(t), baloo.id, 'claude', at('11:01'), {}, anchorNow());
      await new Promise((r) => setTimeout(r, 400));
      await tx.session.update({ where: { id: s.id }, data: { llmModel: HAIKU } });
    });
    expect(await assigning).toBe('worker-not-free');
    expect(await assigneeOf(t.id)).toBeNull();
  });

  it('the same wait with a refresh that keeps the tier still assigns (the re-check is not a blanket refusal)', async () => {
    const s = await bind(baloo, 'claude', OPUS);
    const t = await queued({ role: 'reviewer', minTier: 'mid' });
    let assigning!: Promise<string>;
    await db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM sessions WHERE id = ${s.id} FOR UPDATE`;
      assigning = __matcherTesting.tryAssign(db, claimOf(t), baloo.id, 'claude', at('11:01'), {}, anchorNow());
      await new Promise((r) => setTimeout(r, 400));
      await tx.session.update({ where: { id: s.id }, data: { llmModel: SONNET } });
    });
    expect(await assigning).toBe('assigned');
    expect(await assigneeOf(t.id)).toBe(baloo.id);
  });

  it('an unbound worker is refused by the re-check under a minTier', async () => {
    await registerHost(db, { appId: app.id, hostId: 'h1', label: 'h1', pollIntervalSeconds: 60, workers: [{ workerId: baloo.id, family: 'claude', worktrees: ['repo/worker'] }] }, at('11:00'));
    const t = await queued({ role: 'reviewer', minTier: 'low' });
    expect(await __matcherTesting.tryAssign(db, claimOf(t), baloo.id, 'claude', at('11:01'), {}, anchorNow())).toBe('worker-not-free');
  });
});
