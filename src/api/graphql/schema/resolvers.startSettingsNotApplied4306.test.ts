/**
 * #4306 (epic #4229; pairs with hadron-cli#2204 C8) — a host-started bind whose start reported its run settings NOT
 * applied inherits none of them from the start's args (hrn:node:hadronmemory.com:specs:cor:agt:070:08, the S14 bind
 * rule of #4291; the exception is Proposed). An exec-path worker runs its own fixed argv, so its host cannot apply the
 * family, model and effort a worker.start names; the launched agent's bind then says so with
 * `startSettingsApplied: false`, and the session, the worker's last-used record and the task's applied stamp hold only
 * what the bind itself reports.
 *
 * Cast and fixtures are those of resolvers.runSettings4291.test.ts: Bo holds Sam (SHORT_LIVED, builder); orca1 hosts Sam.
 * Every start here carries codex / gpt-6.1 / LOW from Sam's record, and the record is emptied before the bind, so a
 * value on the session or the record afterwards can only have come from the start's args or from the bind.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { GraphQLError, buildSchema, defaultFieldResolver, graphql } from 'graphql';
import { typeDefs } from './typeDefs.js';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { WORKER_SIGNATURE_DEFAULTS } from '../../../lib/workerSignature.js';
import { runAsActor } from '../../../lib/requestActor.js';
import { serveEveryAgent } from '../../../test/servedBootPrompt.js';
import { resolvers, type Context } from './resolvers.js';

vi.mock('../../../integrations/github/writeNodeToGit.js', () => ({ writeNodeToGit: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../../../lib/bus/index.js', () => ({ getBusClient: vi.fn(async () => null) }));

const M = resolvers.Mutation as any;
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

beforeEach(async () => {
  await cleanDb(db);
  const n = Math.floor(Math.random() * 1_000_000);
  org = await db.organization.create({ data: { id: generateId(), name: 'S14', urn: `s14-4306-${n}.example` }, select: { id: true, urn: true } });
  const u = (k: number, name: string) =>
    db.user.create({ data: { id: generateId(), githubId: 43_060_000 + k * 1000 + (n % 1000), githubUsername: `s14-${name}-${n}`, roles: ['READER'] }, select: { id: true } });
  admin = await u(1, 'admin');
  bo = await u(2, 'bo');
  await db.orgMember.create({ data: { id: generateId(), organizationId: org.id, userId: admin.id, role: 'ADMIN' } });
  longAgent = (await M.createAgent({}, { orgRef: org.id, name: 'Coordinator' }, ctx(admin.id))).id;
  shortAgent = (await M.createAgent({}, { orgRef: org.id, name: 'Builder', lifecycle: 'SHORT_LIVED' }, ctx(admin.id))).id;
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


const CODEX = { family: 'codex', model: 'gpt-6.1', effort: 'LOW' };
const sessionOf = async (id: string) => {
  const r = await db.session.findUniqueOrThrow({ where: { id } }) as any;
  return { family: r.family, model: r.llmModel, effort: r.effort };
};
/** A task assigned to Sam whose start carries CODEX; Sam's record is then emptied. */
async function startedAsCodex() {
  await setRecord(sam, CODEX);
  const t = await assignTo(sam);
  expect((await starts(sam)).map((o) => o.args)).toEqual([expect.objectContaining(CODEX)]);
  await setRecord(sam, {});
  return t;
}
/** Sam starts the task under session `s`, and the applied stamp is read back. */
async function appliedAfterStart(t: { id: string }, s: { id: string }) {
  await runAsActor({ workerId: sam.id, agentId: shortAgent }, () => M.startAgentTask({}, { taskId: t.id }, { ...ctx(bo.id), sessionId: s.id } as Context));
  return T.appliedRunSettings(await db.agentTask.findUniqueOrThrow({ where: { id: t.id } }));
}
const counts = async () => ({ sessions: await db.session.count(), events: await db.agentTeamEvent.count(), consumed: await db.launchGrant.count({ where: { consumedAt: { not: null } } }) });

describe('a grant bind with startSettingsApplied: false inherits no run settings from the start (#4306)', () => {
  it('reporting nothing (a tool no family is derived from): the session, the worker\'s record and the task\'s applied settings are not filled from the start\'s args', async () => {
    const t = await startedAsCodex();
    const s = await bindFromStart(sam, { tool: 'exec-runner', startSettingsApplied: false });
    expect(await sessionOf(s.id)).toEqual({ family: null, model: null, effort: null });
    expect(await recordOf(sam)).toEqual({ family: null, model: null, effort: null });
    expect(await appliedAfterStart(t, s)).toBeNull();
    // The bind itself is an ordinary launch: the grant is spent and the session records its start.
    const row = await db.session.findUniqueOrThrow({ where: { id: s.id } });
    expect(row.launchOperationId).toBe((await starts(sam))[0]!.id);
    expect(row.workerId).toBe(sam.id);
  });

  it('reporting only a tool a family IS derived from (codex-cli, on a start that said claude): the family is the tool\'s, the bind\'s own report, never the start\'s, and no model or effort is inherited', async () => {
    const claude = { family: 'claude', model: 'claude-opus-5-5', effort: 'HIGH' };
    await setRecord(sam, claude);
    await assignTo(sam);
    expect((await starts(sam)).map((o) => o.args)).toEqual([expect.objectContaining(claude)]);
    await setRecord(sam, {});
    const s = await bindFromStart(sam, { tool: 'codex-cli', startSettingsApplied: false });
    expect(await sessionOf(s.id)).toEqual({ family: 'codex', model: null, effort: null });
    expect(await recordOf(sam)).toEqual({ family: 'codex', model: null, effort: null });
  });

  it('a record the worker already had is left as it was, not overwritten by the start\'s args', async () => {
    await setRecord(sam, CODEX);
    await assignTo(sam);
    await setRecord(sam, { family: 'claude', model: 'claude-opus-5-5', effort: 'HIGH' });
    const s = await bindFromStart(sam, { tool: 'exec-runner', startSettingsApplied: false });
    expect(await sessionOf(s.id)).toEqual({ family: null, model: null, effort: null });
    expect(await recordOf(sam)).toEqual({ family: 'claude', model: 'claude-opus-5-5', effort: 'HIGH' });
  });

  it('with the bind\'s own settings: those are recorded as today', async () => {
    const t = await startedAsCodex();
    const s = await bindFromStart(sam, { startSettingsApplied: false, llmModel: 'claude-sonnet-5-5', effort: 'MEDIUM' }); // tool claude-code derives no family; the model does
    const own = { family: 'claude', model: 'claude-sonnet-5-5', effort: 'MEDIUM' };
    expect(await sessionOf(s.id)).toEqual(own);
    expect(await recordOf(sam)).toEqual(own);
    expect(await appliedAfterStart(t, s)).toEqual(own);
  });

  it('with only a family of its own, the start\'s family: the start\'s model and effort are still not inherited', async () => {
    await startedAsCodex();
    const s = await bindFromStart(sam, { startSettingsApplied: false, family: 'codex' });
    expect(await sessionOf(s.id)).toEqual({ family: 'codex', model: null, effort: null });
    expect(await recordOf(sam)).toEqual({ family: 'codex', model: null, effort: null });
  });

  it('without a launchGrant: refused BAD_USER_INPUT, with nothing written', async () => {
    await startedAsCodex();
    const before = await counts();
    const r = await refusal(bind(sam, { startSettingsApplied: false }));
    expect(r.code).toBe('BAD_USER_INPUT');
    expect(r.message).toMatch(/startSettingsApplied/);
    expect(await counts()).toEqual(before);
    expect(await recordOf(sam)).toEqual({ family: null, model: null, effort: null });
    // The start is untouched: its grant is still live and binds afterwards.
    expect((await starts(sam))[0]!.status).not.toBe('failed');
    await bindFromStart(sam);
  });

  it('without a launchGrant and with no worker at all (a plain session): refused the same way', async () => {
    const before = await counts();
    const r = await refusal(M.startSession({}, { input: { id: generateId(), appRef: app.id, tool: 'claude-code', startSettingsApplied: false } }, ctx(bo.id)));
    expect(r.code).toBe('BAD_USER_INPUT');
    expect(await counts()).toEqual(before);
  });
});

describe('the field reaches the resolver through the executable schema (#4310)', () => {
  it('startSession with startSettingsApplied: false on a grant bind is accepted and the session inherits no settings', async () => {
    await startedAsCodex();
    const [op] = await starts(sam);
    const got = (await M.collectHostOperations({}, { appRef: app.id }, keyCtx(orca1)) as Array<{ id: string; launchGrant: string | null }>).find((o) => o.id === op!.id);
    const schema = buildSchema(typeDefs);
    const fieldResolver = (p: any, a: any, c: any, i: any) =>
      typeof (resolvers as any)[i.parentType.name]?.[i.fieldName] === 'function' ? (resolvers as any)[i.parentType.name][i.fieldName](p, a, c, i) : defaultFieldResolver(p, a, c, i);
    const source = 'mutation($input: SessionInput!){ startSession(input: $input){ id } }';
    const input = { id: generateId(), tool: 'exec-runner', launchGrant: got!.launchGrant, startSettingsApplied: false };
    const out = await graphql({ schema, source, variableValues: { input }, contextValue: ctx(bo.id), fieldResolver });
    expect(out.errors).toBeUndefined();
    const id = (out.data!.startSession as { id: string }).id;
    expect(await sessionOf(id)).toEqual({ family: null, model: null, effort: null });
    expect((await db.session.findUniqueOrThrow({ where: { id } })).workerId).toBe(sam.id);
  });
});

describe('absent, null or true: the bind inherits as before (GREEN ON MAIN BY DESIGN; this is an older CLI)', () => {
  for (const [label, extra] of [['absent', {}], ['null', { startSettingsApplied: null }], ['true', { startSettingsApplied: true }]] as const) {
    it(`startSettingsApplied ${label}: the session, the record and the applied settings read the start\'s args`, async () => {
      const t = await startedAsCodex();
      const s = await bindFromStart(sam, { tool: 'exec-runner', ...extra });
      expect(await sessionOf(s.id)).toEqual(CODEX);
      expect(await recordOf(sam)).toEqual(CODEX);
      expect(await appliedAfterStart(t, s)).toEqual(CODEX);
    });
  }

  it('true or null without a launchGrant is not refused: only false qualifies a start', async () => {
    await bind(sam, { startSettingsApplied: true });
    await bind(kit, { startSettingsApplied: null });
  });
});

describe('the input is documented in the SDL (#4306)', () => {
  it('StartSessionInput.startSettingsApplied is an optional Boolean with a description that cites the rule', async () => {
    const { typeDefs } = await import('./typeDefs.js');
    const sdl = typeof typeDefs === 'string' ? typeDefs : (typeDefs as any).loc?.source?.body ?? String(typeDefs);
    const m = /"""((?:(?!""")[\s\S])*)"""\s*startSettingsApplied: Boolean\n/.exec(sdl);
    expect(m, 'a documented `startSettingsApplied: Boolean` input field').not.toBeNull();
    expect(m![1]).toMatch(/hrn:node:hadronmemory\.com:specs:cor:agt:070:08/);
    expect(m![1]).toMatch(/BAD_USER_INPUT/);
  });
});
