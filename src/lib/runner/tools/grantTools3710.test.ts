/**
 * #3710 (Grants S2a-run; cor:acl:140:05 "An agent reads its own grants", cor:agt:010:01 rev 45, cor:acl:040:02): the run tool
 * `hadron_list_grants`. A run lists the grants its OWN agent holds in its OWN App, through S2a's data-layer read
 * (`listGrantsForRunAgent`), ids and scalars only. Pins, one per gate item:
 *   1  every state listed, with `allows` and `state` from the one live function and the one derivation;
 *   2  two Apps, two agents: no other App's grant, no other agent's, not the same agent's grant in another App (item 20b),
 *      not a base agent's (20a), nothing held by a worker, person or App;
 *   3  a run without an agent has no branch: it is refused and reads nothing (mutant: an agentless fallback);
 *   4  the policy chain gates `tool.hadron_list_grants`, at cost 0.
 * Plus the principal guard, closed arguments, a deleted App's concealment and an uninstalled agent.
 */
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { evaluatePolicyChain, parsePolicyLink } from '@hadron-memory/access-control';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { generateId } from '../../id.js';
import { runContext } from '../../../jobs/appRunDeps.js';
import { WORKER_SIGNATURE_DEFAULTS } from '../../workerSignature.js';
import { DB_NOW, dbNowPlus, dropTestActions, insertGrant, insertGrantUnguarded, raw, seedWorld, type World } from '../../grants/grantFixtures3668.js';
import { hadronListGrants, resolveRunTools } from './index.js';
import type { AppRun } from '../../../generated/prisma/index.js';
import type { RunToolContext } from './types.js';

let w: World;
beforeEach(async () => {
  await cleanDb(db);
  w = await seedWorld();
  await db.appAgent.create({ data: { appId: w.appId, agentId: w.agentId } });
});
afterAll(async () => { await cleanDb(db); await dropTestActions(); });

async function mintRun(appId: string, agentId: string | null): Promise<AppRun> {
  const run = await db.appRun.create({ data: { id: generateId(), organizationId: (await db.app.findUniqueOrThrow({ where: { id: appId } })).organizationId as string, appId, agentId: agentId as string, triggerKind: 'MANUAL', entryNodeUrn: 'x::m::flow:entry', status: 'RUNNING' } });
  return run;
}
const ctxOf = (run: AppRun): RunToolContext => ({ log: vi.fn(), db, run, principal: runContext(db, run) });
const call = async (run: AppRun, args: Record<string, unknown> = {}) => hadronListGrants.execute(ctxOf(run), args) as Promise<{ grants: Array<Record<string, unknown>>; total: number; limit: number; offset: number; hasMore: boolean }>;
const agentGrant = (agentId: string, appId: string, over: Record<string, unknown> = {}) => insertGrant(w, { user_id: null, agent_id: agentId, app_id: appId, ...over } as never);
const newAgent = (name: string, extra: Record<string, unknown> = {}) => db.agent.create({ data: { organizationId: w.orgId, name, urn: `${w.orgUrn}:${name}-${generateId().slice(0, 6)}`, ...extra } });

describe('hadron_list_grants (#3710)', () => {
  it('1: lists the run agent\'s grants in every state, with allows and state, ids and scalars only', async () => {
    const run = await mintRun(w.appId, w.agentId);
    const pending = await agentGrant(w.agentId, w.appId);
    const active = await insertGrantUnguarded(w, { user_id: null, agent_id: w.agentId, activated_at: raw(DB_NOW), verification_kind: 'TEST', verified_by: 't' });
    const revoked = await insertGrantUnguarded(w, { user_id: null, agent_id: w.agentId, activated_at: raw(DB_NOW), verification_kind: 'TEST', verified_by: 't', revoked_at: raw(DB_NOW), revoked_by: w.userId });
    const expired = await insertGrantUnguarded(w, { user_id: null, agent_id: w.agentId, created_at: raw(`${DB_NOW} - interval '3 hours'`), activated_at: raw(`${DB_NOW} - interval '2 hours'`), verification_kind: 'TEST', verified_by: 't', expires_at: raw(`${DB_NOW} - interval '1 hour'`) });
    const out = await call(run);
    expect(out.total).toBe(4);
    const byId = new Map(out.grants.map((g) => [g.id as string, g]));
    expect([...byId.keys()].sort()).toEqual([pending, active, revoked, expired].sort());
    expect(byId.get(active)).toMatchObject({ allows: true, state: 'ACTIVE', holderKind: 'AGENT', holderId: w.agentId, appId: w.appId });
    expect(byId.get(pending)).toMatchObject({ allows: false, state: 'PENDING' });
    expect(byId.get(revoked)).toMatchObject({ allows: false, state: 'REVOKED' });
    expect(byId.get(expired)).toMatchObject({ allows: false, state: 'EXPIRED' });
    for (const g of out.grants) {
      expect(typeof g.urn).toBe('string');
      for (const v of Object.values(g)) expect(v === null || typeof v !== 'object' || v instanceof Date || Array.isArray(v) || Object.getPrototypeOf(v) === Object.prototype).toBe(true);
      expect(g).not.toHaveProperty('revokedBy');
      expect(g).not.toHaveProperty('holderDepartedAt');
      expect(g).not.toHaveProperty('signatures');
    }
  });

  it('2 (§10): two Apps, two agents: only the run agent\'s grants in the run\'s own App', async () => {
    const mine = await agentGrant(w.agentId, w.appId);
    const other = await newAgent('other');
    await db.appAgent.create({ data: { appId: w.appId, agentId: other.id } });
    const othersGrant = await agentGrant(other.id, w.appId);
    await db.appAgent.create({ data: { appId: w.app2Id, agentId: w.agentId } });
    const myAgentInApp2 = await agentGrant(w.agentId, w.app2Id);
    await db.appAgent.create({ data: { appId: w.app2Id, agentId: other.id } });
    const othersInApp2 = await agentGrant(other.id, w.app2Id);

    const runA = await call(await mintRun(w.appId, w.agentId));
    expect(runA.grants.map((g) => g.id)).toEqual([mine]);
    expect(runA.total).toBe(1);
    // The same agent in the OTHER App sees only its own pair, never App A's (item 20b).
    const runB = await call(await mintRun(w.app2Id, w.agentId));
    expect(runB.grants.map((g) => g.id)).toEqual([myAgentInApp2]);
    // The other agent, in App A, sees only its own.
    const runOther = await call(await mintRun(w.appId, other.id));
    expect(runOther.grants.map((g) => g.id)).toEqual([othersGrant]);
    expect([...runA.grants, ...runB.grants, ...runOther.grants].map((g) => g.id)).not.toContain(othersInApp2);
  });

  it('2: a grant in an App where the run\'s agent holds nothing lists nothing, even when the agent holds one in another App (20b)', async () => {
    await db.appAgent.create({ data: { appId: w.app2Id, agentId: w.agentId } });
    await agentGrant(w.agentId, w.appId);
    const run = await call(await mintRun(w.app2Id, w.agentId));
    expect(run).toMatchObject({ grants: [], total: 0 });
  });

  it('2 (20a): never a base agent\'s grant, and never a grant held by a worker or a person', async () => {
    const child = await newAgent('child', { extendsAgentId: w.agentId });
    await db.appAgent.create({ data: { appId: w.appId, agentId: child.id } });
    await agentGrant(w.agentId, w.appId); // the BASE agent's grant
    await insertGrant(w, { user_id: null, worker_id: w.workerId }); // a worker's
    await insertGrant(w, {}); // a person's
    const run = await call(await mintRun(w.appId, child.id));
    expect(run).toMatchObject({ grants: [], total: 0 });
  });

  it('1 + 2 (Peter on #4598): lists the grants the App itself holds; never another App\'s, and never one naming this App from another App', async () => {
    const appHeld = await insertGrant(w, { user_id: null, grantee_app_id: w.appId });
    const mine = await agentGrant(w.agentId, w.appId);
    await db.appAgent.create({ data: { appId: w.app2Id, agentId: w.agentId } });
    const app2Held = await insertGrant(w, { app_id: w.app2Id, user_id: null, grantee_app_id: w.app2Id }); // another App's App-held
    const crossNaming = await insertGrant(w, { app_id: w.app2Id, user_id: null, grantee_app_id: w.appId }); // lives in App 2, names App 1
    const a = await call(await mintRun(w.appId, w.agentId));
    expect(a.grants.map((g) => g.id).sort()).toEqual([appHeld, mine].sort());
    expect(a.grants.find((g) => g.id === appHeld)).toMatchObject({ holderKind: 'APP', holderId: w.appId });
    const b = await call(await mintRun(w.app2Id, w.agentId));
    expect(b.grants.map((g) => g.id)).toEqual([app2Held]);
    expect([...a.grants, ...b.grants].map((g) => g.id)).not.toContain(crossNaming);
  });

  it('1: a spent grant is listed and allows nothing; the projection is exactly the Grant scalars', async () => {
    const spent = await insertGrantUnguarded(w, { user_id: null, agent_id: w.agentId, activated_at: raw(DB_NOW), verification_kind: 'TEST', verified_by: 't', max_uses: 1, use_count: 1 });
    const out = await call(await mintRun(w.appId, w.agentId));
    const g = out.grants.find((x) => x.id === spent)!;
    expect(g).toMatchObject({ state: 'SPENT', allows: false });
    expect(Object.keys(g).sort()).toEqual(['action', 'activatedAt', 'allows', 'appId', 'createdAt', 'expiresAt', 'holderId', 'holderKind', 'id', 'issuerUserId', 'maxUses', 'reason',
      'requestedBySessionId', 'requestedByUserId', 'requestedByWorkerId', 'revokedAt', 'signatureId', 'startsAt', 'state', 'urn', 'useCount', 'values', 'verificationKind', 'verifiedBy'].sort());
  });

  it('an installed agent whose licence is unusable lists nothing (licensing, not only installation)', async () => {
    const foreignOrg = await db.organization.create({ data: { name: 'foreign', urn: `foreign-${generateId().slice(0, 6)}.test` } });
    const foreign = await db.agent.create({ data: { organizationId: foreignOrg.id, name: 'foreign', urn: `${foreignOrg.urn}:agent` } });
    await db.appAgent.create({ data: { appId: w.appId, agentId: foreign.id } });
    await agentGrant(foreign.id, w.appId);
    const { isAgentInstalledAndLicensed } = await import('../../appAgent.js');
    // The fixture must be the distinct condition: installed by a row, yet not licensed here.
    expect(await isAgentInstalledAndLicensed(db, w.appId, foreign.id)).toBe(false);
    expect(await call(await mintRun(w.appId, foreign.id))).toMatchObject({ grants: [], total: 0 });
  });

  it('hasMore is false on an empty page, even with an offset past the end', async () => {
    await agentGrant(w.agentId, w.appId);
    const out = await call(await mintRun(w.appId, w.agentId), { offset: 5 });
    expect(out).toMatchObject({ grants: [], total: 1, hasMore: false });
  });

  it('3: a run without an agent is refused and reads nothing: no agentless fallback', async () => {
    await agentGrant(w.agentId, w.appId);
    await insertGrant(w, { user_id: null, worker_id: w.workerId });
    const run = await mintRun(w.appId, w.agentId);
    const agentless = { ...run, agentId: null } as AppRun;
    await expect(call(agentless)).rejects.toMatchObject({ extensions: { code: 'GRANT_READ_NO_AGENT' } });
  });

  it('4: tool.hadron_list_grants is registered at cost 0 and deniable through the policy chain', () => {
    const { tools, unknown } = resolveRunTools(['hadron_list_grants']);
    expect(unknown).toEqual([]);
    const def = tools.find((t) => t.name === 'hadron_list_grants')!;
    expect(def.cost).toBe(0);
    expect(def.policyAction).toBeUndefined();
    const restrictive = parsePolicyLink({ allow: ['run.execute', 'llm.invoke'] });
    expect(evaluatePolicyChain('tool.hadron_list_grants', [restrictive])).toBe(false);
    expect(evaluatePolicyChain('tool.hadron_list_grants', [parsePolicyLink({ allow: ['tool.hadron_list_grants'] })])).toBe(true);
    expect(evaluatePolicyChain('tool.hadron_list_grants', [parsePolicyLink({ allow: ['*'] }), restrictive])).toBe(false);
  });

  it('refuses a principal that is not this run\'s run principal', async () => {
    const run = await mintRun(w.appId, w.agentId);
    const other = await mintRun(w.appId, w.agentId);
    await expect(hadronListGrants.execute({ ...ctxOf(run), principal: runContext(db, other) }, {})).rejects.toMatchObject({ extensions: { code: 'GRANT_READ_NO_AGENT' } });
    await expect(hadronListGrants.execute({ ...ctxOf(run), principal: { appId: w.appId } as never }, {})).rejects.toMatchObject({ extensions: { code: 'GRANT_READ_NO_AGENT' } });
  });

  it('accepts no App, agent or holder selector as model input', async () => {
    const run = await mintRun(w.appId, w.agentId);
    for (const bad of [{ appId: w.app2Id }, { agentId: w.agentId }, { holder: 'x' }, { limit: 0 }, { limit: 201 }, { offset: -1 }, { limit: 1.5 }]) {
      await expect(call(run, bad)).rejects.toMatchObject({ extensions: { code: 'GRANT_READ_INVALID_ARGUMENT' } });
    }
  });

  it('pages newest first with limit and offset', async () => {
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) ids.push(await agentGrant(w.agentId, w.appId, { created_at: dbNowPlus(`${i} seconds`) }));
    const run = await mintRun(w.appId, w.agentId);
    const first = await call(run, { limit: 2 });
    expect(first.grants.map((g) => g.id)).toEqual([ids[2], ids[1]]);
    expect(first).toMatchObject({ total: 3, limit: 2, offset: 0, hasMore: true });
    const second = await call(run, { limit: 2, offset: 2 });
    expect(second.grants.map((g) => g.id)).toEqual([ids[0]]);
    expect(second.hasMore).toBe(false);
  });

  it('conceals a soft-deleted App\'s grants and lists nothing once the agent is uninstalled', async () => {
    await agentGrant(w.agentId, w.appId);
    const run = await mintRun(w.appId, w.agentId);
    expect((await call(run)).total).toBe(1);
    await db.appAgent.delete({ where: { appId_agentId: { appId: w.appId, agentId: w.agentId } } });
    expect(await call(run)).toMatchObject({ grants: [], total: 0 });
    await db.appAgent.create({ data: { appId: w.appId, agentId: w.agentId } });
    expect((await call(run)).total).toBe(1);
    await db.app.update({ where: { id: w.appId }, data: { deletedAt: new Date() } });
    expect(await call(run)).toMatchObject({ grants: [], total: 0 });
  });
});
