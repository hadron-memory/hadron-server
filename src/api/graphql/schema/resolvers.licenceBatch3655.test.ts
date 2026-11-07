/**
 * #3655 — the #1148 licence and text checks are batched on the hot read paths: one page or request reads the Agents,
 * the App owner's memberships, the owner's subscriptions and the caller's memberships ONCE, however many Agents (or
 * Apps, or workers) it covers. Before this, each row ran its own `agent`, `orgMember` and `agentSubscription` reads
 * (personalOrgAgentLicenseHolds: 3, personalOrgAgentTextAllowed: 5), so the cost grew with the roster.
 *
 * The pins count only those three models: everything else these paths read is out of #3655's scope and may stay
 * linear. Behaviour is pinned separately (the differential at the end, and every existing #1148/#3653 pin unchanged).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import type { Context } from './resolvers.js';
import { getAppMemoryCandidates, participantSystemMemoryFolds } from '../../../mcp/access-control.js';
import { readableInstallMemoryIds } from '../../../lib/auth/installMemory.js';
import { activeAppInstallLicenseIdsForAgent } from '../../../lib/appAgent.js';
import { resolveServedBootPrompt, type PageServedMemo } from '../../../lib/bootPrompt/serve.js';
import { serveAgentBootPrompt } from '../../../test/servedBootPrompt.js';

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
    expect(cost[4], JSON.stringify(cost)).toBe(cost[1]);
  });

  it('participantSystemMemoryFolds (access-control.ts installedSystemMemoryFolds)', async () => {
    const cost = await costAt(async (f, client) => {
      const folds = await participantSystemMemoryFolds(client, viewer(f, client));
      const ids = new Set(folds.flatMap(fold => [...fold.map.keys()]));
      return f.systemIds.filter(id => ids.has(id)).length;
    });
    expect(cost[4], JSON.stringify(cost)).toBe(cost[1]);
  });

  it('readableInstallMemoryIds (installMemory.ts)', async () => {
    const cost = await costAt(async (f, client) => (await readableInstallMemoryIds(client, viewer(f, client))).length);
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
    expect(cost[4], JSON.stringify(cost)).toBe(cost[1]);
  });
});
