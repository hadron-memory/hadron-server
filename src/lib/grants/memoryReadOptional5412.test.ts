/**
 * #5412 (hrn:node:hadronmemory.com:specs:cor:acl:140:02, `memory.read`'s two Proposed optional parameters; cor:acl:140:09, the
 * absent-key form): the doors that make a `memory.read` grant with an optional `branch` (one loc inside the ONE memory form (b) names)
 * or `automation` (one live schedule or webhook of the App). An optional parameter with no value has NO key: never null, "", [] or the
 * wildcard. The summary writes nothing for an absent key, so a grant with neither reads, and its sentence reads, exactly as an S1 grant.
 * The READ these grants allow is pinned in src/api/graphql/schema/resolvers.appReadGrant5412.test.ts.
 */
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../../integrations/db/client.js';
import { cleanDb } from '../../test/helpers.js';
import { generateId } from '../id.js';
import { PLATFORM_ACTIONS, upsertPlatformActions } from './actions.js';
import { createPendingGrant, GrantCreateRefusal } from './create.js';
import { renderGrantSummary, GrantSummaryError } from './summary.js';
import { dropTestActions, seedWorld, type World } from './grantFixtures3668.js';

vi.mock('../../integrations/github/writeNodeToGit.js', () => ({ writeNodeToGit: vi.fn().mockResolvedValue(undefined) }));

const ENTRY = 'hrn:node:example.com:m:flows:entry';
let w: World;
let manager: string;
let kb: { id: string };
let kb2: { id: string };

const create = (values: unknown) => db.$transaction((tx) => createPendingGrant(tx, {
  appId: w.appId, requester: { userId: manager, workerId: null, sessionId: null }, holder: { kind: 'app', id: w.appId },
  action: 'memory.read', values, reason: 'r', canReadMemory: async () => true,
} as never));
const code = (p: Promise<unknown>) => p.then(() => 'OK', (e) => e instanceof GrantCreateRefusal ? `${e.code}` : String(e));
const schedule = (appId = w.appId) => db.agentSchedule.create({ data: { id: generateId(), organizationId: w.orgId, appId, name: 'S', cron: '* * * * *', entryNodeUrn: ENTRY } });
const webhook = (appId = w.appId) => db.agentWebhook.create({ data: { id: generateId(), organizationId: w.orgId, appId, name: 'W', secret: generateId(), entryNodeUrn: ENTRY } });

async function userKb(owner: string) {
  const own = await db.organization.create({ data: { id: generateId(), name: `u-${generateId().slice(-8)}`, urn: `u-${generateId().slice(-8)}` } });
  await db.orgMember.create({ data: { organizationId: own.id, userId: owner, role: 'OWNER' } });
  return db.memory.create({ data: { id: generateId(), name: 'kb', urn: `${own.urn}:kb`, class: 'knowledge', visibility: 'ORGANIZATION', organizationId: own.id } as never });
}

beforeEach(async () => {
  await cleanDb(db);
  w = await seedWorld();
  await upsertPlatformActions(db);
  manager = (await db.user.create({ data: { handle: `mgr-${generateId().slice(-6)}` } })).id;
  await db.orgMember.create({ data: { organizationId: w.orgId, userId: manager, role: 'READER' } });
  kb = await userKb(manager);
  kb2 = await userKb(manager);
});
afterAll(async () => { await cleanDb(db); await dropTestActions(); });

describe('the registry declares the two optional parameters (cor:acl:140:02)', () => {
  it('memory.read: memory required; branch and automation optional, refusing the wildcard; the template names every parameter', () => {
    const a = PLATFORM_ACTIONS.find((x) => x.name === 'memory.read')!;
    expect(a.parameters).toEqual([
      { name: 'memory', type: 'memory-ref', refusesWildcard: true },
      { name: 'branch', type: 'loc-prefix', refusesWildcard: true, optional: true },
      { name: 'automation', type: 'automation-ref', refusesWildcard: true, optional: true },
    ]);
    expect(a.summaryTemplate).toBe('Let {app}, acting with no person behind it, read {memory}{branch}, read only{automation}');
  });

  it('no other action carries `optional`, so their stored parameters keep their bytes', () => {
    for (const a of PLATFORM_ACTIONS.filter((x) => x.name !== 'memory.read')) {
      for (const p of a.parameters) expect({ a: a.name, p: p.name, has: 'optional' in p }).toEqual({ a: a.name, p: p.name, has: false });
    }
  });

  it('the stored row carries `optional: true` only on the two optional parameters', async () => {
    const row = await db.action.findUniqueOrThrow({ where: { name: 'memory.read' }, select: { parameters: true } });
    expect(row.parameters).toEqual(PLATFORM_ACTIONS.find((x) => x.name === 'memory.read')!.parameters);
  });

  it('the registry check refuses `optional` other than true, and an optional parameter that admits the wildcard, before any write', async () => {
    const base = PLATFORM_ACTIONS.find((x) => x.name === 'memory.read')!;
    const withParam = (p: Record<string, unknown>) => [{ ...base, parameters: [base.parameters[0], p] }] as never;
    await expect(upsertPlatformActions(db, withParam({ name: 'branch', type: 'loc-prefix', refusesWildcard: true, optional: false }))).rejects.toThrow(/optional other than true/);
    await expect(upsertPlatformActions(db, withParam({ name: 'branch', type: 'loc-prefix', refusesWildcard: false, optional: true }))).rejects.toThrow(/must refuse the wildcard/);
  });
});

describe('creation: the absent-key form (cor:acl:140:09)', () => {
  it('no optional key: stored exactly as an S1 grant', async () => {
    const id = await create({ memory: kb.id });
    expect((await db.grant.findUniqueOrThrow({ where: { id } })).values).toEqual({ memory: kb.id });
  });

  it('branch with one memory as a single string is stored as given', async () => {
    for (const branch of ['docs', 'docs:api', 'a:b:c']) {
      const id = await create({ memory: kb.id, branch });
      expect((await db.grant.findUniqueOrThrow({ where: { id } })).values).toEqual({ memory: kb.id, branch });
    }
  });

  it('automation names a live schedule or webhook of the App, with either form', async () => {
    const s = await schedule();
    const h = await webhook();
    for (const values of [{ memory: kb.id, automation: s.id }, { memory: kb.id, automation: h.id, branch: 'docs' }, { memory: w.orgId, automation: s.id }, { memory: [kb.id, kb2.id], automation: h.id }]) {
      const id = await create(values);
      expect((await db.grant.findUniqueOrThrow({ where: { id } })).values).toEqual(values);
    }
  });

  it('a present optional key never stands for its absence: null, "", [], the wildcard and a list are refused, storing nothing', async () => {
    const s = await schedule();
    for (const branch of [null, '', [], '*', ['docs'], 7, {}, 'bad loc', ':docs', 'docs:']) {
      expect({ branch, code: await code(create({ memory: kb.id, branch })) }).toEqual({ branch, code: 'GRANT_VALUES_INVALID' });
    }
    for (const automation of [null, '', [], '*', [s.id], 7, {}]) {
      expect({ automation, code: await code(create({ memory: kb.id, automation })) }).toEqual({ automation, code: 'GRANT_VALUES_INVALID' });
    }
    expect(await db.grant.count({ where: { action: 'memory.read' } })).toBe(0);
  });

  it('branch only with form (b) naming ONE memory: form (a) and a list are refused (the gate\'s decision)', async () => {
    for (const memory of [w.orgId, [kb.id], [kb.id, kb2.id]]) {
      expect({ memory, code: await code(create({ memory, branch: 'docs' })) }).toEqual({ memory, code: 'GRANT_VALUES_INVALID' });
    }
    expect(await db.grant.count({ where: { action: 'memory.read' } })).toBe(0);
  });

  it('automation: a missing, deleted or other-App trigger is the one refusal (no existence oracle)', async () => {
    const gone = await schedule();
    await db.agentSchedule.update({ where: { id: gone.id }, data: { deletedAt: new Date() } });
    const goneHook = await webhook();
    await db.agentWebhook.update({ where: { id: goneHook.id }, data: { deletedAt: new Date() } });
    const foreign = await schedule(w.app2Id);
    const foreignHook = await webhook(w.app2Id);
    for (const automation of [generateId(), gone.id, goneHook.id, foreign.id, foreignHook.id]) {
      expect({ automation, code: await code(create({ memory: kb.id, automation })) }).toEqual({ automation, code: 'GRANT_VALUES_INVALID' });
    }
    expect(await db.grant.count({ where: { action: 'memory.read' } })).toBe(0);
  });

  it('an undeclared key is refused, and the required `memory` stays required', async () => {
    expect(await code(create({ memory: kb.id, prefix: 'docs' }))).toBe('GRANT_VALUES_INVALID');
    expect(await code(create({ branch: 'docs' }))).toBe('GRANT_VALUES_INVALID');
    expect(await code(create({}))).toBe('GRANT_VALUES_INVALID');
    expect(await db.grant.count({ where: { action: 'memory.read' } })).toBe(0);
  });
});

describe('the signed sentence names every restriction, and nothing for an absent key', () => {
  const action = () => PLATFORM_ACTIONS.find((a) => a.name === 'memory.read')!;
  const app = { urn: 'hrn:app:acme.com:mealplan' };
  const refs = { m1: { urn: 'hrn:mem:acme.com:recipes' }, o1: { urn: 'hrn:org:acme.com' } };
  const S = '01a2scheduleid00000000000000000s';
  const H = '01a2webhookid000000000000000000w';
  const automations = { [S]: 'schedule', [H]: 'webhook' } as const;
  const render = (values: Record<string, unknown>) => renderGrantSummary({ action: action(), app, values, refs, automations });

  it('the five sentences of the pre-build bytes (issuecomment-7236803193), the first byte-identical to S1', () => {
    expect(render({ memory: 'm1' }))
      .toBe('Let hrn:app:acme.com:mealplan, acting with no person behind it, read the memory hrn:mem:acme.com:recipes, read only');
    expect(render({ memory: 'm1', branch: 'docs:api' }))
      .toBe('Let hrn:app:acme.com:mealplan, acting with no person behind it, read the memory hrn:mem:acme.com:recipes, only the loc docs:api and below it, read only');
    expect(render({ memory: 'm1', automation: S }))
      .toBe(`Let hrn:app:acme.com:mealplan, acting with no person behind it, read the memory hrn:mem:acme.com:recipes, read only, and only in the runs of the schedule ${S}`);
    expect(render({ memory: 'm1', branch: 'docs:api', automation: H }))
      .toBe(`Let hrn:app:acme.com:mealplan, acting with no person behind it, read the memory hrn:mem:acme.com:recipes, only the loc docs:api and below it, read only, and only in the runs of the webhook ${H}`);
    expect(render({ memory: 'o1', automation: S }))
      .toBe(`Let hrn:app:acme.com:mealplan, acting with no person behind it, read all ORGANIZATION knowledge of hrn:org:acme.com, read only, and only in the runs of the schedule ${S}`);
  });

  it('a value it cannot write refuses the whole sentence: null, "", the wildcard, a list, an unresolved automation', () => {
    for (const values of [
      { memory: 'm1', branch: null }, { memory: 'm1', branch: '' }, { memory: 'm1', branch: '*' }, { memory: 'm1', branch: ['docs'] },
      { memory: 'm1', automation: null }, { memory: 'm1', automation: '' }, { memory: 'm1', automation: '*' }, { memory: 'm1', automation: [S] },
      { memory: 'm1', automation: generateId() },
    ]) expect(() => render(values)).toThrow(GrantSummaryError);
    expect(() => renderGrantSummary({ action: action(), app, values: { memory: 'm1', automation: S }, refs })).toThrow(GrantSummaryError);
  });
});
