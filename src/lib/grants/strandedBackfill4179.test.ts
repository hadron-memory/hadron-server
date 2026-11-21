/**
 * #4179 clause 1: the one-off backfill that ends the agent grants stranded before #4172 shipped (cor:acl:140:03, Holger R2).
 * Negative controls named by the gate: stale (already ended), expired and reinstalled rows. Dry run writes nothing; a second
 * run ends nothing; the stamp is the backfill's own time (the schema keeps no record of an agent uninstall).
 *
 * Fixture honesty: agent grants are seeded through the test-only guard bypass (insertGrantUnguarded), as in #4172's tests.
 */
import { beforeEach, afterAll, describe, expect, it } from 'vitest';
import { Prisma } from '../../generated/prisma/index.js';
import { db } from '../../integrations/db/client.js';
import { cleanDb } from '../../test/helpers.js';
import { generateId } from '../id.js';
import { DB_NOW, dropTestActions, insertGrantUnguarded, raw, seedWorld, type World } from './grantFixtures3668.js';
import { backfillStrandedAgentGrants } from './strandedBackfill.js';

const HOUR_AGO = raw(`${DB_NOW} - interval '1 hour'`);
let w: World;
let admin: { id: string };

type Row = { departed: boolean; stamp: string | null; updated: string };
const row = async (id: string): Promise<Row> => (await db.$queryRaw<Row[]>(Prisma.sql`
  SELECT holder_departed_at IS NOT NULL AS departed, (to_jsonb(g)->>'holder_departed_at') AS stamp, (to_jsonb(g)->>'updated_at') AS updated
    FROM grants g WHERE id = ${id}`))[0]!;
const held = (agentId: string, appId: string, over: Record<string, unknown> = {}) =>
  insertGrantUnguarded(w, { user_id: null, agent_id: agentId, app_id: appId, activated_at: HOUR_AGO, ...over } as never);
const install = (appId: string, agentId: string) => db.appAgent.create({ data: { appId, agentId } });

beforeEach(async () => {
  await cleanDb(db);
  w = await seedWorld();
  admin = await db.user.create({ data: { handle: `adm-${generateId().slice(0, 8)}` } });
});
afterAll(async () => { await cleanDb(db); await dropTestActions(); });

describe('#4179 backfill of stranded agent grants', () => {
  it('ends live and pending agent grants of an agent with no installation in the App; the dry run writes nothing', async () => {
    const live = await held(w.agentId, w.appId);
    const pending = await held(w.agentId, w.appId, { activated_at: null });
    const dry = await backfillStrandedAgentGrants(db, { apply: false });
    expect(dry).toMatchObject({ applied: false, candidates: 2, stamped: 0 });
    expect((await row(live)).departed).toBe(false);
    const done = await backfillStrandedAgentGrants(db, { apply: true });
    expect(done).toMatchObject({ applied: true, candidates: 2, stamped: 2 });
    for (const id of [live, pending]) expect((await row(id)).departed, id).toBe(true);
  });

  it('negative controls: stale (revoked, departed), expired and spent rows keep their first end', async () => {
    const revoked = await held(w.agentId, w.appId, { revoked_at: raw(DB_NOW), revoked_by: admin.id });
    const departed = await held(w.agentId, w.appId, { holder_departed_at: HOUR_AGO });
    const expired = await held(w.agentId, w.appId, { activated_at: raw(`${DB_NOW} - interval '3 hours'`), expires_at: HOUR_AGO });
    const spent = await held(w.agentId, w.appId, { max_uses: 1, use_count: 1 });
    const before = await row(departed);
    const r = await backfillStrandedAgentGrants(db, { apply: true });
    expect(r).toMatchObject({ candidates: 0, stamped: 0 });
    for (const id of [revoked, expired, spent]) expect((await row(id)).departed, id).toBe(false);
    expect(await row(departed)).toEqual(before);
  });

  it('negative control: an agent installed in the App (a reinstall, or never uninstalled) keeps every grant, counted not stamped', async () => {
    await install(w.appId, w.agentId);
    const id = await held(w.agentId, w.appId);
    const r = await backfillStrandedAgentGrants(db, { apply: true });
    expect(r).toMatchObject({ candidates: 0, stamped: 0, skippedInstalled: 1 });
    expect((await row(id)).departed).toBe(false);
  });

  it('a derived install (a live importing parent under a usable licence) is an installation: not stamped', async () => {
    const parent = await db.agent.create({ data: { organizationId: w.orgId, name: 'parent', urn: `${w.orgId}:parent` } });
    const child = await db.agent.create({ data: { organizationId: w.orgId, name: 'child', urn: `${w.orgId}:child` } });
    await install(w.appId, parent.id);
    await db.agentOrgGrant.create({ data: { orgId: w.orgId, agentId: child.id, activatedAt: new Date() } });
    await db.agentImport.create({ data: { parentAgentId: parent.id, importedAgentId: child.id, position: 1, required: true, agentOrgGrantOrgId: w.orgId, agentOrgGrantAgentId: child.id } });
    const id = await held(child.id, w.appId);
    expect(await backfillStrandedAgentGrants(db, { apply: true })).toMatchObject({ candidates: 0, stamped: 0 });
    expect((await row(id)).departed).toBe(false);
  });

  it('a licence revoked since is reported behind-dated-revocation but stamped with the backfill\'s own time, never the record\'s', async () => {
    const child = await db.agent.create({ data: { organizationId: w.orgId, name: 'child', urn: `${w.orgId}:child` } });
    const revokedAt = new Date(Date.now() - 24 * 3600_000);
    await db.agentOrgGrant.create({ data: { orgId: w.orgId, agentId: child.id, activatedAt: new Date(Date.now() - 48 * 3600_000), revokedAt } });
    const id = await held(child.id, w.appId);
    const r = await backfillStrandedAgentGrants(db, { apply: true });
    expect(r).toMatchObject({ candidates: 1, stamped: 1, behindDatedLicenceRevocation: 1 });
    expect(new Date((await row(id)).stamp + 'Z').getTime()).toBeGreaterThan(revokedAt.getTime() + 3600_000);
  });

  it('only AGENT-held rows of a LIVE agent in an existing App: worker-held, person-held and a soft-deleted agent are untouched', async () => {
    const worker = await held(w.agentId, w.appId, { agent_id: null, worker_id: w.workerId });
    const person = await held(w.agentId, w.appId, { agent_id: null, user_id: w.userId });
    const gone = await db.agent.create({ data: { organizationId: w.orgId, name: 'gone', urn: `${w.orgId}:gone` } });
    const softDeleted = await held(gone.id, w.appId);
    await db.agent.update({ where: { id: gone.id }, data: { deletedAt: new Date() } });
    const r = await backfillStrandedAgentGrants(db, { apply: true });
    expect(r).toMatchObject({ candidates: 0, stamped: 0 });
    for (const id of [worker, person, softDeleted]) expect((await row(id)).departed, id).toBe(false);
  });

  it('a second run ends nothing and moves no stamp; batches of one still cover every row', async () => {
    const ids = [await held(w.agentId, w.appId), await held(w.agentId, w.appId), await held(w.agentId, w.app2Id)];
    expect((await backfillStrandedAgentGrants(db, { apply: true, batchSize: 1 })).stamped).toBe(3);
    const stamps = await Promise.all(ids.map(async (id) => (await row(id)).stamp));
    expect(await backfillStrandedAgentGrants(db, { apply: true })).toMatchObject({ candidates: 0, stamped: 0 });
    expect(await Promise.all(ids.map(async (id) => (await row(id)).stamp))).toEqual(stamps);
  });
});
