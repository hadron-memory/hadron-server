/**
 * #3690 S2a-h — the holder's departure through the REAL doors (ruling 0259 "Retire ends grants too"; 0255 item 3):
 * `retireWorker`, `deleteWorker`, `deleteAgent` (a soft delete: no FK action fires, so code must end the grant) and
 * `deleteApp` (a soft delete of a grantee App). The grant ends and allows nothing, in the same transaction; the record stays.
 * A worker that only HOLDS a grant is not "in use" (cor:acl:140:03); one that asked for a grant, or appears in its events, still is.
 */
import { beforeEach, afterAll, describe, expect, it, vi } from 'vitest';
import { Prisma } from '../../../generated/prisma/index.js';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { waitForLockWaiters } from '../../../test/lockWait.js';
import { WORKER_SIGNATURE_DEFAULTS } from '../../../lib/workerSignature.js';
import { serveAgentBootPrompt } from '../../../test/servedBootPrompt.js';
import { DB_NOW, dropTestActions, ensureTestAction, insertGrantUnguarded, raw, type World } from '../../../lib/grants/grantFixtures3668.js';
import { grantLiveSql } from '../../../lib/grants/live.js';
import { resolvers, type Context } from './resolvers.js';

vi.mock('../../../integrations/github/writeNodeToGit.js', () => ({ writeNodeToGit: vi.fn().mockResolvedValue(undefined) }));
const M = resolvers.Mutation as any;
let f: any;
let w: World;
const ctx = (userId = f.holder.id): Context => ({ db, userId, roles: ['READER'] });
const adminCtx = () => ctx(f.admin.id);
const active = (over: Record<string, unknown> = {}) => insertGrantUnguarded(w, { activated_at: raw(`${DB_NOW} - interval '1 hour'`), ...over } as never);
type Row = { live: boolean; holder_departed_at: string | null; worker_id: string | null; agent_id: string | null; grantee_app_id: string | null };
const read = async (id: string): Promise<Row> => (await db.$queryRaw<Row[]>(Prisma.sql`
  SELECT ${grantLiveSql('g')} AS live, (to_jsonb(g)->>'holder_departed_at') AS holder_departed_at, g.worker_id, g.agent_id, g.grantee_app_id FROM grants g WHERE g.id = ${id}`))[0];

beforeEach(async () => {
  await cleanDb(db);
  await ensureTestAction();
  const holder = await db.user.create({ data: { handle: 'dep-holder', roles: ['READER'] } });
  const admin = await db.user.create({ data: { handle: 'dep-admin', roles: ['READER'] } });
  const org = await db.organization.create({ data: { name: 'Departure', urn: 'dep3690.test' } });
  await db.orgMember.createMany({ data: [{ organizationId: org.id, userId: holder.id, role: 'CONTRIBUTOR' }, { organizationId: org.id, userId: admin.id, role: 'ADMIN' }] });
  const app = await db.app.create({ data: { organizationId: org.id, name: 'Team', urn: 'dep3690.test:team' } });
  const app2 = await db.app.create({ data: { organizationId: org.id, name: 'Other', urn: 'dep3690.test:other' } });
  await db.appMember.create({ data: { appId: app.id, userId: holder.id, role: 'owner' } });
  const agent = await M.createAgent({}, { orgId: org.id, name: 'Role', personaRole: 'server-engineer' }, ctx(admin.id));
  await db.appAgent.create({ data: { appId: app.id, agentId: agent.id } });
  await serveAgentBootPrompt(db, agent.id, '{{worker.name}} {{worker.role}}');
  const target = await db.worker.create({ data: { ...WORKER_SIGNATURE_DEFAULTS, appId: app.id, agentId: agent.id, name: 'Target', slug: 'target' } });
  const sibling = await db.worker.create({ data: { ...WORKER_SIGNATURE_DEFAULTS, appId: app.id, agentId: agent.id, name: 'Sibling', slug: 'sibling' } });
  f = { holder, admin, org, app, app2, agent, target, sibling };
  w = { orgId: org.id, appId: app.id, app2Id: app2.id, userId: holder.id, user2Id: admin.id, agentId: agent.id, workerId: target.id, sessionId: '' };
});
afterAll(async () => { await cleanDb(db); await dropTestActions(); });

const retire = (c = ctx()) => M.retireWorker({}, { workerRef: f.target.id }, c);
const remove = (c = ctx()) => M.deleteWorker({}, { workerRef: f.target.id, confirmNoExternalAttribution: true }, c);

describe('retireWorker ends the grants the worker holds (ruling 0259), in the retiring transaction', () => {
  it('a retired worker\'s grant is ended and stamped; a sibling\'s grant is untouched', async () => {
    const mine = await active({ user_id: null, worker_id: f.target.id });
    const theirs = await active({ user_id: null, worker_id: f.sibling.id });
    expect((await read(mine)).live).toBe(true);
    await retire();
    expect(await read(mine)).toMatchObject({ live: false, worker_id: f.target.id });
    expect((await read(mine)).holder_departed_at).not.toBeNull();
    expect(await read(theirs)).toMatchObject({ live: true, holder_departed_at: null });
  });
  it('retiring twice does not re-stamp: the first end stands (the arm runs only when the claim retired the worker)', async () => {
    const id = await active({ user_id: null, worker_id: f.target.id });
    await retire();
    const first = (await read(id)).holder_departed_at;
    expect(first).not.toBeNull();
    await retire();
    expect((await read(id)).holder_departed_at).toEqual(first);
  });
  it('a grant that was already revoked is not stamped by the retirement (the first end stands)', async () => {
    const id = await active({ user_id: null, worker_id: f.target.id, revoked_at: raw(DB_NOW), revoked_by: f.holder.id });
    const open = await active({ user_id: null, worker_id: f.target.id });
    await retire();
    expect((await read(open)).holder_departed_at).not.toBeNull(); // the same retirement ended the open grant...
    expect((await read(id)).holder_departed_at).toBeNull(); // ...and left the already-revoked one with its first end
  });
  it('an already expired or spent grant keeps its first end: retiring the holder stamps the open one only', async () => {
    const expired = await active({ user_id: null, worker_id: f.target.id, starts_at: raw(`${DB_NOW} - interval '2 hours'`), expires_at: raw(`${DB_NOW} - interval '1 minute'`) });
    const spent = await active({ user_id: null, worker_id: f.target.id, max_uses: 1, use_count: 1 });
    const open = await active({ user_id: null, worker_id: f.target.id });
    await retire();
    expect((await read(open)).holder_departed_at).not.toBeNull();
    expect((await read(expired)).holder_departed_at).toBeNull();
    expect((await read(spent)).holder_departed_at).toBeNull();
  });
  it('lock order: a transaction holding the grant row makes the retirement wait, and the end lands when it releases', async () => {
    const id = await active({ user_id: null, worker_id: f.target.id });
    let release!: () => void; let locked!: () => void;
    const lockedP = new Promise<void>((r) => { locked = r; });
    const releaseP = new Promise<void>((r) => { release = r; });
    const holder = db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM grants WHERE id = ${id} FOR UPDATE`;
      locked();
      await releaseP;
    }, { timeout: 20_000 });
    await lockedP;
    const retiring = retire();
    try { await waitForLockWaiters(db as any); } finally { release(); }
    await holder; await retiring;
    expect(await read(id)).toMatchObject({ live: false });
    expect((await read(id)).holder_departed_at).not.toBeNull();
  });
});

describe('deleteWorker: holding a grant is not "in use"; the delete ends the grant (cor:acl:140:03)', () => {
  it('a worker that only holds a grant is deleted: the grant stays, ended, with the sealed worker id', async () => {
    const id = await active({ user_id: null, worker_id: f.target.id });
    expect(await remove()).toBe(true);
    expect(await db.worker.findUnique({ where: { id: f.target.id } })).toBeNull();
    expect(await read(id)).toMatchObject({ live: false, worker_id: f.target.id });
    expect((await read(id)).holder_departed_at).not.toBeNull();
  });
  it('a worker that REQUESTED a grant (or is named in its events) is still in use: the fence stands and nothing is written', async () => {
    const id = await active({ user_id: f.holder.id, requested_by_worker_id: f.target.id });
    await expect(remove()).rejects.toMatchObject({ extensions: { code: 'WORKER_IN_USE' } });
    expect(await db.worker.findUnique({ where: { id: f.target.id } })).not.toBeNull();
    expect(await read(id)).toMatchObject({ live: true, holder_departed_at: null });
    const ev = await active({ user_id: f.holder.id });
    await db.$executeRawUnsafe(`INSERT INTO grant_events (id, grant_id, app_id, action, worker_id) VALUES ($1, $2, $3, 'CREATE', $4)`, generateId(), ev, f.app.id, f.sibling.id);
    await expect(M.deleteWorker({}, { workerRef: f.sibling.id, confirmNoExternalAttribution: true }, ctx())).rejects.toMatchObject({ extensions: { code: 'WORKER_IN_USE' } });
  });
});

describe('deleteAgent (a SOFT delete: no FK action fires) ends the grants the agent holds', () => {
  it('an agent-held grant is ended and stamped; another agent\'s grant is untouched', async () => {
    const spare = await M.createAgent({}, { orgId: f.org.id, name: 'Spare', personaRole: 'x' }, adminCtx());
    const other = await M.createAgent({}, { orgId: f.org.id, name: 'Keeper', personaRole: 'y' }, adminCtx());
    const mine = await active({ user_id: null, agent_id: spare.id });
    const theirs = await active({ user_id: null, agent_id: other.id });
    expect(await M.deleteAgent(null, { ref: spare.id }, adminCtx())).toBe(true);
    expect(await read(mine)).toMatchObject({ live: false, agent_id: spare.id });
    expect((await read(mine)).holder_departed_at).not.toBeNull();
    expect(await read(theirs)).toMatchObject({ live: true, holder_departed_at: null });
  });
  it('a refused delete (the agent is still installed) ends nothing', async () => {
    const id = await active({ user_id: null, agent_id: f.agent.id });
    await expect(M.deleteAgent(null, { ref: f.agent.id }, adminCtx())).rejects.toMatchObject({ extensions: { code: 'AGENT_IN_USE' } });
    expect(await read(id)).toMatchObject({ live: true, holder_departed_at: null });
  });
});

describe('deleteApp (a SOFT delete)', () => {
  it('the scope App\'s soft delete makes its grants allow nothing at once (until the reclaim cascades them)', async () => {
    const id = await active({ user_id: null, agent_id: f.agent.id });
    expect(await M.deleteApp(null, { ref: f.app.id }, adminCtx())).toBe(true);
    expect((await read(id)).live).toBe(false);
    expect(await db.$queryRawUnsafe('SELECT id FROM grants WHERE id = $1', id)).toHaveLength(1);
  });
  it('a grantee App deleted on its own while the grant\'s App stays: that holder ends the grant', async () => {
    const id = await active({ user_id: null, grantee_app_id: f.app2.id });
    await M.deleteApp(null, { ref: f.app2.id }, adminCtx());
    expect(await read(id)).toMatchObject({ live: false, grantee_app_id: f.app2.id });
    expect((await read(id)).holder_departed_at).not.toBeNull();
  });
});
