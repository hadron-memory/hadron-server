/**
 * #3972 (follow-up to #3945 / PR #3964 §10 F1-F3) — pins for the agentTask global search:
 *  1. an impersonated session reaches task hits only through the shared org (cor:acl:100:03, cor:acl:040:07);
 *  2. the gate's catch arm: a typed GraphQLError reads as denied, anything else propagates;
 *  3. the candidate-App scope is a superset of every arm the gate admits, and the gate still decides each App;
 *  4. a caller's hits and `total` do not depend on how many other tenants' Apps match.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { GraphQLError } from 'graphql';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { runAsActor } from '../../../lib/requestActor.js';
import { WORKER_SIGNATURE_DEFAULTS } from '../../../lib/workerSignature.js';
import { taskSearchLimits } from '../../../lib/global-search/entities.js';
import { globalSearch } from '../../../lib/global-search/index.js';
import type { SearchPrincipal } from '../../../lib/global-search/types.js';
import { resolvers, type Context } from './resolvers.js';
import { taskAppScopeFor, taskReadGateFor } from './resolvers.query.org.js';

vi.mock('../../../integrations/github/writeNodeToGit.js', () => ({ writeNodeToGit: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../../../integrations/github/syncGraphFromGithub.js', () => ({ syncGraphFromGithub: vi.fn().mockResolvedValue({ error: null }) }));

const M = resolvers.Mutation as any;
const Q = resolvers.Query as any;

let suffix: string;
let orgA: { id: string; urn: string };
let orgB: { id: string; urn: string };
let target: { id: string };
let stranger: { id: string };

const userCtx = (u: { id: string }): Context => ({ db, userId: u.id, roles: ['READER'] });
const impCtx = (u: { id: string }, org: string): Context =>
  ({ db, userId: u.id, roles: ['READER'], impersonation: { sessionId: 's', actorUserId: 'adm', orgId: org, expiresAt: new Date(Date.now() + 3600e3) } }) as any;
const search = (ctx: Context, query: string) => Q.globalSearch({}, { query, entityTypes: ['agentTask'] }, ctx);
const ids = (r: { hits: Array<{ id: string }> }) => r.hits.map((h) => h.id).sort();
const mkUser = (n: number, tag: string) =>
  db.user.create({ data: { id: generateId(), githubId: 99_500 + n, githubUsername: `${tag}-${suffix}`, roles: ['READER'] }, select: { id: true } });
const mkOrgApp = (org: { id: string; urn: string }, name: string, idPrefix = '') =>
  db.app.create({ data: { id: `${idPrefix}${generateId()}`.slice(0, 32), organizationId: org.id, name, urn: `${org.urn}:${name}-${generateId()}` } });
// Tasks are inserted directly so the fixture does not depend on who may create them.
const mkTask = async (appId: string, createdBy: string, title: string) =>
  db.agentTask.create({ data: { id: generateId(), appId, title, createdBy, ownerUserId: createdBy } as any, select: { id: true } });
const gateOnly = (gate: (appId: string) => Promise<boolean>): SearchPrincipal => ({
  viewerUserId: target.id,
  isPlatformAdmin: false,
  accessibleMemoryIds: [],
  orgIds: [],
  viewerOrgIds: [],
  taskReadGate: gate,
});

beforeEach(async () => {
  await cleanDb(db);
  suffix = `${Date.now()}-${Math.floor(Math.random() * 100_000)}`;
  orgA = await db.organization.create({ data: { id: generateId(), name: 'a', urn: `org-a-${suffix}.com` } });
  orgB = await db.organization.create({ data: { id: generateId(), name: 'b', urn: `org-b-${suffix}.com` } });
  target = await mkUser(1, 'target');
  stranger = await mkUser(2, 'stranger');
});

describe('impersonation reaches task hits only through the shared org (#3972 item 1; cor:acl:100:03, cor:acl:040:07)', () => {
  /** Three Apps the target participates in, each with one matching task. */
  async function threeApps() {
    const shared = await mkOrgApp(orgA, 'shared');
    const otherOrg = await mkOrgApp(orgB, 'other');
    const own = await db.app.create({ data: { id: generateId(), ownerUserId: target.id, name: 'own', urn: `u-${generateId()}:own` } as any });
    await db.appMember.createMany({ data: [{ appId: shared.id, userId: target.id, role: 'member' }, { appId: otherOrg.id, userId: target.id, role: 'member' }] });
    return {
      shared,
      otherOrg,
      own,
      tShared: await mkTask(shared.id, target.id, 'pinzebra shared'),
      tOther: await mkTask(otherOrg.id, target.id, 'pinzebra other org'),
      tOwn: await mkTask(own.id, target.id, 'pinzebra personal'),
    };
  }

  it('the gate itself: the shared-org App reads, another org of the target and the personally-owned App do not', async () => {
    const t = await threeApps();
    const own = await taskReadGateFor(userCtx(target));
    expect([await own(t.shared.id), await own(t.otherOrg.id), await own(t.own.id)]).toEqual([true, true, true]);
    const gate = taskReadGateFor(impCtx(target, orgA.id));
    expect(await gate(t.shared.id)).toBe(true);
    expect(await gate(t.otherOrg.id)).toBe(false);
    expect(await gate(t.own.id)).toBe(false);
  });

  it('the candidate scope under impersonation holds only the shared org\'s Apps', async () => {
    const t = await threeApps();
    const plain = await db.app.findMany({ where: (await taskAppScopeFor(userCtx(target), false)) as any, select: { id: true } });
    expect(plain.map((a) => a.id).sort()).toEqual([t.shared.id, t.otherOrg.id, t.own.id].sort());
    const imp = await db.app.findMany({ where: (await taskAppScopeFor(impCtx(target, orgA.id), false)) as any, select: { id: true } });
    expect(imp.map((a) => a.id)).toEqual([t.shared.id]);
  });

  it('end to end: only the shared-org task is a hit, and total agrees', async () => {
    const t = await threeApps();
    const r = await search(impCtx(target, orgA.id), 'pinzebra');
    expect(ids(r)).toEqual([t.tShared.id]);
    expect(r.total).toBe(1);
    const plain = await search(userCtx(target), 'pinzebra');
    expect(ids(plain)).toEqual([t.tShared.id, t.tOther.id, t.tOwn.id].sort());
  });
});

describe('the gate\'s catch arm (#3972 item 2)', () => {
  it('a typed GraphQLError denies that App only: its task is in neither hits nor total, and the search succeeds', async () => {
    const ok = await mkOrgApp(orgA, 'ok');
    const refused = await mkOrgApp(orgA, 'refused');
    const tOk = await mkTask(ok.id, target.id, 'catchzebra ok');
    await mkTask(refused.id, target.id, 'catchzebra refused');
    const gate = vi.fn(async (appId: string) => {
      if (appId === refused.id) throw new GraphQLError('refused', { extensions: { code: 'FORBIDDEN' } });
      return true;
    });
    const r = await globalSearch(db, { query: 'catchzebra', entityTypes: ['agentTask'], fields: ['name'] }, gateOnly(gate));
    expect(gate).toHaveBeenCalledWith(refused.id);
    expect(ids(r)).toEqual([tOk.id]);
    expect(r.total).toBe(1);
  });

  it('any other error propagates and fails the search; it is never read as "denied"', async () => {
    const a = await mkOrgApp(orgA, 'a');
    await mkTask(a.id, target.id, 'catchzebra');
    const boom = new Error('database went away');
    await expect(
      globalSearch(db, { query: 'catchzebra', entityTypes: ['agentTask'], fields: ['name'] }, gateOnly(async () => { throw boom; })),
    ).rejects.toThrow(/database went away/);
  });
});

describe('the candidate scope keeps every arm the gate admits, and the gate still decides each App (#3972 items 3-4)', () => {
  it('a readable task is found through each arm: owned App, AppMember App, org CONTRIBUTOR App, bound worker App', async () => {
    const owned = await db.app.create({ data: { id: generateId(), ownerUserId: target.id, name: 'owned', urn: `u-${generateId()}:owned` } as any });
    const member = await mkOrgApp(orgB, 'member');
    await db.appMember.create({ data: { appId: member.id, userId: target.id, role: 'member' } });
    const contribOrg = await db.organization.create({ data: { id: generateId(), name: 'c', urn: `org-c-${suffix}.com` } });
    await db.orgMember.create({ data: { id: generateId(), organizationId: contribOrg.id, userId: target.id, role: 'CONTRIBUTOR' } });
    const viaOrg = await mkOrgApp(contribOrg, 'viaorg');
    const want = [
      (await mkTask(owned.id, target.id, 'armzebra owned')).id,
      (await mkTask(member.id, target.id, 'armzebra member')).id,
      (await mkTask(viaOrg.id, target.id, 'armzebra via org')).id,
    ].sort();
    expect(ids(await search(userCtx(target), 'armzebra'))).toEqual(want);

    // The bound worker arm: the worker's own App only, whatever its holder could otherwise read.
    const agent = await M.createAgent({}, { orgId: orgA.id, name: 'Agent' }, { db, userId: (await ownerOf(orgA)).id, roles: ['READER'] });
    const wApp = await mkOrgApp(orgA, 'wapp');
    await db.appMember.create({ data: { appId: wApp.id, userId: target.id, role: 'member' } });
    const tW = await mkTask(wApp.id, target.id, 'armzebra worker app');
    const worker = await db.worker.create({ data: { ...WORKER_SIGNATURE_DEFAULTS, id: generateId(), appId: wApp.id, agentId: agent.id, name: 'W', slug: 'w' }, select: { id: true } });
    const r = await runAsActor({ workerId: worker.id, agentId: agent.id }, () => search(userCtx(target), 'armzebra'));
    expect(ids(r)).toEqual([tW.id]);
  });

  it('the gate decides each candidate: a retired worker\'s App is its candidate, yet it contributes nothing to hits or total', async () => {
    const agent = await M.createAgent({}, { orgId: orgA.id, name: 'Agent' }, { db, userId: (await ownerOf(orgA)).id, roles: ['READER'] });
    const wApp = await mkOrgApp(orgA, 'wapp');
    await db.appMember.create({ data: { appId: wApp.id, userId: target.id, role: 'member' } });
    await mkTask(wApp.id, target.id, 'gatezebra worker app');
    const worker = await db.worker.create({ data: { ...WORKER_SIGNATURE_DEFAULTS, id: generateId(), appId: wApp.id, agentId: agent.id, name: 'W', slug: 'w' }, select: { id: true } });
    const asWorker = () => runAsActor({ workerId: worker.id, agentId: agent.id }, () => search(userCtx(target), 'gatezebra'));
    expect((await asWorker()).total).toBe(1);
    await db.worker.update({ where: { id: worker.id }, data: { retiredAt: new Date() } });
    const r = await asWorker();
    expect(r.hits).toEqual([]);
    expect(r.total).toBe(0);
  });

  it('hits and total are the same whether zero or many non-candidate Apps match, even when they sort before the readable App', async () => {
    const mine = await mkOrgApp(orgA, 'mine', 'ffffffff');
    await db.appMember.create({ data: { appId: mine.id, userId: target.id, role: 'member' } });
    const tMine = await mkTask(mine.id, target.id, 'tenantzebra mine');
    const before = await search(userCtx(target), 'tenantzebra');
    const saved = { ...taskSearchLimits };
    // A scan bound far below the number of outsider Apps: a walk over them would exhaust it before reaching `mine`.
    Object.assign(taskSearchLimits, { page: 2, admittedApps: 1, maxScanned: 4 });
    try {
      for (let i = 0; i < 12; i++) {
        const a = await mkOrgApp(orgB, `o${i}`, `0000000${i}`);
        await db.appMember.create({ data: { appId: a.id, userId: stranger.id, role: 'member' } });
        await mkTask(a.id, stranger.id, 'tenantzebra outsider');
      }
      const after = await search(userCtx(target), 'tenantzebra');
      expect(ids(after)).toEqual(ids(before));
      expect(ids(after)).toEqual([tMine.id]);
      expect(after.total).toBe(before.total);
      expect(after.total).toBe(1);
    } finally {
      Object.assign(taskSearchLimits, saved);
    }
  });
});

async function ownerOf(org: { id: string }): Promise<{ id: string }> {
  const u = await mkUser(7, 'orgowner');
  await db.orgMember.create({ data: { id: generateId(), organizationId: org.id, userId: u.id, role: 'ADMIN' } });
  return u;
}
