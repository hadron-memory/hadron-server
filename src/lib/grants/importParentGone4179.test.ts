/**
 * #4179 clause 2 (cor:acl:140:03, Holger R2): a HARD delete of an importing parent cascades its agent_imports edges away, and an
 * imported agent left with no effective installation in an App has gone for its grants there. The AFTER DELETE trigger on
 * agent_imports stamps them in the deleting transaction, the way hadron_grant_holder_gone does for a deleted holder.
 *
 * Conditions pinned here (the FIT's, bound by the gate): it runs #4172's effective-installation check (any remaining route, a
 * physical row or another importing parent, keeps the grant); only agent-held rows; only rows not already ended (the first end
 * stands, judged on the database clock); only rows whose own App still exists. An ordinary edge removal (the parent still exists)
 * is NOT this trigger's: removeAgentImport judges it under its own locks (#4172 D2).
 *
 * Red on main: there is no trigger on agent_imports, so every "stamped" case below leaves the row live.
 */
import { beforeEach, afterAll, describe, expect, it } from 'vitest';
import { Prisma } from '../../generated/prisma/index.js';
import { db } from '../../integrations/db/client.js';
import { cleanDb } from '../../test/helpers.js';
import { generateId } from '../id.js';
import { DB_NOW, dropTestActions, insertGrantUnguarded, raw, seedWorld, type World } from './grantFixtures3668.js';

const HOUR_AGO = raw(`${DB_NOW} - interval '1 hour'`);

let w: World;
let parent: { id: string };
let child: { id: string };
let admin: { id: string };

type Row = { departed: boolean; stamp: string | null };
const row = async (id: string): Promise<Row> => (await db.$queryRaw<Row[]>(Prisma.sql`
  SELECT holder_departed_at IS NOT NULL AS departed, (to_jsonb(g)->>'holder_departed_at') AS stamp FROM grants g WHERE id = ${id}`))[0]!;
const held = (agentId: string, appId: string, over: Record<string, unknown> = {}) =>
  insertGrantUnguarded(w, { user_id: null, agent_id: agentId, app_id: appId, activated_at: HOUR_AGO, ...over } as never);
const install = (appId: string, agentId: string) => db.appAgent.create({ data: { appId, agentId } });
const license = (agentId: string) => db.agentOrgGrant.upsert({
  where: { orgId_agentId: { orgId: w.orgId, agentId } },
  create: { orgId: w.orgId, agentId, activatedAt: new Date() }, update: { activatedAt: new Date(), revokedAt: null },
});
let edgePos = 100;
const importEdge = async (p: string, c: string) => {
  await license(c);
  return db.agentImport.create({ data: { parentAgentId: p, importedAgentId: c, position: edgePos++, required: true, agentOrgGrantOrgId: w.orgId, agentOrgGrantAgentId: c } });
};
const hardDelete = (agentId: string) => db.agent.delete({ where: { id: agentId } });

beforeEach(async () => {
  await cleanDb(db);
  w = await seedWorld();
  admin = await db.user.create({ data: { handle: `adm-${generateId().slice(0, 8)}` } });
  parent = await db.agent.create({ data: { organizationId: w.orgId, name: 'parent', urn: `${w.orgId}:parent` } });
  child = await db.agent.create({ data: { organizationId: w.orgId, name: 'child', urn: `${w.orgId}:child` } });
});
afterAll(async () => { await cleanDb(db); await dropTestActions(); });

describe('#4179 hard-deleted importing parent: the imported agent\'s grants end in the deleting transaction', () => {
  it('a derived-only install: live and pending agent grants in that App are stamped; other holders and other Apps are not', async () => {
    await install(w.appId, parent.id); await importEdge(parent.id, child.id);
    await install(w.app2Id, child.id); // the child's own physical install in ANOTHER App
    const live = await held(child.id, w.appId);
    const pending = await held(child.id, w.appId, { activated_at: null });
    const otherApp = await held(child.id, w.app2Id);
    const worker = await held(child.id, w.appId, { agent_id: null, worker_id: w.workerId });
    const person = await held(child.id, w.appId, { agent_id: null, user_id: w.userId });
    await hardDelete(parent.id);
    expect((await row(live)).departed).toBe(true);
    expect((await row(pending)).departed).toBe(true);
    for (const id of [otherApp, worker, person]) expect((await row(id)).departed, id).toBe(false);
  });

  it('a remaining route keeps the grant: the child\'s own physical install, or a second importing parent', async () => {
    const parent2 = await db.agent.create({ data: { organizationId: w.orgId, name: 'parent2', urn: `${w.orgId}:parent2` } });
    await install(w.appId, parent.id); await install(w.appId, parent2.id);
    await importEdge(parent.id, child.id); await importEdge(parent2.id, child.id);
    const viaSecondParent = await held(child.id, w.appId);
    await hardDelete(parent.id);
    expect((await row(viaSecondParent)).departed).toBe(false);

    const child2 = await db.agent.create({ data: { organizationId: w.orgId, name: 'child2', urn: `${w.orgId}:child2` } });
    const parent3 = await db.agent.create({ data: { organizationId: w.orgId, name: 'parent3', urn: `${w.orgId}:parent3` } });
    await install(w.appId, parent3.id); await importEdge(parent3.id, child2.id); await install(w.appId, child2.id);
    const physical = await held(child2.id, w.appId);
    await hardDelete(parent3.id);
    expect((await row(physical)).departed).toBe(false);
  });

  it('the first end stands: revoked, expired, spent and an earlier departure are not stamped anew', async () => {
    await install(w.appId, parent.id); await importEdge(parent.id, child.id);
    const revoked = await held(child.id, w.appId, { revoked_at: raw(DB_NOW), revoked_by: admin.id });
    const expired = await held(child.id, w.appId, { activated_at: raw(`${DB_NOW} - interval '3 hours'`), expires_at: HOUR_AGO });
    const spent = await held(child.id, w.appId, { max_uses: 1, use_count: 1 });
    const departed = await held(child.id, w.appId, { holder_departed_at: HOUR_AGO });
    const before = await row(departed);
    const live = await held(child.id, w.appId);
    await hardDelete(parent.id);
    for (const id of [revoked, expired, spent]) expect((await row(id)).departed, id).toBe(false);
    expect(await row(departed)).toEqual(before);
    expect((await row(live)).departed).toBe(true);
  });

  it('an ordinary edge removal (the parent still exists) is not this trigger: no stamp from the raw delete', async () => {
    await install(w.appId, parent.id); await importEdge(parent.id, child.id);
    const id = await held(child.id, w.appId);
    await db.$executeRawUnsafe('DELETE FROM agent_imports WHERE parent_agent_id = $1', parent.id);
    expect((await row(id)).departed).toBe(false);
  });

  it('rollback: a failure after the parent\'s delete leaves the grant unstamped, the stamp rides the deleting transaction', async () => {
    await install(w.appId, parent.id); await importEdge(parent.id, child.id);
    const id = await held(child.id, w.appId);
    await expect(db.$transaction(async (tx) => {
      await tx.agent.delete({ where: { id: parent.id } });
      const [inside] = await tx.$queryRaw<Array<{ departed: boolean }>>(Prisma.sql`SELECT holder_departed_at IS NOT NULL AS departed FROM grants WHERE id = ${id}`);
      expect(inside!.departed).toBe(true);
      throw new Error('boom');
    })).rejects.toThrow('boom');
    expect((await row(id)).departed).toBe(false);
    expect(await db.agent.count({ where: { id: parent.id } })).toBe(1);
  });

  it('a retry moves nothing: the stamp is once', async () => {
    await install(w.appId, parent.id); await importEdge(parent.id, child.id);
    const id = await held(child.id, w.appId);
    await hardDelete(parent.id);
    const stamp = (await row(id)).stamp;
    expect(stamp).not.toBeNull();
    const parentB = await db.agent.create({ data: { organizationId: w.orgId, name: 'parentB', urn: `${w.orgId}:parentB` } });
    await install(w.appId, parentB.id); await importEdge(parentB.id, child.id);
    await hardDelete(parentB.id);
    expect((await row(id)).stamp).toBe(stamp);
  });
});
