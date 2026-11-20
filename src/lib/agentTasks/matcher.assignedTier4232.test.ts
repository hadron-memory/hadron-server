import { WORKER_SIGNATURE_DEFAULTS } from '../workerSignature.js';
/**
 * #4232 (S9 of #4229) — an UNBOUND worker's tier comes from the model of its host assignment (S1a, #4222) on a live
 * host; a BOUND worker keeps its binding's model (cor:agt:060:06, :04; the assignment is a platform-stated input, the
 * binding's model is self-declared, so a binding always wins).
 *
 * Rule pinned here: tier = the lowest tier among the in-effect assignments of a worker on live hosts (every one of them
 * must map; one that doesn't, or has no model, makes the tier unknown, and unknown never meets a minimum). An
 * assignment is in effect only while the App's `hostSetupSource` is `server` (S1a). The bare launcher aliases
 * `opus` / `sonnet` / `haiku` count for an ASSIGNED model only (a manager typed it); `tierOf` stays strict for the
 * self-declared binding model.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import type { Prisma } from '../../generated/prisma/index.js';
import { db } from '../../integrations/db/client.js';
import { cleanDb } from '../../test/helpers.js';
import { generateId } from '../id.js';
import { anchorNow } from '../stopSignals/state.js';
import { resolvers } from '../../api/graphql/schema/resolvers.js';
import { __matcherTesting, matchQueuedTasks, workerTier } from './matcher.js';
import { tierOfAssignedModel } from './family.js';
import { loadLaunchableModels, registerHost } from './hosts.js';

const M = resolvers.Mutation as any;
const at = (hhmm: string): Date => new Date(`2026-10-31T${hhmm}:00Z`);
const ctx = (userId?: string) => ({ db, userId, roles: ['READER'] }) as any;

let app: { id: string };
let agentId: string;
let mia: { id: string };
const w: Record<string, { id: string }> = {};
let seq = 0;

/** An assignment on `hostId` and a live registration that lists its workdir. */
async function assign(worker: { id: string }, model: string | null, hostId = 'h1', family = 'claude') {
  await db.hostWorkerAssignment.create({
    data: { id: generateId(), appId: app.id, hostId, workerId: worker.id, workdir: `wt/${worker.id}`, family, model, createdByUserId: mia.id },
  });
  await registerHost(db, { appId: app.id, hostId, label: hostId, pollIntervalSeconds: 60, workers: [{ workerId: worker.id, family, worktrees: [`wt/${worker.id}`] }] }, at('11:00'));
}
const queued = (requirements: Prisma.InputJsonObject | null) =>
  db.agentTask.create({
    data: { appId: app.id, title: 'Review', ownerUserId: mia.id, createdAt: at('10:00'), ...(requirements ? { requirements } : {}) },
    select: { id: true },
  });
const assigneeOf = async (id: string) => (await db.agentTask.findUniqueOrThrow({ where: { id }, select: { assigneeWorkerId: true } })).assigneeWorkerId;
const run = () => matchQueuedTasks(db, at('11:01'), { appId: app.id });

describe('#4232 workerTier — the pure rule', () => {
  it('a bound worker keeps its binding model, whatever it is assigned', () => {
    expect(workerTier({ bound: true, bindingModel: 'claude-haiku-5-5', assignedModels: ['claude-opus-5-5'] })).toBe('low');
    expect(workerTier({ bound: true, bindingModel: null, assignedModels: ['claude-opus-5-5'] })).toBeNull();
  });
  it('an unbound worker takes the lowest assigned tier; one that does not map makes it unknown', () => {
    expect(workerTier({ bound: false, bindingModel: null, assignedModels: ['claude-opus-5-5'] })).toBe('high');
    expect(workerTier({ bound: false, bindingModel: null, assignedModels: ['claude-opus-5-5', 'claude-sonnet-5-5'] })).toBe('mid');
    expect(workerTier({ bound: false, bindingModel: null, assignedModels: ['claude-opus-5-5', 'octopus-v1'] })).toBeNull();
    expect(workerTier({ bound: false, bindingModel: null, assignedModels: ['claude-opus-5-5', null] })).toBeNull();
    expect(workerTier({ bound: false, bindingModel: null, assignedModels: [] })).toBeNull();
    expect(workerTier({ bound: false, bindingModel: null })).toBeNull();
  });
  it('the bare launcher aliases count for an assigned model only', () => {
    expect(workerTier({ bound: false, bindingModel: null, assignedModels: ['opus'] })).toBe('high');
    expect(workerTier({ bound: false, bindingModel: null, assignedModels: ['sonnet'] })).toBe('mid');
    expect(workerTier({ bound: false, bindingModel: null, assignedModels: ['haiku'] })).toBe('low');
    expect(workerTier({ bound: true, bindingModel: 'opus', assignedModels: ['opus'] })).toBeNull();
  });
});

describe('#4232 tierOfAssignedModel', () => {
  it('reads aliases and full ids, trimmed and case-folded; nothing else', () => {
    expect(tierOfAssignedModel(' OPUS ')).toBe('high');
    expect(tierOfAssignedModel('Claude-Sonnet-5-5')).toBe('mid');
    for (const bad of ['', '  ', null, undefined, 'claude-opus', 'octopus', 'gpt-5', 'opus-ish']) expect(tierOfAssignedModel(bad as never), String(bad)).toBeNull();
  });
});

describe('#4232 matching an unbound worker by its assignment', () => {
  beforeEach(async () => {
    await cleanDb(db);
    const n = (process.pid % 100_000) * 1000 + ++seq;
    const org = await db.organization.create({ data: { name: 'S9', urn: `s9-${n}.example` } });
    const admin = await db.user.create({ data: { githubId: 800_000 + n, githubUsername: `s9-admin-${n}`, roles: ['READER'] } });
    mia = await db.user.create({ data: { githubId: 900_000 + n, githubUsername: `s9-mia-${n}`, roles: ['READER'] } });
    await db.orgMember.create({ data: { organizationId: org.id, userId: admin.id, role: 'ADMIN' } });
    agentId = (await M.createAgent({}, { orgRef: org.id, name: 'Team Agent' }, ctx(admin.id))).id;
    app = await db.app.create({ data: { organizationId: org.id, name: 'Team', urn: `s9-${n}.example:team`, hostSetupSource: 'server' }, select: { id: true } });
    await db.appMember.create({ data: { appId: app.id, userId: mia.id, role: 'member' } });
    for (const name of ['Una', 'Dov', 'Tre']) {
      w[name] = await db.worker.create({
        data: { ...WORKER_SIGNATURE_DEFAULTS, appId: app.id, agentId, name, slug: name.toLowerCase(), role: 'reviewer', heldByUserId: mia.id }, select: { id: true },
      });
    }
  });

  it('S1: an unbound worker assigned `opus` matches a minTier high task', async () => {
    await assign(w.Una, 'opus');
    const t = await queued({ role: 'reviewer', minTier: 'high' });
    await run();
    expect(await assigneeOf(t.id)).toBe(w.Una.id);
  });

  it('S1b: a full model id works the same', async () => {
    await assign(w.Una, 'claude-opus-5-5');
    const t = await queued({ role: 'reviewer', minTier: 'high' });
    await run();
    expect(await assigneeOf(t.id)).toBe(w.Una.id);
  });

  it('S2: an assignment below the minimum is skipped; the same worker takes a lower minimum', async () => {
    await assign(w.Una, 'sonnet');
    const hi = await queued({ role: 'reviewer', minTier: 'high' });
    await run();
    expect(await assigneeOf(hi.id)).toBeNull();
    const mid = await queued({ role: 'reviewer', minTier: 'mid' });
    await run();
    expect(await assigneeOf(mid.id)).toBe(w.Una.id);
  });

  it('S3: no assignment, or an assignment with no model, stays unknown and is skipped under a minimum', async () => {
    await assign(w.Una, null);
    const t = await queued({ role: 'reviewer', minTier: 'low' });
    await run();
    expect(await assigneeOf(t.id)).toBeNull();
    // Una's tier is unknown, which only a minimum refuses: with no minimum she is still free for work.
    const free = await queued({ role: 'reviewer' });
    await run();
    expect(await assigneeOf(free.id)).toBe(w.Una.id); // no minimum: unknown tiers still match
  });

  it('S4: an unmapped assigned model is unknown and never meets a minimum', async () => {
    await assign(w.Una, 'octopus-v1');
    const t = await queued({ role: 'reviewer', minTier: 'low' });
    await run();
    expect(await assigneeOf(t.id)).toBeNull();
  });

  it('S5: a bound worker keeps its binding model: bound on haiku, assigned opus, fails a high minimum', async () => {
    await assign(w.Una, 'opus');
    await db.session.create({ data: { id: generateId(), appId: app.id, workerId: w.Una.id, agentId, family: 'claude', llmModel: 'claude-haiku-5-5', startedAt: at('11:00'), updatedAt: at('11:00') } });
    const t = await queued({ role: 'reviewer', minTier: 'high' });
    await run();
    expect(await assigneeOf(t.id)).toBeNull();
  });

  it('S6: two live hosts that assign different models give the lowest tier', async () => {
    await assign(w.Una, 'opus', 'h1');
    await assign(w.Una, 'haiku', 'h2');
    const t = await queued({ role: 'reviewer', minTier: 'mid' });
    await run();
    expect(await assigneeOf(t.id)).toBeNull();
  });

  it('S7: an assignment is in effect only under hostSetupSource server', async () => {
    await assign(w.Una, 'opus');
    await db.app.update({ where: { id: app.id }, data: { hostSetupSource: 'host' } });
    // The host's own registration (family only) is what launches it now; the stored model is not a tier witness.
    await registerHost(db, { appId: app.id, hostId: 'h1', label: 'h1', pollIntervalSeconds: 60, workers: [{ workerId: w.Una.id, family: 'claude', worktrees: ['wt/x'] }] }, at('11:00'));
    const t = await queued({ role: 'reviewer', minTier: 'high' });
    await run();
    expect(await assigneeOf(t.id)).toBeNull();
  });

  it('S8: with no minimum the cheapest known tier goes first, an assigned-opus unbound worker after a bound sonnet', async () => {
    await assign(w.Una, 'opus');
    await db.session.create({ data: { id: generateId(), appId: app.id, workerId: w.Dov.id, agentId, family: 'claude', llmModel: 'claude-sonnet-5-5', startedAt: at('11:00'), updatedAt: at('11:00') } });
    const t = await queued({ role: 'reviewer' });
    await run();
    expect(await assigneeOf(t.id)).toBe(w.Dov.id);
  });

  it('S9: the assignment re-check (tryAssign) agrees with the pass', async () => {
    await assign(w.Una, 'opus');
    const hi = await queued({ role: 'reviewer', minTier: 'high' });
    const claim = (await db.agentTask.findUniqueOrThrow({ where: { id: hi.id }, select: { id: true, appId: true, requirements: true, closeSessionWhenDone: true, createdByWorkerId: true } })) as any;
    expect(await __matcherTesting.tryAssign(db, claim, w.Una.id, 'claude', at('11:01'), {}, anchorNow())).toBe('assigned');
    const sonnetTask = await queued({ role: 'reviewer', minTier: 'high' });
    await assign(w.Tre, 'sonnet');
    const claim2 = (await db.agentTask.findUniqueOrThrow({ where: { id: sonnetTask.id }, select: { id: true, appId: true, requirements: true, closeSessionWhenDone: true, createdByWorkerId: true } })) as any;
    expect(await __matcherTesting.tryAssign(db, claim2, w.Tre.id, 'claude', at('11:01'), {}, anchorNow())).toBe('worker-not-free'); // the re-check's one refusal, tier included
  });

  it('S10: an assignment with no model beside one that names `opus` makes the tier unknown (the loader keeps the null)', async () => {
    await assign(w.Una, 'opus', 'h1');
    await assign(w.Una, null, 'h2');
    expect((await loadLaunchableModels(db, { workerIds: [w.Una.id] }, at('11:01'))).get(w.Una.id)?.slice().sort()).toEqual([null, 'opus']);
    const t = await queued({ role: 'reviewer', minTier: 'low' });
    await run();
    expect(await assigneeOf(t.id)).toBeNull();
  });

  it('S11: the same model on two hosts collapses to one entry', async () => {
    await assign(w.Una, 'opus', 'h1');
    await assign(w.Una, 'opus', 'h2');
    expect((await loadLaunchableModels(db, { workerIds: [w.Una.id] }, at('11:01'))).get(w.Una.id)).toEqual(['opus']);
  });

  it('S12: an assignment on a lapsed host stops counting', async () => {
    await assign(w.Una, 'opus');
    const t = await queued({ role: 'reviewer', minTier: 'high' });
    // the registration was refreshed at 11:00 with a 60 s poll; a day later it has lapsed
    expect((await loadLaunchableModels(db, { workerIds: [w.Una.id] }, new Date('2026-11-01T11:00:00Z'))).size).toBe(0);
    await matchQueuedTasks(db, new Date('2026-11-01T11:00:00Z'), { appId: app.id });
    expect(await assigneeOf(t.id)).toBeNull();
  });
});
