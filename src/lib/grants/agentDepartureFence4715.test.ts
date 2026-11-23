/**
 * #4715 (SEC10 on #4697; cor:acl:140:03 holder-gone row, FIT AT0.9491.1): the #4172 departure doors judge an agent gone under the
 * installation locks, but those hold the agent row FOR SHARE at most, and only for an agent that still has a witness row. createGrant
 * and the insert guard hold the same row FOR SHARE, so the two do not conflict: a create whose install read and guarded insert are
 * uncommitted could commit AFTER a door judged the agent departed, leaving a live grant for an agent that is not installed.
 * The fix: the door takes the candidate agents' rows FOR NO KEY UPDATE before judging (the #4179 trigger's order: agent row, then grants).
 *
 * Both orders are pinned, on two real connections: create first (the door waits, then judges and ends the committed grant) and door
 * first (the create waits on the agent row, then reads the install gone). The sweeper (#4178) is the second judge and is pinned too.
 * The action-limits arm (the first end stands when an ACTION's own limits ended the grant) is pinned through the door.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Client } from 'pg';
import { PrismaClient, type Prisma } from '../../generated/prisma/index.js';
import { lockAppInstallations, lockAppInstallationsFenced } from '../appInstallations.js';
import { db } from '../../integrations/db/client.js';
import { cleanDb } from '../../test/helpers.js';
import { generateId } from '../id.js';
import { upsertPlatformActions } from './actions.js';
import { endGrantsOfAgentsNoLongerInstalled } from './agentInstallDeparture.js';
import { sweepLapsedAgentGrants } from './lapseSweep.js';
import { createPendingGrant, type CreateGrantArgs } from './create.js';
import { DB_NOW, insertGrantUnguarded, raw, type World } from './grantFixtures3668.js';

const EDIT = 'bootprompt.source.edit';
// Prisma's default interactive-transaction timeout is 5 s, the same as the budget waitUntilBlockedBy allows a waiter: a transaction that
// WAITS on a lock by design must outlive that wait, or a slow runner rolls it back for the wrong reason (#4808, blind P2).
const WAITS = { timeout: 30_000, maxWait: 30_000 } as const;

let orgId: string;
let admin: { id: string };
let appId: string;
let agentId: string;
let nodeId: string;
const opened: Client[] = [];

async function mkAgent(name: string) {
  const mem = await db.memory.create({ data: { id: generateId(), class: 'system', name: `${name}-sys`, urn: `f4715.example:${name}-sys`, organizationId: orgId } });
  return (await db.agent.create({ data: { id: generateId(), name, urn: `f4715.example:${name}`, organizationId: orgId, systemMemoryId: mem.id } })).id;
}

beforeEach(async () => {
  await cleanDb(db);
  await upsertPlatformActions(db);
  orgId = (await db.organization.create({ data: { id: generateId(), name: 'F Org', urn: 'f4715.example' } })).id;
  admin = await db.user.create({ data: { githubId: 471501, githubUsername: 'f-admin', handle: 'f-admin', roles: [] } });
  await db.orgMember.create({ data: { organizationId: orgId, userId: admin.id, role: 'ADMIN' } });
  appId = (await db.app.create({ data: { id: generateId(), name: 'F App', urn: 'f4715.example:app', organizationId: orgId } })).id;
  agentId = await mkAgent('held');
  await db.appAgent.create({ data: { appId, agentId } });
  const install = await db.memory.create({
    data: { id: generateId(), class: 'system', name: 'install', urn: 'f4715.example:install', organizationId: orgId, appId, installOfAgentId: agentId, isInstallMemory: true },
  });
  nodeId = (await db.node.create({ data: { id: generateId(), memoryId: install.id, loc: 'boot:s', name: 'S', content: 'c', role: 'boot-prompt' } })).id;
});
afterAll(async () => { await cleanDb(db); });

const world = () => ({ appId, userId: admin.id } as unknown as World);
const grant = (over: Record<string, unknown> = {}) => insertGrantUnguarded(world(), {
  user_id: null, agent_id: agentId, action: EDIT, action_values: { sourceNode: nodeId }, max_uses: null, expires_at: null,
  activated_at: raw(DB_NOW), verification_kind: 'passkey', verified_by: admin.id, issuer_user_id: admin.id, ...over,
} as never);
const departedAt = async (id: string) => (await db.grant.findUniqueOrThrow({ where: { id } })).holderDepartedAt;

async function connect(): Promise<Client> {
  const c = new Client({ connectionString: process.env.DATABASE_URL });
  await c.connect();
  opened.push(c);
  return c;
}

/** A transaction that stays OPEN after `body` ran, until `commit()` or `rollback()`, with its backend pid and the body's value. */
interface HeldTx<T> { pid: number; value: T; done: Promise<T>; commit: () => void; rollback: () => void }
const releasers: Array<{ release: () => void; settled: Promise<unknown> }> = [];
async function holdTx<T>(body: (tx: Prisma.TransactionClient) => Promise<T>): Promise<HeldTx<T>> {
  let finish!: (commit: boolean) => void;
  const gate = new Promise<boolean>((resolve) => { finish = resolve; });
  let ready!: (v: { pid: number; value: T }) => void;
  const readyP = new Promise<{ pid: number; value: T }>((resolve) => { ready = resolve; });
  const done = db.$transaction(async (tx) => {
    const [{ pid }] = await tx.$queryRaw<[{ pid: number }]>`SELECT pg_backend_pid() AS pid`;
    const value = await body(tx);
    ready({ pid, value });
    if (!(await gate)) throw new Error('rolled back by the test');
    return value;
  }, WAITS);
  // a rollback is expected: the cleanup awaits this settled copy so nothing is left running into the next test
  releasers.push({ release: () => finish(false), settled: done.catch(() => undefined) });
  const { pid, value } = await Promise.race([readyP, done.then(() => { throw new Error('the held transaction ended before it was held'); })]);
  return { pid, value, done, commit: () => finish(true), rollback: () => finish(false) };
}

// A failed pin must not leave its connection or held transaction holding locks for the next test's cleanup.
afterEach(async () => {
  const held = releasers.splice(0);
  for (const h of held) h.release();
  await Promise.all(held.map((h) => h.settled));
  for (const c of opened.splice(0)) { await c.query('ROLLBACK').catch(() => undefined); await c.end().catch(() => undefined); }
});

/**
 * Wait until `atLeast` backends are BLOCKED by `holderPid`, directly or queued behind a backend it blocks (a second row-lock waiter queues
 * behind the first, not behind the holder), observed in pg_stat_activity / pg_blocking_pids, so a "must wait" pin has seen the waiter
 * reach the lock instead of sleeping and hoping (#4808: a fixed sleep passes vacuously on a slow runner). Only waiters behind THIS
 * holder count, not every lock wait in the database. Fails loudly if they never arrive.
 */
async function waitUntilBlockedBy(holderPid: number, atLeast = 1): Promise<number> {
  for (let i = 0; i < 200; i++) {
    const [row] = await db.$queryRaw<Array<{ n: bigint }>>`
      WITH RECURSIVE behind(pid) AS (
        SELECT a.pid FROM pg_stat_activity a WHERE a.datname = current_database() AND ${holderPid}::int = ANY(pg_blocking_pids(a.pid))
        UNION
        SELECT a.pid FROM pg_stat_activity a JOIN behind b ON b.pid = ANY(pg_blocking_pids(a.pid)) WHERE a.datname = current_database()
      ) SELECT count(*) AS n FROM behind WHERE pid <> pg_backend_pid()`;
    const n = Number(row!.n);
    if (n >= atLeast) return n;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`expected ${atLeast} backend(s) blocked by pid ${holderPid}, too few ever were`);
}
/** Track whether a promise has settled, without waiting for it. */
const track = (p: Promise<unknown>) => { const t = { done: false }; void p.then(() => { t.done = true; }, () => { t.done = true; }); return t; };

/** The args of a person-who-manages-the-App create of an EDIT grant held by `holder` (the same call the resolvers make). */
const createArgs = (holder: string = agentId): CreateGrantArgs => ({
  appId, requester: { userId: admin.id, workerId: null, sessionId: null }, holder: { kind: 'agent', id: holder }, heldAgentAnchor: holder,
  action: EDIT, values: { sourceNode: nodeId }, maxUses: 1, reason: 'departure fence pin', canReadMemory: async () => true,
});
/** The REAL create path (`createPendingGrant`, the one writer of a grant row), run in a transaction that stays open and uncommitted. */
const openCreate = (holder: string = agentId) => holdTx((tx) => createPendingGrant(tx, createArgs(holder)));
/** The #4172 uninstall door, as the resolvers run it: the witness delete, then the judge, in one transaction. */
const uninstallBody = (tx: Prisma.TransactionClient) =>
  tx.appAgent.delete({ where: { appId_agentId: { appId, agentId } } })
    .then(() => endGrantsOfAgentsNoLongerInstalled(tx, [{ appId, agentId }], admin.id, 'AGENT_UNINSTALLED'));
const uninstallDoor = () => db.$transaction(uninstallBody, WAITS);

describe('#4715 the departure door fences a concurrent agent-grant create', () => {
  it('create first: the door waits for the uncommitted create, then judges and ends the committed grant', async () => {
    const create = await openCreate();
    const door = uninstallDoor();
    const doorState = track(door);
    await waitUntilBlockedBy(create.pid); // the door reached the agent row and WAITS (observed, not slept)
    expect(doorState.done, 'the door must wait on the agent row, not judge around the create').toBe(false);
    create.commit();
    await create.done;
    const out = await door;
    expect(out.departed).toEqual([{ appId, agentId }]);
    expect(await departedAt(create.value), 'the grant the create committed is ended as holder gone').not.toBeNull();
  });

  it('create first: the ended grant keeps that first end (a second end never moves the stamp)', async () => {
    const create = await openCreate();
    const door = uninstallDoor();
    await waitUntilBlockedBy(create.pid);
    create.commit();
    await create.done;
    await door;
    const first = await departedAt(create.value);
    expect(first, 'ended by the first door').not.toBeNull();
    await db.$transaction((tx) => endGrantsOfAgentsNoLongerInstalled(tx, [{ appId, agentId }], admin.id, 'AGENT_UNINSTALLED'));
    expect((await departedAt(create.value))?.getTime()).toBe(first?.getTime());
  });

  it('door first: the real create waits on the agent row, then reads the install gone and is refused; no grant is written', async () => {
    const door = await holdTx(uninstallBody); // the door has judged the agent gone and not committed
    const create = db.$transaction((tx) => createPendingGrant(tx, createArgs()), WAITS);
    const createState = track(create);
    const outcome = create.then(() => 'created', (e: { code?: string }) => e.code ?? 'threw');
    await waitUntilBlockedBy(door.pid); // the create reached the agent row and WAITS
    expect(createState.done, 'the create must wait for the door that judged this agent gone').toBe(false);
    door.commit();
    await door.done;
    // The refusal comes from the create's own re-judgement under the lock (isAgentInstalledAndLicensed), not from the insert guard,
    // which only requires the holder row to exist and be live: the real create path is what keeps a grant off an uninstalled agent.
    expect(await outcome, 'after the wait the create sees the departure and refuses').toBe('GRANT_HOLDER_NOT_ALLOWED');
    const [{ n }] = await db.$queryRaw<[{ n: bigint }]>`SELECT count(*) AS n FROM grants WHERE agent_id = ${agentId}`;
    expect(Number(n), 'a refused create leaves no row').toBe(0);
  });

  it('the sweeper (#4178) is fenced the same way: a lapsed derived install, a real create in flight', async () => {
    const parent = await mkAgent('parent');
    const child = await mkAgent('child');
    await db.appAgent.create({ data: { appId, agentId: parent } });
    await db.agentOrgGrant.create({ data: { orgId, agentId: child, activatedAt: new Date(Date.now() - 86_400_000) } });
    await db.agentImport.create({ data: { parentAgentId: parent, importedAgentId: child, position: 0, agentOrgGrantOrgId: orgId, agentOrgGrantAgentId: child } });
    const existing = await grant({ agent_id: child });
    const create = await openCreate(child); // opened while the derived install is still licensed, so the real create accepts it
    await db.agentOrgGrant.update({ where: { orgId_agentId: { orgId, agentId: child } }, data: { expiresAt: new Date(Date.now() - 3_600_000) } });
    const sweep = sweepLapsedAgentGrants(db);
    const sweepState = track(sweep);
    await waitUntilBlockedBy(create.pid); // the sweep reached the agent row and WAITS
    expect(sweepState.done, 'the sweep must wait on the agent row').toBe(false);
    create.commit();
    await create.done;
    await sweep;
    expect(await departedAt(existing)).not.toBeNull();
    expect(await departedAt(create.value), 'the create that committed during the sweep is ended too').not.toBeNull();
  });
});

describe('#4808 coverage the first pins lacked (Jimmy F5)', () => {
  it('a named agent that is STILL installed is not ended: the judge reads the install, the grants survive (no over-ending)', async () => {
    const live = await grant();
    const pending = (await openCreate()); // a pending grant of the same, still installed, agent
    pending.commit();
    await pending.done;
    const out = await db.$transaction((tx) => endGrantsOfAgentsNoLongerInstalled(tx, [{ appId, agentId }], admin.id, 'AGENT_UNINSTALLED'));
    expect(out.departed, 'the agent is installed (a witness row exists): it is not departed').toEqual([]);
    expect(out.ended).toBe(0);
    expect(await departedAt(live)).toBeNull();
    expect(await departedAt(pending.value)).toBeNull();
  });

  it('judge against judge: two doors judging the same gone agent end the grant ONCE and the first end stands', async () => {
    const id = await grant();
    const first = await holdTx(uninstallBody); // judged, ended, not committed
    const second = db.$transaction((tx) => endGrantsOfAgentsNoLongerInstalled(tx, [{ appId, agentId }], admin.id, 'AGENT_UNINSTALLED'), WAITS);
    const secondState = track(second);
    await waitUntilBlockedBy(first.pid); // the second judge WAITS on the agent row the first holds
    expect(secondState.done, 'the second judge must wait, not judge around the first').toBe(false);
    first.commit();
    await first.done;
    const out = await second;
    const stamp = await departedAt(id);
    expect(first.value.ended, 'the first judge ends the grant').toBe(1);
    expect(out.ended, 'the second judge finds it already ended and ends nothing').toBe(0);
    expect(stamp, 'the grant carries one end').not.toBeNull();
    // The reason recorded is the first end's: the stamp is not moved by a later pass.
    await db.$transaction((tx) => endGrantsOfAgentsNoLongerInstalled(tx, [{ appId, agentId }], admin.id, 'AGENT_UNINSTALLED'));
    expect((await departedAt(id))?.getTime()).toBe(stamp?.getTime());
  });

  it('door against sweeper: a door that judged a lapsed derived agent gone first, the sweep waits and does not move the stamp', async () => {
    const parent = await mkAgent('parent');
    const child = await mkAgent('child');
    await db.appAgent.create({ data: { appId, agentId: parent } });
    await db.agentOrgGrant.create({ data: { orgId, agentId: child, activatedAt: new Date(Date.now() - 86_400_000) } });
    await db.agentImport.create({ data: { parentAgentId: parent, importedAgentId: child, position: 0, agentOrgGrantOrgId: orgId, agentOrgGrantAgentId: child } });
    const id = await grant({ agent_id: child });
    await db.agentOrgGrant.update({ where: { orgId_agentId: { orgId, agentId: child } }, data: { expiresAt: new Date(Date.now() - 3_600_000) } });
    const door = await holdTx((tx) => endGrantsOfAgentsNoLongerInstalled(tx, [{ appId, agentId: child }], admin.id, 'AGENT_UNINSTALLED'));
    expect(door.value.ended, 'the door ends the grant of the agent whose install lapsed').toBe(1);
    const sweep = sweepLapsedAgentGrants(db);
    const sweepState = track(sweep);
    await waitUntilBlockedBy(door.pid);
    expect(sweepState.done, 'the sweep must wait for the door').toBe(false);
    door.commit();
    await door.done;
    const afterDoor = await departedAt(id);
    expect(afterDoor, 'the door ended it').not.toBeNull();
    await sweep;
    expect((await departedAt(id))?.getTime(), 'the sweep did not move the first end').toBe(afterDoor?.getTime());
  });
});

describe('#4715 the door keeps the first end of a grant its action\'s limits ended (the action-limits arm)', () => {
  it('used once and past its hour keep their first end; the live one is stamped, through the uninstall door', async () => {
    const used = await grant({ use_count: 1 });
    const timedOut = await grant({ activated_at: raw(`${DB_NOW} - interval '61 minutes'`) });
    const live = await grant();
    const out = await uninstallDoor();
    expect(out.ended).toBe(1);
    expect(await departedAt(used)).toBeNull();
    expect(await departedAt(timedOut)).toBeNull();
    expect(await departedAt(live)).not.toBeNull();
  });
});

describe('#4715 the judge locks the agents in ONE id-ordered pass, each row at its own strength (BLIND P2)', () => {
  it('a named agent, a witness between two named agents and the named agents lock in id order; only the named ones are NO KEY UPDATE', async () => {
    const lo = await mkAgent('n-lo'); const mid = await mkAgent('parent-mid'); const hi = await mkAgent('n-hi');
    // the database's id order, as the other pins derive it (a JS .sort() orders by code unit and can differ under a locale collation)
    const sorted = (await db.$queryRaw<Array<{ id: string }>>`SELECT id FROM agents WHERE id = ANY(${[lo, mid, hi]}) ORDER BY id`).map((r) => r.id);
    const [first, middle, last] = sorted as [string, string, string];
    // the middle id is the parent that imports both outer ids, installed in the App: a witness between two named agents
    for (const child of [first, last]) {
      await db.agentOrgGrant.create({ data: { orgId, agentId: child, activatedAt: new Date(Date.now() - 86_400_000) } });
      await db.agentImport.create({ data: { parentAgentId: middle, importedAgentId: child, position: child === first ? 0 : 1, agentOrgGrantOrgId: orgId, agentOrgGrantAgentId: child } });
    }
    await db.appAgent.create({ data: { appId, agentId: middle } });
    const log: Array<[string, string]> = [];
    const logged = new PrismaClient({ datasourceUrl: process.env.DATABASE_URL, log: [{ emit: 'event', level: 'query' }] });
    let counting = false;
    logged.$on('query', (e) => {
      if (!counting || !/FROM agents WHERE id = \$1 FOR/.test(e.query)) return;
      log.push([/NO KEY UPDATE/.test(e.query) ? 'NKU' : 'SHARE', (JSON.parse(e.params) as string[])[0]!]);
    });
    try {
      await logged.$transaction(async (tx) => {
        counting = true;
        await lockAppInstallations(tx as never, appId, [first, last], { fenceAgents: true });
        counting = false;
      });
    } finally { await logged.$disconnect(); }
    expect(log).toEqual([['NKU', first], ['SHARE', middle], ['NKU', last]]);
  });

  it('fenceAgents without agents to fence (none, or an empty list) is refused before any lock, not silently a SHARE lock', async () => {
    await expect(db.$transaction((tx) => lockAppInstallations(tx, appId, undefined, { fenceAgents: true }))).rejects.toThrow(/fenceAgents needs the agents/);
    await expect(db.$transaction((tx) => lockAppInstallations(tx, appId, [], { fenceAgents: true }))).rejects.toThrow(/fenceAgents needs the agents/);
  });

  it('a fenced id that names no agent row locks nothing, a soft-deleted agent IS still locked, and the judge completes', async () => {
    const gone = await mkAgent('gone');
    await db.agent.update({ where: { id: gone }, data: { deletedAt: new Date() } });
    const rec = lockRecorder();
    await rec.spyDb.$transaction((tx) => lockAppInstallationsFenced(tx as never, new Map([[appId, ['no-such-agent', gone]]])));
    expect(rec.log.map(([, mode, id]) => `${mode}:${id}`)).toEqual([`NKU:${gone}`]);
  });
});

describe('#4895 a vanished App still fences its named agents (Bindi F2 on #4795, follow-up of #4808)', () => {
  it('an App id with no row: its named agents still take FOR NO KEY UPDATE, and the judge completes', async () => {
    const lone = await mkAgent('lone-4895');
    const rec = lockRecorder();
    await rec.spyDb.$transaction((tx) => lockAppInstallationsFenced(tx as never, new Map([[generateId(), [lone]]])));
    expect(rec.log.map(([, mode, id]) => `${mode}:${id}`)).toEqual([`NKU:${lone}`]);
  });

  it('a vanished App\'s named agents join the SAME one id-ordered pass as a found App\'s fence, and it invents no witness', async () => {
    const nA = await mkAgent('mix-a-4895'); const nB = await mkAgent('mix-b-4895'); const nV = await mkAgent('mix-v-4895');
    // The database's id order of the three (queried, not assumed: the pass is ordered by the database, not a JS sort).
    const dbOrder = (await db.$queryRaw<Array<{ id: string }>>`SELECT id FROM agents WHERE id = ANY(${[nA, nB, nV]}) ORDER BY id`).map((r) => r.id);
    // The found App names the first and last in that order; the VANISHED App names the middle one, so a second per-App pass (or a
    // dropped agent) cannot produce the expected sequence. The vanished App id has no apps row at all.
    const byApp = new Map<string, readonly string[]>([[appId, [dbOrder[0]!, dbOrder[2]!]], [generateId(), [dbOrder[1]!]]]);
    const rec = lockRecorder();
    await rec.spyDb.$transaction((tx) => lockAppInstallationsFenced(tx as never, byApp));
    expect(rec.log.map(([, mode, id]) => `${mode}:${id}`)).toEqual(dbOrder.map((id) => `NKU:${id}`));
  });
});

describe('#4895 round 2 (Arden\'s BLIND P2s): the App list and the fence derive together; an id in both sets; empty lists; the found App\'s structure', () => {
  it('an id that is BOTH a witness and fenced locks ONCE as NO KEY UPDATE, a pure witness takes SHARE, and the sequence is one apps statement, the rows, then the agents', async () => {
    const named = await mkAgent('r2-named'); // named under the found App AND a vanished one; also the target of the found App's import edge
    const witnessRow = await mkAgent('r2-row'); // a physical row of the found App, named NOWHERE: a witness, never fenced
    const vanishedNamed = await mkAgent('r2-vanished'); // named only under the vanished App
    await db.appAgent.create({ data: { appId, agentId: witnessRow } });
    await db.agentOrgGrant.create({ data: { orgId, agentId: named, activatedAt: new Date(Date.now() - 86_400_000) } });
    await db.agentImport.create({
      data: { parentAgentId: witnessRow, importedAgentId: named, position: 0, agentOrgGrantOrgId: orgId, agentOrgGrantAgentId: named },
    });
    const dbOrder = (await db.$queryRaw<Array<{ id: string }>>`SELECT id FROM agents WHERE id = ANY(${[named, witnessRow, vanishedNamed]}) ORDER BY id`).map((r) => r.id);
    const vanished = generateId();
    const byApp = new Map<string, readonly string[]>([[appId, [named]], [vanished, [named, vanishedNamed]]]);
    const rec = lockRecorder();
    await rec.spyDb.$transaction((tx) => lockAppInstallationsFenced(tx as never, byApp));
    // The agent pass: each id ONCE, at its own strength — the both-sets id (named) is fenced, the pure witness (witnessRow) is SHARE.
    expect(rec.log.map(([, mode, id]) => `${mode}:${id}`)).toEqual(dbOrder.map((id) => `${id === witnessRow ? 'SHARE' : 'NKU'}:${id}`));
    // The whole sequence: ONE apps statement covering every App that has a named agent (found AND vanished), the found App's row lock,
    // then the one agent pass. The vanished App has no structure of its own to lock.
    expect(rec.trace).toEqual([
      `app SHARE ${appId}`, `app SHARE ${vanished}`, `rows SHARE ${appId}`,
      ...dbOrder.map((id) => `agent ${id === witnessRow ? 'SHARE' : 'NKU'} ${id}`),
    ]);
  });

  it('an App with an EMPTY named list locks nothing anywhere (not even its own row), and a vanished App naming an id with no agent row locks nothing and completes', async () => {
    const ghost = generateId();
    let rec = lockRecorder();
    await rec.spyDb.$transaction((tx) => lockAppInstallationsFenced(tx as never, new Map<string, readonly string[]>([[appId, []], [ghost, ['no-such-agent-4895r2']]])));
    // The empty-list App is absent from the one apps statement (only the vanished App's ghost id is named); no row has the ghost agent id.
    expect(rec.trace).toEqual([`app SHARE ${ghost}`]);
    expect(rec.log).toEqual([]);
    rec = lockRecorder();
    await rec.spyDb.$transaction((tx) => lockAppInstallationsFenced(tx as never, new Map<string, readonly string[]>([[appId, []]])));
    expect(rec.trace).toEqual([]); // every list empty: not even the apps statement runs
    expect(rec.log).toEqual([]);
  });
});

/** Every agent-row lock a transaction takes, in order: [txIndex, 'SHARE' | 'NKU', agentId]. A wrapper around `db` whose transactions log their raw statements.
 * `trace` (#4895 round 2) additionally records the structural statements in execution order — the one `apps` FOR SHARE statement (one
 * line per App id it names), each App's `app_agents` row lock, and every agent-row lock — so a pin can assert the whole lock sequence. */
function lockRecorder() {
  const log: Array<[number, 'SHARE' | 'NKU', string]> = [];
  const trace: string[] = [];
  let txCount = 0;
  const wrapTx = (tx: any, index: number) => new Proxy(tx, {
    get(target, prop) {
      if (prop === '$queryRaw') {
        return (strings: TemplateStringsArray, ...values: unknown[]) => {
          const text = Array.isArray(strings) ? strings.join('?') : String(strings);
          const m = /FROM agents WHERE id (?:= \?|= ANY\(\?\)).*?FOR (SHARE|NO KEY UPDATE)/s.exec(text);
          if (m) {
            for (const v of values.flat()) if (typeof v === 'string') {
              log.push([index, m[1] === 'SHARE' ? 'SHARE' : 'NKU', v]);
              trace.push(`agent ${m[1] === 'SHARE' ? 'SHARE' : 'NKU'} ${v}`);
            }
          } else if (/FROM apps WHERE id = ANY\(\?\) ORDER BY id FOR SHARE/.test(text)) {
            for (const v of values.flat()) if (typeof v === 'string') trace.push(`app SHARE ${v}`);
          } else if (/FROM app_agents aa WHERE aa\.app_id\s*=\s*\?.*?FOR SHARE OF aa/s.test(text)) {
            if (typeof values[0] === 'string') trace.push(`rows SHARE ${values[0]}`);
          }
          return (target as any).$queryRaw(strings, ...values);
        };
      }
      const v = (target as any)[prop];
      return typeof v === 'function' ? v.bind(target) : v;
    },
  });
  const spyDb = new Proxy(db, {
    get(target, prop) {
      if (prop === '$transaction') {
        return (fn: any, opts?: unknown) => typeof fn === 'function'
          ? (target as any).$transaction((tx: any) => fn(wrapTx(tx, ++txCount)), opts)
          : (target as any).$transaction(fn, opts);
      }
      const v = (target as any)[prop];
      return typeof v === 'function' ? v.bind(target) : v;
    },
  }) as typeof db;
  return { log, trace, spyDb };
}

describe('#4715 the judge takes its agents in ONE pass across all Apps, in the database\'s id order (BLIND P2s, Bindi)', () => {
  it('two Apps whose named agents sort opposite to the Apps lock the agents in the database\'s order, not App by App', async () => {
    const app2 = (await db.app.create({ data: { id: generateId(), name: 'F App 2', urn: 'f4715.example:app2', organizationId: orgId } })).id;
    // ids that sort differently in the database (en_US collation ignores punctuation first) and in JavaScript (code units).
    // PRECONDITION: the test database uses that collation (the shared host and CI do, see CLAUDE.md, test-database collation). Under a
    // C collation the two orders agree and this pin cannot tell a database-ordered pass from a JavaScript-ordered one.
    const x = (await db.agent.create({ data: { id: 'ag-2', name: 'x', urn: 'f4715.example:ag-2', organizationId: orgId } })).id;
    const y = (await db.agent.create({ data: { id: 'ag1', name: 'y', urn: 'f4715.example:ag1', organizationId: orgId } })).id;
    const dbOrder = (await db.$queryRaw<Array<{ id: string }>>`SELECT id FROM agents WHERE id = ANY(${[x, y]}) ORDER BY id`).map((r) => r.id);
    const appOrder = (await db.$queryRaw<Array<{ id: string }>>`SELECT id FROM apps WHERE id = ANY(${[appId, app2]}) ORDER BY id`).map((r) => r.id);
    // the first App (in the database's order) names the agent that sorts LAST, the second names the one that sorts first
    const byApp = new Map<string, string[]>([[appOrder[0]!, [dbOrder[1]!]], [appOrder[1]!, [dbOrder[0]!]]]);
    const rec = lockRecorder();
    await rec.spyDb.$transaction((tx) => lockAppInstallationsFenced(tx as never, byApp));
    expect(rec.log.map(([, mode, id]) => `${mode}:${id}`)).toEqual(dbOrder.map((id) => `NKU:${id}`));
  });
});

describe('#4715 two judges that reach the same agents through different Apps do not deadlock (Peter, Bindi)', () => {
  // Only backends blocked by the held connection count (not every lock wait in the database).
  const waitForWaiters = (holderPid: number, n: number) => waitUntilBlockedBy(holderPid, n);

  it('tx1 names the later agent in the first App and the earlier one in the second; tx2 names both in the second: both finish', async () => {
    const app2 = (await db.app.create({ data: { id: generateId(), name: 'F App 2', urn: 'f4715.example:app2', organizationId: orgId } })).id;
    const a1 = await mkAgent('cross-1'); const a2 = await mkAgent('cross-2');
    const [lo, hi] = (await db.$queryRaw<Array<{ id: string }>>`SELECT id FROM agents WHERE id = ANY(${[a1, a2]}) ORDER BY id`).map((r) => r.id) as [string, string];
    const [first, second] = (await db.$queryRaw<Array<{ id: string }>>`SELECT id FROM apps WHERE id = ANY(${[appId, app2]}) ORDER BY id`).map((r) => r.id) as [string, string];
    // a third connection holds the EARLIER agent, so both judges queue behind it, tx2 first, with nothing else taken in the new order
    const h = await connect();
    await h.query('BEGIN');
    const holderPid = Number((await h.query('SELECT pg_backend_pid() AS pid')).rows[0].pid);
    await h.query('SELECT id FROM agents WHERE id = $1 FOR NO KEY UPDATE', [lo]);
    const tx2 = db.$transaction((tx) => lockAppInstallationsFenced(tx, new Map([[second, [lo, hi]]])), { timeout: 20_000 });
    await waitForWaiters(holderPid, 1);
    // App by App, tx1 would take `hi` (in the first App) and only then queue for `lo`: tx2 gets `lo`, wants `hi`, and the two cycle.
    const tx1 = db.$transaction((tx) => lockAppInstallationsFenced(tx, new Map([[first, [hi]], [second, [lo]]])), { timeout: 20_000 });
    await waitForWaiters(holderPid, 2);
    await h.query('COMMIT');
    const settled = await Promise.allSettled([tx1, tx2]);
    expect(settled.map((r) => r.status), JSON.stringify(settled.map((r) => (r as PromiseRejectedResult).reason?.message?.slice(0, 120)))).toEqual(['fulfilled', 'fulfilled']);
  });
});

describe('#4896 the judge locks the Apps in the database\'s id order (Anita on #4795, filed as a follow-up of #4808)', () => {
  /**
   * `lockAppInstallationsFenced` locks the Apps in ONE statement, `SELECT id FROM apps WHERE id = ANY(..) ORDER BY id FOR SHARE`, so two
   * judges naming the same Apps in any order take them in the same sequence. Dropping the `ORDER BY` left every existing pin green: the
   * agent order is pinned, the Apps' was not. This pin observes the LOCK ORDER itself, with no SQL text matched:
   *   - two Apps whose ids sort opposite to the order they were inserted (the later-sorting one is the heap's first row);
   *   - a holder takes the EARLIER-sorting App FOR UPDATE, so the judge must wait on it;
   *   - while it waits, the judge holds the LATER-sorting App only if it locked in heap or input order, not id order: a NOWAIT
   *     FOR UPDATE on that App succeeds exactly when the judge has not locked it yet.
   * The judge's transaction turns the index and bitmap scans off, so a statement WITHOUT the ORDER BY returns the heap order (the
   * production plan may use the primary-key index, which would hide the mutant); WITH the ORDER BY the order is the id order whatever the plan.
   * The pin states its own precondition: if the unordered read does not come back in the opposite order, it fails loudly instead of passing.
   * The ids are plain lowercase letters and digits, so the C collation and en_US order them alike.
   */
  it('the App that sorts first is locked first: a judge blocked on it holds nothing, so the App that sorts last is still free', async () => {
    const late = (await db.app.create({ data: { id: 'appzzzz1', name: 'F App late', urn: 'f4715.example:app-late', organizationId: orgId } })).id;
    const early = (await db.app.create({ data: { id: 'appaaaa1', name: 'F App early', urn: 'f4715.example:app-early', organizationId: orgId } })).id;
    const noIndex = async (tx: Prisma.TransactionClient) => {
      await tx.$executeRaw`SET LOCAL enable_indexscan = off`;
      await tx.$executeRaw`SET LOCAL enable_indexonlyscan = off`;
      await tx.$executeRaw`SET LOCAL enable_bitmapscan = off`;
    };
    const heapOrder = await db.$transaction(async (tx) => {
      await noIndex(tx);
      return (await tx.$queryRaw<Array<{ id: string }>>`SELECT id FROM apps WHERE id = ANY(${[late, early]})`).map((r) => r.id);
    });
    expect(heapOrder, 'PRECONDITION: the unordered read must return the Apps opposite to id order, or this pin cannot tell an ORDER BY from none').toEqual([late, early]);

    const h = await connect();
    await h.query('BEGIN');
    const holderPid = Number((await h.query('SELECT pg_backend_pid() AS pid')).rows[0].pid);
    await h.query('SELECT id FROM apps WHERE id = $1 FOR UPDATE', [early]); // the App that sorts FIRST is held

    // the judge names the Apps in the opposite order to the id order too, so a statement following the input order fails the same way
    const judge = db.$transaction(async (tx) => {
      await noIndex(tx);
      await lockAppInstallationsFenced(tx, new Map([[late, [agentId]], [early, [agentId]]]));
    }, WAITS);
    const judgeState = track(judge);
    await waitUntilBlockedBy(holderPid); // the judge reached the held App and WAITS
    expect(judgeState.done).toBe(false);

    const probe = await connect();
    await probe.query('BEGIN');
    let heldByJudge: unknown;
    try {
      await probe.query('SELECT id FROM apps WHERE id = $1 FOR UPDATE NOWAIT', [late]);
    } catch (e) { heldByJudge = e; }
    await probe.query('ROLLBACK');
    expect(heldByJudge, 'the waiting judge already holds the App that sorts LAST: it locked the Apps out of id order').toBeUndefined();

    await h.query('COMMIT');
    await judge; // and it completes once the first App is free
  });
});
