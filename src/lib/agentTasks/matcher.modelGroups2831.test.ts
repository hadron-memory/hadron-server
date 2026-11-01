/**
 * #2831 S2 — `modelGroupIn` / `modelGroupNotIn` in the matcher (cor:agt:060:12, :06; gate: Xan, issue comment 6549954066).
 *
 * A task may name model groups. Eligible = today's role/family/exclusion/tier/free filters AND (the worker's model is in
 * at least one `modelGroupIn` group) AND (it is in none of the `modelGroupNotIn` groups). Groups resolve LIVE per
 * pass; a session with no model (or an unbound worker) is in no group: it fails every `In` and passes every `NotIn`.
 * A task with no group requirement matches exactly as before.
 *
 * Cast: Baloo runs opus, Liam sonnet, Rook haiku (all reviewers, claude); Kit is bound with no model.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Prisma } from '../../generated/prisma/index.js';
import { db } from '../../integrations/db/client.js';
import { cleanDb } from '../../test/helpers.js';
import { generateId } from '../id.js';
import { WORKER_SIGNATURE_DEFAULTS } from '../workerSignature.js';
import { resolvers } from '../../api/graphql/schema/resolvers.js';
import { __matcherTesting, matchQueuedTasks, parseRequirements } from './matcher.js';
import { anchorNow } from '../stopSignals/state.js';
import { modelInGroup, modelMatchesPattern } from './modelGroups.js';

const DAY = '2026-10-31';
const at = (hhmm: string): Date => new Date(`${DAY}T${hhmm}:00Z`);
const OPUS = 'claude-opus-5-5';
const SONNET = 'claude-sonnet-5-5';
const HAIKU = 'claude-haiku-5-5';

let app: { id: string };
let agentId: string;
let mia: { id: string };
let baloo: { id: string };
let liam: { id: string };
let rook: { id: string };
let kit: { id: string };

beforeEach(async () => {
  await cleanDb(db);
  const n = Math.floor(Math.random() * 1_000_000);
  const org = await db.organization.create({ data: { name: 'Grp', urn: `grp-${n}.example` } });
  mia = await db.user.create({ data: { githubId: 900_000 + n, githubUsername: `grp-mia-${n}`, roles: ['READER'] } });
  agentId = (await db.agent.create({ data: { name: 'Team Agent', urn: `hrn:agent:grp-${n}.example:team`, organizationId: org.id } as never })).id;
  app = await db.app.create({ data: { organizationId: org.id, name: 'Team', urn: `grp-${n}.example:team` }, select: { id: true } });
  await db.appMember.create({ data: { appId: app.id, userId: mia.id, role: 'member' } });
  const worker = (name: string) =>
    db.worker.create({ data: { ...WORKER_SIGNATURE_DEFAULTS, appId: app.id, agentId, name, slug: name.toLowerCase(), role: 'reviewer', heldByUserId: mia.id }, select: { id: true } });
  baloo = await worker('Baloo');
  liam = await worker('Liam');
  rook = await worker('Rook');
  kit = await worker('Kit');
});

afterEach(() => { delete process.env.DISABLE_TASK_MATCHER; });

const bind = (w: { id: string }, llmModel: string | null, t: Date = at('11:00')) =>
  db.session.create({
    data: { id: generateId(), appId: app.id, workerId: w.id, agentId, family: 'claude', llmModel, startedAt: t, updatedAt: t },
    select: { id: true },
  });
const group = (name: string, patterns: string[]) => db.modelGroup.create({ data: { appId: app.id, name, patterns } });
const queued = (requirements: Prisma.InputJsonObject | null) =>
  db.agentTask.create({ data: { appId: app.id, title: 'Review', ownerUserId: mia.id, createdAt: at('10:00'), ...(requirements ? { requirements } : {}) }, select: { id: true } });
const assigneeOf = async (taskId: string) =>
  (await db.agentTask.findUniqueOrThrow({ where: { id: taskId }, select: { assigneeWorkerId: true } })).assigneeWorkerId;
const run = () => matchQueuedTasks(db, at('11:01'), { appId: app.id });

describe('#2831 S2 pure pieces', () => {
  it('modelMatchesPattern: full-string, lowercase, * and ? only', () => {
    expect(modelMatchesPattern('claude-opus-*', 'Claude-Opus-5-5')).toBe(true);
    expect(modelMatchesPattern('claude-opus', 'claude-opus-5-5')).toBe(false);
    expect(modelMatchesPattern('claude-?-5', 'claude-x-5')).toBe(true);
    expect(modelMatchesPattern('claude-?-5', 'claude-xx-5')).toBe(false);
    expect(modelMatchesPattern('a.b*', 'axb')).toBe(false); // "." is literal
  });
  it('modelMatchesPattern agrees with a regex reference on every short input over a small alphabet', () => {
    const ref = (pat: string, m: string) =>
      new RegExp(`^${pat.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')}$`, 's').test(m);
    const alpha = ['a', 'b', '*', '?'];
    const words = (n: number): string[] => (n === 0 ? [''] : words(n - 1).flatMap((w) => alpha.map((c) => w + c)));
    const models = (n: number): string[] => (n === 0 ? [''] : models(n - 1).flatMap((w) => ['a', 'b'].map((c) => w + c)));
    const pats = [0, 1, 2, 3, 4].flatMap(words);
    const ms = [0, 1, 2, 3, 4, 5].flatMap(models);
    for (const pat of pats) for (const m of ms) expect(modelMatchesPattern(pat, m), `${pat} vs ${m}`).toBe(ref(pat, m));
  });

  it('modelMatchesPattern does not backtrack on separated stars: the worst legal pattern against a long model is fast', () => {
    const pattern = `${'a*'.repeat(63)}b`; // 127 chars, inside MODEL_GROUP_PATTERN_MAX
    expect(pattern.length).toBeLessThanOrEqual(128);
    const t0 = performance.now();
    expect(modelMatchesPattern(pattern, 'a'.repeat(5000))).toBe(false);
    expect(modelMatchesPattern(`${'a*'.repeat(20)}?b`, `${'a'.repeat(5000)}c`)).toBe(false);
    expect(performance.now() - t0).toBeLessThan(500);
  });

  it('modelInGroup: no model is in no group; an unknown group holds nothing', () => {
    const groups = [{ name: 'large', patterns: ['*opus*'], origin: 'APP' as const }];
    expect(modelInGroup(groups, 'large', OPUS)).toBe(true);
    expect(modelInGroup(groups, 'large', SONNET)).toBe(false);
    expect(modelInGroup(groups, 'large', null)).toBe(false);
    expect(modelInGroup(groups, 'ghost', OPUS)).toBe(false);
  });
});

describe('#2831 S2 parseRequirements', () => {
  it('reads both lists (together allowed) and leaves a task without them unchanged', () => {
    expect(parseRequirements({ modelGroupIn: ['large'], modelGroupNotIn: ['small'] })).toMatchObject({ modelGroupIn: ['large'], modelGroupNotIn: ['small'] });
    const plain = parseRequirements({ role: 'reviewer', minTier: 'mid' });
    expect(plain).toEqual({ role: 'reviewer', familyIn: undefined, familyNotIn: undefined, excludeWorkerIds: undefined, minTier: 'mid' });
    expect('modelGroupIn' in plain).toBe(false);
  });
  it('a malformed list is invalid, never "no filter"', () => {
    for (const bad of ['large', [''], [5], [{}], ['Bad Name']]) {
      expect(parseRequirements({ modelGroupIn: bad as never }).invalid, JSON.stringify(bad)).toBe(true);
      expect(parseRequirements({ modelGroupNotIn: bad as never }).invalid, JSON.stringify(bad)).toBe(true);
    }
  });
});

describe('#2831 S2 matching', () => {
  beforeEach(async () => {
    await bind(baloo, OPUS);
    await bind(liam, SONNET);
    await bind(rook, HAIKU);
    await bind(kit, null);
    await group('large', ['*opus*']);
    await group('small', ['*haiku*']);
  });

  it('In: only a worker whose model is in the group is matched', async () => {
    const t = await queued({ modelGroupIn: ['large'] });
    await run();
    expect(await assigneeOf(t.id)).toBe(baloo.id);
  });

  it('In names several groups: any one admits', async () => {
    const t = await queued({ modelGroupIn: ['small', 'large'], role: 'reviewer' });
    await db.agentTask.create({ data: { appId: app.id, title: 'Busy', ownerUserId: mia.id, assigneeWorkerId: baloo.id, assignedAt: at('10:30'), createdAt: at('10:30') } });
    await run();
    expect(await assigneeOf(t.id)).toBe(rook.id);
  });

  it('NotIn: a worker in the group is never matched; a worker in no group (and one with no model) is', async () => {
    await db.agentTask.create({ data: { appId: app.id, title: 'B1', ownerUserId: mia.id, assigneeWorkerId: liam.id, assignedAt: at('10:30'), createdAt: at('10:30') } });
    const t = await queued({ modelGroupNotIn: ['large', 'small'] });
    await run();
    expect(await assigneeOf(t.id)).toBe(kit.id);
  });

  it('a session with no model fails In and an unbound worker too', async () => {
    await db.session.updateMany({ where: { workerId: { in: [baloo.id, liam.id, rook.id] } }, data: { endedAt: at('10:59') } });
    const t = await queued({ modelGroupIn: ['large', 'small'] });
    await run();
    expect(await assigneeOf(t.id)).toBeNull();
  });

  it('ANDs with role, minTier and familyNotIn', async () => {
    const wrongRole = await queued({ modelGroupIn: ['large'], role: 'engineer' });
    const tier = await queued({ modelGroupIn: ['small'], minTier: 'mid' });
    const fam = await queued({ modelGroupIn: ['large'], familyNotIn: ['claude'] });
    await run();
    expect(await assigneeOf(wrongRole.id)).toBeNull();
    expect(await assigneeOf(tier.id)).toBeNull();
    expect(await assigneeOf(fam.id)).toBeNull();
  });

  it('a worker that rebinds on a new session counts by its newest binding', async () => {
    await db.session.updateMany({ where: { workerId: liam.id }, data: { endedAt: at('10:59') } });
    await bind(liam, OPUS, at('11:00'));
    await db.session.updateMany({ where: { workerId: baloo.id }, data: { endedAt: at('10:59') } });
    const t = await queued({ modelGroupIn: ['large'] });
    await run();
    expect(await assigneeOf(t.id)).toBe(liam.id);
  });

  it('a model switch on the SAME open session counts: llmModel updated in place', async () => {
    await db.session.updateMany({ where: { workerId: liam.id }, data: { llmModel: OPUS } });
    await db.session.updateMany({ where: { workerId: baloo.id }, data: { endedAt: at('10:59') } });
    const t = await queued({ modelGroupIn: ['large'] });
    await run();
    expect(await assigneeOf(t.id)).toBe(liam.id);
  });

  it('live: an App edit of the group is seen by the next pass, and a deleted group admits no In and excludes no NotIn', async () => {
    await db.modelGroup.updateMany({ where: { appId: app.id, name: 'large' }, data: { patterns: ['*sonnet*'] } });
    const t = await queued({ modelGroupIn: ['large'] });
    await run();
    expect(await assigneeOf(t.id)).toBe(liam.id);
    await db.modelGroup.deleteMany({ where: { appId: app.id, name: 'small' } });
    const gone = await queued({ modelGroupIn: ['small'] });
    const notGone = await queued({ modelGroupNotIn: ['small'] });
    await run();
    expect(await assigneeOf(gone.id)).toBeNull();
    expect(await assigneeOf(notGone.id)).not.toBeNull();
  });

  it('no group requirement: matching is as before (cheapest known tier first)', async () => {
    const t = await queued({ role: 'reviewer' });
    await run();
    expect(await assigneeOf(t.id)).toBe(rook.id);
  });
});

describe('#2831 S2 the assignment transaction re-reads the groups on the deciding row', () => {
  const claimOf = (t: { id: string }) => ({ id: t.id, appId: app.id, requirements: null, closeSessionWhenDone: false, createdByWorkerId: null });
  const attempt = async (t: { id: string }, w: { id: string }) =>
    __matcherTesting.tryAssign(db, claimOf(t), w.id, 'claude', at('11:01'), {}, anchorNow());

  beforeEach(async () => {
    await bind(baloo, OPUS);
    await group('large', ['*opus*']);
  });

  it('In: a group edited after the snapshot so the worker is no longer in it refuses the assignment', async () => {
    const t = await queued({ modelGroupIn: ['large'] });
    await db.modelGroup.updateMany({ where: { appId: app.id, name: 'large' }, data: { patterns: ['*haiku*'] } });
    expect(await attempt(t, baloo)).toBe('worker-not-free');
    expect(await assigneeOf(t.id)).toBeNull();
  });

  it('NotIn: a group edited after the snapshot so the worker is now in it refuses the assignment', async () => {
    const t = await queued({ modelGroupNotIn: ['small'] });
    await group('small', ['*opus*']);
    expect(await attempt(t, baloo)).toBe('worker-not-free');
    expect(await assigneeOf(t.id)).toBeNull();
  });

  it('control: the same attempt with the worker in the group assigns', async () => {
    const t = await queued({ modelGroupIn: ['large'] });
    expect(await attempt(t, baloo)).toBe('assigned');
  });
});

describe('#2831 S2 groups inherited from the Team Agent reach the matcher', () => {
  it('an Agent group admits by its patterns, and an App override of the same name replaces it (no merge)', async () => {
    const org = await db.organization.findFirstOrThrow({ where: { urn: { startsWith: 'grp-' } } });
    const admin = await db.user.create({ data: { githubId: 700_000 + Math.floor(Math.random() * 100_000), githubUsername: `grp-admin-${generateId()}`, roles: ['READER'] } });
    await db.orgMember.create({ data: { organizationId: org.id, userId: admin.id, role: 'ADMIN' } });
    const team = await (resolvers.Mutation as any).createAgent({}, { orgId: org.id, name: 'Group Team Agent' }, { db, userId: admin.id, roles: ['READER'] });
    await db.node.create({ data: { id: generateId(), memoryId: team.systemMemoryId, loc: 'roles:engineer', name: 'engineer', content: '', data: { names: ['Iris'] } } });
    await db.appAgent.create({ data: { appId: app.id, agentId: team.id } });
    await db.modelGroup.create({ data: { agentId: team.id, name: 'big', patterns: ['*opus*'] } });
    await bind(baloo, OPUS);
    await bind(liam, SONNET);
    const inherited = await queued({ modelGroupIn: ['big'] });
    await run();
    expect(await assigneeOf(inherited.id)).toBe(baloo.id);
    await db.modelGroup.create({ data: { appId: app.id, name: 'big', patterns: ['*sonnet*'] } });
    const overridden = await queued({ modelGroupIn: ['big'] });
    await run();
    expect(await assigneeOf(overridden.id)).toBe(liam.id);
  });
});
