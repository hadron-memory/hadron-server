/**
 * #2484 (epic #2435, #2431 slice A): an App's prefix-scoped write grant on a
 * memory, for its USERLESS runs only (cor:agt:010:01).
 *
 * Red first. On main there is no grant table, no set / revoke / list door and
 * no run-principal arm in the write gate, so every case below that needs the
 * grant fails there. The cases marked CONTROL are green on main by design:
 * they pin authority that must NOT change when the grant lands.
 *
 * Contract pinned here (gate: Xavier's re-gate on the issue; Holger's rulings of
 * 2026-10-27):
 *  - the grant is one row per (App, memory, loc prefix); the prefix is required
 *    and matches the loc itself and its `:`-boundary descendants only;
 *  - it permits node create and update by a userless run principal of THAT App,
 *    checked live at each write; nothing else (no delete, edges, settings,
 *    stored files) and nobody else (other Apps, user-backed runs, App keys,
 *    workers);
 *  - set by a person acting as themselves who manages the App and can write the
 *    target; revoked by whoever manages the App;
 *  - shared memories: only a memory the App's own org or team space holds;
 *    personal and private: only by the memory's owner, who also manages the
 *    App; encrypted: never.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { runAuthContext } from '../../../lib/auth/runPrincipal.js';
import { runAsActor } from '../../../lib/requestActor.js';
import { WORKER_SIGNATURE_DEFAULTS } from '../../../lib/workerSignature.js';
import { resolvers } from './resolvers.js';
import { writeNodeCore } from './resolvers.mutation.node.js';
import { mintAppRun } from '../../../jobs/appRuns.js';
import { makeProdRunDeps } from '../../../jobs/appRunDeps.js';

vi.mock('../../../lib/bus/index.js', () => ({ getBusClient: vi.fn(async () => null) }));
vi.mock('../../../integrations/github/writeNodeToGit.js', () => ({ writeNodeToGit: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../../../integrations/github/syncGraphFromGithub.js', () => ({ syncGraphFromGithub: vi.fn().mockResolvedValue({ error: null }) }));
beforeEach(async () => { await cleanDb(db); });

const M = resolvers.Mutation as any;
const Q = resolvers.Query as any;
const PREFIX = 'reports:team-progress';
const REGISTER = 'hrn:node:hadronmemory.com:hadron-dev-team-shared:coordination:authorizations';

async function fixture() {
  const org = await db.organization.create({ data: { name: 'Grant Org', urn: 'grant2484.test' } });
  const mgr = await db.user.create({ data: { handle: 'grant-mgr' } });
  await db.orgMember.create({ data: { userId: mgr.id, organizationId: org.id, role: 'ADMIN' } });
  const app = await db.app.create({ data: { name: 'Grant App', urn: 'grant2484.test:app', organizationId: org.id } });
  await db.appMember.create({ data: { appId: app.id, userId: mgr.id, role: 'owner' } });
  const otherApp = await db.app.create({ data: { name: 'Other App', urn: 'grant2484.test:other', organizationId: org.id } });
  const mem = (urn: string, extra: Record<string, unknown> = {}) =>
    db.memory.create({ data: { name: urn.split(':')[1], urn, class: 'knowledge', ...(extra.class ? {} : { visibility: 'ORGANIZATION' }), organizationId: org.id, ...extra } as never });
  const dest = await mem('grant2484.test:dest');
  const personal = await mem('grant2484.test:mine', { class: 'personal', userId: mgr.id });
  const priv = await mem('grant2484.test:secret', { class: 'private', userId: mgr.id });
  const encrypted = await mem('grant2484.test:vault', { isEncrypted: true });
  const encPersonal = await mem('grant2484.test:vaultmine', { class: 'personal', userId: mgr.id, isEncrypted: true });
  const foreignOrg = await db.organization.create({ data: { name: 'Foreign', urn: 'foreign2484.test' } });
  const foreign = await db.memory.create({ data: { name: 'foreign', urn: 'foreign2484.test:mem', class: 'knowledge', visibility: 'ORGANIZATION', organizationId: foreignOrg.id } as never });
  const ctx = { db, userId: mgr.id, roles: [] as never[] };
  const runCtx = (appId = app.id, userId: string | null = null) =>
    ({ db, ...runAuthContext({ id: generateId(), appId, userId, organizationId: org.id }) }) as never;
  return { org, mgr, app, otherApp, dest, personal, priv, encrypted, encPersonal, foreign, ctx, runCtx };
}
type F = Awaited<ReturnType<typeof fixture>>;

const grant = (f: F, memory: { id: string }, ctx: unknown = f.ctx, prefix = PREFIX) =>
  M.setAppMemoryWriteGrant({}, { appRef: f.app.id, memoryRef: memory.id, prefix, registerNodeUrn: REGISTER }, ctx);
const revoke = (id: string, ctx: unknown) => M.revokeAppMemoryWriteGrant({}, { id }, ctx);
const create = (ctx: unknown, memory: { id: string }, loc: string) =>
  writeNodeCore({ memoryId: memory.id, loc, name: loc.split(':').pop()!, nodeType: 'record', content: 'body' } as never, ctx as never, 'create');
const update = (ctx: unknown, memory: { id: string }, loc: string) =>
  writeNodeCore({ memoryId: memory.id, loc, content: 'changed' } as never, ctx as never, 'update');
const refused = (p: Promise<unknown>) => expect(p).rejects.toMatchObject({ extensions: { code: 'FORBIDDEN' } });
/** Refused by some gate before the effect; the caller also asserts the state did not change. */
const notDone = (p: Promise<unknown>) => expect(p).rejects.toBeTruthy();
const rows = (appId: string) => db.appMemoryWriteGrant.findMany({ where: { appId }, orderBy: { createdAt: 'asc' } });
const events = (appId: string) => db.appMemoryWriteGrantEvent.findMany({ where: { appId }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] });
const nodes = (memoryId: string) => db.node.count({ where: { memoryId } });

describe('who may set and revoke a grant', () => {
  it('a manager with write on a shared target sets it: one row citing the register line, one content-free event', async () => {
    const f = await fixture();
    const g = await grant(f, f.dest);
    expect(g).toMatchObject({ prefix: PREFIX, registerNodeUrn: REGISTER, revokedAt: null });
    const [row] = await rows(f.app.id);
    expect(row).toMatchObject({ appId: f.app.id, memoryId: f.dest.id, prefix: PREFIX, grantedBy: f.mgr.id, revokedAt: null, registerNodeUrn: REGISTER });
    const evs = await events(f.app.id);
    expect(evs).toHaveLength(1);
    expect(evs[0]).toMatchObject({ action: 'GRANT', actorUserId: f.mgr.id, appId: f.app.id, memoryId: f.dest.id, prefix: PREFIX });
    expect(Object.keys(evs[0]).sort()).toEqual(['action', 'actorUserId', 'appId', 'createdAt', 'grantId', 'id', 'memoryId', 'prefix']);
  });

  it('refuses a person who does not manage the App, even one who can write the target', async () => {
    const f = await fixture();
    const u = await db.user.create({ data: { handle: 'grant-contrib' } });
    await db.orgMember.create({ data: { userId: u.id, organizationId: f.org.id, role: 'CONTRIBUTOR' } });
    await db.appMember.create({ data: { appId: f.app.id, userId: u.id, role: 'member' } });
    await refused(grant(f, f.dest, { db, userId: u.id, roles: [] }));
    expect(await rows(f.app.id)).toHaveLength(0);
    expect(await events(f.app.id)).toHaveLength(0);
  });

  it('refuses a manager who cannot write the target (delegation ceiling)', async () => {
    const f = await fixture();
    const owner2 = await db.user.create({ data: { handle: 'grant-owner2' } });
    await db.appMember.create({ data: { appId: f.app.id, userId: owner2.id, role: 'owner' } });
    const closed = await db.memory.create({ data: { name: 'closed', urn: 'grant2484.test:closed', class: 'knowledge', organizationId: f.org.id } as never });
    await refused(grant(f, closed, { db, userId: owner2.id, roles: [] }));
    expect(await rows(f.app.id)).toHaveLength(0);
  });

  it('refuses a worker session, a run principal, an impersonation and an App key as the setter', async () => {
    const f = await fixture();
    const agent = await db.agent.create({ data: { name: 'Iris', urn: 'grant2484.test:iris', organizationId: f.org.id } as never });
    const worker = await db.worker.create({ data: { ...WORKER_SIGNATURE_DEFAULTS, id: generateId(), appId: f.app.id, agentId: agent.id, name: 'Iris', slug: 'iris' } });
    await refused(runAsActor({ workerId: worker.id, agentId: agent.id }, () => grant(f, f.dest)));
    const session = await db.session.create({ data: { appId: f.app.id, userId: f.mgr.id, workerId: worker.id, agentId: agent.id } as never });
    await refused(grant(f, f.dest, { ...f.ctx, sessionId: session.id }));
    await refused(grant(f, f.dest, { ...f.ctx, ...runAuthContext({ id: generateId(), appId: f.app.id, userId: f.mgr.id, organizationId: f.org.id }) }));
    await refused(grant(f, f.dest, { ...f.ctx, impersonation: { adminUserId: 'x', orgId: f.org.id } }));
    await refused(grant(f, f.dest, { db, appId: f.app.id, clientId: 'appkey:k', roles: [] }));
    expect(await rows(f.app.id)).toHaveLength(0);
    expect(await events(f.app.id)).toHaveLength(0);
  });

  it('refuses a shared memory outside the App\'s org or team space', async () => {
    const f = await fixture();
    await db.orgMember.create({ data: { userId: f.mgr.id, organizationId: f.foreign.organizationId!, role: 'ADMIN' } });
    await refused(grant(f, f.foreign));
    expect(await rows(f.app.id)).toHaveLength(0);
  });

  it('a required prefix: empty, a trailing colon and a malformed loc are refused', async () => {
    const f = await fixture();
    for (const prefix of ['', ' ', 'reports:', ':reports', 'reports::x', 'a b']) {
      await expect(grant(f, f.dest, f.ctx, prefix)).rejects.toMatchObject({ extensions: { code: 'BAD_USER_INPUT' } });
    }
    expect(await rows(f.app.id)).toHaveLength(0);
  });

  it('revoking needs only App management; the row stays, terminal, with a REVOKE event', async () => {
    const f = await fixture();
    const g = await grant(f, f.dest);
    const owner2 = await db.user.create({ data: { handle: 'grant-owner2' } });
    await db.appMember.create({ data: { appId: f.app.id, userId: owner2.id, role: 'owner' } });
    const r = await revoke(g.id, { db, userId: owner2.id, roles: [] });
    expect(r.revokedAt).toBeInstanceOf(Date);
    const [row] = await rows(f.app.id);
    expect(row.revokedAt).toBeInstanceOf(Date);
    expect(row.revokedBy).toBe(owner2.id);
    expect((await events(f.app.id)).map(e => [e.action, e.actorUserId])).toEqual([['GRANT', f.mgr.id], ['REVOKE', owner2.id]]);
    // terminal: a second revoke changes nothing and records nothing
    await revoke(g.id, f.ctx);
    expect(await events(f.app.id)).toHaveLength(2);
    const stranger = await db.user.create({ data: { handle: 'grant-stranger' } });
    const g2 = await grant(f, f.dest, f.ctx, 'other:prefix');
    await refused(revoke(g2.id, { db, userId: stranger.id, roles: [] }));
  });

  it('the event stream is append-only', async () => {
    const f = await fixture();
    await grant(f, f.dest);
    await expect(db.$executeRawUnsafe('UPDATE app_memory_write_grant_events SET prefix = \'x\'')).rejects.toThrow(/append-only/);
    await expect(db.$executeRawUnsafe('DELETE FROM app_memory_write_grant_events')).rejects.toThrow(/append-only/);
  });
});

describe('personal, private and encrypted targets', () => {
  it.each(['personal', 'priv'] as const)('the owner who manages the App grants on their unencrypted %s memory; the run writes under the prefix and not past it', async kind => {
    const f = await fixture();
    const memory = f[kind];
    await grant(f, memory);
    const run = f.runCtx();
    await create(run, memory, `${PREFIX}:a`);
    await update(run, memory, `${PREFIX}:a`);
    await refused(create(run, memory, 'reports:other:a'));
    expect(await nodes(memory.id)).toBe(1);
  });

  it.each(['personal', 'priv'] as const)('refuses a non-owner who manages the App and can write the %s memory', async kind => {
    const f = await fixture();
    const other = await db.user.create({ data: { handle: 'grant-nonowner' } });
    await db.orgMember.create({ data: { userId: other.id, organizationId: f.org.id, role: 'CONTRIBUTOR' } });
    await db.appMember.create({ data: { appId: f.app.id, userId: other.id, role: 'owner' } });
    if (kind === 'personal') await db.memoryShare.create({ data: { memoryId: f.personal.id, granteeId: other.id, grantorId: f.mgr.id, role: 'writer' } });
    await refused(grant(f, f[kind], { db, userId: other.id, roles: [] }));
    expect(await rows(f.app.id)).toHaveLength(0);
  });

  it('refuses the owner when they do not manage the App being granted', async () => {
    const f = await fixture();
    // An org ADMIN manages every App of the org, so the owner here is a plain member of the App, not a manager.
    const plain = await db.user.create({ data: { handle: 'grant-plain' } });
    await db.orgMember.create({ data: { userId: plain.id, organizationId: f.org.id, role: 'CONTRIBUTOR' } });
    await db.appMember.create({ data: { appId: f.app.id, userId: plain.id, role: 'member' } });
    const mine = await db.memory.create({ data: { name: 'plain-mine', urn: 'grant2484.test:plain-mine', class: 'personal', userId: plain.id, organizationId: f.org.id } as never });
    await refused(M.setAppMemoryWriteGrant({}, { appRef: f.app.id, memoryRef: mine.id, prefix: PREFIX }, { db, userId: plain.id, roles: [] }));
    expect(await rows(f.app.id)).toHaveLength(0);
  });

  it.each(['encrypted', 'encPersonal'] as const)('never grants on an encrypted memory (%s), for the owner and a platform admin alike', async kind => {
    const f = await fixture();
    await refused(grant(f, f[kind]));
    await refused(grant(f, f[kind], { db, userId: f.mgr.id, roles: ['ADMIN'] }));
    expect(await rows(f.app.id)).toHaveLength(0);
  });

  it('writes stop when the owner stops managing the App, and when the memory becomes encrypted', async () => {
    const f = await fixture();
    await grant(f, f.personal);
    await grant(f, f.dest);
    await create(f.runCtx(), f.personal, `${PREFIX}:one`);
    await create(f.runCtx(), f.dest, `${PREFIX}:one`);
    await db.appMember.delete({ where: { appId_userId: { appId: f.app.id, userId: f.mgr.id } } });
    await db.orgMember.update({ where: { organizationId_userId: { organizationId: f.org.id, userId: f.mgr.id } }, data: { role: 'CONTRIBUTOR' } });
    await refused(create(f.runCtx(), f.personal, `${PREFIX}:two`));
    // the shared grant is the App's, not the setter's: it outlives the setter's own role
    await create(f.runCtx(), f.dest, `${PREFIX}:two`);
    await db.memory.update({ where: { id: f.dest.id }, data: { isEncrypted: true } });
    await refused(create(f.runCtx(), f.dest, `${PREFIX}:three`));
  });
});

describe('what a userless run of the App may write', () => {
  it('creates and updates under the prefix, at the prefix itself, and refuses one character past it and a sibling', async () => {
    const f = await fixture();
    await grant(f, f.dest);
    const run = f.runCtx();
    await create(run, f.dest, PREFIX);
    await create(run, f.dest, `${PREFIX}:2026-10-27`);
    await create(run, f.dest, `${PREFIX}:2026-10-27:deep`);
    await update(run, f.dest, `${PREFIX}:2026-10-27`);
    await refused(create(run, f.dest, `${PREFIX}X`));
    await refused(create(run, f.dest, `${PREFIX}X:child`));
    await refused(create(run, f.dest, 'reports:team-progres'));
    await refused(create(run, f.dest, 'reports:other'));
    await refused(create(run, f.dest, 'reports'));
    await refused(update(run, f.dest, 'reports:other'));
    expect(await nodes(f.dest.id)).toBe(3);
  });

  it('an update by node id cannot reach a node outside the prefix by naming a loc inside it', async () => {
    const f = await fixture();
    await grant(f, f.dest);
    const outside = await db.node.create({ data: { memoryId: f.dest.id, loc: 'reports:other', name: 'other', content: 'keep' } });
    // The write door's own moved-node guard stops it (NODE_WRITE_CONFLICT) before any write.
    await expect(writeNodeCore({ memoryId: f.dest.id, loc: `${PREFIX}:x`, content: 'overwritten' } as never, f.runCtx() as never, 'update', { targetNodeId: outside.id }))
      .rejects.toMatchObject({ extensions: { code: 'NODE_WRITE_CONFLICT' } });
    expect((await db.node.findUniqueOrThrow({ where: { id: outside.id } })).content).toBe('keep');
  });

  it('is matched on the destination AFTER writeTo expansion, through the real run write', async () => {
    const f = await fixture();
    await grant(f, f.dest);
    const flow = await db.memory.create({ data: { name: 'flow', urn: 'grant2484.test:flow', class: 'knowledge', visibility: 'ORGANIZATION', organizationId: f.org.id } as never });
    const agent = await db.agent.create({ data: { name: 'flow-agent', urn: 'grant2484.test:flow-agent', organizationId: f.org.id } as never });
    await db.appAgent.create({ data: { appId: f.app.id, agentId: agent.id } });
    await db.agentMemoryItem.create({ data: { agentId: agent.id, memoryId: flow.id, role: 'read-write' } });
    const entry = (writeTo: string) => db.node.upsert({
      where: { loc_memoryId: { loc: 'flow:report', memoryId: flow.id } },
      create: { memoryId: flow.id, loc: 'flow:report', name: 'report', content: 'Produce.', data: { output: { writeTo, mode: 'replace' } } as never },
      update: { data: { output: { writeTo, mode: 'replace' } } as never },
    });
    const run = await mintAppRun(db, { organizationId: f.org.id, appId: f.app.id, triggerKind: 'MANUAL', entryNodeUrn: 'hrn:node:grant2484.test:flow:flow:report', eventData: {} });
    const deps = makeProdRunDeps(db);
    await entry(`hrn:node:grant2484.test:dest:${PREFIX}:{runId}`);
    const id = await deps.writeOutput(run, 'hrn:node:grant2484.test:flow:flow:report', 'the report');
    expect(id).toBeTruthy();
    expect((await db.node.findUniqueOrThrow({ where: { loc_memoryId: { loc: `${PREFIX}:${run.id}`, memoryId: f.dest.id } } })).content).toBe('the report');
    await entry(`hrn:node:grant2484.test:dest:${PREFIX}X:{runId}`);
    await expect(deps.writeOutput(run, 'hrn:node:grant2484.test:flow:flow:report', 'leak')).rejects.toThrow(/not granted/i);
    expect(await nodes(f.dest.id)).toBe(1);
  });

  it('with no row, or a revoked one, the run is refused; a revoke between two writes refuses the second', async () => {
    const f = await fixture();
    await refused(create(f.runCtx(), f.dest, `${PREFIX}:a`));
    const g = await grant(f, f.dest);
    const run = f.runCtx();
    await create(run, f.dest, `${PREFIX}:a`);
    await revoke(g.id, f.ctx);
    await refused(create(run, f.dest, `${PREFIX}:b`));
    await refused(update(run, f.dest, `${PREFIX}:a`));
    expect(await nodes(f.dest.id)).toBe(1);
  });

  it('a revoke cannot return while a granted write is mid-commit (the grant row is held through the write)', async () => {
    const f = await fixture();
    const g = await grant(f, f.dest);
    const { canWriteToMemory } = await import('../../../mcp/access-control.js');
    let released!: () => void;
    const hold = new Promise<void>(r => { released = r; });
    let revokedAt = 0, committedAt = 0;
    const writer = db.$transaction(async tx => {
      expect(await canWriteToMemory(tx as never, f.runCtx() as never, f.dest.id, { destination: { loc: `${PREFIX}:x`, verb: 'create' } })).toBe(true);
      await hold;
      committedAt = Date.now();
    });
    await new Promise(r => setTimeout(r, 150));
    const revoking = revoke(g.id, f.ctx).then(() => { revokedAt = Date.now(); });
    await new Promise(r => setTimeout(r, 300));
    expect(revokedAt).toBe(0);
    released();
    await Promise.all([writer, revoking]);
    expect(revokedAt).toBeGreaterThanOrEqual(committedAt);
    await refused(create(f.runCtx(), f.dest, `${PREFIX}:y`));
  });

  it('other Apps\' runs, user-backed runs, App keys and workers gain nothing from the row', async () => {
    const f = await fixture();
    await grant(f, f.dest);
    await refused(create(f.runCtx(f.otherApp.id), f.dest, `${PREFIX}:a`));
    const u = await db.user.create({ data: { handle: 'grant-runuser' } });
    await db.appMember.create({ data: { appId: f.app.id, userId: u.id, role: 'member' } });
    await refused(create(f.runCtx(f.app.id, u.id), f.dest, `${PREFIX}:a`));
    await refused(create({ db, appId: f.app.id, clientId: 'appkey:k', roles: [] }, f.dest, `${PREFIX}:a`));
    await refused(create({ db, appId: f.app.id, userId: u.id, clientId: `user:${u.id}`, roles: [] }, f.dest, `${PREFIX}:a`));
    expect(await nodes(f.dest.id)).toBe(0);
  });

  it('no delete, no edge outside the prefix, no memory settings, no stored file', async () => {
    const f = await fixture();
    await grant(f, f.dest);
    const run = f.runCtx();
    const a = await create(run, f.dest, `${PREFIX}:a`) as { id: string };
    const outside = await db.node.create({ data: { memoryId: f.dest.id, loc: 'reports:other', name: 'other' } });
    await notDone(M.deleteNode({}, { nodeRef: a.id }, run));
    await notDone(M.createEdge({}, { sourceRef: a.id, targetRef: outside.id, name: 'x' }, run));
    await notDone(M.updateMemory({}, { id: f.dest.id, name: 'renamed' }, run));
    // inline edges ride the node write but reach past the prefix, so a write that carries any is not a grant write
    await refused(writeNodeCore({ memoryId: f.dest.id, loc: `${PREFIX}:b`, name: 'b', edges: [{ targetId: outside.id, name: 'x' }] } as never, run as never, 'create'));
    await refused(writeNodeCore({ memoryId: f.dest.id, loc: `${PREFIX}:b`, name: 'b', edges: [] } as never, run as never, 'create'));
    expect(await db.node.findUnique({ where: { loc_memoryId: { loc: `${PREFIX}:b`, memoryId: f.dest.id } } })).toBeNull();
    const { STORE_TOOLS } = await import('../../../lib/runner/tools/storeTools.js');
    const row = await mintAppRun(db, { organizationId: f.org.id, appId: f.app.id, triggerKind: 'MANUAL', entryNodeUrn: 'hrn:node:grant2484.test:dest:x', eventData: {} });
    await expect(STORE_TOOLS[0].execute({ db, run: row, principal: run, log: () => {} } as never, { urn: `hrn:node:grant2484.test:dest:${PREFIX}:file`, filename: 'a.md', content: 'x' })).rejects.toThrow(/not writable/i);
    expect(await db.node.findUniqueOrThrow({ where: { id: a.id } })).toMatchObject({ deletedAt: null });
    expect((await db.memory.findUniqueOrThrow({ where: { id: f.dest.id } })).name).toBe('dest');
    expect(await db.edge.count({ where: { sourceId: a.id } })).toBe(0);
    expect(await db.asset.count({ where: { memoryId: f.dest.id } })).toBe(0);
  });

  it('CONTROL: a run with no grant still cannot write a personal or private memory', async () => {
    const f = await fixture();
    await refused(create(f.runCtx(), f.personal, `${PREFIX}:a`));
    await refused(create(f.runCtx(), f.priv, `${PREFIX}:a`));
    await refused(create(f.runCtx(f.app.id, f.mgr.id), f.priv, `${PREFIX}:a`));
  });
});

describe('listing', () => {
  it('lists the App\'s grants to a manager only, and hides a personal or private grant from a manager who is not its owner', async () => {
    const f = await fixture();
    const shared = await grant(f, f.dest);
    const mine = await grant(f, f.personal);
    const owner2 = await db.user.create({ data: { handle: 'grant-owner2' } });
    await db.appMember.create({ data: { appId: f.app.id, userId: owner2.id, role: 'owner' } });
    const ownerView = await Q.appMemoryWriteGrants({}, { appRef: f.app.id }, f.ctx);
    expect(ownerView.map((g: { id: string }) => g.id).sort()).toEqual([shared.id, mine.id].sort());
    const peerView = await Q.appMemoryWriteGrants({}, { appRef: f.app.id }, { db, userId: owner2.id, roles: [] });
    expect(peerView.map((g: { id: string }) => g.id)).toEqual([shared.id]);
    const stranger = await db.user.create({ data: { handle: 'grant-stranger' } });
    await refused(Q.appMemoryWriteGrants({}, { appRef: f.app.id }, { db, userId: stranger.id, roles: [] }));
  });
});
