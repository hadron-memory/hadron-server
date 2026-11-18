/**
 * #3655 — the #1148 licence and text checks are batched on the hot read paths: one page or request reads the Agents,
 * the App owner's memberships, the owner's subscriptions and the caller's memberships ONCE, however many Agents (or
 * Apps, or workers) it covers. Before this, each row ran its own `agent`, `orgMember` and `agentSubscription` reads
 * (personalOrgAgentLicenseHolds: 3, personalOrgAgentTextAllowed: 5), so the cost grew with the roster.
 *
 * The pins count only those three models: everything else these paths read is out of #3655's scope and may stay
 * linear. Behaviour is pinned separately: the differential at the end holds the batch to the single helpers, and every
 * existing #1148/#3653 pin is unchanged.
 */
import { describe, expect, it, vi } from 'vitest';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import type { Context } from './resolvers.js';
import { getAppMemoryCandidates, participantSystemMemoryFolds } from '../../../mcp/access-control.js';
import { readableInstallMemoryIds } from '../../../lib/auth/installMemory.js';
import { activeAgentInstallLicenseIds, activeAgentInstallLicenseIdsAcross, activeAppInstallLicenseIdsForAgent } from '../../../lib/appAgent.js';
import { resolveServedBootPrompt, type PageServedMemo } from '../../../lib/bootPrompt/serve.js';
import { serveAgentBootPrompt } from '../../../test/servedBootPrompt.js';
import {
  personalOrgAgentLicenseBatch, personalOrgAgentLicenseHolds, personalOrgAgentTextAllowed, personalOrgAgentTextBatch,
} from '../../../lib/auth/personalOrgAgentInstall.js';

vi.mock('../../../integrations/github/writeNodeToGit.js', () => ({ writeNodeToGit: vi.fn().mockResolvedValue(undefined) }));

/** The models the per-row #1148 helpers read. */
const PER_ROW_MODELS = new Set(['Agent', 'OrgMember', 'AgentSubscription']);

/** A client whose reads of the per-row models are counted. It is the only handle the paths under test see. */
function counted() {
  const counter = { n: 0, ops: [] as string[] };
  const client = db.$extends({
    query: {
      $allOperations: ({ model, operation, args, query }) => {
        if (model && PER_ROW_MODELS.has(model)) { counter.n += 1; counter.ops.push(`${model}.${operation}`); }
        return query(args);
      },
    },
  }) as unknown as typeof db;
  return { client, counter };
}

type Fixture = { ownerId: string; viewerId: string; orgId: string; appId: string; agentIds: string[]; systemIds: string[] };

/** A personal App owned by a member of a publishing org, with `n` licensed ORGANIZATION Agents of that org installed. */
async function build(n: number): Promise<Fixture> {
  await cleanDb(db);
  const ownerId = (await db.user.create({ data: { id: generateId(), handle: 'owner3655', roles: ['READER'] } })).id;
  const viewerId = (await db.user.create({ data: { id: generateId(), handle: 'viewer3655', roles: ['READER'] } })).id;
  const orgId = (await db.organization.create({ data: { id: generateId(), name: 'Publisher', urn: 'publisher3655.test' } })).id;
  await db.orgMember.createMany({ data: [ownerId, viewerId].map(userId => ({ organizationId: orgId, userId, role: 'READER' as const })) });
  const appId = (await db.app.create({ data: { id: generateId(), ownerUserId: ownerId, name: 'Personal', urn: '@owner3655:personal' } })).id;
  await db.appMember.createMany({ data: [{ appId, userId: ownerId, role: 'owner' }, { appId, userId: viewerId, role: 'member' }] });
  const agentIds: string[] = [];
  const systemIds: string[] = [];
  for (let i = 0; i < n; i++) {
    const systemMemoryId = (await db.memory.create({ data: { class: 'system', organizationId: orgId, name: `Definition ${i}`, urn: `publisher3655.test:definition-${i}` } })).id;
    const agentId = (await db.agent.create({ data: { id: generateId(), organizationId: orgId, name: `Agent ${i}`, urn: `publisher3655.test:agent-${i}`, visibility: 'ORGANIZATION', systemMemoryId } })).id;
    await db.agentSubscription.create({ data: { userId: ownerId, agentId, activatedAt: new Date('2020-01-01') } });
    await db.appAgent.create({ data: { appId, agentId } });
    await db.memory.create({ data: { class: 'system', appId, ownerUserId: ownerId, isInstallMemory: true, installOfAgentId: agentId, name: `Install ${i}`, urn: `@owner3655:install-${i}` } });
    agentIds.push(agentId);
    systemIds.push(systemMemoryId);
  }
  return { ownerId, viewerId, orgId, appId, agentIds, systemIds };
}

/** One Agent of the org installed on `n` personal Apps, each owned by a different licensed member. */
async function buildApps(n: number) {
  await cleanDb(db);
  const orgId = (await db.organization.create({ data: { id: generateId(), name: 'Publisher', urn: 'publisher3655.test' } })).id;
  const agentId = (await db.agent.create({ data: { id: generateId(), organizationId: orgId, name: 'Shared', urn: 'publisher3655.test:shared', visibility: 'ORGANIZATION' } })).id;
  const appIds: string[] = [];
  for (let i = 0; i < n; i++) {
    const ownerId = (await db.user.create({ data: { id: generateId(), handle: `owner3655-${i}`, roles: ['READER'] } })).id;
    await db.orgMember.create({ data: { organizationId: orgId, userId: ownerId, role: 'READER' } });
    await db.agentSubscription.create({ data: { userId: ownerId, agentId, activatedAt: new Date('2020-01-01') } });
    const appId = (await db.app.create({ data: { id: generateId(), ownerUserId: ownerId, name: `Personal ${i}`, urn: `@owner3655-${i}:personal` } })).id;
    await db.appAgent.create({ data: { appId, agentId } });
    appIds.push(appId);
  }
  return { agentId, appIds };
}

const viewer = (f: Fixture, client: typeof db): Context => ({ db: client, userId: f.viewerId, roles: ['READER'] });

/** Per-row-model reads of `run` at roster sizes 1 and 4; the outcome check proves each run admitted every row. */
async function costAt(path: (f: Fixture, client: typeof db) => Promise<number>) {
  const out: Record<number, number> = {};
  for (const n of [1, 4]) {
    const f = await build(n);
    const { client, counter } = counted();
    expect(await path(f, client), `all ${n} rows admitted`).toBe(n);
    out[n] = counter.n;
  }
  return out;
}

describe('#3655: per-row licence and text reads do not grow with the roster', () => {
  it('getAppMemoryCandidates (access-control.ts buildAppMemoryMap + appAgent.ts activeAgentInstallLicenseIds)', async () => {
    const cost = await costAt(async (f, client) => {
      const map = await getAppMemoryCandidates(client, f.appId, { allAgents: true, callerUserId: f.viewerId });
      return f.systemIds.filter(id => map.has(id)).length;
    });
    expect(cost[1], `the counter saw the per-row reads: ${JSON.stringify(cost)}`).toBeGreaterThan(0);
    expect(cost[4], JSON.stringify(cost)).toBe(cost[1]);
  });

  it('participantSystemMemoryFolds (access-control.ts installedSystemMemoryFolds)', async () => {
    const cost = await costAt(async (f, client) => {
      const folds = await participantSystemMemoryFolds(client, viewer(f, client));
      const ids = new Set(folds.flatMap(fold => [...fold.map.keys()]));
      return f.systemIds.filter(id => ids.has(id)).length;
    });
    expect(cost[1], `the counter saw the per-row reads: ${JSON.stringify(cost)}`).toBeGreaterThan(0);
    expect(cost[4], JSON.stringify(cost)).toBe(cost[1]);
  });

  it('participantSystemMemoryFolds across many personal Apps (installedSystemMemoryFolds licence per App, Dorian P2-1)', async () => {
    const cost: Record<number, number> = {};
    for (const n of [1, 4]) {
      await cleanDb(db);
      const ownerId = (await db.user.create({ data: { id: generateId(), handle: 'owner3655', roles: ['READER'] } })).id;
      const viewerId = (await db.user.create({ data: { id: generateId(), handle: 'viewer3655', roles: ['READER'] } })).id;
      const orgId = (await db.organization.create({ data: { id: generateId(), name: 'Publisher', urn: 'publisher3655.test' } })).id;
      await db.orgMember.createMany({ data: [ownerId, viewerId].map(userId => ({ organizationId: orgId, userId, role: 'READER' as const })) });
      const systemMemoryId = (await db.memory.create({ data: { class: 'system', organizationId: orgId, name: 'Definition', urn: 'publisher3655.test:definition' } })).id;
      const agentId = (await db.agent.create({ data: { id: generateId(), organizationId: orgId, name: 'Shared', urn: 'publisher3655.test:shared', visibility: 'ORGANIZATION', systemMemoryId } })).id;
      await db.agentSubscription.create({ data: { userId: ownerId, agentId, activatedAt: new Date('2020-01-01') } });
      for (let i = 0; i < n; i++) {
        const appId = (await db.app.create({ data: { id: generateId(), ownerUserId: ownerId, name: `Personal ${i}`, urn: `@owner3655:personal-${i}` } })).id;
        await db.appMember.createMany({ data: [{ appId, userId: ownerId, role: 'owner' }, { appId, userId: viewerId, role: 'member' }] });
        await db.appAgent.create({ data: { appId, agentId } });
      }
      const { client, counter } = counted();
      const folds = await participantSystemMemoryFolds(client, { userId: viewerId });
      expect(folds.filter(fold => fold.map.has(systemMemoryId)).length, `all ${n} Apps folded`).toBe(n);
      cost[n] = counter.n;
    }
    expect(cost[1], `the counter saw the per-row reads: ${JSON.stringify(cost)}`).toBeGreaterThan(0);
    expect(cost[4], JSON.stringify(cost)).toBe(cost[1]);
  });

  it('readableInstallMemoryIds (installMemory.ts)', async () => {
    const cost = await costAt(async (f, client) => (await readableInstallMemoryIds(client, viewer(f, client))).length);
    expect(cost[1], `the counter saw the per-row reads: ${JSON.stringify(cost)}`).toBeGreaterThan(0);
    expect(cost[4], JSON.stringify(cost)).toBe(cost[1]);
  });

  it('activeAppInstallLicenseIdsForAgent over many personal Apps (appAgent.ts)', async () => {
    const cost: Record<number, number> = {};
    for (const n of [1, 4]) {
      const { agentId, appIds } = await buildApps(n);
      const { client, counter } = counted();
      expect((await activeAppInstallLicenseIdsForAgent(client, agentId, appIds)).size, `all ${n} Apps licensed`).toBe(n);
      cost[n] = counter.n;
    }
    expect(cost[1], `the counter saw the per-row reads: ${JSON.stringify(cost)}`).toBeGreaterThan(0);
    expect(cost[4], JSON.stringify(cost)).toBe(cost[1]);
  });

  it('one page of uncustomised workers of one install checks the licence once (bootPrompt/serve.ts)', async () => {
    const cost: Record<number, number> = {};
    for (const n of [1, 4]) {
      const f = await build(1);
      await serveAgentBootPrompt(db, f.agentIds[0]!, 'SYNTHETIC 3655');
      const { client, counter } = counted();
      const memo: PageServedMemo = new Map();
      const agent = { id: f.agentIds[0]!, name: 'Agent 0' };
      const served = await Promise.all(Array.from({ length: n }, (_, i) =>
        resolveServedBootPrompt(client, { surface: 'bind', appId: f.appId, agent, workerId: `worker-${i}` }, { memo, workerPointer: null })));
      expect(served.every(s => s.content === 'SYNTHETIC 3655'), `all ${n} served`).toBe(true);
      cost[n] = counter.n;
    }
    expect(cost[1], `the counter saw the per-row reads: ${JSON.stringify(cost)}`).toBeGreaterThan(0);
    expect(cost[4], JSON.stringify(cost)).toBe(cost[1]);
  });
});

describe('#3655: the counter counts', () => {
  it('one single-helper licence check through the counted client is seen as its Agent, OrgMember and AgentSubscription reads', async () => {
    const f = await build(1);
    const { client, counter } = counted();
    expect(await personalOrgAgentLicenseHolds(client, { organizationId: null, ownerUserId: f.ownerId }, f.agentIds[0])).toBe(true);
    expect(new Set(counter.ops.map(op => op.split('.')[0]))).toEqual(PER_ROW_MODELS);
  });
});

describe('#3655: the cross-App licence batch keeps each App to its own rows', () => {
  it('a grant licenses only its own org, and a deleted org licenses nothing through a retained grant or subscription', async () => {
    await cleanDb(db);
    const org = async (name: string, deletedAt: Date | null = null) =>
      (await db.organization.create({ data: { id: generateId(), name, urn: `${name}3655x.test`, deletedAt } })).id;
    const [publisher, granted, ungranted, gone] = [await org('publisher'), await org('granted'), await org('ungranted'), await org('gone', new Date())];
    const owner = (await db.user.create({ data: { id: generateId(), handle: 'owner3655x', roles: ['READER'] } })).id;
    const agent = async (name: string, organizationId: string, visibility: 'ORGANIZATION' | 'PUBLIC') =>
      db.agent.create({ data: { id: generateId(), name, urn: `${name}3655x.test:agent`, organizationId, visibility }, select: { id: true, organizationId: true, ownerUserId: true } });
    const foreign = await agent('foreign', publisher, 'ORGANIZATION');
    const goneOwned = await agent('gone-public', gone, 'PUBLIC');
    await db.agentOrgGrant.createMany({ data: [
      { orgId: granted, agentId: foreign.id, activatedAt: new Date('2020-01-01') },
      { orgId: gone, agentId: foreign.id, activatedAt: new Date('2020-01-01') },
    ] });
    await db.agentSubscription.create({ data: { userId: owner, agentId: goneOwned.id, activatedAt: new Date('2020-01-01') } });
    const licensed = await activeAgentInstallLicenseIdsAcross(db, [
      { app: { organizationId: granted, ownerUserId: null }, agents: [foreign] },
      { app: { organizationId: ungranted, ownerUserId: null }, agents: [foreign] },
      { app: { organizationId: gone, ownerUserId: null }, agents: [foreign] },
      { app: { organizationId: null, ownerUserId: owner }, agents: [goneOwned] },
    ]);
    expect(licensed.map(set => [...set])).toEqual([[foreign.id], [], [], []]);
  });
});

describe('#3655 differential: the batch answers exactly what the single helpers answer', () => {
  it('a mixed roster of Apps, Agents, licences and callers', async () => {
    await cleanDb(db);
    const user = async (handle: string) => (await db.user.create({ data: { id: generateId(), handle, roles: ['READER'] } })).id;
    const [owner, lapsedOwner, departedOwner, member, outsider] = await Promise.all(
      ['owner', 'lapsed', 'departed', 'member', 'outsider'].map(h => user(`${h}3655d`)));
    const org = (await db.organization.create({ data: { id: generateId(), name: 'Publisher', urn: 'publisher3655d.test' } })).id;
    const goneOrg = (await db.organization.create({ data: { id: generateId(), name: 'Gone', urn: 'gone3655d.test', deletedAt: new Date() } })).id;
    await db.orgMember.createMany({ data: [
      { organizationId: org, userId: owner, role: 'READER' },
      { organizationId: org, userId: lapsedOwner, role: 'READER' },
      { organizationId: org, userId: departedOwner, role: 'READER', deletedAt: new Date() },
      { organizationId: org, userId: member, role: 'READER' },
      { organizationId: goneOrg, userId: owner, role: 'READER' },
    ] });
    const agent = async (name: string, data: Record<string, unknown>) =>
      (await db.agent.create({ data: { id: generateId(), name, urn: `publisher3655d.test:${name}`, ...data } })).id;
    const agents = {
      org: await agent('org', { organizationId: org, visibility: 'ORGANIZATION' }),
      public: await agent('public', { organizationId: org, visibility: 'PUBLIC' }),
      personalVis: await agent('personal-vis', { organizationId: org, visibility: 'PERSONAL' }),
      deleted: await agent('deleted', { organizationId: org, visibility: 'ORGANIZATION', deletedAt: new Date() }),
      goneOrg: await agent('gone-org', { organizationId: goneOrg, visibility: 'ORGANIZATION' }),
      userOwned: await agent('user-owned', { ownerUserId: owner, visibility: 'PERSONAL' }),
      unsubscribed: await agent('unsubscribed', { organizationId: org, visibility: 'ORGANIZATION' }),
      expired: await agent('expired', { organizationId: org, visibility: 'ORGANIZATION' }),
      missing: generateId(),
    };
    const subscribe = (userId: string, agentId: string, extra: Record<string, unknown> = {}) =>
      db.agentSubscription.create({ data: { userId, agentId, activatedAt: new Date('2020-01-01'), ...extra } });
    for (const id of [agents.org, agents.public, agents.personalVis, agents.deleted, agents.goneOrg]) {
      await subscribe(owner, id);
      await subscribe(departedOwner, id);
    }
    await subscribe(lapsedOwner, agents.org, { revokedAt: new Date() });
    await subscribe(owner, agents.expired, { expiresAt: new Date('2021-01-01') });
    await subscribe(lapsedOwner, agents.expired, { activatedAt: null });
    const apps = [
      { organizationId: null, ownerUserId: owner },
      { organizationId: null, ownerUserId: lapsedOwner },
      { organizationId: null, ownerUserId: departedOwner },
      { organizationId: org, ownerUserId: null },
      { organizationId: null, ownerUserId: null },
    ];
    const callers = [owner, member, outsider, departedOwner, null, undefined];
    const checks = apps.flatMap(app => Object.values(agents).map(agentId => ({ app, agentId })));
    const textChecks = checks.flatMap(check => callers.map(userId => ({ ...check, userId })));

    const licenceBatch = await personalOrgAgentLicenseBatch(db, checks);
    const licenceSingle = await Promise.all(checks.map(c => personalOrgAgentLicenseHolds(db, c.app, c.agentId)));
    expect(licenceBatch).toEqual(licenceSingle);
    const textBatch = await personalOrgAgentTextBatch(db, textChecks);
    const textSingle = await Promise.all(textChecks.map(c => personalOrgAgentTextAllowed(db, c.app, c.agentId, c.userId)));
    expect(textBatch).toEqual(textSingle);
    // The roster must exercise both answers, or equality proves nothing.
    expect(new Set(licenceSingle)).toEqual(new Set([true, false]));
    expect(new Set(textSingle)).toEqual(new Set([true, false]));
    // Dorian P2-1 on #3681: the fold now licenses every App in one batch. Hold it to the single-App helper over the
    // same roster plus org-owned Apps (same-org, granted, revoked grant, deleted org) and an empty group.
    const grantee = (await db.organization.create({ data: { id: generateId(), name: 'Grantee', urn: 'grantee3655d.test' } })).id;
    await db.agentOrgGrant.createMany({ data: [
      { orgId: grantee, agentId: agents.org, activatedAt: new Date('2020-01-01') },
      { orgId: grantee, agentId: agents.expired, activatedAt: new Date('2020-01-01'), revokedAt: new Date() },
    ] });
    const shapes = await db.agent.findMany({ where: { id: { in: Object.values(agents) } }, select: { id: true, organizationId: true, ownerUserId: true } });
    const roster = [...shapes, { id: agents.missing, organizationId: org, ownerUserId: null }];
    const groups = [
      ...apps,
      { organizationId: grantee, ownerUserId: null },
      { organizationId: goneOrg, ownerUserId: null },
    ].map(app => ({ app, agents: roster })).concat([{ app: apps[0], agents: [] }]);
    const across = (await activeAgentInstallLicenseIdsAcross(db, groups)).map(set => [...set].sort());
    const perApp = await Promise.all(groups.map(async g => [...await activeAgentInstallLicenseIds(db, g.app, g.agents)].sort()));
    expect(across).toEqual(perApp);
    expect(perApp.some(ids => ids.length > 0) && perApp.some((ids, i) => ids.length < groups[i].agents.length)).toBe(true);
    expect(await personalOrgAgentLicenseBatch(db, [])).toEqual([]);
  });
});

describe('#3655: shared answers stay per row', () => {
  it('one page memo answers each Agent of an App for itself', async () => {
    const f = await build(2);
    for (const id of f.agentIds) await serveAgentBootPrompt(db, id, 'SYNTHETIC 3655');
    await db.agentSubscription.update({ where: { userId_agentId: { userId: f.ownerId, agentId: f.agentIds[1]! } }, data: { revokedAt: new Date() } });
    const memo: PageServedMemo = new Map();
    const serve = (i: number) => resolveServedBootPrompt(db, { surface: 'bind', appId: f.appId, agent: { id: f.agentIds[i]!, name: `Agent ${i}` }, workerId: `worker-${i}` }, { memo, workerPointer: null });
    expect((await serve(0)).content).toBe('SYNTHETIC 3655');
    await expect(serve(1)).rejects.toMatchObject({ extensions: { code: 'BOOT_PROMPT_INSTALL_LICENSE_INACTIVE' } });
  });

  it('a fold admits each Agent on its own text answer, not the batch as a whole', async () => {
    const f = await build(1);
    const otherOrg = (await db.organization.create({ data: { id: generateId(), name: 'Elsewhere', urn: 'elsewhere3655.test' } })).id;
    await db.orgMember.create({ data: { organizationId: otherOrg, userId: f.ownerId, role: 'READER' } });
    const systemMemoryId = (await db.memory.create({ data: { class: 'system', organizationId: otherOrg, name: 'Elsewhere', urn: 'elsewhere3655.test:definition' } })).id;
    const agentId = (await db.agent.create({ data: { id: generateId(), organizationId: otherOrg, name: 'Elsewhere', urn: 'elsewhere3655.test:agent', visibility: 'ORGANIZATION', systemMemoryId } })).id;
    await db.agentSubscription.create({ data: { userId: f.ownerId, agentId, activatedAt: new Date('2020-01-01') } });
    await db.appAgent.create({ data: { appId: f.appId, agentId } });
    // The viewer is a member of the first org only: the second Agent's text is the owner's to read, not the viewer's.
    const folds = await participantSystemMemoryFolds(db, viewer(f, db));
    const ids = new Set(folds.flatMap(fold => [...fold.map.keys()]));
    expect(ids.has(f.systemIds[0]!)).toBe(true);
    expect(ids.has(systemMemoryId)).toBe(false);
  });
});
