/**
 * #4767 (Grants R6; cor:acl:140:03 item 5 through ruling 0255 item 21, cor:acl:140:05): the run tool `hadron_withdraw_grant`.
 * A headless run of agent A withdraws a PENDING grant its OWN AGENT asked for through a run (`requested_by_run_id`): the
 * requester is judged on the row's holder and its run column, never on the calling run's identity, so a later run of the same
 * agent qualifies exactly as much as the one that asked. The row records no person (`revoked_by` stays NULL,
 * `withdrawn_at = revoked_at`), and the one WITHDRAW event carries the withdrawing run and nothing else.
 *
 * Every refusal that could tell the caller a grant exists — an unknown id, another agent's run-made grant, this agent's
 * run-made grant in another App, a grant a person or a worker asked for — is byte-identical to 'not your request'
 * (GRANT_NOT_REQUESTER, S2b's text). Only a grant the rightful caller already had activated answers GRANT_NOT_PENDING, which
 * leaks nothing: it fires after the requester match, and the rightful requester can read the row's state anyway (#3710).
 * Resolver-level pins call the tool through the real run principal (`runContext`); policy pins go through `admitAndExecuteTool`.
 */
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { GraphQLError } from 'graphql';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { generateId } from '../../id.js';
import { runContext } from '../../../jobs/appRunDeps.js';
import { upsertPlatformActions } from '../../grants/actions.js';
import { isGrantLive } from '../../grants/live.js';
import { admitAndExecuteTool, ToolDeniedError } from '../toolAdmission.js';
import { DB_NOW, dropTestActions, insertGrant, insertGrantUnguarded, raw, seedReadableNodes, seedWorld, type World } from '../../grants/grantFixtures3668.js';
import { hadronCreateGrant, hadronListGrants, hadronWithdrawGrant, resolveRunTools } from './index.js';
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
const ask = (run: AppRun) => hadronCreateGrant.execute(ctxOf(run), { action: 'schedule.create', values: entry(), reason: 'nightly digest' }) as Promise<{ id: string }>;
const pull = (run: AppRun, grantId: unknown, extra: Record<string, unknown> = {}) => hadronWithdrawGrant.execute(ctxOf(run), { grantId, ...extra }) as Promise<{ id: string; status: string }>;
const rows = () => db.$queryRawUnsafe<any[]>('SELECT * FROM grants ORDER BY created_at');
const events = () => db.$queryRawUnsafe<any[]>('SELECT * FROM grant_events');
async function refused(p: Promise<unknown>): Promise<string | undefined> {
  try { await p; } catch (e) { expect(e).toBeInstanceOf(GraphQLError); return (e as GraphQLError).extensions?.code as string; }
  throw new Error('expected a refusal');
}
/** Every answer of the concealing set as `code|message`, so a pin can assert they are ONE answer. */
async function answered(p: Promise<unknown>): Promise<string> {
  try { await p; } catch (e) { expect(e).toBeInstanceOf(GraphQLError); return `${(e as GraphQLError).extensions?.code}|${(e as GraphQLError).message}`; }
  throw new Error('expected a refusal');
}
const newAgent = (name: string) => db.agent.create({ data: { organizationId: w.orgId, name, urn: `${w.orgUrn}:${name}-${generateId().slice(0, 6)}` } });
const live = (row: any) => isGrantLive({ activatedAt: row.activated_at, revokedAt: row.revoked_at, startsAt: row.starts_at, expiresAt: row.expires_at, maxUses: row.max_uses, useCount: row.use_count, holderDepartedAt: row.holder_departed_at, appDeletedAt: null, actionMaxUses: null, actionLifetimeSeconds: null } as never, new Date());

describe('hadron_withdraw_grant (#4767)', () => {
  it('R1: a LATER run of the same agent withdraws a pending run-made grant: stamped, not live, no person on the row, one WITHDRAW event naming the withdrawing run', async () => {
    const asker = await mintRun(w.appId, w.agentId);
    const { id } = await ask(asker);
    const withdrawer = await mintRun(w.appId, w.agentId);
    const out = await pull(withdrawer, id);
    expect(out).toMatchObject({ id, status: 'withdrawn' });
    const [row] = await rows();
    expect(row).toMatchObject({ id, revoked_by: null, activated_at: null, agent_id: w.agentId, app_id: w.appId });
    expect(row.revoked_at).not.toBeNull();
    expect(row.withdrawn_at).toEqual(row.revoked_at);
    expect(live(row)).toBe(false);
    expect(await events()).toHaveLength(1);
    expect(await events()).toMatchObject([{ grant_id: id, app_id: w.appId, action: 'WITHDRAW', actor_user_id: null, worker_id: null, session_id: null, run_id: withdrawer.id }]);
  });

  it('R2: the run that asked may withdraw its own pending grant too (the match is on the agent, not the run identity)', async () => {
    const asker = await mintRun(w.appId, w.agentId);
    const { id } = await ask(asker);
    const out = await pull(asker, id);
    expect(out).toMatchObject({ id, status: 'withdrawn' });
    expect((await events())[0]).toMatchObject({ action: 'WITHDRAW', run_id: asker.id, actor_user_id: null });
  });

  it('R3: one answer for every way the grant is not this agent\'s own run-made request: unknown id, another agent\'s, this agent\'s in another App, a worker\'s or a person\'s request', async () => {
    const run = await mintRun(w.appId, w.agentId);
    const other = await newAgent('other');
    await db.appAgent.create({ data: { appId: w.appId, agentId: other.id } });
    const foreign = (await ask(await mintRun(w.appId, other.id))).id; // another agent's run-made grant, same App
    await db.appAgent.create({ data: { appId: w.app2Id, agentId: w.agentId } });
    const elsewhere = (await ask(await mintRun(w.app2Id, w.agentId))).id; // this agent's run-made grant, ANOTHER App
    const workerMade = await insertGrant(w, { user_id: null, worker_id: null, agent_id: w.agentId, requested_by_worker_id: w.workerId }); // held by A, asked for by a worker session
    const personMade = await insertGrant(w, { user_id: null, worker_id: null, agent_id: w.agentId, requested_by_user_id: w.userId }); // held by A, asked for by a person
    const answers = new Set<string>();
    for (const id of [generateId(), foreign, elsewhere, workerMade, personMade]) answers.add(await answered(pull(run, id)));
    expect(answers.size).toBe(1);
    expect([...answers][0]).toBe('GRANT_NOT_REQUESTER|Only the one who asked for a grant can withdraw it.');
    expect((await rows()).filter((r) => r.revoked_at !== null)).toHaveLength(0);
    expect(await events()).toHaveLength(0);
  });

  it('R4: a grant that was activated is refused GRANT_NOT_PENDING (S2b\'s rule) and stays live', async () => {
    const run = await mintRun(w.appId, w.agentId);
    const id = await insertGrantUnguarded(w, {
      user_id: null, worker_id: null, agent_id: w.agentId, requested_by_run_id: run.id,
      issuer_user_id: w.userId, verification_kind: 'passkey', verified_by: w.userId, activated_at: raw(DB_NOW),
    });
    expect(await refused(pull(run, id))).toBe('GRANT_NOT_PENDING');
    const [row] = await rows();
    expect(row.revoked_at).toBeNull();
    expect(live(row)).toBe(true);
    expect(await events()).toHaveLength(0);
  });

  it('R5: a withdrawal is once: a second call writes nothing new and answers the row as it is', async () => {
    const asker = await mintRun(w.appId, w.agentId);
    const { id } = await ask(asker);
    await pull(asker, id);
    const before = (await rows())[0];
    const again = await pull(asker, id);
    expect(again).toMatchObject({ id, status: 'withdrawn' });
    const after = (await rows())[0];
    expect(after.revoked_at).toEqual(before.revoked_at);
    expect(after.withdrawn_at).toEqual(before.withdrawn_at);
    expect(await events()).toHaveLength(1);
  });

  it('R6: a run that is not RUNNING, a principal naming another run or App, or an agentless run: the concealing APP_NOT_FOUND, nothing written', async () => {
    const asker = await mintRun(w.appId, w.agentId);
    const { id } = await ask(asker);
    for (const status of ['COMPLETED', 'FAILED', 'CANCELLED', 'TIMED_OUT']) {
      const done = await mintRun(w.appId, w.agentId);
      await db.appRun.update({ where: { id: done.id }, data: { status } as never });
      expect(await refused(pull(done, id))).toBe('APP_NOT_FOUND');
    }
    const run = await mintRun(w.appId, w.agentId);
    const other = await mintRun(w.appId, w.agentId);
    const wrongRun = { ...ctxOf(run), principal: runContext(db, other) };
    expect(await refused(hadronWithdrawGrant.execute(wrongRun, { grantId: id }))).toBe('APP_NOT_FOUND');
    const app2Run = await mintRun(w.app2Id, w.agentId);
    const wrongApp = { ...ctxOf(run), principal: runContext(db, app2Run) };
    expect(await refused(hadronWithdrawGrant.execute(wrongApp, { grantId: id }))).toBe('APP_NOT_FOUND');
    const noAgent = { ...ctxOf(run), run: { ...run, agentId: null } as AppRun };
    expect(await refused(hadronWithdrawGrant.execute(noAgent, { grantId: id }))).toBe('APP_NOT_FOUND');
    const notRun = { ...ctxOf(run), principal: { ...runContext(db, run), clientId: 'other' } };
    expect(await refused(hadronWithdrawGrant.execute(notRun as never, { grantId: id }))).toBe('APP_NOT_FOUND');
    expect((await rows())[0].revoked_at).toBeNull();
    expect(await events()).toHaveLength(0);
  });

  it('R7: the tool exists only where signing is on, and a run resolved while it was on writes nothing once it is off', async () => {
    expect(resolveRunTools(['hadron_withdraw_grant']).unknown).toEqual([]);
    // The ask happens while signing is ON (the run resolved its tools then); only the withdrawal is attempted with it off.
    const asker = await mintRun(w.appId, w.agentId);
    const { id } = await ask(asker);
    vi.stubEnv('PASSKEY_SIGNING_ENABLED', 'false');
    const off = resolveRunTools(['hadron_withdraw_grant', 'hadron_list_grants']);
    expect(off.unknown).toEqual(['hadron_withdraw_grant']);
    expect(off.tools.map((t) => t.name)).not.toContain('hadron_withdraw_grant');
    expect(await refused(pull(asker, id))).toBe('GRANT_SIGNING_UNAVAILABLE');
    vi.stubEnv('PASSKEY_SIGNING_ENABLED', 'true');
    expect((await rows())[0].revoked_at).toBeNull();
  });

  it('R8: the policy chain gates tool.hadron_withdraw_grant at cost 1; a denial writes nothing', async () => {
    expect(hadronWithdrawGrant.policyAction ?? `tool.${hadronWithdrawGrant.name}`).toBe('tool.hadron_withdraw_grant');
    expect(hadronWithdrawGrant.policyAction ?? `tool.${hadronWithdrawGrant.name}`).not.toBe(hadronListGrants.policyAction ?? `tool.${hadronListGrants.name}`);
    expect(hadronWithdrawGrant.cost).toBe(1);
    const asker = await mintRun(w.appId, w.agentId);
    const { id } = await ask(asker);
    const run = await mintRun(w.appId, w.agentId);
    const seen: Array<[string, number]> = [];
    await expect(admitAndExecuteTool(hadronWithdrawGrant, { grantId: id }, { toolCtx: ctxOf(run), onToolCall: async (a, c) => { seen.push([a, c]); return false; } })).rejects.toBeInstanceOf(ToolDeniedError);
    expect(seen).toEqual([['tool.hadron_withdraw_grant', 1]]);
    expect((await rows())[0].revoked_at).toBeNull();
    expect(await events()).toHaveLength(0);
    await admitAndExecuteTool(hadronWithdrawGrant, { grantId: id }, { toolCtx: ctxOf(run), onToolCall: async () => true });
    expect((await rows())[0].revoked_at).not.toBeNull();
  });

  it('R9: the call takes exactly one key, grantId: anything else is refused before any read', async () => {
    const run = await mintRun(w.appId, w.agentId);
    for (const bad of [{}, { grantId: 5 }, { grantId: null }, { id: 'x' }, { grantId: 'x', force: true }, { ref: 'x' }]) {
      expect(await refused(hadronWithdrawGrant.execute(ctxOf(run), bad as never)), JSON.stringify(bad)).toBe('GRANT_WITHDRAW_INVALID_ARGUMENT');
    }
    expect(await rows()).toHaveLength(0);
  });

  it('R10: a gone anchor under the lock is concealed (Rook P3-1, Beatrix P3-2): a deleted agent answers GRANT_NOT_REQUESTER, a gone org or owner the create arm\'s APP_NOT_FOUND; nothing is ever written', async () => {
    const asker = await mintRun(w.appId, w.agentId);
    const { id } = await ask(asker);
    // A gone ORG: the anchor's liveness re-read denies under the lock; the fresh reads conceal it as the create arm does.
    await db.organization.update({ where: { id: w.orgId }, data: { deletedAt: new Date() } });
    expect(await refused(pull(asker, id))).toBe('APP_NOT_FOUND');
    await db.organization.update({ where: { id: w.orgId }, data: { deletedAt: null } });
    // A gone OWNER (the App becomes user-owned after the ask — the org/owner XOR forces the flip — and the anchors follow
    // the App row the withdrawal reads).
    await db.app.update({ where: { id: w.appId }, data: { organizationId: null, ownerUserId: w.user2Id } });
    await db.user.update({ where: { id: w.user2Id }, data: { deletedAt: new Date() } });
    expect(await refused(pull(asker, id))).toBe('APP_NOT_FOUND');
    await db.user.update({ where: { id: w.user2Id }, data: { deletedAt: null } });
    await db.app.update({ where: { id: w.appId }, data: { organizationId: w.orgId, ownerUserId: null } });
    // A gone AGENT: its grants are not this run's to withdraw any more — the requester refusal, not the App's.
    await db.agent.update({ where: { id: w.agentId }, data: { deletedAt: new Date() } });
    expect(await refused(pull(asker, id))).toBe('GRANT_NOT_REQUESTER');
    const [row] = await rows();
    expect(row.revoked_at).toBeNull();
    expect(row.withdrawn_at).toBeNull();
    expect(row.holder_departed_at).toBeNull(); // a raw soft delete stamps nothing; only the code doors do
    expect(await events()).toHaveLength(0);
  });
});
