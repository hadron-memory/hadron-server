/**
 * #4291 (S14 of #4229) — family, model and effort are run settings, not worker identity (decision record
 * hrn:node:hadronmemory.com:hadron-business:decisions:run-settings-are-not-worker-identity; cor:agt:060:04, :06,
 * cor:agt:050:01, cor:agt:070:08, the changes drafted as Proposed).
 *
 * Cast: an org admin manages the App; Bo holds Kit (LONG_LIVED, role coordinator) and Sam (SHORT_LIVED, role builder).
 * orca1 registers both with a worktree, as claude. Unless a test says otherwise the App's host setup source is `host`,
 * so no launcher profile exists and a start's settings can only come from the task or the worker's record.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { GraphQLError } from 'graphql';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { WORKER_SIGNATURE_DEFAULTS } from '../../../lib/workerSignature.js';
import { matchQueuedTasks } from '../../../lib/agentTasks/matcher.js';
import { startDesiredWorkers } from '../../../lib/desiredState/desiredStart.js';
import { runAsActor } from '../../../lib/requestActor.js';
import { serveEveryAgent } from '../../../test/servedBootPrompt.js';
import { resolvers, type Context } from './resolvers.js';

vi.mock('../../../integrations/github/writeNodeToGit.js', () => ({ writeNodeToGit: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../../../lib/bus/index.js', () => ({ getBusClient: vi.fn(async () => null) }));

const M = resolvers.Mutation as any;
const Q = resolvers.Query as any;
const T = (resolvers as any).AgentTask;
const ctx = (userId?: string): Context => ({ db, userId, roles: ['READER'] }) as Context;
const keyCtx = (k: { id: string }): Context => ({ db, appId: app.id, appKeyId: k.id, roles: [] }) as Context;

async function refusal(p: Promise<unknown>): Promise<{ code?: string; reason?: string; message?: string }> {
  try {
    await p;
  } catch (e) {
    expect(e).toBeInstanceOf(GraphQLError);
    const g = e as GraphQLError;
    return { code: g.extensions?.code as string, reason: g.extensions?.reason as string, message: g.message };
  }
  return {};
}

let org: { id: string; urn: string };
let admin: { id: string };
let bo: { id: string };
let app: { id: string };
let kit: { id: string };
let sam: { id: string };
let longAgent: string;
let shortAgent: string;
let orca1: { id: string };

type Record3 = { family: string | null; model: string | null; effort: string | null };
const setRecord = (w: { id: string }, r: Partial<Record3>) =>
  db.worker.update({ where: { id: w.id }, data: { lastUsedFamily: r.family ?? null, lastUsedModel: r.model ?? null, lastUsedEffort: (r.effort ?? null) as never } });
const recordOf = async (w: { id: string }): Promise<Record3> => {
  const r = await db.worker.findUniqueOrThrow({ where: { id: w.id } }) as any;
  return { family: r.lastUsedFamily, model: r.lastUsedModel, effort: r.lastUsedEffort };
};
const starts = (w: { id: string }) => db.hostOperation.findMany({ where: { workerId: w.id, type: 'worker.start' }, orderBy: { issuedAt: 'asc' } });
const startArgs = async (w: { id: string }) => (await starts(w)).map((o) => o.args as Record<string, string>);
const match = () => matchQueuedTasks(db, new Date(), { appId: app.id });
const assigneeOf = async (id: string) => (await db.agentTask.findUniqueOrThrow({ where: { id }, select: { assigneeWorkerId: true } })).assigneeWorkerId;

/** A queued task for a builder (Sam's role) or, with `role`, another role; `runSettings` and `requirements` as given. */
const queue = (runSettings: Record<string, unknown> | null, requirements: Record<string, unknown> = {}, role = 'builder') =>
  M.createAgentTask({}, { input: { appRef: app.id, title: 'Build', requirements: { role, ...requirements }, ...(runSettings ? { runSettings } : {}) } }, ctx(admin.id));
/** A task assigned by hand to `w`. */
const assignTo = (w: { id: string }, runSettings: Record<string, unknown> | null = null) =>
  M.createAgentTask({}, { input: { appRef: app.id, title: 'Build', assignee: { worker: w.id }, ...(runSettings ? { runSettings } : {}) } }, ctx(admin.id));

/** The host collects its operations and the holder binds with the grant, sending NO family, model or effort. */
async function bindFromStart(w: { id: string }, extra: Record<string, unknown> = {}) {
  const [op] = await starts(w);
  const got = (await M.collectHostOperations({}, { appRef: app.id }, keyCtx(orca1)) as Array<{ id: string; launchGrant: string | null }>).find((o) => o.id === op!.id);
  return M.startSession({}, { input: { id: generateId(), tool: 'claude-code', launchGrant: got!.launchGrant, ...extra } }, ctx(bo.id));
}
/** Bo binds `w` by name, with no host involved. */
const bind = (w: { id: string }, extra: Record<string, unknown> = {}) =>
  M.startSession({}, { input: { id: generateId(), appRef: app.id, workerRef: w.id, tool: 'claude-code', ...extra } }, ctx(bo.id));
const rosterRow = async (w: { id: string }) =>
  ((await Q.teamRoster({}, { appRef: app.id }, ctx(admin.id))).workers as any[]).find((r) => r.workerId === w.id);

beforeEach(async () => {
  await cleanDb(db);
  const n = Math.floor(Math.random() * 1_000_000);
  org = await db.organization.create({ data: { id: generateId(), name: 'S14', urn: `s14-4291-${n}.example` }, select: { id: true, urn: true } });
  const u = (k: number, name: string) =>
    db.user.create({ data: { id: generateId(), githubId: 42_910_000 + k * 1000 + (n % 1000), githubUsername: `s14-${name}-${n}`, roles: ['READER'] }, select: { id: true } });
  admin = await u(1, 'admin');
  bo = await u(2, 'bo');
  await db.orgMember.create({ data: { id: generateId(), organizationId: org.id, userId: admin.id, role: 'ADMIN' } });
  longAgent = (await M.createAgent({}, { orgId: org.id, name: 'Coordinator' }, ctx(admin.id))).id;
  shortAgent = (await M.createAgent({}, { orgId: org.id, name: 'Builder', lifecycle: 'SHORT_LIVED' }, ctx(admin.id))).id;
  app = await db.app.create({ data: { id: generateId(), organizationId: org.id, name: 'Team', urn: `${org.urn}:team` }, select: { id: true } });
  await db.appMember.create({ data: { appId: app.id, userId: bo.id, role: 'member' } });
  const w = (agentId: string, name: string, role: string) =>
    db.worker.create({ data: { ...WORKER_SIGNATURE_DEFAULTS, id: generateId(), appId: app.id, agentId, name, slug: name.toLowerCase(), role, heldByUserId: bo.id, heldAt: new Date() }, select: { id: true } });
  kit = await w(longAgent, 'Kit', 'coordinator');
  sam = await w(shortAgent, 'Sam', 'builder');
  orca1 = await db.appKey.create({ data: { id: generateId(), appId: app.id, keyHash: `h-${generateId()}`, keyPreview: 'abcd', label: 'orca1' }, select: { id: true } });
  await M.grantAppKeyScope({}, { id: orca1.id, scope: 'host:operate', hostId: 'orca1' }, ctx(admin.id));
  await M.registerHost({}, { input: { appRef: app.id, label: 'Orca 1', pollIntervalSeconds: 600, workers: [
    { worker: kit.id, family: 'claude', worktrees: ['hadron-server/kit'] },
    { worker: sam.id, family: 'claude', worktrees: ['hadron-server/sam'] },
  ] } }, keyCtx(orca1));
  await serveEveryAgent(db); // #2712: binds are served the Agent's boot prompt
});

describe('the worker record: written from what the session reports, never cleared', () => {
  it('a host-started bind that sends no family or model: the session and the record read the start\'s args; the roster row is not NO_FAMILY and shows effort', async () => {
    await setRecord(sam, { family: 'claude', model: 'claude-opus-5-5', effort: 'HIGH' });
    await assignTo(sam);
    expect(await startArgs(sam)).toEqual([expect.objectContaining({ family: 'claude', model: 'claude-opus-5-5', effort: 'HIGH' })]);
    // The record is emptied, so only the start's args can fill the session and the record back in.
    await setRecord(sam, {});
    const s = await bindFromStart(sam);
    const row = await db.session.findUniqueOrThrow({ where: { id: s.id } }) as any;
    expect({ family: row.family, model: row.llmModel, effort: row.effort }).toEqual({ family: 'claude', model: 'claude-opus-5-5', effort: 'HIGH' });
    expect(await recordOf(sam)).toEqual({ family: 'claude', model: 'claude-opus-5-5', effort: 'HIGH' });
    const r = await rosterRow(sam);
    expect(r.state).not.toBe('NO_FAMILY');
    expect(r.family).toBe('claude');
    expect(r.effort).toBe('HIGH');
    expect(r.lastUsed).toEqual({ family: 'claude', model: 'claude-opus-5-5', effort: 'HIGH' });
  });

  it('what the bind itself reports wins over the start\'s args', async () => {
    await setRecord(sam, { family: 'claude', model: 'claude-opus-5-5', effort: 'HIGH' });
    await assignTo(sam);
    const s = await bindFromStart(sam, { llmModel: 'claude-sonnet-5-5', effort: 'LOW' });
    const row = await db.session.findUniqueOrThrow({ where: { id: s.id } }) as any;
    expect({ family: row.family, model: row.llmModel, effort: row.effort }).toEqual({ family: 'claude', model: 'claude-sonnet-5-5', effort: 'LOW' });
    expect(await recordOf(sam)).toEqual({ family: 'claude', model: 'claude-sonnet-5-5', effort: 'LOW' });
  });

  it('set-model on a running session updates the record; updateSession(effort: HIGH) sets the session\'s effort and the record\'s; a later model-only update leaves the effort', async () => {
    const s = await bind(kit, { llmModel: 'claude-sonnet-5-5' });
    expect(await recordOf(kit)).toEqual({ family: 'claude', model: 'claude-sonnet-5-5', effort: null });
    await M.updateSession({}, { id: s.id, llmModel: 'gpt-6.1' }, ctx(bo.id));
    expect(await recordOf(kit)).toEqual({ family: 'codex', model: 'gpt-6.1', effort: null });
    const updated = await M.updateSession({}, { id: s.id, effort: 'HIGH' }, ctx(bo.id));
    expect(updated.effort).toBe('HIGH');
    expect(await recordOf(kit)).toEqual({ family: 'codex', model: 'gpt-6.1', effort: 'HIGH' });
    await M.updateSession({}, { id: s.id, llmModel: 'claude-opus-5-5' }, ctx(bo.id));
    expect(((await db.session.findUniqueOrThrow({ where: { id: s.id } })) as any).effort).toBe('HIGH');
    expect(await recordOf(kit)).toEqual({ family: 'claude', model: 'claude-opus-5-5', effort: 'HIGH' });
  });

  it('a null or omitted value never clears the record, and ending the session keeps it (060:04 clear-on-unbind is replaced)', async () => {
    await setRecord(kit, { family: 'codex', model: 'gpt-6.1', effort: 'MAX' });
    const s = await bind(kit);
    expect(await recordOf(kit)).toEqual({ family: 'codex', model: 'gpt-6.1', effort: 'MAX' });
    await M.updateSession({}, { id: s.id, llmModel: null, family: null, effort: null }, ctx(bo.id));
    expect(await recordOf(kit)).toEqual({ family: 'codex', model: 'gpt-6.1', effort: 'MAX' });
    await M.updateSession({}, { id: s.id, family: 'claude' }, ctx(bo.id));
    await M.endSession({}, { id: s.id }, ctx(bo.id));
    expect(await recordOf(kit)).toEqual({ family: 'claude', model: 'gpt-6.1', effort: 'MAX' });
    const r = await rosterRow(kit);
    expect(r.bound).toBe(false);
    expect(r.lastUsed).toEqual({ family: 'claude', model: 'gpt-6.1', effort: 'MAX' });
  });

  it('a report on an ENDED session does not move the record: the record follows the running session', async () => {
    const s = await bind(kit, { llmModel: 'claude-sonnet-5-5' });
    await M.endSession({}, { id: s.id }, ctx(bo.id));
    await M.updateSession({}, { id: s.id, llmModel: 'gpt-6.1', effort: 'LOW' }, ctx(bo.id));
    expect(await recordOf(kit)).toEqual({ family: 'claude', model: 'claude-sonnet-5-5', effort: null });
  });

  it('a family with no effort control: the session records NOT_APPLICABLE with no refusal, the roster shows it, and a start that falls back to it sends UNSET', async () => {
    const s = await bind(sam, { family: 'glm', llmModel: 'glm-4.6', effort: 'NOT_APPLICABLE' });
    expect(s.effort).toBe('NOT_APPLICABLE');
    expect(await recordOf(sam)).toEqual({ family: 'glm', model: 'glm-4.6', effort: 'NOT_APPLICABLE' });
    expect((await rosterRow(sam)).effort).toBe('NOT_APPLICABLE');
    await M.endSession({}, { id: s.id }, ctx(bo.id));
    await assignTo(sam);
    expect(await startArgs(sam)).toEqual([expect.objectContaining({ family: 'glm', model: 'glm-4.6', effort: 'UNSET' })]);
  });

  it('a worker that never reported has an empty record: the roster shows a null effort', async () => {
    const r = await rosterRow(kit);
    expect(r.effort).toBeNull();
    expect(r.lastUsed).toEqual({ family: null, model: null, effort: null });
  });
});

describe('a start: the task\'s own setting first, then the worker\'s record', () => {
  it('a task with model claude-opus-5-5 and effort HIGH, matched to a SHORT_LIVED worker whose last used is codex: the args carry claude / claude-opus-5-5 / HIGH, and after the bind the record reads them', async () => {
    await setRecord(sam, { family: 'codex', model: 'gpt-6.1', effort: 'LOW' });
    const t = await queue({ model: 'claude-opus-5-5', effort: 'HIGH' });
    await match();
    expect(await assigneeOf(t.id)).toBe(sam.id);
    const [args] = await startArgs(sam);
    expect(args).toMatchObject({ family: 'claude', model: 'claude-opus-5-5', effort: 'HIGH', taskId: t.id });
    expect(args).not.toHaveProperty('tier');
    await bindFromStart(sam);
    expect(await recordOf(sam)).toEqual({ family: 'claude', model: 'claude-opus-5-5', effort: 'HIGH' });
  });

  it('a task naming nothing: the args carry the worker\'s last used', async () => {
    await setRecord(sam, { family: 'codex', model: 'gpt-6.1', effort: 'XHIGH' });
    const t = await queue(null);
    await match();
    expect(await assigneeOf(t.id)).toBe(sam.id);
    const [args] = await startArgs(sam);
    expect(args).toMatchObject({ family: 'codex', model: 'gpt-6.1', effort: 'XHIGH' });
  });

  it('a task naming the tier high and no model: the args carry the tier, not a model', async () => {
    await setRecord(sam, { family: 'claude', model: 'claude-haiku-5-5', effort: 'LOW' });
    await assignTo(sam, { tier: 'high' });
    const [args] = await startArgs(sam);
    expect(args).toMatchObject({ family: 'claude', tier: 'high', effort: 'LOW' });
    expect(args).not.toHaveProperty('model');
  });

  it('a task that changes only the family drops the record\'s model, which belongs to the other family', async () => {
    await setRecord(sam, { family: 'codex', model: 'gpt-6.1', effort: 'MEDIUM' });
    await assignTo(sam, { family: 'claude' });
    const [args] = await startArgs(sam);
    expect(args).toMatchObject({ family: 'claude', effort: 'MEDIUM' });
    expect(args).not.toHaveProperty('model');
  });

  it('a recorded model no start can carry is left out rather than failing the start', async () => {
    await setRecord(sam, { family: 'claude', model: 'Claude Opus 5.5 (1M context)', effort: null });
    await assignTo(sam);
    const [args] = await startArgs(sam);
    expect(args).toMatchObject({ family: 'claude' });
    expect(args).not.toHaveProperty('model');
  });

  it('the database admits tier on worker.start only as high, mid or low', async () => {
    // A start records the hold it was issued under (#1883, prisma/host-launch-invariants.sql).
    const base = { appId: app.id, hostId: 'orca1', type: 'worker.start', workerId: sam.id, issuedBy: 'platform', holdUserId: bo.id };
    const args = { workerId: sam.id, worktree: 'hadron-server/sam', family: 'claude' };
    await expect(db.hostOperation.create({ data: { ...base, id: generateId(), args: { ...args, tier: 'high' } } })).resolves.toBeTruthy();
    for (const tier of ['HIGH', 'ultra', '']) {
      await expect(db.hostOperation.create({ data: { ...base, id: generateId(), args: { ...args, tier } } })).rejects.toThrow(/chk_host_operations_shape|23514|check constraint/);
    }
  });
});

describe('a desired-running start reads the record, and the assignment profile only seeds an EMPTY record', () => {
  beforeEach(async () => {
    await M.assignHostWorker({}, { input: { appRef: app.id, hostId: 'orca1', worker: 'Kit', workdir: 'hadron-server/kit', family: 'claude', model: 'claude-opus-5-5', effort: 'high', accountProfile: 'worker' } }, ctx(admin.id));
    await M.assignHostWorker({}, { input: { appRef: app.id, hostId: 'orca1', worker: 'Sam', workdir: 'hadron-server/sam', family: 'claude' } }, ctx(admin.id));
    await M.setHostSetupSource({}, { appRef: app.id, source: 'server' }, ctx(admin.id));
    await M.setAppSweepMode({}, { appRef: app.id, mode: 'APPLY' }, ctx(admin.id));
  });

  it('after the record changed: the args carry the record\'s values, not the profile\'s', async () => {
    await setRecord(kit, { family: 'codex', model: 'gpt-6.1', effort: 'LOW' });
    await startDesiredWorkers(db, new Date());
    const [args] = await startArgs(kit);
    expect(args).toMatchObject({ family: 'codex', model: 'gpt-6.1', effort: 'LOW', accountProfile: 'worker', lifecycle: 'LONG_LIVED' });
  });

  it('an empty record: the profile seeds the start, and the bind writes it to the record', async () => {
    await startDesiredWorkers(db, new Date());
    const [args] = await startArgs(kit);
    expect(args).toMatchObject({ family: 'claude', model: 'claude-opus-5-5', effort: 'high', accountProfile: 'worker' });
    await bindFromStart(kit);
    expect(await recordOf(kit)).toEqual({ family: 'claude', model: 'claude-opus-5-5', effort: 'HIGH' });
  });

  it('a record with any value is not empty: the profile fills nothing in', async () => {
    await setRecord(kit, { family: 'claude', model: null, effort: null });
    await startDesiredWorkers(db, new Date());
    const [args] = await startArgs(kit);
    expect(args).toMatchObject({ family: 'claude', accountProfile: 'worker' });
    expect(args).not.toHaveProperty('model');
    expect(args).not.toHaveProperty('effort');
  });
});

describe('a task\'s run settings are checked at creation', () => {
  const refused = (runSettings: Record<string, unknown>, requirements: Record<string, unknown> = {}) => refusal(queue(runSettings, requirements));

  it('a model gpt-6.1 with familyIn [claude] is refused, typed', async () => {
    expect(await refused({ model: 'gpt-6.1' }, { familyIn: ['claude'] })).toMatchObject({ code: 'TASK_RUN_SETTINGS_INVALID', reason: 'FAMILY_EXCLUDED' });
  });
  it('effort NOT_APPLICABLE is a report, not a request: refused, typed', async () => {
    expect(await refused({ effort: 'NOT_APPLICABLE' })).toMatchObject({ code: 'TASK_RUN_SETTINGS_INVALID', reason: 'EFFORT_NOT_A_REQUEST' });
  });
  it('minTier mid with tier low is refused; so is an exact model whose tier is below the minimum', async () => {
    expect(await refused({ tier: 'low' }, { minTier: 'mid' })).toMatchObject({ code: 'TASK_RUN_SETTINGS_INVALID', reason: 'TIER_BELOW_MINIMUM' });
    expect(await refused({ model: 'claude-haiku-5-5' }, { minTier: 'mid' })).toMatchObject({ code: 'TASK_RUN_SETTINGS_INVALID', reason: 'TIER_BELOW_MINIMUM' });
  });
  it('family codex with familyIn [claude] is refused; family claude with familyNotIn [claude] is refused', async () => {
    expect(await refused({ family: 'codex' }, { familyIn: ['claude'] })).toMatchObject({ code: 'TASK_RUN_SETTINGS_INVALID', reason: 'FAMILY_EXCLUDED' });
    expect(await refused({ family: 'claude' }, { familyNotIn: ['claude'] })).toMatchObject({ code: 'TASK_RUN_SETTINGS_INVALID', reason: 'FAMILY_EXCLUDED' });
  });
  it('an exact model outside the task\'s own family is refused; a model and a tier together are refused; a value that is no token is refused', async () => {
    expect(await refused({ family: 'claude', model: 'gpt-6.1' })).toMatchObject({ code: 'TASK_RUN_SETTINGS_INVALID', reason: 'MODEL_OUTSIDE_FAMILY' });
    expect(await refused({ model: 'claude-opus-5-5', tier: 'high' })).toMatchObject({ code: 'TASK_RUN_SETTINGS_INVALID', reason: 'MODEL_AND_TIER' });
    expect(await refused({ model: '$(id)' })).toMatchObject({ code: 'TASK_RUN_SETTINGS_INVALID', reason: 'BAD_VALUE' });
    expect(await refused({ family: 'Not A Family' })).toMatchObject({ code: 'TASK_RUN_SETTINGS_INVALID', reason: 'BAD_VALUE' });
    expect(await refused({ tier: 'ultra' })).toMatchObject({ code: 'TASK_RUN_SETTINGS_INVALID', reason: 'BAD_VALUE' });
    expect(await db.agentTask.count({ where: { appId: app.id, title: 'Build' } })).toBe(0);
  });
  it('consistent settings are stored and read back; a task naming none reads null', async () => {
    const t = await queue({ family: 'Anthropic', model: 'claude-opus-5-5', effort: 'HIGH' }, { familyIn: ['claude'], minTier: 'mid' }, 'nobody');
    expect(T.runSettings(await db.agentTask.findUniqueOrThrow({ where: { id: t.id } }))).toEqual({ family: 'claude', model: 'claude-opus-5-5', tier: null, effort: 'HIGH' });
    const plain = await queue(null, {}, 'nobody');
    expect(T.runSettings(await db.agentTask.findUniqueOrThrow({ where: { id: plain.id } }))).toBeNull();
  });
  it('a later requirements edit that the stored settings would violate is refused the same way', async () => {
    const t = await queue({ family: 'codex' }, {}, 'nobody');
    expect(await refusal(M.updateAgentTask({}, { taskId: t.id, input: { requirements: { role: 'nobody', familyIn: ['claude'] } } }, ctx(admin.id))))
      .toMatchObject({ code: 'TASK_RUN_SETTINGS_INVALID', reason: 'FAMILY_EXCLUDED' });
  });
});

describe('a run setting is not a requirement for a worker that is already running', () => {
  it('override family codex, no familyIn: a short-lived worker with an open claude session and a long-lived claude worker each run it as claude; the read shows override codex and applied claude; each record stays claude; nothing is started', async () => {
    for (const w of [sam, kit]) {
      const s = await bind(w, { llmModel: 'claude-sonnet-5-5', effort: 'MEDIUM' });
      const t = await assignTo(w, { family: 'codex' });
      await runAsActor({ workerId: w.id, agentId: w === sam ? shortAgent : longAgent }, () => M.startAgentTask({}, { taskId: t.id }, { ...ctx(bo.id), sessionId: s.id } as Context));
      const row = await db.agentTask.findUniqueOrThrow({ where: { id: t.id } });
      expect(row.status).toBe('started');
      expect(T.runSettings(row)).toEqual({ family: 'codex', model: null, tier: null, effort: null });
      expect(T.appliedRunSettings(row)).toEqual({ family: 'claude', model: 'claude-sonnet-5-5', effort: 'MEDIUM' });
      expect(await recordOf(w)).toEqual({ family: 'claude', model: 'claude-sonnet-5-5', effort: 'MEDIUM' });
      expect(await starts(w)).toEqual([]);
    }
  });

  it('a task that has not started shows no applied settings', async () => {
    const t = await queue({ family: 'codex' }, {}, 'nobody');
    expect(T.appliedRunSettings(await db.agentTask.findUniqueOrThrow({ where: { id: t.id } }))).toBeNull();
  });

  it('a bound claude worker is matched to a task whose override is codex (the override does not filter), and familyIn still does', async () => {
    await bind(sam, { llmModel: 'claude-sonnet-5-5' });
    const filtered = await queue(null, { familyIn: ['codex'] });
    await match();
    expect(await assigneeOf(filtered.id)).toBeNull();
    const t = await queue({ family: 'codex' });
    await match();
    expect(await assigneeOf(t.id)).toBe(sam.id);
  });
});

describe('the matcher: an unbound short-lived worker is judged on what the launch would apply (Peter #110659)', () => {
  it('record codex, familyIn [claude]: matched when the task overrides the family to claude, not matched with no override', async () => {
    await setRecord(sam, { family: 'codex', model: 'gpt-6.1', effort: null });
    const plain = await queue(null, { familyIn: ['claude'] });
    await match();
    expect(await assigneeOf(plain.id)).toBeNull();
    await db.agentTask.update({ where: { id: plain.id }, data: { status: 'cancelled', cancelledAt: new Date() } });
    const t = await queue({ family: 'claude' }, { familyIn: ['claude'] });
    await match();
    expect(await assigneeOf(t.id)).toBe(sam.id);
    expect((await startArgs(sam))[0]).toMatchObject({ family: 'claude', taskId: t.id });
  });

  it('record tier low, minTier mid: not matched with no override, matched with override tier high', async () => {
    await setRecord(sam, { family: 'claude', model: 'claude-haiku-5-5', effort: null });
    const plain = await queue(null, { minTier: 'mid' });
    await match();
    expect(await assigneeOf(plain.id)).toBeNull();
    await db.agentTask.update({ where: { id: plain.id }, data: { status: 'cancelled', cancelledAt: new Date() } });
    const t = await queue({ tier: 'high' }, { minTier: 'mid' });
    await match();
    expect(await assigneeOf(t.id)).toBe(sam.id);
    expect((await startArgs(sam))[0]).toMatchObject({ family: 'claude', tier: 'high' });
  });

  it('an unbound worker is matched on its record, not on the family its host registered (060:04)', async () => {
    await setRecord(sam, { family: 'codex', model: 'gpt-6.1', effort: null });
    const claudeOnly = await queue(null, { familyIn: ['claude'] });
    const codexOnly = await queue(null, { familyIn: ['codex'] });
    await match();
    expect(await assigneeOf(claudeOnly.id)).toBeNull();
    expect(await assigneeOf(codexOnly.id)).toBe(sam.id);
  });

  it('a LONG_LIVED unbound worker is judged on its record, whatever the task overrides', async () => {
    await setRecord(kit, { family: 'codex', model: 'gpt-6.1', effort: null });
    const t = await queue({ family: 'claude' }, { familyIn: ['claude'] }, 'coordinator');
    await match();
    expect(await assigneeOf(t.id)).toBeNull();
  });

  it('an override family the App has marked unavailable keeps the worker out', async () => {
    await setRecord(sam, { family: 'codex', model: 'gpt-6.1', effort: null });
    await M.setModelFamilyAvailability({}, { input: { appRef: app.id, family: 'claude', state: 'UNAVAILABLE', reason: 'OUT_OF_TOKENS' } }, ctx(admin.id));
    const t = await queue({ family: 'claude' });
    await match();
    expect(await assigneeOf(t.id)).toBeNull();
  });

  it('a record family the App has marked unavailable does not keep the worker from a task that overrides it', async () => {
    await setRecord(sam, { family: 'codex', model: 'gpt-6.1', effort: null });
    await M.setModelFamilyAvailability({}, { input: { appRef: app.id, family: 'codex', state: 'UNAVAILABLE', reason: 'OUT_OF_TOKENS' } }, ctx(admin.id));
    const t = await queue({ family: 'claude' });
    await match();
    expect(await assigneeOf(t.id)).toBe(sam.id);
  });
});
