/**
 * #3753 (Grants S2c; cor:acl:140:05 S5 and S9, rulings 0253 item 4, 0255 items 6, 20b and 21, gate conditions on #3753): the run tool
 * `hadron_create_grant`. A headless run naming the agent asks for a PENDING grant held by ITS OWN agent in ITS OWN App; the row records the
 * RUN (`requested_by_run_id`, B18) and no person, worker or session. Pins B1-B18 of the plan, named in each title. Resolver-level pins call the
 * tool through the real run principal (`runContext`); policy pins go through `admitAndExecuteTool`; the races hold a lock on a second connection.
 */
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { GraphQLError } from 'graphql';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { generateId } from '../../id.js';
import { runContext } from '../../../jobs/appRunDeps.js';
import { lockAuthorityAnchors } from '../../auth/authorityAnchors.js';
import { upsertPlatformActions } from '../../grants/actions.js';
import { isGrantLive } from '../../grants/live.js';
import { admitAndExecuteTool, ToolDeniedError } from '../toolAdmission.js';
import { grantCreateMutations } from '../../../api/graphql/schema/resolvers.grantCreate.js';
import { dropTestActions, seedReadableNodes, seedWorld, type World } from '../../grants/grantFixtures3668.js';
import { WORKER_SIGNATURE_DEFAULTS } from '../../workerSignature.js';
import { hadronCreateGrant, hadronListGrants, resolveRunTools } from './index.js';
import type { AppRun } from '../../../generated/prisma/index.js';
import type { RunToolContext } from './types.js';

let w: World;
let pubNode: string;
beforeEach(async () => {
  vi.stubEnv('PASSKEY_SIGNING_ENABLED', 'true');
  await cleanDb(db);
  w = await seedWorld();
  [pubNode] = await seedReadableNodes(w.orgId);
  await upsertPlatformActions(db);
  await db.appAgent.create({ data: { appId: w.appId, agentId: w.agentId } });
});
afterAll(async () => { await cleanDb(db); await dropTestActions(); vi.unstubAllEnvs(); });

async function mintRun(appId: string, agentId: string | null, over: Record<string, unknown> = {}): Promise<AppRun> {
  const app = await db.app.findUniqueOrThrow({ where: { id: appId } });
  return db.appRun.create({ data: { id: generateId(), organizationId: app.organizationId as string, appId, agentId: agentId as string, triggerKind: 'MANUAL', entryNodeUrn: 'x::m::flow:entry', status: 'RUNNING', ...over } as never });
}
const ctxOf = (run: AppRun): RunToolContext => ({ log: vi.fn(), db, run, principal: runContext(db, run) });
const entry = () => ({ entryNode: pubNode });
const ask = (run: AppRun, args: Record<string, unknown> = {}) => hadronCreateGrant.execute(ctxOf(run), { action: 'schedule.create', values: entry(), reason: 'nightly digest', ...args }) as Promise<{ id: string; status: string }>;
const rows = () => db.$queryRawUnsafe<any[]>('SELECT * FROM grants ORDER BY created_at');
const events = () => db.$queryRawUnsafe<any[]>('SELECT * FROM grant_events');
async function refused(p: Promise<unknown>): Promise<string | undefined> {
  try { await p; } catch (e) { expect(e).toBeInstanceOf(GraphQLError); return (e as GraphQLError).extensions?.code as string; }
  throw new Error('expected a refusal');
}
const newAgent = (name: string) => db.agent.create({ data: { organizationId: w.orgId, name, urn: `${w.orgUrn}:${name}-${generateId().slice(0, 6)}` } });

describe('hadron_create_grant (#3753)', () => {
  it('B1 + B18 (S5): a RUNNING run in an App with no team creates ONE pending row held by (its agent, its App), recording the run and no person, worker or session; no event', async () => {
    const run = await mintRun(w.appId, w.agentId, { userId: w.user2Id });
    const out = await ask(run);
    expect(out.status).toBe('pending');
    const [row] = await rows();
    expect(await rows()).toHaveLength(1);
    expect(row).toMatchObject({ id: out.id, app_id: w.appId, agent_id: w.agentId, user_id: null, worker_id: null, grantee_app_id: null,
      requested_by_run_id: run.id, requested_by_user_id: null, requested_by_worker_id: null, requested_by_session_id: null, activated_at: null, action: 'schedule.create' });
    expect(await events()).toHaveLength(0);
  });

  it('B18: the run column is append-only: the guard refuses changing or clearing it', async () => {
    const run = await mintRun(w.appId, w.agentId);
    const { id } = await ask(run);
    await expect(db.$executeRawUnsafe('UPDATE grants SET requested_by_run_id = $2 WHERE id = $1', id, generateId())).rejects.toThrow();
    await expect(db.$executeRawUnsafe('UPDATE grants SET requested_by_run_id = NULL WHERE id = $1', id)).rejects.toThrow();
    expect((await rows())[0].requested_by_run_id).toBe(run.id);
  });

  it('B2: nothing activates it: activation keys are refused as unknown, and the row reads not live (even for a run on behalf of the App owner)', async () => {
    await db.orgMember.create({ data: { organizationId: w.orgId, userId: w.user2Id, role: 'OWNER' } });
    const run = await mintRun(w.appId, w.agentId, { userId: w.user2Id });
    for (const k of ['activatedAt', 'signatureId', 'verifiedBy', 'verificationKind', 'version', 'useCount', 'issuerUserId', 'requestedByUserId']) {
      expect(await refused(ask(run, { [k]: 'x' }))).toBe('GRANT_TERMS_INVALID');
    }
    expect(await rows()).toHaveLength(0);
    await ask(run);
    const [row] = await rows();
    expect(row.activated_at).toBeNull();
    expect(isGrantLive({ activatedAt: row.activated_at, revokedAt: row.revoked_at, startsAt: row.starts_at, expiresAt: row.expires_at, maxUses: row.max_uses, useCount: row.use_count, holderDepartedAt: row.holder_departed_at } as never, new Date())).toBe(false);
    const live = await db.$queryRawUnsafe<any[]>('SELECT id FROM grants g WHERE g.activated_at IS NOT NULL');
    expect(live).toHaveLength(0);
  });

  it('B3 (item 20b): an agent installed in A and B, running in B, gets a row in B only; a run in A gets its own row in A', async () => {
    await db.appAgent.create({ data: { appId: w.app2Id, agentId: w.agentId } });
    await ask(await mintRun(w.app2Id, w.agentId));
    expect((await rows()).map((r) => r.app_id)).toEqual([w.app2Id]);
    await ask(await mintRun(w.appId, w.agentId));
    expect((await rows()).map((r) => r.app_id).sort()).toEqual([w.appId, w.app2Id].sort());
  });

  it('B4: never for another holder: every holder-like key is S2a\'s holder code, byte-identical for a holder that exists and one that does not; nothing written', async () => {
    const other = await newAgent('other');
    await db.appAgent.create({ data: { appId: w.appId, agentId: other.id } });
    const role = await newAgent('role');
    const roleWorker = await db.worker.create({ data: { ...WORKER_SIGNATURE_DEFAULTS, appId: w.appId, agentId: role.id, name: 'r', slug: `r-${generateId().slice(0, 6)}` } });
    const run = await mintRun(w.appId, w.agentId, { userId: w.user2Id });
    const messages: string[] = [];
    for (const extra of [
      { holder: { agent: other.id } }, { holderKind: 'AGENT', holderRef: other.id }, { agentId: other.id }, { agentId: role.id }, { workerId: w.workerId },
      { workerId: roleWorker.id }, { worker: w.workerId }, { userId: w.user2Id }, { user: w.user2Id }, { appId: w.app2Id }, { appRef: w.app2Id }, { app: w.appId },
      { agentId: generateId() }, { workerId: generateId() }, { userId: generateId() }, { appRef: generateId() },
    ]) {
      try { await ask(run, extra); throw new Error('no refusal'); } catch (e) {
        expect((e as GraphQLError).extensions?.code).toBe('GRANT_HOLDER_NOT_ALLOWED');
        messages.push((e as GraphQLError).message);
      }
    }
    expect(new Set(messages).size).toBe(1);
    expect(await rows()).toHaveLength(0);
    expect(await events()).toHaveLength(0);
  });

  it('B5: not installed or soft-deleted: refused with the holder code, no row', async () => {
    const run = await mintRun(w.appId, w.agentId);
    await db.appAgent.deleteMany({ where: { appId: w.appId, agentId: w.agentId } });
    expect(await refused(ask(run))).toBe('GRANT_HOLDER_NOT_ALLOWED');
    await db.appAgent.create({ data: { appId: w.appId, agentId: w.agentId } });
    await db.agent.update({ where: { id: w.agentId }, data: { deletedAt: new Date() } });
    expect(await refused(ask(run))).toBe('GRANT_HOLDER_NOT_ALLOWED');
    expect(await rows()).toHaveLength(0);
  });

  it('B6 (item 21): a run principal on behalf of an App manager is never admitted by GraphQL createGrant, on any arm; and through the tool the row records the run, not the manager', async () => {
    await db.orgMember.create({ data: { organizationId: w.orgId, userId: w.user2Id, role: 'ADMIN' } });
    const run = await mintRun(w.appId, w.agentId, { userId: w.user2Id });
    const input = (over: Record<string, unknown> = {}) => ({ appRef: w.appId, action: 'schedule.create', values: entry(), holderKind: 'AGENT', holderRef: w.agentId, reason: 'x', ...over });
    for (const i of [input(), input({ appRef: null }), input({ holderKind: 'WORKER', holderRef: w.workerId })]) {
      const c = await refused((grantCreateMutations.createGrant as any)(null, { input: i }, runContext(db, run)));
      expect(['GRANT_NOT_MANAGER', 'GRANT_REQUESTER_NOT_WORKER']).toContain(c);
    }
    expect(await rows()).toHaveLength(0);
    await ask(run);
    expect((await rows())[0]).toMatchObject({ requested_by_user_id: null, requested_by_run_id: run.id });
  });

  it('B7: a run that is not RUNNING, a principal naming another run or App, or an agentless run: the concealing APP_NOT_FOUND, nothing written', async () => {
    for (const status of ['COMPLETED', 'FAILED', 'CANCELLED', 'TIMED_OUT']) {
      const done = await mintRun(w.appId, w.agentId);
      await db.appRun.update({ where: { id: done.id }, data: { status } as never });
      expect(await refused(ask(done))).toBe('APP_NOT_FOUND');
    }
    const run = await mintRun(w.appId, w.agentId);
    const other = await mintRun(w.appId, w.agentId);
    const wrongRun = { ...ctxOf(run), principal: runContext(db, other) };
    expect(await refused(hadronCreateGrant.execute(wrongRun, { action: 'schedule.create', values: entry(), reason: 'x' }))).toBe('APP_NOT_FOUND');
    const app2Run = await mintRun(w.app2Id, w.agentId);
    const wrongApp = { ...ctxOf(run), principal: runContext(db, app2Run) };
    expect(await refused(hadronCreateGrant.execute(wrongApp, { action: 'schedule.create', values: entry(), reason: 'x' }))).toBe('APP_NOT_FOUND');
    const noAgent = { ...ctxOf(run), run: { ...run, agentId: null } as AppRun };
    expect(await refused(hadronCreateGrant.execute(noAgent, { action: 'schedule.create', values: entry(), reason: 'x' }))).toBe('APP_NOT_FOUND');
    const notRun = { ...ctxOf(run), principal: { ...runContext(db, run), clientId: 'other' } };
    expect(await refused(hadronCreateGrant.execute(notRun as never, { action: 'schedule.create', values: entry(), reason: 'x' }))).toBe('APP_NOT_FOUND');
    expect(await rows()).toHaveLength(0);
  });

  it('B8 + B17: the S2a refusals keep their wire codes, each before any write; no value in the message', async () => {
    const run = await mintRun(w.appId, w.agentId);
    expect(await refused(ask(run, { action: 'no.such.action' }))).toBe('GRANT_ACTION_UNKNOWN');
    expect(await refused(ask(run, { values: { entryNode: pubNode, extra: 'x' } }))).toBe('GRANT_VALUES_INVALID');
    expect(await refused(ask(run, { values: { entryNode: 5 } }))).toBe('GRANT_VALUES_INVALID');
    expect(await refused(ask(run, { values: { entryNode: '*' } }))).toBe('GRANT_VALUES_INVALID');
    expect(await refused(ask(run, { values: { entryNode: 'not an id!' } }))).toBe('GRANT_VALUES_INVALID');
    expect(await refused(ask(run, { reason: '   ' }))).toBe('GRANT_TERMS_INVALID');
    expect(await refused(ask(run, { reason: undefined }))).toBe('GRANT_TERMS_INVALID');
    expect(await refused(ask(run, { action: 7 }))).toBe('GRANT_ACTION_UNKNOWN');
    expect(await rows()).toHaveLength(0);
  });

  it('B16: an entry node that does not exist or is in another org gets the same answer', async () => {
    const run = await mintRun(w.appId, w.agentId);
    const org = await db.organization.create({ data: { name: 'f', urn: `f-${generateId().slice(0, 6)}.test` } });
    const memory = await db.memory.create({ data: { id: generateId(), organizationId: org.id, urn: `${org.urn}:kb`, name: 'kb', class: 'knowledge', visibility: 'ORGANIZATION' } as never });
    const foreign = (await db.node.create({ data: { id: generateId(), memoryId: memory.id, loc: 'n0', name: 'n0', nodeType: 'info', content: 'x' } as never })).id;
    const answers = new Set<string>();
    for (const node of [generateId(), foreign]) {
      try { await ask(run, { values: { entryNode: node } }); throw new Error('no refusal'); } catch (e) { answers.add(`${(e as GraphQLError).extensions?.code}|${(e as GraphQLError).message}`); }
    }
    expect(answers.size).toBe(1);
    expect(await rows()).toHaveLength(0);
  });

  it('B12: the policy chain gates tool.hadron_create_grant at cost 1; a denial writes nothing', async () => {
    expect(hadronCreateGrant.policyAction ?? `tool.${hadronCreateGrant.name}`).toBe('tool.hadron_create_grant');
    expect(hadronCreateGrant.policyAction ?? `tool.${hadronCreateGrant.name}`).not.toBe(hadronListGrants.policyAction ?? `tool.${hadronListGrants.name}`);
    expect(hadronCreateGrant.cost).toBe(1);
    const run = await mintRun(w.appId, w.agentId);
    const seen: Array<[string, number]> = [];
    await expect(admitAndExecuteTool(hadronCreateGrant, { action: 'schedule.create', values: entry(), reason: 'x' }, { toolCtx: ctxOf(run), onToolCall: async (a, c) => { seen.push([a, c]); return false; } })).rejects.toBeInstanceOf(ToolDeniedError);
    expect(seen).toEqual([['tool.hadron_create_grant', 1]]);
    expect(await rows()).toHaveLength(0);
    await admitAndExecuteTool(hadronCreateGrant, { action: 'schedule.create', values: entry(), reason: 'x' }, { toolCtx: ctxOf(run), onToolCall: async () => true });
    expect(await rows()).toHaveLength(1);
  });

  it('B17: through the kernel path a refusal keeps its code and the values stay out of the log', async () => {
    const run = await mintRun(w.appId, w.agentId);
    const c = ctxOf(run);
    await expect(admitAndExecuteTool(hadronCreateGrant, { action: 'schedule.create', values: { entryNode: 'bad id' }, reason: 'secretish' }, { toolCtx: c, onToolCall: async () => true }))
      .rejects.toMatchObject({ name: 'ToolExecutionError' });
    await ask(run).then(() => undefined);
    expect(c.log as ReturnType<typeof vi.fn>).not.toHaveBeenCalled();
    const c2 = ctxOf(run);
    await hadronCreateGrant.execute(c2, { action: 'schedule.create', values: entry(), reason: 'do not log me' });
    const lines = (c2.log as ReturnType<typeof vi.fn>).mock.calls.map((x) => String(x[0]));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/^requested grant \S+ for schedule\.create$/);
    expect(lines.join()).not.toContain(pubNode);
    expect(lines.join()).not.toContain('do not log me');
  });

  it('signing gate: the tool exists only where signing is on (resolveRunTools)', () => {
    expect(resolveRunTools(['hadron_create_grant']).unknown).toEqual([]);
    vi.stubEnv('PASSKEY_SIGNING_ENABLED', 'false');
    const off = resolveRunTools(['hadron_create_grant', 'hadron_list_grants']);
    expect(off.unknown).toEqual(['hadron_create_grant']);
    expect(off.tools.map((t) => t.name)).not.toContain('hadron_create_grant');
    vi.stubEnv('PASSKEY_SIGNING_ENABLED', 'true');
  });

  it('signing gate at execute: a run resolved while signing was on writes nothing once it is off', async () => {
    const run = await mintRun(w.appId, w.agentId);
    vi.stubEnv('PASSKEY_SIGNING_ENABLED', 'false');
    expect(await refused(ask(run))).toBe('GRANT_TERMS_INVALID');
    vi.stubEnv('PASSKEY_SIGNING_ENABLED', 'true');
    expect(await rows()).toHaveLength(0);
  });

  it('a term the caller gives that is malformed is refused, never read as absent (it would widen the grant)', async () => {
    const run = await mintRun(w.appId, w.agentId);
    for (const bad of [{ startsAt: 5 }, { expiresAt: {} }, { expiresAt: 'not a date' }, { startsAt: 'x' }, { expiresAt: true }, { maxUses: 0 }, { maxUses: -1 }, { maxUses: 1.5 }, { maxUses: '3' }]) {
      expect(await refused(ask(run, bad)), JSON.stringify(bad)).toBe('GRANT_TERMS_INVALID');
    }
    expect(await rows()).toHaveLength(0);
    await ask(run, { expiresAt: new Date(Date.now() + 86400000).toISOString(), maxUses: 2 });
    expect((await rows())[0]).toMatchObject({ max_uses: 2 });
    expect((await rows())[0].expires_at).not.toBeNull();
  });

  it('B14 (structural only): no non-run caller reaches the run arm: the tool refuses any principal that is not THIS run (isRunPrincipal and clientId run:<runId>), and its schema has no holder, App or activation key', async () => {
    const run = await mintRun(w.appId, w.agentId, { userId: w.user2Id });
    const person = { ...runContext(db, run), clientId: undefined };
    for (const principal of [person, { ...runContext(db, run), clientId: 'user:x' }, { ...runContext(db, run), clientId: `run:${generateId()}` }]) {
      expect(await refused(hadronCreateGrant.execute({ ...ctxOf(run), principal: principal as never }, { action: 'schedule.create', values: entry(), reason: 'x' }))).toBe('APP_NOT_FOUND');
    }
    expect(await rows()).toHaveLength(0);
    expect(Object.keys((hadronCreateGrant.inputSchema as any).properties).sort()).toEqual(['action', 'expiresAt', 'maxUses', 'reason', 'startsAt', 'values']);
    expect((hadronCreateGrant.inputSchema as any).additionalProperties).toBe(false);
  });

  it('core run arm: a run row of another App, or naming another agent, is refused by the core itself (the locked run row, not the caller, decides)', async () => {
    const other = await newAgent('other');
    await db.appAgent.create({ data: { appId: w.appId, agentId: other.id } });
    const run = await mintRun(w.appId, w.agentId);
    const args = (appId: string, agentId: string) => ({
      appId, requester: { runId: run.id, agentId }, holder: { kind: 'agent' as const, id: agentId }, heldAgentAnchor: agentId, action: 'schedule.create',
      values: entry(), reason: 'x', canReadMemory: async () => true,
    });
    const { createPendingGrant, GrantRunGone } = await import('../../grants/create.js');
    await expect(db.$transaction((tx) => createPendingGrant(tx, args(w.app2Id, w.agentId)))).rejects.toBeInstanceOf(GrantRunGone);
    await expect(db.$transaction((tx) => createPendingGrant(tx, args(w.appId, other.id)))).rejects.toBeInstanceOf(GrantRunGone);
    expect(await rows()).toHaveLength(0);
    await db.$transaction((tx) => createPendingGrant(tx, args(w.appId, w.agentId)));
    expect(await rows()).toHaveLength(1);
  });

  describe('races (two connections)', () => {
    async function waitUntilBlocked(): Promise<void> {
      for (let i = 0; i < 200; i += 1) {
        const [{ n }] = await db.$queryRawUnsafe<Array<{ n: number }>>("SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock'");
        if (n > 0) return;
        await new Promise((r) => setTimeout(r, 50));
      }
      throw new Error('the call never blocked on a lock');
    }

    it('B9a: deleteAgent holds the agent anchor and commits first: the create waits, is refused (holder), writes nothing', async () => {
      const run = await mintRun(w.appId, w.agentId);
      let release!: () => void; const held = new Promise<void>((r) => { release = r; });
      let locked!: () => void; const taken = new Promise<void>((r) => { locked = r; });
      const deleter = db.$transaction(async (tx) => {
        await lockAuthorityAnchors(tx, [{ kind: 'agent', id: w.agentId }], 'exclusive');
        locked(); await held;
        await tx.agent.update({ where: { id: w.agentId }, data: { deletedAt: new Date() } });
      }, { timeout: 30000 });
      await taken;
      const call = ask(run).then(() => 'ok', (e: GraphQLError) => e.extensions?.code);
      await waitUntilBlocked();
      release(); await deleter;
      expect(await call).toBe('GRANT_HOLDER_NOT_ALLOWED');
      expect(await rows()).toHaveLength(0);
    });

    it('B9b (sequential, not a race): the create finishes first: the row exists pending, and the agent delete that follows succeeds', async () => {
      const run = await mintRun(w.appId, w.agentId);
      await ask(run);
      await db.agent.update({ where: { id: w.agentId }, data: { deletedAt: new Date() } });
      expect(await rows()).toHaveLength(1);
      expect((await rows())[0].activated_at).toBeNull();
    });

    it('B10: uninstall holding the App and agent anchors commits first: the create is refused, no row; create first: the row exists, pending', async () => {
      const run = await mintRun(w.appId, w.agentId);
      let release!: () => void; const held = new Promise<void>((r) => { release = r; });
      let locked!: () => void; const taken = new Promise<void>((r) => { locked = r; });
      const uninstall = db.$transaction(async (tx) => {
        await lockAuthorityAnchors(tx, [{ kind: 'app', id: w.appId }, { kind: 'agent', id: w.agentId }], 'exclusive');
        locked(); await held;
        await tx.appAgent.deleteMany({ where: { appId: w.appId, agentId: w.agentId } });
      }, { timeout: 30000 });
      await taken;
      const call = ask(run).then(() => 'ok', (e: GraphQLError) => e.extensions?.code);
      await waitUntilBlocked();
      release(); await uninstall;
      expect(await call).toBe('GRANT_HOLDER_NOT_ALLOWED');
      expect(await rows()).toHaveLength(0);
      await db.appAgent.create({ data: { appId: w.appId, agentId: w.agentId } });
      await ask(run);
      expect(await rows()).toHaveLength(1);
    });

    it('B11: the run finishing (row locked, status flipped) commits first: the create waits on the run row, is refused APP_NOT_FOUND, no row', async () => {
      const run = await mintRun(w.appId, w.agentId);
      let release!: () => void; const held = new Promise<void>((r) => { release = r; });
      let locked!: () => void; const taken = new Promise<void>((r) => { locked = r; });
      const finisher = db.$transaction(async (tx) => {
        await tx.$queryRawUnsafe('SELECT id FROM app_runs WHERE id = $1 FOR UPDATE', run.id);
        locked(); await held;
        await tx.appRun.update({ where: { id: run.id }, data: { status: 'COMPLETED' } as never });
      }, { timeout: 30000 });
      await taken;
      const call = ask(run).then(() => 'ok', (e: GraphQLError) => e.extensions?.code);
      await waitUntilBlocked();
      release(); await finisher;
      expect(await call).toBe('APP_NOT_FOUND');
      expect(await rows()).toHaveLength(0);
    });
  });
});
