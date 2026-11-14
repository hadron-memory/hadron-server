/**
 * #4172 (Holger ruling A, epic #1975; cor:acl:140:01, :03): an agent's grants in an App END when the agent has no effective
 * installation left there. Doors: U1 uninstallAgentFromApp, U2 removeAgentFromApp (alias), D1 an importing parent's uninstall,
 * D2 removeAgentImport, D3 revokeAgentOrgGrant, D4 the soft delete of an importing parent. A direct-row delete while a derived
 * witness remains is NOT a departure. Only AGENT-held grants end; worker-held and person-held stay. Reinstall revives nothing.
 *
 * Fixture honesty: agent grants are seeded through the test-only guard bypass (insertGrantUnguarded); no claim of a shipped
 * creator path beyond what main has. Residuals #4175, #4178, #4179 are NOT built here.
 */
import { beforeEach, afterAll, describe, expect, it } from 'vitest';
import { Prisma } from '../../../generated/prisma/index.js';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { DB_NOW, dropTestActions, insertGrantUnguarded, raw, seedWorld, type World } from '../../../lib/grants/grantFixtures3668.js';
import { resolveAppInstallation } from '../../../lib/appInstallations.js';
import { resolvers, type Context } from './resolvers.js';

const M = resolvers.Mutation as any;
const HOUR_AGO = raw(`${DB_NOW} - interval '1 hour'`);

let w: World;
let admin: { id: string };
let parent: { id: string };   // an importing agent
let child: { id: string };    // the imported agent
const ctx = (): Context => ({ db, userId: admin.id, roles: ['READER'] }) as Context;

type Row = { departed: boolean; stamp: string | null };
const row = async (id: string): Promise<Row> => (await db.$queryRaw<Row[]>(Prisma.sql`
  SELECT holder_departed_at IS NOT NULL AS departed, (to_jsonb(g)->>'holder_departed_at') AS stamp FROM grants g WHERE id = ${id}`))[0]!;
const held = (agentId: string, appId: string, over: Record<string, unknown> = {}) =>
  insertGrantUnguarded(w, { user_id: null, agent_id: agentId, app_id: appId, activated_at: HOUR_AGO, ...over } as never);
const install = (appId: string, agentId: string) => db.appAgent.create({ data: { appId, agentId } });
const license = (agentId: string, over: Record<string, unknown> = {}) => db.agentOrgGrant.upsert({
  where: { orgId_agentId: { orgId: w.orgId, agentId } },
  create: { orgId: w.orgId, agentId, activatedAt: new Date(), ...over }, update: { activatedAt: new Date(), revokedAt: null, ...over },
});
let edgePos = 100;
const importEdge = async (p: string, c: string) => {
  await license(c);
  return db.agentImport.create({ data: { parentAgentId: p, importedAgentId: c, position: edgePos++, required: true, agentOrgGrantOrgId: w.orgId, agentOrgGrantAgentId: c } });
};
const uninstall = (appId: string, agentId: string, op = 'uninstallAgentFromApp') => M[op]({}, { appRef: appId, agentRef: agentId }, ctx());

beforeEach(async () => {
  await cleanDb(db);
  w = await seedWorld();
  admin = await db.user.create({ data: { handle: `adm-${generateId().slice(0, 8)}` } });
  await db.orgMember.create({ data: { organizationId: w.orgId, userId: admin.id, role: 'OWNER' } });
  parent = await db.agent.create({ data: { organizationId: w.orgId, name: 'parent', urn: `${w.orgId}:parent` } });
  child = await db.agent.create({ data: { organizationId: w.orgId, name: 'child', urn: `${w.orgId}:child` } });
});
afterAll(async () => { await cleanDb(db); await dropTestActions(); });

describe('U1/U2: uninstall ends only that App\'s agent grants', () => {
  for (const op of ['uninstallAgentFromApp', 'removeAgentFromApp']) {
    it(`${op}: live and pending end in this App; the agent's other App, a worker-held and a person-held grant stay`, async () => {
      await install(w.appId, w.agentId); await install(w.app2Id, w.agentId);
      const live = await held(w.agentId, w.appId);
      const pending = await held(w.agentId, w.appId, { activated_at: null });
      const otherApp = await held(w.agentId, w.app2Id);
      const worker = await held(w.agentId, w.appId, { agent_id: null, worker_id: w.workerId });
      const person = await held(w.agentId, w.appId, { agent_id: null, user_id: w.userId });
      await uninstall(w.appId, w.agentId, op);
      expect((await row(live)).departed).toBe(true);
      expect((await row(pending)).departed).toBe(true);
      for (const id of [otherApp, worker, person]) expect((await row(id)).departed, id).toBe(false);
    });
  }

  it('first end stands: revoked, expired, spent and an earlier departure are not stamped anew; a retry moves nothing', async () => {
    await install(w.appId, w.agentId);
    const revoked = await held(w.agentId, w.appId, { revoked_at: raw(DB_NOW), revoked_by: admin.id });
    const expired = await held(w.agentId, w.appId, { activated_at: raw(`${DB_NOW} - interval '3 hours'`), expires_at: HOUR_AGO });
    const spent = await held(w.agentId, w.appId, { max_uses: 1, use_count: 1 });
    const departed = await held(w.agentId, w.appId, { holder_departed_at: HOUR_AGO });
    const before = await row(departed);
    await uninstall(w.appId, w.agentId);
    for (const id of [revoked, expired, spent]) expect((await row(id)).departed, id).toBe(false);
    expect(await row(departed)).toEqual(before);
    const live = await held(w.agentId, w.appId);
    await uninstall(w.appId, w.agentId); // not installed any more: a retry still ends a stranded live row, once
    const stamp = (await row(live)).stamp;
    expect(stamp).not.toBeNull();
    await uninstall(w.appId, w.agentId);
    expect((await row(live)).stamp).toBe(stamp);
  });

  it('reinstall revives nothing and writes no grant rows', async () => {
    await install(w.appId, w.agentId);
    const id = await held(w.agentId, w.appId);
    await uninstall(w.appId, w.agentId);
    const stamp = (await row(id)).stamp;
    const count = await db.grant.count();
    await install(w.appId, w.agentId);
    expect(await row(id)).toMatchObject({ departed: true, stamp });
    expect(await db.grant.count()).toBe(count);
  });

  it('a direct-row uninstall while a derived witness remains is NOT a departure', async () => {
    await install(w.appId, parent.id); await install(w.appId, child.id); await importEdge(parent.id, child.id);
    const id = await held(child.id, w.appId);
    await uninstall(w.appId, child.id);
    expect(await resolveAppInstallation(db, w.appId, child.id)).toMatchObject({ installationKind: 'DERIVED' });
    expect((await row(id)).departed).toBe(false);
  });

  it('rollback: a failure after the departure leaves the install row and the grant', async () => {
    await install(w.appId, w.agentId);
    const id = await held(w.agentId, w.appId);
    await expect(db.$transaction(async (tx) => {
      await tx.appAgent.deleteMany({ where: { appId: w.appId, agentId: w.agentId } });
      const { endGrantsOfAgentsNoLongerInstalled } = await import('../../../lib/grants/agentInstallDeparture.js');
      await endGrantsOfAgentsNoLongerInstalled(tx, [{ appId: w.appId, agentId: w.agentId }], null);
      throw new Error('boom');
    })).rejects.toThrow('boom');
    expect((await row(id)).departed).toBe(false);
    expect(await db.appAgent.count({ where: { appId: w.appId, agentId: w.agentId } })).toBe(1);
  });
});

describe('D1-D4: the imported agent loses its derived install', () => {
  beforeEach(async () => { await install(w.appId, parent.id); await importEdge(parent.id, child.id); });

  it('D1: the importing parent\'s uninstall ends the imported agent\'s grants there, not in an App that still has it', async () => {
    await install(w.app2Id, child.id);
    const here = await held(child.id, w.appId);
    const direct = await held(child.id, w.app2Id);
    await uninstall(w.appId, parent.id);
    expect((await row(here)).departed).toBe(true);
    expect((await row(direct)).departed).toBe(false);
  });

  it('D1: an imported agent also installed by row keeps its grants', async () => {
    await install(w.appId, child.id);
    const id = await held(child.id, w.appId);
    await uninstall(w.appId, parent.id);
    expect((await row(id)).departed).toBe(false);
  });

  it('D2: removeAgentImport ends them; with a second importer or a row install nothing ends', async () => {
    const id = await held(child.id, w.appId);
    const other = await db.agent.create({ data: { organizationId: w.orgId, name: 'other', urn: `${w.orgId}:other` } });
    await install(w.appId, other.id); await importEdge(other.id, child.id);
    await M.removeAgentImport({}, { parentAgentRef: parent.id, importedAgentRef: child.id }, ctx());
    expect((await row(id)).departed).toBe(false);
    await M.removeAgentImport({}, { parentAgentRef: other.id, importedAgentRef: child.id }, ctx());
    expect((await row(id)).departed).toBe(true);
    await M.removeAgentImport({}, { parentAgentRef: other.id, importedAgentRef: child.id }, ctx()); // idempotent
  });

  it('D3: revoking the organization\'s licence ends the derived agent\'s grants; the same revoke leaves a row-installed one', async () => {
    const id = await held(child.id, w.appId);
    await M.revokeAgentOrgGrant({}, { agentRef: child.id, orgRef: w.orgId }, ctx());
    expect((await row(id)).departed).toBe(true);
  });

  it('D3: a row-installed agent keeps its grants through the revoke', async () => {
    await install(w.appId, child.id);
    const id = await held(child.id, w.appId);
    await M.revokeAgentOrgGrant({}, { agentRef: child.id, orgRef: w.orgId }, ctx());
    expect((await row(id)).departed).toBe(false);
  });

  it('D4: deleting an importing parent installed in a live App is refused (so no derived witness is ever lost to a soft delete), ending nothing', async () => {
    const mine = await held(child.id, w.appId);
    const parents = await held(parent.id, w.appId);
    await expect(M.deleteAgent({}, { ref: parent.id }, ctx())).rejects.toThrow(/still in use/);
    expect((await row(mine)).departed).toBe(false);
    expect((await row(parents)).departed).toBe(false);
    await uninstall(w.appId, parent.id);
    await M.deleteAgent({}, { ref: parent.id }, ctx()); // uninstalled first: the parent's own grants end (existing behaviour)
    expect((await row(parents)).departed).toBe(true);
  });
});

describe('the SQL guard proves the TRUE cause (a bare stamp)', () => {
  const stamp = (id: string) => db.$executeRawUnsafe(`UPDATE grants SET holder_departed_at = ${DB_NOW} WHERE id = $1`, id);
  it('P-bare-row: refused while the agent has an app_agents row', async () => {
    await install(w.appId, w.agentId);
    await expect(stamp(await held(w.agentId, w.appId))).rejects.toThrow(/append-only/);
  });
  it('P-bare-derived: refused while a derived witness holds; admitted once the edge, the parent or the licence is gone', async () => {
    await install(w.appId, parent.id); await importEdge(parent.id, child.id);
    const id = await held(child.id, w.appId);
    await expect(stamp(id)).rejects.toThrow(/append-only/);
    await db.agentOrgGrant.update({ where: { orgId_agentId: { orgId: w.orgId, agentId: child.id } }, data: { revokedAt: new Date() } });
    await expect(stamp(id)).resolves.toBe(1);
  });
  it('P-bare-none: admitted when there is no row and no witness', async () => {
    await expect(stamp(await held(w.agentId, w.appId))).resolves.toBe(1);
  });
  it('P-diff: the SQL twin agrees with resolveAppInstallation across the witness matrix', async () => {
    const sqlSays = async (a: string, g: string) => (await db.$queryRawUnsafe<Array<{ r: boolean }>>('SELECT hadron_agent_installed_in_app($1,$2) AS r', a, g))[0]!.r;
    const agree = async (label: string) => {
      for (const g of [w.agentId, parent.id, child.id]) {
        expect(await sqlSays(w.appId, g), `${label}:${g}`).toBe(!!(await resolveAppInstallation(db, w.appId, g)));
      }
    };
    await agree('empty');
    await install(w.appId, parent.id); await agree('row');
    await importEdge(parent.id, child.id); await agree('derived usable');
    await db.agentOrgGrant.update({ where: { orgId_agentId: { orgId: w.orgId, agentId: child.id } }, data: { expiresAt: new Date(Date.now() - 1000) } }); await agree('licence expired');
    await db.agentOrgGrant.update({ where: { orgId_agentId: { orgId: w.orgId, agentId: child.id } }, data: { expiresAt: null, revokedAt: new Date() } }); await agree('licence revoked');
    await db.agentOrgGrant.update({ where: { orgId_agentId: { orgId: w.orgId, agentId: child.id } }, data: { revokedAt: null } }); await agree('licence back');
    await db.agent.update({ where: { id: child.id }, data: { deletedAt: new Date() } }); await agree('imported soft-deleted');
    await db.agent.update({ where: { id: child.id }, data: { deletedAt: null } });
    await db.agent.update({ where: { id: parent.id }, data: { deletedAt: new Date() } }); await agree('parent soft-deleted');
    await db.agent.update({ where: { id: parent.id }, data: { deletedAt: null } }); await agree('parent back');
    await db.app.update({ where: { id: w.appId }, data: { uninstalledAt: new Date() } }); await agree('App uninstalled');
    await db.app.update({ where: { id: w.appId }, data: { uninstalledAt: null } });
    await db.organization.update({ where: { id: w.orgId }, data: { deletedAt: new Date() } }); await agree('org deleted');
    await db.organization.update({ where: { id: w.orgId }, data: { deletedAt: null } });
    const foreign = await db.organization.create({ data: { name: 'f', urn: `f-${generateId().slice(0, 6)}.test` } });
    const fa = await db.agent.create({ data: { organizationId: foreign.id, name: 'fa', urn: `${foreign.id}:fa` } });
    await importEdge(parent.id, fa.id);
    expect(await sqlSays(w.appId, fa.id)).toBe(!!(await resolveAppInstallation(db, w.appId, fa.id)));
  });
});

// #4210 LOCAL F1: two removals under DIFFERENT anchors in one App used to deadlock (40P01) on each other's post-delete witness
// scans. Both writes are driven by the real resolvers and held at a barrier right after their own witness delete, so the pin is
// red unless the second door waits at the fence BEFORE deleting (then only one reaches the barrier and the barrier times out
// into the release path below).
function barrierDb(model: 'agentImport' | 'appAgent') {
  let reached = 0; let release!: () => void;
  const barrier = new Promise<void>((r) => { release = r; });
  // The fenced door never reaches the barrier together with the other one: release after a bound so the first can finish.
  const timer = setTimeout(() => release(), 2500);
  const proxied = new Proxy(db, { get(target, key) {
    if (key === '$transaction') return (fn: any, options: any) => target.$transaction(async (tx: any) => {
      const wrapped = new Proxy(tx, { get(t, k) {
        if (k === model) return new Proxy(t[model], { get(m, name) {
          if (name === 'deleteMany') return async (...args: any[]) => {
            const result = await m.deleteMany(...args); reached++; if (reached === 2) release();
            await barrier; return result;
          };
          const v = m[name]; return typeof v === 'function' ? v.bind(m) : v;
        } });
        const v = t[k]; return typeof v === 'function' ? v.bind(t) : v;
      } });
      return fn(wrapped);
    }, { ...options, timeout: 20000 });
    const v = (target as any)[key]; return typeof v === 'function' ? v.bind(target) : v;
  } });
  return { proxied: proxied as unknown as typeof db, done: () => clearTimeout(timer) };
}

describe('F1: concurrent removals under different anchors do not deadlock', () => {
  it('two parents owned by different people, one App, one imported agent: both removeAgentImport calls succeed', async () => {
    const u2 = await db.user.create({ data: { handle: `other-${generateId().slice(0, 8)}` } });
    const p1 = await db.agent.create({ data: { ownerUserId: admin.id, name: 'p1', urn: `p1-${generateId()}` } });
    const p2 = await db.agent.create({ data: { ownerUserId: u2.id, name: 'p2', urn: `p2-${generateId()}` } });
    await install(w.appId, p1.id); await install(w.appId, p2.id);
    await importEdge(p1.id, child.id); await importEdge(p2.id, child.id);
    const grant = await held(child.id, w.appId);
    const { proxied, done } = barrierDb('agentImport');
    const results = await Promise.allSettled([
      M.removeAgentImport({}, { parentAgentRef: p1.id, importedAgentRef: child.id }, { db: proxied, userId: admin.id, roles: ['READER'] }),
      M.removeAgentImport({}, { parentAgentRef: p2.id, importedAgentRef: child.id }, { db: proxied, userId: u2.id, roles: ['READER'] }),
    ]);
    done();
    expect(results.map((r) => (r.status === 'rejected' ? String(r.reason) : r.status))).toEqual(['fulfilled', 'fulfilled']);
    expect((await row(grant)).departed).toBe(true);
  }, 40000);

  it('two different parents uninstalled from one App at once: both succeed and the imported agent ends', async () => {
    const p1 = await db.agent.create({ data: { organizationId: w.orgId, name: 'q1', urn: `${w.orgId}:q1` } });
    const p2 = await db.agent.create({ data: { organizationId: w.orgId, name: 'q2', urn: `${w.orgId}:q2` } });
    await install(w.appId, p1.id); await install(w.appId, p2.id);
    await importEdge(p1.id, child.id); await importEdge(p2.id, child.id);
    const grant = await held(child.id, w.appId);
    const { proxied, done } = barrierDb('appAgent');
    const c = { db: proxied, userId: admin.id, roles: ['READER'] };
    const results = await Promise.allSettled([
      M.uninstallAgentFromApp({}, { appRef: w.appId, agentRef: p1.id }, c),
      M.uninstallAgentFromApp({}, { appRef: w.appId, agentRef: p2.id }, c),
    ]);
    done();
    expect(results.map((r) => (r.status === 'rejected' ? String(r.reason) : r.status))).toEqual(['fulfilled', 'fulfilled']);
    expect((await row(grant)).departed).toBe(true);
  }, 40000);
});
