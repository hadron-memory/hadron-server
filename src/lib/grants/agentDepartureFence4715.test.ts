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
import { PrismaClient } from '../../generated/prisma/index.js';
import { lockAppInstallations } from '../appInstallations.js';
import { db } from '../../integrations/db/client.js';
import { cleanDb } from '../../test/helpers.js';
import { generateId } from '../id.js';
import { upsertPlatformActions } from './actions.js';
import { endGrantsOfAgentsNoLongerInstalled } from './agentInstallDeparture.js';
import { sweepLapsedAgentGrants } from './lapseSweep.js';
import { DB_NOW, grantInsertSql, insertGrantUnguarded, raw, type World } from './grantFixtures3668.js';

const EDIT = 'bootprompt.source.edit';
const WAIT_MS = 500;

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
// A failed pin must not leave its connection holding locks for the next test's cleanup.
afterEach(async () => { for (const c of opened.splice(0)) { await c.query('ROLLBACK').catch(() => undefined); await c.end().catch(() => undefined); } });

/** What createGrant does for an agent holder, uncommitted: the agent row FOR SHARE, then the guarded insert of one PENDING grant. */
async function openCreate(): Promise<{ a: Client; id: string }> {
  const a = await connect();
  await a.query('BEGIN');
  await a.query('SELECT id FROM agents WHERE id = $1 AND deleted_at IS NULL FOR SHARE', [agentId]);
  const ins = grantInsertSql(world(), { user_id: null, agent_id: agentId, app_id: appId, action: EDIT, action_values: { sourceNode: nodeId } } as never);
  await a.query(ins.text, ins.params);
  return { a, id: ins.id };
}
/** The #4172 uninstall door, as the resolvers run it: the witness delete, then the judge, in one transaction. */
const uninstallDoor = () => db.$transaction(async (tx) => {
  await tx.appAgent.delete({ where: { appId_agentId: { appId, agentId } } });
  return endGrantsOfAgentsNoLongerInstalled(tx, [{ appId, agentId }], admin.id, 'AGENT_UNINSTALLED');
});
const settles = async (p: Promise<unknown>, ms = WAIT_MS): Promise<boolean> => {
  let done = false;
  void p.then(() => { done = true; }, () => { done = true; });
  await new Promise((r) => setTimeout(r, ms));
  return done;
};

describe('#4715 the departure door fences a concurrent agent-grant create', () => {
  it('create first: the door waits for the uncommitted create, then judges and ends the committed grant', async () => {
    const { a, id } = await openCreate();
    const door = uninstallDoor();
    expect(await settles(door), 'the door must wait on the agent row, not judge around the create').toBe(false);
    await a.query('COMMIT');
    const out = await door;
    expect(out.departed).toEqual([{ appId, agentId }]);
    expect(await departedAt(id), 'the grant the create committed is ended as holder gone').not.toBeNull();
  });

  it('create first: the ended grant keeps that first end (a second end never moves the stamp)', async () => {
    const { a, id } = await openCreate();
    const door = uninstallDoor();
    await settles(door);
    await a.query('COMMIT');
    await door;
    const first = await departedAt(id);
    expect(first, 'ended by the first door').not.toBeNull();
    await db.$transaction((tx) => endGrantsOfAgentsNoLongerInstalled(tx, [{ appId, agentId }], admin.id, 'AGENT_UNINSTALLED'));
    expect((await departedAt(id))?.getTime()).toBe(first?.getTime());
  });

  it('door first: a create waits on the agent row, then reads the install gone', async () => {
    let release!: () => void;
    const hold = new Promise<void>((r) => { release = r; });
    let judged!: () => void;
    const judgedP = new Promise<void>((r) => { judged = r; });
    const door = db.$transaction(async (tx) => {
      await tx.appAgent.delete({ where: { appId_agentId: { appId, agentId } } });
      await endGrantsOfAgentsNoLongerInstalled(tx, [{ appId, agentId }], admin.id, 'AGENT_UNINSTALLED');
      judged();
      await hold;
    });
    await judgedP;
    const a = await connect();
    await a.query('BEGIN');
    const lock = a.query('SELECT id FROM agents WHERE id = $1 AND deleted_at IS NULL FOR SHARE', [agentId]);
    expect(await settles(lock), 'the create must wait for the door that judged this agent gone').toBe(false);
    release();
    await door;
    await lock;
    const installed = await a.query('SELECT 1 FROM app_agents WHERE app_id = $1 AND agent_id = $2', [appId, agentId]);
    expect(installed.rowCount, 'after the wait the create sees the departure and refuses').toBe(0);
    await a.query('ROLLBACK');
  });

  it('the sweeper (#4178) is fenced the same way: a lapsed derived install, a create in flight', async () => {
    const parent = await mkAgent('parent');
    const child = await mkAgent('child');
    await db.appAgent.create({ data: { appId, agentId: parent } });
    await db.agentOrgGrant.create({ data: { orgId, agentId: child, activatedAt: new Date(Date.now() - 86_400_000) } });
    await db.agentImport.create({ data: { parentAgentId: parent, importedAgentId: child, position: 0, agentOrgGrantOrgId: orgId, agentOrgGrantAgentId: child } });
    const existing = await grant({ agent_id: child });
    await db.agentOrgGrant.update({ where: { orgId_agentId: { orgId, agentId: child } }, data: { expiresAt: new Date(Date.now() - 3_600_000) } });
    const a = await connect();
    await a.query('BEGIN');
    await a.query('SELECT id FROM agents WHERE id = $1 AND deleted_at IS NULL FOR SHARE', [child]);
    const ins = grantInsertSql(world(), { user_id: null, agent_id: child, app_id: appId, action: EDIT, action_values: { sourceNode: nodeId } } as never);
    await a.query(ins.text, ins.params);
    const sweep = sweepLapsedAgentGrants(db);
    expect(await settles(sweep), 'the sweep must wait on the agent row').toBe(false);
    await a.query('COMMIT');
    await sweep;
    expect(await departedAt(existing)).not.toBeNull();
    expect(await departedAt(ins.id), 'the create that committed during the sweep is ended too').not.toBeNull();
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
    const sorted = [lo, mid, hi].sort();
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

  it('fenceAgents without the agents to fence is refused, not silently a SHARE lock', async () => {
    await expect(db.$transaction((tx) => lockAppInstallations(tx, appId, undefined, { fenceAgents: true }))).rejects.toThrow(/fenceAgents needs the agents/);
  });
});
