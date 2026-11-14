/**
 * #4163 (part of #1975; cor:acl:140:02, :03; cor:agt:040:11; Holger's ruling of 2026-11-14) — a boot-prompt grant that has been
 * used, or whose hour has passed, must read `allows: false` on the shared live definition, and a grant ended that way keeps its
 * first end when its worker goes (ruling 0259). The action carries the limits (a count of uses, a lifetime from activation); the
 * edit door spends through the guarded `use_count + 1`.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { GraphQLError } from 'graphql';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { resolvers, type Context } from './resolvers.js';
import { runAsActor } from '../../../lib/requestActor.js';
import { WORKER_SIGNATURE_DEFAULTS } from '../../../lib/workerSignature.js';
import { upsertPlatformActions, PLATFORM_ACTIONS } from '../../../lib/grants/actions.js';
import { createPendingGrant, GrantCreateRefusal } from '../../../lib/grants/create.js';
import { endHeldGrants } from '../../../lib/grants/departure.js';
import { getGrantForWorker } from '../../../lib/grants/read.js';
import { isGrantLive, readGrantForUpdate } from '../../../lib/grants/live.js';
import { readFileSync } from 'node:fs';
import { DB_NOW, insertGrantUnguarded, raw, type World } from '../../../lib/grants/grantFixtures3668.js';

vi.mock('../../../integrations/github/writeNodeToGit.js', () => ({ writeNodeToGit: vi.fn().mockResolvedValue(undefined) }));

const EDIT = 'bootprompt.source.edit';
const BATCH = 'bootprompt.compile.approve';

let admin: { id: string };
let appId: string;
let workerId: string;
let installMemoryId: string;
const ctx = (): Context => ({ db, userId: admin.id, roles: [] });
const world = () => ({ appId, userId: admin.id } as unknown as World);
const grant = (values: Record<string, unknown>, over: Record<string, unknown> = {}) => insertGrantUnguarded(world(), {
  user_id: null, worker_id: workerId, action: EDIT, action_values: values, max_uses: 1,
  activated_at: raw(DB_NOW), verification_kind: 'passkey', verified_by: admin.id, issuer_user_id: admin.id, expires_at: null, ...over,
} as never);
const edit = (id: string) => runAsActor({ workerId, agentId: null }, () => resolvers.Mutation.updateNode(null, { input: { id, content: 'edited' } }, ctx()));
const view = async (id: string) => (await getGrantForWorker(db, { appId, workerId }, id))!;
const row = (id: string) => db.grant.findUniqueOrThrow({ where: { id } });

beforeEach(async () => {
  await cleanDb(db);
  await upsertPlatformActions(db);
  const org = await db.organization.create({ data: { id: generateId(), name: 'L Org', urn: 'g4163.example' } });
  admin = await db.user.create({ data: { githubId: 416301, githubUsername: 'l-admin', handle: 'l-admin', roles: [] } });
  await db.orgMember.create({ data: { organizationId: org.id, userId: admin.id, role: 'ADMIN' } });
  const app = await db.app.create({ data: { id: generateId(), name: 'L App', urn: 'g4163.example:app', organizationId: org.id } });
  appId = app.id;
  const agentMem = await db.memory.create({ data: { id: generateId(), class: 'system', name: 'agent-sys', urn: 'g4163.example:agent-sys', organizationId: org.id } });
  const agent = await db.agent.create({ data: { id: generateId(), name: 'L agent', urn: 'g4163.example:agent', organizationId: org.id, systemMemoryId: agentMem.id } });
  await db.appAgent.create({ data: { appId: app.id, agentId: agent.id } });
  installMemoryId = (await db.memory.create({
    data: { id: generateId(), class: 'system', name: 'install', urn: 'g4163.example:install', organizationId: org.id, appId, installOfAgentId: agent.id, isInstallMemory: true },
  })).id;
  workerId = (await db.worker.create({ data: { ...WORKER_SIGNATURE_DEFAULTS, id: generateId(), appId, agentId: agent.id, name: 'Iris', slug: 'iris' } })).id;
});
const source = () => db.node.create({ data: { id: generateId(), memoryId: installMemoryId, loc: `boot:workers:${workerId}:source`, name: 'S', content: 'original', role: 'boot-prompt' } });

describe('the action carries the limits (cor:acl:140:02)', () => {
  it('the edit action states one use and an hour; the batch action states an hour and no count', async () => {
    const e = await db.action.findUniqueOrThrow({ where: { name: EDIT } });
    const b = await db.action.findUniqueOrThrow({ where: { name: BATCH } });
    expect([e.maxUses, e.lifetimeSeconds]).toEqual([1, 3600]);
    expect([b.maxUses, b.lifetimeSeconds]).toEqual([null, 3600]);
  });
  it('a limit that is not a positive whole number is refused at the definition and at the database', async () => {
    const base = PLATFORM_ACTIONS[0]!;
    await expect(upsertPlatformActions(db, [{ ...base, name: 'x.bad', maxUses: 0 }])).rejects.toThrow(/maxUses/);
    await expect(upsertPlatformActions(db, [{ ...base, name: 'x.bad', lifetimeSeconds: 1.5 }])).rejects.toThrow(/lifetimeSeconds/);
    await expect(db.$executeRawUnsafe(`UPDATE actions SET lifetime_seconds = 0 WHERE name = '${EDIT}'`)).rejects.toThrow(/chk_actions_shape/);
  });
  it('re-running the upsert changes nothing (limits are part of what it compares)', async () => {
    expect(await upsertPlatformActions(db)).toMatchObject({ inserted: 0, updated: 0 });
    await db.$executeRawUnsafe(`UPDATE actions SET max_uses = NULL WHERE name = '${EDIT}'`);
    expect(await upsertPlatformActions(db)).toMatchObject({ updated: 1 });
    expect((await db.action.findUniqueOrThrow({ where: { name: EDIT } })).maxUses).toBe(1);
  });
});

describe('item 1: the edit door counts the use', () => {
  it('after the one edit the grant reads spent: use_count 1, allows false, and the in-memory verdict agrees', async () => {
    const s = await source();
    const g = await grant({ sourceNode: s.id });
    expect(await view(g)).toMatchObject({ allows: true, useCount: 0 });
    await edit(s.id);
    expect(await view(g)).toMatchObject({ allows: false, useCount: 1 });
    const r = await row(g);
    expect(isGrantLive({ ...r, appDeletedAt: null, actionMaxUses: 1, actionLifetimeSeconds: 3600 }, new Date())).toBe(false);
  });
  it('a stored grant WITHOUT a count is still spent by its USE event: the door refuses a second edit', async () => {
    const s = await source();
    const g = await grant({ sourceNode: s.id }, { max_uses: null });
    await edit(s.id);
    // the action's own count reads it spent too, though the row never said "max-uses 1"
    expect(await view(g)).toMatchObject({ allows: false, useCount: 1 });
    await expect(edit(s.id)).rejects.toBeInstanceOf(GraphQLError);
  });
  it('a refused edit spends nothing: the count and the events stay at zero', async () => {
    const s = await source();
    const g = await grant({ sourceNode: s.id }, { activated_at: raw(`${DB_NOW} - interval '61 minutes'`) });
    await expect(edit(s.id)).rejects.toBeInstanceOf(GraphQLError);
    expect((await row(g)).useCount).toBe(0);
  });
  it('three racing edits on one grant: one is admitted, use_count is exactly 1', async () => {
    const s = await source();
    const g = await grant({ sourceNode: s.id });
    const out = await Promise.allSettled([edit(s.id), edit(s.id), edit(s.id)]);
    expect(out.filter((o) => o.status === 'fulfilled')).toHaveLength(1);
    expect((await row(g)).useCount).toBe(1);
  });
});

describe('creation: an action that limits its uses has its grants say so (V50)', () => {
  const make = (maxUses: number | null | undefined, node: string) => db.$transaction((tx) => createPendingGrant(tx, {
    appId, requester: { userId: admin.id, workerId: null, sessionId: null }, holder: { kind: 'worker', id: workerId }, action: EDIT,
    values: { sourceNode: node }, maxUses, reason: 'fix the prompt', canReadMemory: async () => true,
  } as never));
  it('max_uses 1 is accepted; none, 2 and 0 are refused and store nothing', async () => {
    const s = await source();
    const id = await make(1, s.id);
    expect((await row(id)).maxUses).toBe(1);
    for (const bad of [undefined, null, 2, 0]) {
      const before = await db.grant.count();
      await expect(make(bad as never, s.id)).rejects.toBeInstanceOf(GrantCreateRefusal);
      expect(await db.grant.count()).toBe(before);
    }
  });
  it('an action with no count limit (the batch grant) still takes any count', async () => {
    const s = await source();
    const id = await db.$transaction((tx) => createPendingGrant(tx, {
      appId, requester: { userId: admin.id, workerId: null, sessionId: null }, holder: { kind: 'worker', id: workerId }, action: BATCH,
      values: { compiledNode: [s.id] }, maxUses: null, reason: 'compile', canReadMemory: async () => true,
    } as never));
    expect((await row(id)).maxUses).toBeNull();
  });
});

describe('item 2: the hour is the action\'s lifetime, read by the shared definition', () => {
  it('an edit grant an hour past activation reads allows false although its expires_at says none, and one inside the hour reads true', async () => {
    const s = await source();
    const old = await grant({ sourceNode: s.id }, { activated_at: raw(`${DB_NOW} - interval '61 minutes'`) });
    const fresh = await grant({ sourceNode: s.id }, { activated_at: raw(`${DB_NOW} - interval '59 minutes'`) });
    expect((await row(old)).expiresAt).toBeNull();
    expect((await view(old)).allows).toBe(false);
    expect((await view(fresh)).allows).toBe(true);
  });
  it('a batch grant past its hour reads allows false; inside it, true, with no count', async () => {
    const s = await source();
    const old = await grant({ compiledNode: [s.id] }, { action: BATCH, max_uses: null, activated_at: raw(`${DB_NOW} - interval '2 hours'`) });
    const fresh = await grant({ compiledNode: [s.id] }, { action: BATCH, max_uses: null, activated_at: raw(`${DB_NOW} - interval '10 minutes'`) });
    expect((await view(old)).allows).toBe(false);
    expect((await view(fresh)).allows).toBe(true);
  });
  it('the boundary is exclusive and uses the database clock: the verdict flips exactly at activation + lifetime', () => {
    const at = new Date('2026-11-14T12:00:00.000Z');
    const f = { activatedAt: at, revokedAt: null, holderDepartedAt: null, appDeletedAt: null, startsAt: null, expiresAt: null, maxUses: null, useCount: 0, actionMaxUses: null, actionLifetimeSeconds: 3600 };
    expect(isGrantLive(f, new Date(at.getTime() + 3599_999))).toBe(true);
    expect(isGrantLive(f, new Date(at.getTime() + 3600_000))).toBe(false);
  });
  it('the in-memory verdict reads the action\'s count even when the grant states none', () => {
    const f = { activatedAt: new Date(0), revokedAt: null, holderDepartedAt: null, appDeletedAt: null, startsAt: null, expiresAt: null, maxUses: null, useCount: 1, actionMaxUses: 1, actionLifetimeSeconds: null };
    expect(isGrantLive(f, new Date())).toBe(false);
    expect(isGrantLive({ ...f, useCount: 0 }, new Date())).toBe(true);
  });
  it('a grant\'s own expiry can only narrow the action\'s hour', async () => {
    const s = await source();
    const g = await grant({ sourceNode: s.id }, { expires_at: raw(`${DB_NOW} - interval '1 minute'`), activated_at: raw(`${DB_NOW} - interval '10 minutes'`) });
    expect((await view(g)).allows).toBe(false);
    const wide = await grant({ sourceNode: s.id }, { expires_at: raw(`${DB_NOW} + interval '1 day'`), activated_at: raw(`${DB_NOW} - interval '2 hours'`) });
    expect((await view(wide)).allows).toBe(false);
  });
  it('the locked read judges the action\'s limits too (readGrantForUpdate)', async () => {
    const s = await source();
    const old = await grant({ sourceNode: s.id }, { activated_at: raw(`${DB_NOW} - interval '61 minutes'`) });
    const r = await db.$transaction((tx) => readGrantForUpdate(tx, old));
    expect(r!.live).toBe(false);
    expect(r!.row).toMatchObject({ actionMaxUses: 1, actionLifetimeSeconds: 3600 });
  });
  it('the database guard refuses to count a use of a grant past its hour', async () => {
    const s = await source();
    const old = await grant({ sourceNode: s.id }, { activated_at: raw(`${DB_NOW} - interval '61 minutes'`) });
    await expect(db.$executeRawUnsafe(`UPDATE grants SET use_count = use_count + 1 WHERE id = '${old}'`)).rejects.toThrow(/append-only/);
  });
});

describe('item 3: a grant ended by use or by the hour keeps its first end when the worker goes (ruling 0259)', () => {
  const depart = async () => { await db.worker.update({ where: { id: workerId }, data: { retiredAt: new Date() } }); return db.$transaction((tx) => endHeldGrants(tx, 'worker', workerId)); };
  it('a used grant, a grant past its hour and a spent batch get no holder_departed_at; a live one does', async () => {
    const s = await source();
    const used = await grant({ sourceNode: s.id });
    await edit(s.id);
    const timedOut = await grant({ sourceNode: s.id }, { activated_at: raw(`${DB_NOW} - interval '61 minutes'`) });
    const batchOld = await grant({ compiledNode: [s.id] }, { action: BATCH, max_uses: null, activated_at: raw(`${DB_NOW} - interval '2 hours'`) });
    const live = await grant({ sourceNode: s.id });
    expect(await depart()).toBe(1);
    for (const id of [used, timedOut, batchOld]) expect((await row(id)).holderDepartedAt).toBeNull();
    expect((await row(live)).holderDepartedAt).not.toBeNull();
  });
  it('the holder-gone trigger on a hard delete keeps the same first end', async () => {
    const s = await source();
    const used = await grant({ sourceNode: s.id });
    await edit(s.id);
    const timedOut = await grant({ sourceNode: s.id }, { activated_at: raw(`${DB_NOW} - interval '61 minutes'`) });
    const live = await grant({ sourceNode: s.id });
    await db.$executeRawUnsafe(`DELETE FROM workers WHERE id = '${workerId}'`);
    for (const id of [used, timedOut]) expect((await row(id)).holderDepartedAt).toBeNull();
    expect((await row(live)).holderDepartedAt).not.toBeNull();
  });
});

describe('upgrade: a grant used before the count existed (LOCAL P2, Baloo)', () => {
  const backfill = () => {
    const sql = readFileSync(new URL('../../../../prisma/migrations/20261114200000_action_limits/migration.sql', import.meta.url), 'utf8');
    return sql.slice(sql.indexOf('-- BEGIN #4163 backfill'), sql.indexOf('-- END #4163 backfill'));
  };
  it('the migration counts the earlier use: it reads spent, and retiring the worker leaves its first end', async () => {
    const s = await source();
    const g = await grant({ sourceNode: s.id }, { max_uses: null, use_count: 0 });
    await db.grantEvent.create({ data: { grantId: g, appId, action: 'USE', workerId } });
    const untouched = await grant({ sourceNode: s.id }, { max_uses: null, use_count: 0 });
    // as it stood before the upgrade: no limits on the action
    await db.$executeRawUnsafe(`UPDATE actions SET max_uses = NULL, lifetime_seconds = NULL WHERE name = '${EDIT}'`);
    expect((await view(g)).allows).toBe(true);
    for (const stmt of backfill().split(';\n').map((x) => x.replace(/^(--.*\n)+/gm, '').trim()).filter(Boolean)) await db.$executeRawUnsafe(stmt);
    expect((await row(g)).useCount).toBe(1);
    expect((await row(untouched)).useCount).toBe(0);
    expect((await db.action.findUniqueOrThrow({ where: { name: EDIT } })).maxUses).toBe(1);
    expect((await view(g)).allows).toBe(false);
    await db.worker.update({ where: { id: workerId }, data: { retiredAt: new Date() } });
    await db.$transaction((tx) => endHeldGrants(tx, 'worker', workerId));
    expect((await row(g)).holderDepartedAt).toBeNull();
    expect((await row(untouched)).holderDepartedAt).not.toBeNull();
    // the guard is back on after the migration statement
    await expect(db.$executeRawUnsafe(`UPDATE grants SET use_count = use_count + 5 WHERE id = '${untouched}'`)).rejects.toThrow(/append-only/);
  });
});
