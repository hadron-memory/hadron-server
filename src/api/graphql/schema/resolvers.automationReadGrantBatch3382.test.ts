/** #3382: synthetic census, exact list contract and per-admission predicate batching.
 * No live/customer inventory, latency, anchor bound or paging claim.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { WORKER_SIGNATURE_DEFAULTS } from '../../../lib/workerSignature.js';
import { automationReadGrantQueries as Q } from './resolvers.automationReadGrant.js';
import type { Context } from './resolvers.helpers.js';

vi.mock('../../../integrations/github/writeNodeToGit.js', () => ({ writeNodeToGit: vi.fn().mockResolvedValue(undefined) }));
const claim = { kind: 'LIVE_CHAT', ref: 'synthetic3382:turn' } as const;
const context = (userId: string, extra: Partial<Context> = {}): Context => ({ db, userId, roles: ['READER'], ...extra });
beforeEach(async () => { await cleanDb(db); });

async function fixture(n: number) {
  const holder = await db.user.create({ data: { handle: 'batch-holder', roles: ['READER'] } });
  const owner = await db.user.create({ data: { handle: 'batch-app-owner', roles: ['READER'] } });
  const appOrg = await db.organization.create({ data: { name: 'App org', urn: 'batch3382-app.test' } });
  const orgs = await Promise.all([0, 1, 2].map(i => db.organization.create({ data: { name: 'Target org', urn: 'batch3382-target' + i + '.test' } })));
  await db.orgMember.createMany({ data: orgs.map((o, i) => ({ organizationId: o.id, userId: holder.id, role: i < 2 ? 'ADMIN' as const : 'READER' as const })) });
  await db.orgMember.create({ data: { organizationId: appOrg.id, userId: holder.id, role: 'CONTRIBUTOR' } });
  const apps = await Promise.all(['a', 'b'].map(name => db.app.create({ data: { name, organizationId: appOrg.id, urn: appOrg.urn + ':' + name } })));
  await db.appMember.createMany({ data: apps.map(a => ({ appId: a.id, userId: owner.id, role: 'owner' })) });
  const casting = await db.agent.create({ data: { name: 'Casting', urn: appOrg.urn + ':casting', organizationId: appOrg.id } });
  const worker = await db.worker.create({ data: { ...WORKER_SIGNATURE_DEFAULTS, name: 'Caller', slug: 'caller', appId: apps[0].id, agentId: casting.id, heldByUserId: holder.id } });
  const session = await db.session.create({ data: { appId: apps[0].id, agentId: casting.id, workerId: worker.id, userId: holder.id, tool: 'vitest' } });
  const memories = [];
  const agents = [];
  for (let i = 0; i <= n; i++) {
    const org = orgs[i === n ? 0 : i % 3];
    const m = await db.memory.create({ data: { name: 'Target', urn: org.urn + ':target-' + i, class: 'system', organizationId: org.id } });
    const a = await db.agent.create({ data: { name: 'Target', urn: org.urn + ':agent-' + i, organizationId: org.id, systemMemoryId: m.id } });
    await db.appAgent.createMany({ data: apps.map(app => ({ appId: app.id, agentId: a.id })) });
    memories.push(m); agents.push(a);
  }
  let seq = 0;
  const grant = (appId: string, memoryId: string, prefix: string, revoked: boolean) => db.appAutomationReadGrant.create({ data: {
    appId, memoryId, triggerKind: 'SCHEDULE', triggerId: generateId(), prefix, grantedBy: owner.id,
    createdAt: new Date(Date.UTC(2025, 0, 1, 0, 0, seq++)),
    ...(revoked ? { revokedAt: new Date('2025-02-01'), revokedBy: owner.id } : {}),
  } });
  for (let i = 0; i < n; i++) {
    await grant(apps[0].id, memories[i].id, 'tasks', false);
    await grant(apps[0].id, memories[i].id, 'reports', false); // repeated target
    await grant(apps[0].id, memories[i].id, 'old', true);
    await grant(apps[1].id, memories[i].id, 'other', false);
  }
  await grant(apps[0].id, memories[n].id, 'revoked-only', true);
  const rows = await db.appAutomationReadGrant.findMany({ orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] });
  const allowed = new Set(memories.filter((_, i) => i === n || i % 3 < 2).map(m => m.id));
  const expected = (appId: string | null, memoryId: string | null, includeRevoked: boolean, asOwner: boolean) => rows
    .filter(r => (!appId || r.appId === appId) && (!memoryId || r.memoryId === memoryId) && (includeRevoked || r.revokedAt === null) && (asOwner || allowed.has(r.memoryId)))
    .map(r => ({ id: r.id, appId: r.appId, triggerKind: r.triggerKind, triggerId: r.triggerId,
      memoryUrn: 'hrn:mem:' + memories.find(m => m.id === r.memoryId)!.urn, prefix: r.prefix, grantedBy: r.grantedBy,
      createdAt: r.createdAt, revokedAt: r.revokedAt, revokedBy: r.revokedBy }));
  return { holder, owner, appOrg, orgs, apps, memories, agents, session, rows, expected };
}

const predicateModels = new Set(['Memory', 'Agent', 'OrgMember', 'AppMember']);
function measured() {
  const counts: Record<string, number> = {};
  const client = db.$extends({ query: { $allModels: { $allOperations: async ({ model, operation, args, query }) => {
    if (predicateModels.has(model) && operation.startsWith('find')) counts[model + '.' + operation] = (counts[model + '.' + operation] ?? 0) + 1;
    return query(args);
  } } } });
  return { client: client as unknown as Context['db'], counts, // Memory.findUnique includes the unchanged per-anchor liveness reads (and legacy URN lookups).
    // Publish them, but do not claim to batch/bound anchors in a predicate-only optimization.
    total: () => Object.entries(counts).filter(([key]) => key !== 'Memory.findUnique').reduce((a, [, b]) => a + b, 0) };
}
const events = () => db.agentTeamEvent.count();
const forbidden = (p: Promise<unknown>) => expect(p).rejects.toMatchObject({ extensions: { code: 'FORBIDDEN' } });

describe('#3382 batch-only list contract', () => {
  for (const n of [3, 36]) it('exact rows/order and numeric census with ' + n + ' distinct active targets', async () => {
    const f = await fixture(n);
    const metrics = [];
    let audit = 0;
    for (const includeRevoked of [false, true]) {
      for (const mode of ['app-manager', 'target-only', 'worker', 'cross-app-memory'] as const) {
        const m = measured();
        const asOwner = mode === 'app-manager';
        const input = mode === 'cross-app-memory' ? { memoryRef: f.memories[0].id, includeRevoked } : {
          appRef: f.apps[0].id, includeRevoked, ...(mode === 'worker' ? { instruction: claim } : {}),
        };
        const out = await Q.automationReadGrants({}, input, context(asOwner ? f.owner.id : f.holder.id, {
          db: m.client, ...(mode === 'worker' ? { sessionId: f.session.id } : {}),
        }));
        expect(JSON.stringify(out)).toBe(JSON.stringify(f.expected(mode === 'cross-app-memory' ? null : f.apps[0].id,
          mode === 'cross-app-memory' ? f.memories[0].id : null, includeRevoked, asOwner)));
        if (mode === 'worker') audit++;
        expect(await events()).toBe(audit);
        metrics.push({ mode, includeRevoked, rows: out.length, queries: m.total(), anchorOrUrnReads: m.counts['Memory.findUnique'] ?? 0, detail: m.counts });
      }
    }
    const census = { active: f.rows.filter(r => !r.revokedAt).length, revoked: f.rows.filter(r => !!r.revokedAt).length,
      revokedOnlyTargets: 1, targetOrgs: new Set(f.memories.map(m => m.organizationId)).size,
      apps: f.apps.map(app => ({ id: app.id, activeRows: f.rows.filter(r => r.appId === app.id && !r.revokedAt).length,
        allRows: f.rows.filter(r => r.appId === app.id).length,
        activeTargets: new Set(f.rows.filter(r => r.appId === app.id && !r.revokedAt).map(r => r.memoryId)).size,
        allTargets: new Set(f.rows.filter(r => r.appId === app.id).map(r => r.memoryId)).size })), metrics };
    console.info('3382 SYNTHETIC CENSUS', JSON.stringify(census));
    expect(census.active).toBe(3 * n);
    expect(census.revoked).toBe(n + 1);
    for (const metric of metrics) expect(metric.queries, JSON.stringify(metric)).toBeLessThanOrEqual(metric.mode === 'worker' ? 24 : 8);
  }, 30_000);

  it('empty, unknown/foreign selectors and invalid instruction/principal refuse or filter without widening', async () => {
    const f = await fixture(3);
    const outsider = await db.user.create({ data: { handle: 'batch-outsider' } });
    const foreign = await db.memory.create({ data: { name: 'Foreign', urn: 'batch3382-user.test:foreign', class: 'knowledge', ownerUserId: outsider.id } });
    for (const memoryRef of [generateId(), foreign.id]) {
      expect(await Q.automationReadGrants({}, { memoryRef }, context(f.holder.id))).toEqual([]);
      await forbidden(Q.automationReadGrants({}, { memoryRef, instruction: claim }, context(f.holder.id, { sessionId: f.session.id })));
    }
    const noGrants = await db.app.create({ data: { name: 'Empty', organizationId: f.appOrg.id, urn: f.appOrg.urn + ':empty' } });
    expect(await Q.automationReadGrants({}, { appRef: noGrants.id }, context(f.owner.id))).toEqual([]);
    for (const instruction of [undefined, { kind: 'LIVE_CHAT', ref: 'not a ref' } as const]) {
      await forbidden(Q.automationReadGrants({}, { appRef: f.apps[0].id, instruction }, context(f.holder.id, { sessionId: f.session.id })));
    }
    for (const extra of [{ appKeyId: generateId() }, { clientId: 'run:synthetic3382' }, { sessionBindingRefused: true }]) {
      await forbidden(Q.automationReadGrants({}, { appRef: f.apps[0].id, instruction: claim }, context(f.holder.id, extra)));
    }
    await forbidden(Q.automationReadGrants({}, { appRef: f.apps[1].id, instruction: claim }, context(f.holder.id, { sessionId: f.session.id })));
    expect(await events()).toBe(0);
  });

  for (const changed of ['all-drift', 'first-drift', 'later-drift', 'deleted'] as const) it('observed target ' + changed + ' preserves drift/first-match admission', async () => {
    const f = await fixture(changed === 'all-drift' ? 1 : 3);
    let injected = false;
    const client = db.$extends({ query: { memory: { findMany: async ({ args, query }) => {
      const rows = await query(args);
      if (!injected && args.where && 'automationReadGrants' in args.where) {
        injected = true;
        const ids = changed === 'all-drift' ? f.memories.map(m => m.id) : [f.memories[changed === 'later-drift' ? 1 : 0].id];
        await db.$transaction(async tx => {
          if (changed === 'deleted') await tx.memory.updateMany({ where: { id: { in: ids } }, data: { deletedAt: new Date() } });
          else {
            await tx.memory.updateMany({ where: { id: { in: ids } }, data: { organizationId: f.orgs[changed === 'later-drift' ? 0 : 1].id } });
            await tx.agent.updateMany({ where: { systemMemoryId: { in: ids } }, data: { organizationId: f.orgs[changed === 'later-drift' ? 0 : 1].id } });
          }
        });
      }
      return rows;
    } } } });
    const call = Q.automationReadGrants({}, { appRef: f.apps[0].id, instruction: claim }, context(f.holder.id, { db: client as unknown as Context['db'], sessionId: f.session.id }));
    if (changed === 'all-drift' || changed === 'deleted') { await forbidden(call); expect(await events()).toBe(0); }
    else { expect((await call).map(r => r.id)).toEqual(f.expected(f.apps[0].id, null, false, false).map(r => r.id)); expect(await events()).toBe(1); }
    expect(injected).toBe(true);
  });

  it('does not reuse the pre-transaction membership decision in final admission', async () => {
    const f = await fixture(1);
    let demoted = false;
    const client = new Proxy(db, { get(target, prop) {
      if (prop === '$transaction') return async (...args: Parameters<typeof db.$transaction>) => {
        demoted = true;
        await db.orgMember.updateMany({ where: { userId: f.holder.id, organizationId: { in: f.orgs.map(o => o.id) } }, data: { role: 'READER' } });
        return Reflect.apply(target.$transaction, target, args);
      };
      const value = Reflect.get(target, prop);
      return typeof value === 'function' ? value.bind(target) : value;
    } });
    await forbidden(Q.automationReadGrants({}, { appRef: f.apps[0].id, instruction: claim }, context(f.holder.id, { db: client, sessionId: f.session.id })));
    expect(demoted).toBe(true); expect(await events()).toBe(0);
  });

  it('a failed audit write never returns a successful list', async () => {
    const f = await fixture(1);
    const client = db.$extends({ query: { agentTeamEvent: { create: async () => { throw new Error('3382 audit failure'); } } } });
    await expect(Q.automationReadGrants({}, { appRef: f.apps[0].id, instruction: claim }, context(f.holder.id, { db: client as unknown as Context['db'], sessionId: f.session.id }))).rejects.toThrow('3382 audit failure');
    expect(await events()).toBe(0);
  });
});
