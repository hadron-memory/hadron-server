/**
 * #4823 (SEC10 delta on #4795; #4715 follow-up): the lapse sweeper stamps `holder_departed_at`, which revokes authority, yet it took
 * no authority anchor. With the #4715 fence it takes the App FOR SHARE and then an agent FOR NO KEY UPDATE; the uninstall door takes
 * the exclusive advisory anchors (app, agent), then the agent row FOR SHARE (withAuthorizedTx's anchor rows), then the App FOR NO KEY
 * UPDATE in afterLock. A sweep tick judging the agent being uninstalled cycled with the door: the sweeper waits on the agent row, the
 * door on the App row, and Postgres aborted one of them (40P01). Availability only: no grant survived wrongly.
 *
 * The fix: the sweeper takes `lockAuthorityAnchors(tx, agents, 'exclusive')` for every agent of its page, before any row lock, as every
 * other revoker does.
 *
 * Pins: (1) the cycle itself on two real connections (red on main: a 40P01 on one side); (2) the call shape, on the real sweeper: the
 * anchors are exclusive, name EVERY agent of the page across Apps, and come BEFORE the installation locks.
 *
 * The door's lock sequence that pin (1) stands in for is owned by `uninstallAgentFromAppCore`
 * (src/api/graphql/schema/resolvers.helpers.ts): `withAuthorizedTx` takes the exclusive anchors and the anchor rows FOR SHARE
 * (src/api/graphql/schema/authorizedTx.ts), then its afterLock takes the App FOR NO KEY UPDATE. The anchor keys come from
 * `authorityAnchorDomain`, the scheme `lockAuthorityAnchors` uses, so a change to the scheme moves both (#4874).
 */
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Client } from 'pg';
import * as anchors from '../auth/authorityAnchors.js';
import * as installs from '../appInstallations.js';
import { db } from '../../integrations/db/client.js';
import { cleanDb } from '../../test/helpers.js';
import { generateId } from '../id.js';
import { upsertPlatformActions } from './actions.js';
import { DB_NOW, insertGrantUnguarded, raw, type World } from './grantFixtures3668.js';
import { authorityAnchorDomain } from '../auth/authorityAnchors.js';
import { sweepLapsedAgentGrants } from './lapseSweep.js';

/** The grant action the fixtures carry: a boot-prompt source edit grant held by the agent. */
const BOOTPROMPT_EDIT_ACTION = 'bootprompt.source.edit';
const WAIT_MS = 500;

let orgId: string;
let admin: { id: string };
let appId: string;
let agentId: string;
let nodeId: string;
const opened: Client[] = [];

async function mkAgent(name: string) {
  const mem = await db.memory.create({ data: { id: generateId(), class: 'system', name: `${name}-sys`, urn: `s4823.example:${name}-sys`, organizationId: orgId } });
  return (await db.agent.create({ data: { id: generateId(), name, urn: `s4823.example:${name}`, organizationId: orgId, systemMemoryId: mem.id } })).id;
}

async function mkApp(name: string) {
  const id = (await db.app.create({ data: { id: generateId(), name, urn: `s4823.example:${name}`, organizationId: orgId } })).id;
  return id;
}

beforeEach(async () => {
  await cleanDb(db);
  await upsertPlatformActions(db);
  orgId = (await db.organization.create({ data: { id: generateId(), name: 'S Org', urn: 's4823.example' } })).id;
  admin = await db.user.create({ data: { githubId: 482301, githubUsername: 's-admin', handle: 's-admin', roles: [] } });
  await db.orgMember.create({ data: { organizationId: orgId, userId: admin.id, role: 'ADMIN' } });
  appId = await mkApp('s-app');
  agentId = await mkAgent('held');
  await db.appAgent.create({ data: { appId, agentId } });
  const install = await db.memory.create({
    data: { id: generateId(), class: 'system', name: 'install', urn: 's4823.example:install', organizationId: orgId, appId, installOfAgentId: agentId, isInstallMemory: true },
  });
  nodeId = (await db.node.create({ data: { id: generateId(), memoryId: install.id, loc: 'boot:s', name: 'S', content: 'c', role: 'boot-prompt' } })).id;
});
afterAll(async () => { await cleanDb(db); });
afterEach(async () => {
  vi.restoreAllMocks();
  for (const c of opened.splice(0)) { await c.query('ROLLBACK').catch(() => undefined); await c.end().catch(() => undefined); }
});

/** The fixture World for one App: insertGrantUnguarded reads only appId and userId; the rest name nothing here. */
const worldFor = (app: string): World => ({ orgUrn: 's4823.example', orgId, appId: app, app2Id: '', userId: admin.id, user2Id: '', agentId: '', workerId: '', sessionId: '' });

/** An active, passkey-verified grant held by `agent` in `app`, inserted past the guard (the sweeper is what is under test). */
const grantFor = (app: string, agent: string): Promise<string> => insertGrantUnguarded(worldFor(app), {
  user_id: null, agent_id: agent, action: BOOTPROMPT_EDIT_ACTION, action_values: { sourceNode: nodeId }, max_uses: null, expires_at: null,
  activated_at: raw(DB_NOW), verification_kind: 'passkey', verified_by: admin.id, issuer_user_id: admin.id,
});

async function connect(): Promise<Client> {
  const c = new Client({ connectionString: process.env.DATABASE_URL });
  await c.connect();
  opened.push(c);
  return c;
}
/**
 * Where a promise stands after `ms`: still pending, fulfilled, or rejected WITH its reason (#4874 F3), so a waiter that failed
 * instead of waiting is reported as the failure it is, never as "settled".
 */
type Standing = { state: 'pending' } | { state: 'fulfilled' } | { state: 'rejected'; reason: string };
const standing = async (p: Promise<unknown>, ms = WAIT_MS): Promise<Standing> => {
  let now: Standing = { state: 'pending' };
  void p.then(() => { now = { state: 'fulfilled' }; }, (e: unknown) => { now = { state: 'rejected', reason: String((e as Error)?.message ?? e).slice(0, 200) }; });
  await new Promise((r) => setTimeout(r, ms));
  return now;
};

describe('#4823 the lapse sweeper does not cycle with the uninstall door', () => {
  it('door holds its anchors and rows, the sweeper arrives, the door then wants the App: neither side is aborted (red on main: 40P01)', async () => {
    await grantFor(appId, agentId);
    // The uninstall door's locks, as withAuthorizedTx takes them: exclusive anchors (app, agent), the anchor rows FOR SHARE.
    const door = await connect();
    await door.query('BEGIN');
    await door.query('SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))', [authorityAnchorDomain('agent'), agentId]);
    await door.query('SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))', [authorityAnchorDomain('app'), appId]);
    await door.query('SELECT id FROM apps WHERE id = $1 FOR SHARE', [appId]);
    await door.query('SELECT id FROM agents WHERE id = $1 FOR SHARE', [agentId]);

    const sweep = sweepLapsedAgentGrants(db);
    expect(await standing(sweep), 'the sweeper must be waiting behind the door: not past it, and not failed').toEqual({ state: 'pending' });

    // afterLock: the App FOR NO KEY UPDATE. Without the anchor the sweeper holds the App FOR SHARE and waits on the agent row: a cycle.
    const doorDone = door.query('SELECT id FROM apps WHERE id = $1 FOR NO KEY UPDATE', [appId]).then(() => door.query('COMMIT'));
    const [doorOutcome, sweepOutcome] = await Promise.allSettled([doorDone, sweep]);
    const why = (r: PromiseSettledResult<unknown>) => (r.status === 'rejected' ? String((r.reason as Error)?.message).slice(0, 160) : '');
    expect(doorOutcome.status, `door: ${why(doorOutcome)}`).toBe('fulfilled');
    expect(sweepOutcome.status, `sweeper: ${why(sweepOutcome)}`).toBe('fulfilled');
  });
});

describe('#4823 the sweeper takes the exclusive agent anchors for its whole page, before any installation lock', () => {
  it('one page over two Apps: one exclusive call naming every agent of the page, ahead of lockAppInstallationsFenced', async () => {
    const app2 = await mkApp('s-app-2');
    const agent2 = await mkAgent('held-2');
    await db.appAgent.create({ data: { appId: app2, agentId: agent2 } });
    await grantFor(appId, agentId);
    await grantFor(app2, agent2);

    const order: string[] = [];
    const realAnchors = anchors.lockAuthorityAnchors;
    const anchorCalls: Array<{ kinds: string[]; ids: string[]; mode: string }> = [];
    vi.spyOn(anchors, 'lockAuthorityAnchors').mockImplementation(async (tx, list, mode) => {
      order.push('anchors');
      anchorCalls.push({ kinds: list.map((a) => a.kind), ids: list.map((a) => a.id), mode });
      return realAnchors(tx, list, mode);
    });
    const realFence = installs.lockAppInstallationsFenced;
    vi.spyOn(installs, 'lockAppInstallationsFenced').mockImplementation(async (tx, byApp) => {
      order.push('installations');
      return realFence(tx, byApp);
    });

    const out = await sweepLapsedAgentGrants(db);
    expect(out.pairsJudged).toBe(2);
    expect(order, 'the anchors come first, then the installation locks').toEqual(['anchors', 'installations']);
    expect(anchorCalls).toHaveLength(1);
    expect(anchorCalls[0]!.mode, 'a revoker of authority holds the anchor exclusively').toBe('exclusive');
    expect(new Set(anchorCalls[0]!.kinds)).toEqual(new Set(['agent']));
    expect([...anchorCalls[0]!.ids].sort()).toEqual([agentId, agent2].sort());
  });

  it('a page boundary re-anchors: two pages are two transactions, each anchoring its own agents', async () => {
    const app2 = await mkApp('s-app-2');
    const agent2 = await mkAgent('held-2');
    await db.appAgent.create({ data: { appId: app2, agentId: agent2 } });
    await grantFor(appId, agentId);
    await grantFor(app2, agent2);
    const realAnchors = anchors.lockAuthorityAnchors;
    const pages: Array<{ ids: string[]; mode: string }> = [];
    vi.spyOn(anchors, 'lockAuthorityAnchors').mockImplementation(async (tx, list, mode) => {
      pages.push({ ids: list.map((a) => a.id).sort(), mode });
      return realAnchors(tx, list, mode);
    });
    await sweepLapsedAgentGrants(db, { batchSize: 1 });
    expect(pages).toHaveLength(2);
    expect(pages.map((p) => p.mode), 'every page anchors exclusively (#4874 F4)').toEqual(['exclusive', 'exclusive']);
    expect(pages.flatMap((p) => p.ids).sort()).toEqual([agentId, agent2].sort());
  });

  it('one agent in two Apps on one page: one exclusive anchor call naming only that agent, both pairs judged (#4874 F4)', async () => {
    const app2 = await mkApp('s-app-2');
    await db.appAgent.create({ data: { appId: app2, agentId } });
    await grantFor(appId, agentId);
    await grantFor(app2, agentId);
    const realAnchors = anchors.lockAuthorityAnchors;
    const calls: Array<{ ids: string[]; mode: string }> = [];
    vi.spyOn(anchors, 'lockAuthorityAnchors').mockImplementation(async (tx, list, mode) => {
      calls.push({ ids: list.map((a) => a.id), mode });
      return realAnchors(tx, list, mode); // orderedAnchors de-duplicates, so the agent's anchor is taken once
    });
    const out = await sweepLapsedAgentGrants(db);
    expect(out.pairsJudged).toBe(2);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.mode).toBe('exclusive');
    expect(new Set(calls[0]!.ids)).toEqual(new Set([agentId]));
  });

  it('an empty page never opens the transaction: no anchor is taken when there is nothing to judge (#4874 F4)', async () => {
    const spy = vi.spyOn(anchors, 'lockAuthorityAnchors');
    const out = await sweepLapsedAgentGrants(db);
    expect(out.pairsJudged).toBe(0);
    expect(spy).not.toHaveBeenCalled();
  });
});
