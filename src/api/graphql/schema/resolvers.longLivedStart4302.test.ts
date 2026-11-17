/**
 * #4302 (follow-up to #4291; cor:agt:070:08 and the 060:06 amendment, Proposed) — a platform start of a LONG_LIVED worker
 * uses the worker's record, never the task's own run settings (decision 10 of
 * hrn:node:hadronmemory.com:hadron-business:decisions:run-settings-are-not-worker-identity: a change to a long-lived
 * worker applies at its next relaunch, and a human triggers it). The matcher already judges a task's settings only for
 * an unbound SHORT_LIVED worker, so the start and the match now follow one lifecycle rule.
 *
 * Fixtures as in resolvers.runSettings4291.test.ts: Bo holds Kit (LONG_LIVED, coordinator) and Sam (SHORT_LIVED,
 * builder); orca1 registers both as claude, host setup source `host`.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { WORKER_SIGNATURE_DEFAULTS } from '../../../lib/workerSignature.js';
import { startSettingsFor } from '../../../lib/hostOperations/launch.js';
import { matchQueuedTasks } from '../../../lib/agentTasks/matcher.js';
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

describe('#4302: from the assignment through the emitted start args, for both lifecycles', () => {
  const OVERRIDE = { family: 'claude', model: 'claude-opus-5-5', effort: 'MAX' };
  const CODEX = { family: 'codex', model: 'gpt-6.1', effort: 'LOW' };

  it('LONG_LIVED, matched: record codex, task override claude: the start carries the record, the read shows override claude and applied codex, the record stays codex', async () => {
    await setRecord(kit, CODEX);
    const t = await queue(OVERRIDE, {}, 'coordinator');
    await match();
    expect(await assigneeOf(t.id)).toBe(kit.id);
    const [args] = await startArgs(kit);
    expect(args).toMatchObject({ ...CODEX, taskId: t.id });
    expect(args).not.toHaveProperty('tier');
    const s = await bindFromStart(kit);
    await runAsActor({ workerId: kit.id, agentId: longAgent }, () => M.startAgentTask({}, { taskId: t.id }, { ...ctx(bo.id), sessionId: s.id } as Context));
    const row = await db.agentTask.findUniqueOrThrow({ where: { id: t.id } });
    expect(T.runSettings(row)).toEqual({ ...OVERRIDE, tier: null });
    expect(T.appliedRunSettings(row)).toEqual(CODEX);
    expect(await recordOf(kit)).toEqual(CODEX);
  });

  it('LONG_LIVED, assigned by hand: the same, and a task naming a tier sends the record\'s model, not the tier', async () => {
    await setRecord(kit, CODEX);
    await assignTo(kit, { family: 'claude', tier: 'high' });
    const [args] = await startArgs(kit);
    expect(args).toMatchObject(CODEX);
    expect(args).not.toHaveProperty('tier');
  });

  it('LONG_LIVED: the start never runs as a family the match did not judge (the override\'s family is unavailable in the App, the record\'s is not)', async () => {
    await setRecord(kit, CODEX);
    await M.setModelFamilyAvailability({}, { input: { appRef: app.id, family: 'claude', state: 'UNAVAILABLE', reason: 'OUT_OF_TOKENS' } }, ctx(admin.id));
    const t = await queue({ family: 'claude' }, {}, 'coordinator');
    await match();
    expect(await assigneeOf(t.id)).toBe(kit.id);
    expect((await startArgs(kit))[0]).toMatchObject({ family: 'codex', model: 'gpt-6.1' });
  });

  it('LONG_LIVED with an empty record: the host\'s family, whatever the task names', async () => {
    await assignTo(kit, { family: 'codex', effort: 'HIGH' });
    const [args] = await startArgs(kit);
    expect(args).toMatchObject({ family: 'claude' });
    expect(args).not.toHaveProperty('effort');
  });

  it('LONG_LIVED: the host is chosen by the record\'s family, not the override\'s', async () => {
    const orca2 = await db.appKey.create({ data: { id: generateId(), appId: app.id, keyHash: `h-${generateId()}`, keyPreview: 'efgh', label: 'orca2' }, select: { id: true } });
    await M.grantAppKeyScope({}, { id: orca2.id, scope: 'host:operate', hostId: 'orca2' }, ctx(admin.id));
    await M.registerHost({}, { input: { appRef: app.id, label: 'Orca 2', pollIntervalSeconds: 600, workers: [{ worker: kit.id, family: 'codex', worktrees: ['hadron-server/kit2'] }] } }, keyCtx(orca2));
    await setRecord(kit, CODEX);
    await assignTo(kit, { family: 'claude' });
    const [op] = await starts(kit);
    expect(op!.hostId).toBe('orca2');
    expect(op!.args).toMatchObject({ family: 'codex', worktree: 'hadron-server/kit2' });
  });

  it('SHORT_LIVED is unchanged: record codex, task override claude: the start carries the override, and after the bind the record reads it', async () => {
    await setRecord(sam, CODEX);
    const t = await queue(OVERRIDE);
    await match();
    expect(await assigneeOf(t.id)).toBe(sam.id);
    expect((await startArgs(sam))[0]).toMatchObject({ ...OVERRIDE, taskId: t.id });
    const s = await bindFromStart(sam);
    await runAsActor({ workerId: sam.id, agentId: shortAgent }, () => M.startAgentTask({}, { taskId: t.id }, { ...ctx(bo.id), sessionId: s.id } as Context));
    expect(T.appliedRunSettings(await db.agentTask.findUniqueOrThrow({ where: { id: t.id } }))).toEqual(OVERRIDE);
    expect(await recordOf(sam)).toEqual(OVERRIDE);
  });

  it('the lifecycle is read when the start is issued: an Agent made SHORT_LIVED since takes the override', async () => {
    await setRecord(kit, CODEX);
    await db.agent.update({ where: { id: longAgent }, data: { lifecycle: 'SHORT_LIVED' } });
    await assignTo(kit, { family: 'claude' });
    expect((await startArgs(kit))[0]).toMatchObject({ family: 'claude' });
  });
  it('#4305: the start args are filled from the settings the host choice read, not from a second lifecycle read', async () => {
    // The Agent is LONG_LIVED when this runs; a caller that read SHORT_LIVED earlier hands over the task's settings.
    // On a second read the lifecycle would drop them (the record's family would win); given, they are used as is.
    await setRecord(kit, CODEX);
    const t = await assignTo(kit, null);
    const reg = { family: 'claude', profile: null };
    const given = { family: 'claude', model: 'claude-opus-5-5', tier: null, effort: 'MAX' } as never;
    const withGiven = await db.$transaction((tx) => startSettingsFor(tx, kit.id, t.id, reg, given));
    const reread = await db.$transaction((tx) => startSettingsFor(tx, kit.id, t.id, reg));
    expect(withGiven).toMatchObject({ family: 'claude' });
    expect(reread).toMatchObject({ family: 'codex' });
    // An explicit null is also "already read": no task settings, and no read of the task or the lifecycle.
    expect(await db.$transaction((tx) => startSettingsFor(tx, kit.id, t.id, reg, null))).toMatchObject({ family: 'codex' });
  });

  it('LONG_LIVED: the record\'s family is unavailable, the task\'s override is available: no assignment and no start (the match judges the record)', async () => {
    await setRecord(kit, CODEX);
    await M.setModelFamilyAvailability({}, { input: { appRef: app.id, family: 'codex', state: 'UNAVAILABLE', reason: 'OUT_OF_TOKENS' } }, ctx(admin.id));
    const t = await queue({ family: 'claude' }, {}, 'coordinator');
    await match();
    expect(await assigneeOf(t.id)).toBeNull();
    expect(await starts(kit)).toEqual([]);
  });
});
