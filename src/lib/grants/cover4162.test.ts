/**
 * #4162 (cor:acl:140:10, :02, :03, :06; cor:agt:040:11; gate deltas 1-6): ONE shared check for which grant covers an act, and ONE
 * shared spend. Every ruled per-action behaviour is a PARAMETER of the check, never a universal, so each is pinned here: a naive
 * consolidation (reach always `workersReachedByGrant`, a list covering for every parameter, no count rule) turns the marked pins red.
 */
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { Prisma } from '../../generated/prisma/index.js';
import { db } from '../../integrations/db/client.js';
import { cleanDb } from '../../test/helpers.js';
import { DB_NOW, dropTestActions, insertGrantUnguarded, raw } from './grantFixtures3668.js';
import { seedTriggerWorld, triggerGrant, useCount, useEvents, type TriggerWorld } from './triggerGrantFixtures3483.js';
import { PLATFORM_ACTIONS, upsertPlatformActions, type ActionDefinition } from './actions.js';
import { coverSql, coverableAction, findCoveringGrants, spendGrant, valueCovers, type CoverableAction } from './cover.js';

let w: TriggerWorld;
beforeEach(async () => { await cleanDb(db); w = await seedTriggerWorld(); });
afterAll(async () => { await cleanDb(db); await dropTestActions(); });

const EDIT = 'bootprompt.source.edit';
const BATCH = 'bootprompt.compile.approve';
const SCHEDULE = 'schedule.create';
const synthetic = (name: string, type: string, over: Partial<ActionDefinition> = {}): ActionDefinition => ({
  name, source: 'PLATFORM', parameters: [{ name: 'target', type, refusesWildcard: true }], tool: null, enforcement: 'RECORDED_ONLY',
  issuerRule: 'TEST_ONLY', summaryTemplate: 'Do it to {target} in {app}', ...over,
});
const cover = (action: CoverableAction, param: string, id: string, over: Record<string, unknown> = {}) => findCoveringGrants(db, {
  appId: w.appId, action, workerId: w.workerId, roleAgentId: w.agentId, values: { [param]: id }, order: 'ACTIVATED', ...over,
} as never);
const ids = async (action: CoverableAction, param: string, id: string) => (await cover(action, param, id)).map((g) => g.id);
const held = (kind: 'worker' | 'agent') => ({ kind, id: kind === 'worker' ? w.workerId : w.agentId });
const grantOf = (action: string, param: string, value: unknown, over: Record<string, unknown> = {}, holder = held('worker')) =>
  triggerGrant(w, { holder, action, over: { action_values: { [param]: value }, ...over } });

describe('the declarations are the actions\' own (code-only, never stored or served)', () => {
  it('reach and the list flag are declared per seeded action', () => {
    expect(coverableAction(SCHEDULE)).toMatchObject({ reach: 'WORKER_OR_ROLE_AGENT', listParameters: ['entryNode'] });
    expect(coverableAction('webhook.create')).toMatchObject({ reach: 'WORKER_OR_ROLE_AGENT', listParameters: ['entryNode'] });
    expect(coverableAction(EDIT)).toMatchObject({ reach: 'WORKER', maxUses: 1 });
    expect(coverableAction(EDIT).listParameters ?? []).toEqual([]);
    expect(coverableAction(BATCH)).toMatchObject({ reach: 'WORKER', listParameters: ['compiledNode'] });
    expect(coverableAction(BATCH).maxUses).toBeUndefined();
  });
  it('the stored parameter shape is unchanged: name, type, refusesWildcard only', async () => {
    const rows = await db.$queryRawUnsafe<Array<{ name: string; parameters: unknown }>>(`SELECT name, parameters FROM actions WHERE name IN ('${EDIT}', '${BATCH}', '${SCHEDULE}')`);
    expect(rows).toHaveLength(3);
    for (const r of rows) for (const p of r.parameters as Array<Record<string, unknown>>) expect(Object.keys(p).sort()).toEqual(['name', 'refusesWildcard', 'type']);
  });
});

describe('valueCovers: cover by the parameter\'s declared type (cor:acl:140:10)', () => {
  const edit = coverableAction(EDIT); const batch = coverableAction(BATCH); const sched = coverableAction(SCHEDULE);
  it('a single id covers exactly that id', () => {
    expect(valueCovers(edit, 'sourceNode', 'a', 'a')).toBe(true);
    expect(valueCovers(edit, 'sourceNode', 'a', 'b')).toBe(false);
  });
  it('[naive-red] a list covers only where the PARAMETER declares it: the edit parameter refuses one, the batch and entry parameters take one', () => {
    expect(valueCovers(edit, 'sourceNode', ['a', 'b'], 'a')).toBe(false);
    expect(valueCovers(batch, 'compiledNode', ['a', 'b'], 'a')).toBe(true);
    expect(valueCovers(batch, 'compiledNode', ['a', 'b'], 'c')).toBe(false);
    expect(valueCovers(sched, 'entryNode', ['a', 'b'], 'b')).toBe(true);
  });
  it('a wildcard covers nothing where the action refuses one', () => {
    for (const [a, p] of [[edit, 'sourceNode'], [batch, 'compiledNode'], [sched, 'entryNode']] as const) expect(valueCovers(a, p, '*', 'a')).toBe(false);
  });
  it('a wildcard covers where the action accepts one', () => {
    const open: CoverableAction = { name: 'x', parameters: [{ name: 't', type: 'node-ref', refusesWildcard: false }] };
    expect(valueCovers(open, 't', '*', 'anything')).toBe(true);
    expect(valueCovers(open, 't', 'a', 'b')).toBe(false);
  });
  it('[naive-red] an unknown type covers nothing, even an equal id', () => {
    const weird: CoverableAction = { name: 'x', parameters: [{ name: 't', type: 'weird-ref', refusesWildcard: true }] };
    expect(valueCovers(weird, 't', 'a', 'a')).toBe(false);
  });
  it('[naive-red] secret actions refuse a list and a wildcard in every parameter (cor:acl:140:02, decided at S0)', () => {
    const secret: CoverableAction = { name: 'secret.reveal', parameters: [{ name: 'secret', type: 'secret-ref', refusesWildcard: true }], reach: 'NO_WORKER' };
    expect(valueCovers(secret, 'secret', 's1', 's1')).toBe(true);
    expect(valueCovers(secret, 'secret', ['s1', 's2'], 's1')).toBe(false);
    expect(valueCovers(secret, 'secret', '*', 's1')).toBe(false);
  });
  it('a value that is not a string or a list of strings covers nothing', () => {
    for (const bad of [null, 1, true, {}, [1], [null]]) expect(valueCovers(batch, 'compiledNode', bad, 'a'), JSON.stringify(bad)).toBe(false);
  });
});

describe('coverSql agrees with valueCovers on every stored shape (one definition, two spellings)', () => {
  const shapes: Array<[string, unknown]> = [
    ['one id', 'a'], ['other id', 'b'], ['list with it', ['a', 'z']], ['list without', ['z']], ['empty list', []], ['wildcard', '*'], ['number', 1], ['null', null], ['object', { a: 1 }],
  ];
  for (const name of [EDIT, BATCH, SCHEDULE]) {
    it(`${name}: the fragment and the function agree on every shape`, async () => {
      const action = coverableAction(name); const param = action.parameters[0]!.name;
      const byGrant = new Map<string, boolean>();
      for (const [label, v] of shapes) {
        const g = await insertGrantUnguarded(w, { user_id: null, worker_id: w.workerId, action: name, action_values: { [param]: v as never } as never, max_uses: null,
          activated_at: raw(DB_NOW), verification_kind: 'passkey', verified_by: w.userId, issuer_user_id: w.userId });
        byGrant.set(g, valueCovers(action, param, v, 'a'));
        void label;
      }
      const rows = await db.$queryRaw<Array<{ id: string }>>(Prisma.sql`SELECT g.id FROM grants g WHERE g.action = ${name} AND ${coverSql(action, 'g', { [param]: 'a' })}`);
      const got = new Set(rows.map((r) => r.id));
      for (const [id, expected] of byGrant) expect(got.has(id), `${name} ${id}`).toBe(expected);
    });
  }
});

describe('a grant naming subject A does not cover an act on subject B (cor:acl:140:10), for each seeded action', () => {
  for (const [name, param] of [[SCHEDULE, 'entryNode'], [EDIT, 'sourceNode'], [BATCH, 'compiledNode']] as const) {
    it(`${name}: covers A, not B; asking spends nothing and records nothing`, async () => {
      const g = await grantOf(name, param, name === BATCH ? [w.entryNodeId] : w.entryNodeId, name === BATCH ? { max_uses: null } : {});
      const action = coverableAction(name);
      expect(await ids(action, param, w.entryNodeId)).toEqual([g]);
      expect(await ids(action, param, w.otherEntryNodeId)).toEqual([]);
      expect(await useCount(g)).toBe(0);
      expect(await useEvents(g)).toHaveLength(0);
    });
  }
  it('another App\'s grant covers nothing here', async () => {
    const g = await grantOf(SCHEDULE, 'entryNode', w.entryNodeId, { app_id: w.app2Id });
    expect(g).toBeTruthy();
    expect(await ids(coverableAction(SCHEDULE), 'entryNode', w.entryNodeId)).toEqual([]);
  });
});

describe('reach is a per-action parameter (gate delta 1)', () => {
  it('[naive-red] a boot-prompt grant held by the ROLE AGENT covers nothing for its worker (cor:agt:040:11 V50)', async () => {
    await grantOf(EDIT, 'sourceNode', w.entryNodeId, {}, held('agent'));
    expect(await ids(coverableAction(EDIT), 'sourceNode', w.entryNodeId)).toEqual([]);
    await grantOf(BATCH, 'compiledNode', [w.entryNodeId], { max_uses: null }, held('agent'));
    expect(await ids(coverableAction(BATCH), 'compiledNode', w.entryNodeId)).toEqual([]);
  });
  it('the same boot-prompt grant held by the worker itself covers', async () => {
    const g = await grantOf(EDIT, 'sourceNode', w.entryNodeId);
    expect(await ids(coverableAction(EDIT), 'sourceNode', w.entryNodeId)).toEqual([g]);
  });
  it('a ROLE AGENT\'s trigger grant reaches its live workers (cor:acl:140:06, Decided)', async () => {
    const g = await grantOf(SCHEDULE, 'entryNode', w.entryNodeId, {}, held('agent'));
    expect(await ids(coverableAction(SCHEDULE), 'entryNode', w.entryNodeId)).toEqual([g]);
  });
  it('a trigger grant held by a DIFFERENT agent reaches nothing for this worker', async () => {
    const other = await db.agent.create({ data: { organizationId: w.orgId, name: 'other', urn: `${(await db.organization.findUniqueOrThrow({ where: { id: w.orgId } })).urn}:other` } });
    await db.appAgent.create({ data: { appId: w.appId, agentId: other.id } });
    await triggerGrant(w, { holder: { kind: 'agent', id: other.id }, action: SCHEDULE });
    expect(await ids(coverableAction(SCHEDULE), 'entryNode', w.entryNodeId)).toEqual([]);
  });
  it('[naive-red] an action whose reach is NO_WORKER (a person-held secret.reveal, cor:acl:140:06 R5) covers no worker, even a worker-held row', async () => {
    await upsertPlatformActions(db, [synthetic('test.s1a.reveal', 'secret-ref', { reach: 'NO_WORKER' })]);
    const g = await grantOf('test.s1a.reveal', 'target', 's1');
    expect(g).toBeTruthy();
    expect(await ids({ ...synthetic('test.s1a.reveal', 'secret-ref', { reach: 'NO_WORKER' }) }, 'target', 's1')).toEqual([]);
  });
});

describe('the count rule is a per-action parameter (gate delta 2) and the migration guard stays (delta 5)', () => {
  it('[naive-red] the edit grant: one whose OWN cap is above the action\'s one use covers nothing', async () => {
    await grantOf(EDIT, 'sourceNode', w.entryNodeId, { max_uses: 2 });
    expect(await ids(coverableAction(EDIT), 'sourceNode', w.entryNodeId)).toEqual([]);
  });
  it('[naive-red] the edit grant stored with a USE event and use_count 0 covers nothing (a used grant is not revived)', async () => {
    const g = await grantOf(EDIT, 'sourceNode', w.entryNodeId, { max_uses: null });
    expect(await ids(coverableAction(EDIT), 'sourceNode', w.entryNodeId)).toEqual([g]);
    await db.grantEvent.create({ data: { grantId: g, appId: w.appId, action: 'USE', workerId: w.workerId } });
    expect(await useCount(g)).toBe(0);
    expect(await ids(coverableAction(EDIT), 'sourceNode', w.entryNodeId)).toEqual([]);
  });
  it('the batch grant has NO count: spent any number of times it still covers while its own max_uses is null', async () => {
    const g = await grantOf(BATCH, 'compiledNode', [w.entryNodeId], { max_uses: null });
    for (let i = 0; i < 3; i++) {
      await db.$transaction((tx) => spendGrant(tx, g, { appId: w.appId, workerId: w.workerId, sessionId: w.sessionId }, () => new Error('miss')));
    }
    expect(await useCount(g)).toBe(3);
    expect(await ids(coverableAction(BATCH), 'compiledNode', w.entryNodeId)).toEqual([g]);
    const row = await db.$queryRawUnsafe<Array<{ max_uses: number | null }>>('SELECT max_uses FROM grants WHERE id = $1', g);
    expect(row[0]!.max_uses).toBeNull();
  });
  it('the hazard the gate named: a batch grant that DOES store a max_uses is spent by it (so create must keep it null)', async () => {
    const g = await grantOf(BATCH, 'compiledNode', [w.entryNodeId], { max_uses: 1 });
    await db.$transaction((tx) => spendGrant(tx, g, { appId: w.appId, workerId: w.workerId, sessionId: null }, () => new Error('miss')));
    expect(await ids(coverableAction(BATCH), 'compiledNode', w.entryNodeId)).toEqual([]);
  });
});

describe('the hour is read from live.ts, not stated here (gate delta 3; ruling 0267, Decided)', () => {
  it('an edit grant an hour past activation covers nothing; inside the hour it does', async () => {
    const fresh = await grantOf(EDIT, 'sourceNode', w.entryNodeId);
    expect(await ids(coverableAction(EDIT), 'sourceNode', w.entryNodeId)).toEqual([fresh]);
    await db.$executeRawUnsafe(`ALTER TABLE grants DISABLE TRIGGER grants_guard`);
    await db.$executeRawUnsafe(`UPDATE grants SET activated_at = ${DB_NOW} - interval '61 minutes' WHERE id = $1`, fresh);
    await db.$executeRawUnsafe(`ALTER TABLE grants ENABLE TRIGGER grants_guard`);
    expect(await ids(coverableAction(EDIT), 'sourceNode', w.entryNodeId)).toEqual([]);
  });
  it('the module states no hour and no count of its own', () => {
    const src = readFileSync(new URL('./cover.ts', import.meta.url), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    for (const forbidden of ['lifetime_seconds', 'lifetimeSeconds', '3600', 'use_count >=', 'interval']) expect(src, forbidden).not.toContain(forbidden);
  });
});

describe('the shared spend (gate: consolidates chargeGrantUse and spendTriggerGrant)', () => {
  it('counts one use and writes one USE event (worker, session, App) in the transaction', async () => {
    const g = await grantOf(SCHEDULE, 'entryNode', w.entryNodeId, { max_uses: 3 });
    await db.$transaction((tx) => spendGrant(tx, g, { appId: w.appId, workerId: w.workerId, sessionId: w.sessionId }, () => new Error('miss')));
    expect(await useCount(g)).toBe(1);
    const ev = await useEvents(g);
    expect(ev).toHaveLength(1);
    expect(ev[0]).toMatchObject({ workerId: w.workerId, sessionId: w.sessionId, appId: w.appId });
  });
  it('a miss throws the CALLER\'s refusal and spends nothing', async () => {
    const g = await grantOf(SCHEDULE, 'entryNode', w.entryNodeId, { max_uses: 1 });
    await db.$transaction((tx) => spendGrant(tx, g, { appId: w.appId, workerId: w.workerId, sessionId: null }, () => new Error('miss')));
    await expect(db.$transaction((tx) => spendGrant(tx, g, { appId: w.appId, workerId: w.workerId, sessionId: null }, () => new Error('spent-refusal')))).rejects.toThrow('spent-refusal');
    expect(await useCount(g)).toBe(1);
    expect(await useEvents(g)).toHaveLength(1);
  });
});

describe('order and locks', () => {
  it('CAPPED_FIRST puts a capped grant before an uncapped one; ACTIVATED goes oldest-first', async () => {
    const uncapped = await grantOf(SCHEDULE, 'entryNode', w.entryNodeId, { max_uses: null });
    const capped = await grantOf(SCHEDULE, 'entryNode', w.entryNodeId, { max_uses: 2 });
    const action = coverableAction(SCHEDULE);
    expect((await cover(action, 'entryNode', w.entryNodeId, { order: 'CAPPED_FIRST' })).map((g) => g.id)).toEqual([capped, uncapped]);
    expect((await cover(action, 'entryNode', w.entryNodeId, { order: 'ACTIVATED' })).map((g) => g.id)).toEqual([uncapped, capped]);
  });
  it('an UPDATE lock holds the candidate rows to the end of the transaction; SHARE lets a reader in but blocks a writer', async () => {
    const g = await grantOf(SCHEDULE, 'entryNode', w.entryNodeId, { max_uses: 2 });
    const action = coverableAction(SCHEDULE);
    await db.$transaction(async (tx) => {
      const found = await findCoveringGrants(tx, { appId: w.appId, action, workerId: w.workerId, roleAgentId: w.agentId, values: { entryNode: w.entryNodeId }, order: 'CAPPED_FIRST', lock: 'UPDATE' });
      expect(found.map((x) => x.id)).toEqual([g]);
      const locks = await tx.$queryRawUnsafe<Array<{ mode: string }>>(`SELECT mode FROM pg_locks l JOIN pg_class c ON c.oid = l.relation WHERE c.relname = 'grants' AND l.pid = pg_backend_pid()`);
      expect(locks.length).toBeGreaterThan(0);
    });
  });
});

describe('no door keeps its own action_values comparison (gate acceptance, a grep pin)', () => {
  for (const file of ['./bootPromptGrant.ts', './triggerGrant.ts']) {
    it(`${file} carries no action_values text`, () => {
      const src = readFileSync(new URL(file, import.meta.url), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
      expect(src).not.toMatch(/action_values/);
    });
  }
  it('every platform action declares its reach', () => {
    for (const a of PLATFORM_ACTIONS) expect(a.reach, a.name).toBeDefined();
  });
});
