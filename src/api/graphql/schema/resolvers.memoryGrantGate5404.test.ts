/**
 * #5404 (hrn:node:hadronmemory.com:specs:cor:acl:140:02 `memory.read` / `memory.write`, hrn:node:hadronmemory.com:specs:cor:agt:010:01):
 * the GATE half of the retired grant tests, restated for the signed grants that replace them. The doors those files also covered
 * (set, revoke, list, projections, concealment, audit events, instructed workers) are retired (DOOR_RETIRED, pinned in
 * resolvers.memoryWriteGrant5404.test.ts); creating and signing the new grants is pinned there and in
 * src/lib/grants/memoryRead5321.test.ts.
 *
 * Sources, cited per case:
 *  - resolvers.appWriteGrant2484.test.ts (ruling 0083's App write grant, now `memory.write`);
 *  - resolvers.appWriteGrant2710.test.ts (a system memory is never a write target);
 *  - resolvers.automationReadGrant2883.test.ts (#2883's per-automation read grant, now `memory.read`).
 *
 * What the rulings changed, so a restated case asserts the NEW behaviour (Holger, 2026-11-27, decision record
 * 2026-11-27-holger-rulings-to-victor-read-grant-shape-r1 sections 5-6):
 *  - the giver of `memory.write` is the memory's manager ("Owner of each named memory"), judged at every write; managing the App
 *    is no longer part of it. A personal grant survives its owner leaving the App; a shared grant ends when its giver stops
 *    managing the memory (0083 kept a shared grant alive past its setter's role).
 *  - `memory.read` is held by the App and reaches every userless run of it: there is no per-automation scope any more, and a
 *    user-backed run gains nothing from it (#2883's user-backed branch is gone too). It has no prefix in this slice (#5412).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../../../integrations/db/client.js';
import { cleanDb, createDbAppAgent, createDbAppWithKey } from '../../../test/helpers.js';
import { serveAgentBootPrompt } from '../../../test/servedBootPrompt.js';
import { generateId } from '../../../lib/id.js';
import { runAuthContext, RUN_CLIENT_PREFIX } from '../../../lib/auth/runPrincipal.js';
import { attestedAuthoring, judgeAuthoring } from '../../../lib/authoringAttestation.js';
import { runAuthoring, runReadsNode } from '../../../lib/runner/runAuthoring.js';
import { canReadMemory, canWriteToMemory } from '../../../mcp/access-control.js';
import { hadronCreateNode, hadronReadNode, hadronUpdateNode } from '../../../lib/runner/tools/nodeTools.js';
import { isMemoryReadableFresh } from './resolvers.helpers.js';
import { resolvers, type Context } from './resolvers.js';
import { writeNodeCore } from './resolvers.mutation.node.js';
import { mintAppRun } from '../../../jobs/appRuns.js';
import { makeProdRunDeps } from '../../../jobs/appRunDeps.js';
import { upsertPlatformActions } from '../../../lib/grants/actions.js';
import { activeMemoryReadGrant, activeMemoryWriteGrant, revokeGrantRow } from '../../../test/appGrants5404.js';
import { testRunAgentId } from '../../../test/runAgent.js';

vi.mock('../../../lib/bus/index.js', () => ({ getBusClient: vi.fn(async () => null) }));
vi.mock('../../../integrations/github/writeNodeToGit.js', () => ({ writeNodeToGit: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../../../integrations/github/syncGraphFromGithub.js', () => ({ syncGraphFromGithub: vi.fn().mockResolvedValue({ error: null }) }));
beforeEach(async () => { await cleanDb(db); await upsertPlatformActions(db); });

const M = resolvers.Mutation as any;
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

// ─── memory.write: the write gate (from resolvers.appWriteGrant2484.test.ts and resolvers.appWriteGrant2710.test.ts) ───

const PREFIX = 'reports:team-progress';

async function fixture() {
  const org = await db.organization.create({ data: { name: 'Grant Org', urn: 'gate5404.test' } });
  const mgr = await db.user.create({ data: { handle: 'gate-mgr' } });
  await db.orgMember.create({ data: { userId: mgr.id, organizationId: org.id, role: 'ADMIN' } });
  const app = await db.app.create({ data: { name: 'Grant App', urn: 'gate5404.test:app', organizationId: org.id } });
  await db.appMember.create({ data: { appId: app.id, userId: mgr.id, role: 'owner' } });
  const otherApp = await db.app.create({ data: { name: 'Other App', urn: 'gate5404.test:other', organizationId: org.id } });
  const mem = (urn: string, extra: Record<string, unknown> = {}) =>
    db.memory.create({ data: { name: urn.split(':')[1], urn, class: 'knowledge', ...(extra.class ? {} : { visibility: 'ORGANIZATION' }), organizationId: org.id, ...extra } as never });
  const dest = await mem('gate5404.test:dest');
  const personal = await mem('gate5404.test:mine', { class: 'personal', userId: mgr.id });
  const priv = await mem('gate5404.test:secret', { class: 'private', userId: mgr.id });
  const ctx = { db, userId: mgr.id, roles: [] as never[] };
  const runCtx = (appId = app.id, userId: string | null = null) =>
    ({ db, ...runAuthContext({ id: generateId(), appId, userId, organizationId: org.id }) }) as never;
  return { org, mgr, app, otherApp, dest, personal, priv, ctx, runCtx };
}
type F = Awaited<ReturnType<typeof fixture>>;

const grant = (f: F, memory: { id: string }, issuer: string | null = f.mgr.id, prefix = PREFIX) =>
  activeMemoryWriteGrant(f.app.id, memory.id, { issuerUserId: issuer, prefix });
/** The real revoke shape (revoked_at with its revoker), through the guards, so it waits on a row a write holds FOR SHARE. */
const revokeGuarded = (id: string, by: string) =>
  db.$executeRawUnsafe(`UPDATE grants SET revoked_at = (clock_timestamp() AT TIME ZONE 'UTC'), revoked_by = $2, updated_at = (clock_timestamp() AT TIME ZONE 'UTC') WHERE id = $1`, id, by);
const create = (ctx: unknown, memory: { id: string }, loc: string) =>
  writeNodeCore({ memoryId: memory.id, loc, name: loc.split(':').pop()!, nodeType: 'record', content: 'body' } as never, ctx as never, 'create', { ownerLimit: 'refuse', sizeCeiling: 'check', authoring: attestedAuthoring(null) });
const update = (ctx: unknown, memory: { id: string }, loc: string) =>
  writeNodeCore({ memoryId: memory.id, loc, content: 'changed' } as never, ctx as never, 'update', { ownerLimit: 'refuse', sizeCeiling: 'check', authoring: attestedAuthoring(null) });
const refused = (p: Promise<unknown>) => expect(p).rejects.toMatchObject({ extensions: { code: 'FORBIDDEN' } });
const notDone = (p: Promise<unknown>) => expect(p).rejects.toBeTruthy();
const nodes = (memoryId: string) => db.node.count({ where: { memoryId } });

describe('memory.write on personal and private memories (2484 "personal, private and encrypted targets")', () => {
  // 2484: "the owner who manages the App grants on their unencrypted %s memory; the run writes under the prefix and not past it"
  it.each(['personal', 'priv'] as const)('the owner\'s grant on their %s memory: the run writes under the prefix and not past it', async kind => {
    const f = await fixture();
    const memory = f[kind];
    await grant(f, memory);
    const run = f.runCtx();
    await create(run, memory, `${PREFIX}:a`);
    await update(run, memory, `${PREFIX}:a`);
    await refused(create(run, memory, 'reports:other:a'));
    expect(await nodes(memory.id)).toBe(1);
  });

  // 2484: "refuses a non-owner who manages the App and can write the %s memory" — restated at the gate: a grant signed by a
  // non-owner (who cannot manage the memory) writes nothing. Signing itself refuses them (memoryWrite5404 pins, section 4).
  it.each(['personal', 'priv'] as const)('a grant whose giver manages the App but not the %s memory writes nothing', async kind => {
    const f = await fixture();
    const other = await db.user.create({ data: { handle: 'gate-nonowner' } });
    await db.orgMember.create({ data: { userId: other.id, organizationId: f.org.id, role: 'CONTRIBUTOR' } });
    await db.appMember.create({ data: { appId: f.app.id, userId: other.id, role: 'owner' } });
    if (kind === 'personal') await db.memoryShare.create({ data: { memoryId: f.personal.id, granteeId: other.id, grantorId: f.mgr.id, role: 'writer' } });
    await grant(f, f[kind], other.id);
    await refused(create(f.runCtx(), f[kind], `${PREFIX}:a`));
    expect(await nodes(f[kind].id)).toBe(0);
  });

  // 2484: "writes stop when the owner stops managing the App, and when the memory becomes encrypted". RULING CHANGE: the giver is
  // judged as the memory's manager, not the App's, so a personal grant survives its owner leaving the App; a shared grant now ENDS
  // when its giver stops managing the memory (0083 let it outlive the setter's role); encryption still ends it.
  it('the giver is judged as the memory\'s manager at every write; encryption ends the write', async () => {
    const f = await fixture();
    await grant(f, f.personal);
    await grant(f, f.dest);
    await create(f.runCtx(), f.personal, `${PREFIX}:one`);
    await create(f.runCtx(), f.dest, `${PREFIX}:one`);
    await db.appMember.delete({ where: { appId_userId: { appId: f.app.id, userId: f.mgr.id } } });
    await db.orgMember.update({ where: { organizationId_userId: { organizationId: f.org.id, userId: f.mgr.id } }, data: { role: 'CONTRIBUTOR' } });
    await create(f.runCtx(), f.personal, `${PREFIX}:two`);
    await refused(create(f.runCtx(), f.dest, `${PREFIX}:two`));
    await db.memory.update({ where: { id: f.personal.id }, data: { isEncrypted: true } });
    await notDone(create(f.runCtx(), f.personal, `${PREFIX}:three`));
    expect(await db.node.count({ where: { memoryId: f.personal.id, loc: `${PREFIX}:three` } })).toBe(0);
  });

  // 2484: "CONTROL: a run with no grant still cannot write a personal or private memory"
  it('CONTROL: a run with no grant still cannot write a personal or private memory', async () => {
    const f = await fixture();
    await refused(create(f.runCtx(), f.personal, `${PREFIX}:a`));
    await refused(create(f.runCtx(), f.priv, `${PREFIX}:a`));
    await refused(create(f.runCtx(f.app.id, f.mgr.id), f.priv, `${PREFIX}:a`));
  });
});

describe('what a userless run of the App may write (2484)', () => {
  // 2484: "creates and updates under the prefix, at the prefix itself, and refuses one character past it and a sibling"
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

  // 2484: "an update by node id cannot reach a node outside the prefix by naming a loc inside it"
  it('an update by node id cannot reach a node outside the prefix by naming a loc inside it', async () => {
    const f = await fixture();
    await grant(f, f.dest);
    const outside = await db.node.create({ data: { memoryId: f.dest.id, loc: 'reports:other', name: 'other', content: 'keep' } });
    await expect(writeNodeCore({ memoryId: f.dest.id, loc: `${PREFIX}:x`, content: 'overwritten' } as never, f.runCtx() as never, 'update', { ownerLimit: 'refuse', sizeCeiling: 'check', authoring: attestedAuthoring(null), targetNodeId: outside.id }))
      .rejects.toMatchObject({ extensions: { code: 'NODE_WRITE_CONFLICT' } });
    expect((await db.node.findUniqueOrThrow({ where: { id: outside.id } })).content).toBe('keep');
  });

  // 2484: "is matched on the destination AFTER writeTo expansion, through the real run write"
  it('is matched on the destination AFTER writeTo expansion, through the real run write', async () => {
    const f = await fixture();
    await grant(f, f.dest);
    const flow = await db.memory.create({ data: { name: 'flow', urn: 'gate5404.test:flow', class: 'knowledge', visibility: 'PUBLIC', organizationId: f.org.id } as never });
    const agent = await db.agent.create({ data: { name: 'flow-agent', urn: 'gate5404.test:flow-agent', organizationId: f.org.id } as never });
    await db.appAgent.create({ data: { appId: f.app.id, agentId: agent.id } });
    await db.agentMemoryItem.create({ data: { agentId: agent.id, memoryId: flow.id, role: 'read-write' } });
    await serveAgentBootPrompt(db, agent.id, 'Test boot prompt.');
    const entry = (writeTo: string) => db.node.upsert({
      where: { loc_memoryId: { loc: 'flow:report', memoryId: flow.id } },
      create: { memoryId: flow.id, loc: 'flow:report', name: 'report', content: 'Produce.', data: { output: { writeTo, mode: 'replace' } } as never },
      update: { data: { output: { writeTo, mode: 'replace' } } as never },
    });
    const run = await mintAppRun(db, { owner: { organizationId: f.org.id }, appId: f.app.id, agentId: agent.id, triggerKind: 'MANUAL', entryNodeUrn: 'hrn:node:gate5404.test:flow:flow:report', eventData: {} });
    const deps = makeProdRunDeps(db);
    await entry(`hrn:node:gate5404.test:dest:${PREFIX}:{runId}`);
    expect(await deps.writeOutput(run, 'hrn:node:gate5404.test:flow:flow:report', 'the report')).toBeTruthy();
    expect((await db.node.findUniqueOrThrow({ where: { loc_memoryId: { loc: `${PREFIX}:${run.id}`, memoryId: f.dest.id } } })).content).toBe('the report');
    await entry(`hrn:node:gate5404.test:dest:${PREFIX}X:{runId}`);
    await expect(deps.writeOutput(run, 'hrn:node:gate5404.test:flow:flow:report', 'leak')).rejects.toThrow(/not granted/i);
    expect(await nodes(f.dest.id)).toBe(1);
  });

  // 2484: "with no row, or a revoked one, the run is refused; a revoke between two writes refuses the second"
  it('with no grant, or a revoked one, the run is refused; a revoke between two writes refuses the second', async () => {
    const f = await fixture();
    await refused(create(f.runCtx(), f.dest, `${PREFIX}:a`));
    const g = await grant(f, f.dest);
    const run = f.runCtx();
    await create(run, f.dest, `${PREFIX}:a`);
    await revokeGrantRow(g, f.mgr.id);
    await refused(create(run, f.dest, `${PREFIX}:b`));
    await refused(update(run, f.dest, `${PREFIX}:a`));
    expect(await nodes(f.dest.id)).toBe(1);
  });

  // 2484: "a revoke cannot return while a granted write is mid-commit (the grant row is held through the write)"
  it('a revoke cannot return while a granted write is mid-commit (the grant row is held through the write)', async () => {
    const f = await fixture();
    const g = await grant(f, f.dest);
    let released!: () => void;
    const hold = new Promise<void>(r => { released = r; });
    let revokedAt = 0, committedAt = 0;
    const writer = db.$transaction(async tx => {
      expect(await canWriteToMemory(tx as never, f.runCtx() as never, f.dest.id, { destination: { loc: `${PREFIX}:x`, verb: 'create' } })).toBe(true);
      await hold;
      committedAt = Date.now();
    });
    await sleep(150);
    const revoking = revokeGuarded(g, f.mgr.id).then(() => { revokedAt = Date.now(); });
    await sleep(300);
    expect(revokedAt).toBe(0);
    released();
    await Promise.all([writer, revoking]);
    expect(revokedAt).toBeGreaterThanOrEqual(committedAt);
    await refused(create(f.runCtx(), f.dest, `${PREFIX}:y`));
  });

  // 2484: "other Apps' runs, user-backed runs, App keys and workers gain nothing from the row"
  it('other Apps\' runs, user-backed runs, App keys and workers gain nothing from the grant', async () => {
    const f = await fixture();
    await grant(f, f.dest);
    await refused(create(f.runCtx(f.otherApp.id), f.dest, `${PREFIX}:a`));
    const u = await db.user.create({ data: { handle: 'gate-runuser' } });
    await db.appMember.create({ data: { appId: f.app.id, userId: u.id, role: 'member' } });
    await refused(create(f.runCtx(f.app.id, u.id), f.dest, `${PREFIX}:a`));
    await refused(create({ db, appId: f.app.id, clientId: 'appkey:k', roles: [] }, f.dest, `${PREFIX}:a`));
    await refused(create({ db, appId: f.app.id, userId: u.id, clientId: `user:${u.id}`, roles: [] }, f.dest, `${PREFIX}:a`));
    expect(await nodes(f.dest.id)).toBe(0);
  });

  // 2484: "no delete, no edge outside the prefix, no memory settings, no stored file"
  it('no delete, no edge outside the prefix, no memory settings, no stored file', async () => {
    const f = await fixture();
    await grant(f, f.dest);
    const run = f.runCtx();
    const a = await create(run, f.dest, `${PREFIX}:a`) as { id: string };
    const outside = await db.node.create({ data: { memoryId: f.dest.id, loc: 'reports:other', name: 'other' } });
    await notDone(M.deleteNode({}, { nodeRef: a.id }, run));
    await notDone(M.createEdge({}, { sourceRef: a.id, targetRef: outside.id, name: 'x' }, run));
    await notDone(M.updateMemory({}, { ref: f.dest.id, name: 'renamed' }, run));
    await refused(writeNodeCore({ memoryId: f.dest.id, loc: `${PREFIX}:b`, name: 'b', edges: [{ targetId: outside.id, name: 'x' }] } as never, run as never, 'create', { ownerLimit: 'refuse', sizeCeiling: 'check', authoring: attestedAuthoring(null) }));
    await refused(writeNodeCore({ memoryId: f.dest.id, loc: `${PREFIX}:b`, name: 'b', edges: [] } as never, run as never, 'create', { ownerLimit: 'refuse', sizeCeiling: 'check', authoring: attestedAuthoring(null) }));
    expect(await db.node.findUnique({ where: { loc_memoryId: { loc: `${PREFIX}:b`, memoryId: f.dest.id } } })).toBeNull();
    const { STORE_TOOLS } = await import('../../../lib/runner/tools/storeTools.js');
    const agent = await db.agent.create({ data: { name: 'store-agent', urn: 'gate5404.test:store-agent', organizationId: f.org.id } as never });
    await db.appAgent.create({ data: { appId: f.app.id, agentId: agent.id } });
    await serveAgentBootPrompt(db, agent.id, 'Test boot prompt.');
    const row = await mintAppRun(db, { owner: { organizationId: f.org.id }, appId: f.app.id, agentId: agent.id, triggerKind: 'MANUAL', entryNodeUrn: 'hrn:node:gate5404.test:dest:x', eventData: {} });
    await expect(STORE_TOOLS[0].execute({ db, run: row, principal: run, log: () => {} } as never, { urn: `hrn:node:gate5404.test:dest:${PREFIX}:file`, filename: 'a.md', content: 'x' })).rejects.toThrow(/not writable/i);
    expect(await db.node.findUniqueOrThrow({ where: { id: a.id } })).toMatchObject({ deletedAt: null });
    expect((await db.memory.findUniqueOrThrow({ where: { id: f.dest.id } })).name).toBe('dest');
    expect(await db.edge.count({ where: { sourceId: a.id } })).toBe(0);
    expect(await db.asset.count({ where: { memoryId: f.dest.id } })).toBe(0);
  });

  // 2484: "content with an include tag is not a grant write: its derived INCLUDE edge would reach past the prefix (§10 P2)"
  it('content with an include tag is not a grant write: its derived INCLUDE edge would reach past the prefix', async () => {
    const f = await fixture();
    const team = await db.memory.create({ data: { name: 'team', urn: 'gate5404.test:team', class: 'app', appId: f.app.id, organizationId: f.org.id } as never });
    await grant(f, team);
    const run = f.runCtx();
    const plan = await db.node.create({ data: { memoryId: team.id, loc: 'secrets:plan', name: 'plan', content: 'secret' } });
    await notDone(writeNodeCore({ memoryId: team.id, loc: `${PREFIX}:r1`, name: 'r1', nodeType: 'record', content: 'see {{> secrets:plan}}' } as never, run as never, 'create', { ownerLimit: 'refuse', sizeCeiling: 'check', authoring: attestedAuthoring(null) }));
    expect(await db.node.findUnique({ where: { loc_memoryId: { loc: `${PREFIX}:r1`, memoryId: team.id } } })).toBeNull();
    expect(await db.edge.count({ where: { targetId: plan.id } })).toBe(0);
    await create(run, team, `${PREFIX}:r2`);
  });

  // 2484: "a node that already carries derived INCLUDE edges is not a grant write target (LOCAL P2)"
  it('a node that already carries derived INCLUDE edges is not a grant write target', async () => {
    const f = await fixture();
    const team = await db.memory.create({ data: { name: 'team', urn: 'gate5404.test:team', class: 'app', appId: f.app.id, organizationId: f.org.id } as never });
    await grant(f, team);
    const plan = await db.node.create({ data: { memoryId: team.id, loc: 'secrets:plan', name: 'plan', content: 'secret' } });
    const mine = await db.node.create({ data: { memoryId: team.id, loc: `${PREFIX}:r1`, name: 'r1', content: 'see {{> secrets:plan}}' } });
    await db.edge.create({ data: { id: generateId(), memoryId: team.id, sourceId: mine.id, targetId: plan.id, loc: `includes:${mine.id}:${plan.id}`, name: 'includes', governedKind: 'INCLUDE' } });
    await refused(update(f.runCtx(), team, `${PREFIX}:r1`));
    expect(await db.edge.count({ where: { sourceId: mine.id, governedKind: 'INCLUDE' } })).toBe(1);
    expect((await db.node.findUniqueOrThrow({ where: { id: mine.id } })).content).toBe('see {{> secrets:plan}}');
    await create(f.runCtx(), team, `${PREFIX}:r2`);
    await update(f.runCtx(), team, `${PREFIX}:r2`);
  });

  // 2710: "a grant row that already exists on one authorizes no userless run write (boot:source stays unwritten)" and its CONTROL.
  // (2710's "setting a grant on an Agent system memory is refused" is creation: memoryWriteTargetRefusal 'system', pinned in
  // src/lib/grants/writeGrantTarget5404.test.ts and resolvers.memoryWriteGrant5404.test.ts section 4.)
  it('an active grant on an Agent system memory authorizes no write; the same giver and run still write a shared memory', async () => {
    const f = await fixture();
    const system = await db.memory.create({ data: { name: 'iris-system', urn: 'gate5404.test:iris-system', class: 'system', organizationId: f.org.id } as never });
    await db.agent.create({ data: { name: 'Iris', urn: 'gate5404.test:iris', organizationId: f.org.id, systemMemoryId: system.id } as never });
    await grant(f, system, f.mgr.id, 'boot');
    await refused(create(f.runCtx(), system, 'boot:source'));
    expect(await nodes(system.id)).toBe(0);
    await grant(f, f.dest, f.mgr.id, 'boot');
    await create(f.runCtx(), f.dest, 'boot:source');
    expect(await nodes(f.dest.id)).toBe(1);
  });
});

describe('an authority change serializes with a granted write (2484 §10, both orderings)', () => {
  function holdWrite(run: unknown, memory: { id: string }, loc: string) {
    let release!: () => void, entered!: () => void;
    const hold = new Promise<void>(r => { release = r; });
    const inside = new Promise<void>(r => { entered = r; });
    const after: Array<() => void> = [];
    const done = db.$transaction(async tx => {
      await writeNodeCore({ memoryId: memory.id, loc, name: 'held', nodeType: 'record', content: 'x' } as never, run as never, 'create',
        { authoring: attestedAuthoring(null), transaction: { tx, pooledDb: db, afterCommit: (fn: () => void) => { after.push(fn); } } } as never);
      entered();
      await hold;
    }, { timeout: 20000 }).then(() => after.forEach(fn => fn()));
    return { release, done, inside: Promise.race([inside, done]) };
  }
  async function writerWins(f: F, memory: { id: string }, change: () => Promise<unknown>) {
    const w = holdWrite(f.runCtx(), memory, `${PREFIX}:held`);
    await w.inside;
    let settled = false;
    let failure: unknown;
    const changing = change().then(() => { settled = true; }, (e) => { settled = true; failure = e ?? new Error('change failed'); });
    await sleep(400);
    expect(settled).toBe(false);
    w.release();
    await w.done;
    await changing;
    expect(failure).toBeUndefined();
    if (await db.memory.findUnique({ where: { id: memory.id } })) expect(await db.node.count({ where: { memoryId: memory.id, loc: `${PREFIX}:held` } })).toBe(1);
  }
  async function changeWins(f: F, memory: { id: string }, change: () => Promise<unknown>) {
    await change();
    await expect(create(f.runCtx(), memory, `${PREFIX}:after`)).rejects.toBeTruthy();
    expect(await db.node.count({ where: { memoryId: memory.id } })).toBe(0);
  }
  const grantId = async (f: F) => (await db.grant.findFirstOrThrow({ where: { appId: f.app.id, action: 'memory.write' } })).id;
  // 2484 cases, the grant's own revoke through its guarded shape. RULING CHANGE: "the owner stops managing the App" no longer ends a
  // personal grant (it is the memory's owner who signs); in its place, the giver of a SHARED grant losing the memory's management.
  const cases: Array<[string, (f: F) => { id: string }, (f: F) => () => Promise<unknown>]> = [
    ['the grant is revoked', f => f.dest, f => async () => revokeGuarded(await grantId(f), f.mgr.id)],
    ['the memory is encrypted', f => f.dest, f => () => db.memory.update({ where: { id: f.dest.id }, data: { isEncrypted: true } })],
    ['the memory is deleted', f => f.dest, f => () => db.memory.delete({ where: { id: f.dest.id } })],
    ['the memory is soft-deleted', f => f.dest, f => () => db.memory.update({ where: { id: f.dest.id }, data: { deletedAt: new Date() } })],
    ['the App is soft-deleted', f => f.dest, f => () => db.app.update({ where: { id: f.app.id }, data: { deletedAt: new Date() } })],
    ['the App is hard-deleted', f => f.dest, f => () => db.app.delete({ where: { id: f.app.id } })],
    ['the giver stops managing the shared memory', f => f.dest, f => () =>
      db.orgMember.update({ where: { organizationId_userId: { organizationId: f.org.id, userId: f.mgr.id } }, data: { role: 'CONTRIBUTOR' } })],
    ['the personal memory moves to another owner', f => f.personal, f => async () => {
      const other = await db.user.create({ data: { handle: 'gate-newowner' } });
      await db.memory.update({ where: { id: f.personal.id }, data: { userId: other.id } });
    }],
  ];
  it.each(cases)('writer first: %s only after the in-flight write commits', async (_name, target, change) => {
    const f = await fixture();
    await grant(f, target(f));
    await writerWins(f, target(f), change(f));
  });
  it.each(cases)('change first: after %s the next write is refused and writes nothing', async (_name, target, change) => {
    const f = await fixture();
    await grant(f, target(f));
    await changeWins(f, target(f), change(f));
  });
});

describe('a memory soft-deleted while a granted write waits on its row (2484 §10 delta P3, A11)', () => {
  it('refuses the write and writes nothing', async () => {
    const f = await fixture();
    await grant(f, f.dest);
    let release!: () => void, locked!: () => void;
    const hold = new Promise<void>(r => { release = r; });
    const gotLock = new Promise<void>(r => { locked = r; });
    const deleter = db.$transaction(async tx => {
      await tx.memory.update({ where: { id: f.dest.id }, data: { deletedAt: new Date() } });
      locked();
      await hold;
    }, { timeout: 20000 });
    await gotLock;
    const writing = create(f.runCtx(), f.dest, `${PREFIX}:x`).then(() => 'wrote', (e: unknown) => e);
    await sleep(500);
    release();
    await deleter;
    expect(await writing).not.toBe('wrote');
    expect(await nodes(f.dest.id)).toBe(0);
  });
});

describe('the grant is bound to its memory and its giver (2484 mutant gaps)', () => {
  // 2484: "a grant on one memory covers no other memory of the same org under the same prefix"
  it('a grant on one memory covers no other memory of the same org under the same prefix', async () => {
    const f = await fixture();
    const second = await db.memory.create({ data: { name: 'second', urn: 'gate5404.test:second', class: 'knowledge', visibility: 'ORGANIZATION', organizationId: f.org.id } as never });
    await grant(f, f.dest);
    await create(f.runCtx(), f.dest, `${PREFIX}:ok`);
    await refused(create(f.runCtx(), second, `${PREFIX}:ok`));
    expect(await nodes(second.id)).toBe(0);
  });

  // 2484: "a personal grant dies with the grantor's ownership, even if the new owner also manages the App" and "the new owner setting
  // the same prefix again replaces the dead grant and can write" (the row/event bookkeeping of the retired door is not restated).
  it('a personal grant dies with its giver\'s ownership; the new owner\'s own grant writes', async () => {
    const f = await fixture();
    await grant(f, f.personal);
    const next = await db.user.create({ data: { handle: 'gate-newmgr' } });
    await db.orgMember.create({ data: { userId: next.id, organizationId: f.org.id, role: 'ADMIN' } });
    await db.appMember.create({ data: { appId: f.app.id, userId: next.id, role: 'owner' } });
    await db.memory.update({ where: { id: f.personal.id }, data: { userId: next.id } });
    await refused(create(f.runCtx(), f.personal, `${PREFIX}:a`));
    expect(await nodes(f.personal.id)).toBe(0);
    await grant(f, f.personal, next.id);
    await create(f.runCtx(), f.personal, `${PREFIX}:a`);
    expect(await nodes(f.personal.id)).toBe(1);
  });

  async function holdGate(f: F, memory: { id: string }) {
    let release!: () => void, entered!: () => void;
    const hold = new Promise<void>(r => { release = r; });
    const inside = new Promise<void>(r => { entered = r; });
    const done = db.$transaction(async tx => {
      expect(await canWriteToMemory(tx as never, f.runCtx() as never, memory.id, { destination: { loc: `${PREFIX}:x`, verb: 'create' } })).toBe(true);
      entered(); await hold;
    }, { timeout: 20000 });
    await Promise.race([inside, done]);
    return { release, done };
  }
  const blocks = async (h: { release: () => void; done: Promise<unknown> }, change: () => Promise<unknown>) => {
    let settled = false;
    let failure: unknown;
    const changing = change().then(() => { settled = true; }, (e) => { settled = true; failure = e ?? new Error('change failed'); });
    await sleep(400);
    expect(settled).toBe(false);
    h.release(); await h.done; await changing;
    expect(failure).toBeUndefined();
  };

  // 2484: "the gate holds the memory row: an encryption flip waits for it"
  it('the gate holds the memory row: an encryption flip waits for it', async () => {
    const f = await fixture();
    await grant(f, f.dest);
    await blocks(await holdGate(f, f.dest), () => db.memory.update({ where: { id: f.dest.id }, data: { isEncrypted: true } }));
  });

  // 2484: "a personal grant holds the owner's user row: deleting the owner waits"
  it('the gate holds the giver\'s user row: deleting the giver waits', async () => {
    const f = await fixture();
    await grant(f, f.personal);
    await blocks(await holdGate(f, f.personal), () => db.user.update({ where: { id: f.mgr.id }, data: { deletedAt: new Date() } }));
  });

  // 2484: "a personal grant holds the owner's org-admin row on its own" — restated for the shared grant, where the org-admin row IS
  // the giver's management of the memory. (2484's "App-owner row" case has no counterpart: App management is no longer judged.)
  it('a shared grant holds the giver\'s org-admin row: demoting the giver waits', async () => {
    const f = await fixture();
    await grant(f, f.dest);
    await blocks(await holdGate(f, f.dest), () => db.orgMember.update({ where: { organizationId_userId: { organizationId: f.org.id, userId: f.mgr.id } }, data: { role: 'CONTRIBUTOR' } }));
  });
});

// ─── memory.read: the read arm (from resolvers.automationReadGrant2883.test.ts) ───

const ENTRY = 'hrn:node:example.com:m:flows:entry';
interface R {
  org: { id: string; urn: string }; app: { id: string }; otherApp: { id: string };
  admin: { id: string }; member: { id: string }; outsider: { id: string };
  know: { id: string; urn: string }; first: { id: string }; s1: { id: string }; s2: { id: string };
  adminCtx: Context;
}
let r: R;
const uctx = (userId: string) => ({ db, userId, roles: ['READER'] }) as unknown as Context;
const schedule = (appId: string, orgId: string) => db.agentSchedule.create({ data: { id: generateId(), organizationId: orgId, appId, name: 'S', cron: '* * * * *', entryNodeUrn: ENTRY } });
const run = async (kind: 'SCHEDULE' | 'WEBHOOK' | 'MANUAL' | 'SPAWN', triggerId: string | null, parentRunId: string | null = null, userId: string | null = null) =>
  db.appRun.create({ data: { id: generateId(), organizationId: r.org.id, appId: r.app.id, agentId: await testRunAgentId(db, r.org.id, r.app.id), triggerKind: kind, triggerId, parentRunId, userId, entryNodeUrn: ENTRY } });
const node = (memoryId: string, loc: string) => db.node.create({ data: { id: generateId(), memoryId, loc, name: loc, content: `body of ${loc}`, nodeType: 'record' } as never });
async function readAs(x: { id: string; appId: string; userId: string | null }, memoryUrn: string, loc: string) {
  const runRow = await db.appRun.findUniqueOrThrow({ where: { id: x.id } });
  const principal = { db, appId: x.appId, userId: x.userId ?? undefined, organizationId: r.org.id, clientId: `${RUN_CLIENT_PREFIX}${x.id}`, roles: [] } as unknown as Context;
  return hadronReadNode.execute({ log: () => undefined, db, run: runRow, principal } as never, { urn: `hrn:node:${memoryUrn}:${loc}` });
}
const readable = async (x: { id: string; appId: string; userId: string | null }, loc = 'tasks:report') => {
  try { await readAs(x, r.know.urn, loc); return true; } catch (e) { if (/not readable/.test((e as Error).message)) return false; throw e; }
};
const give = (memoryId = r.know.id) => activeMemoryReadGrant(r.app.id, memoryId, { issuerUserId: r.admin.id });

describe('memory.read: what a run of the App reads (2883, restated)', () => {
  beforeEach(async () => {
    const org = await db.organization.create({ data: { id: generateId(), name: 'RG Org', urn: `rg-${generateId().toLowerCase()}.example` } });
    const mk = async (h: string) => db.user.create({ data: { id: generateId(), name: h, handle: `${h}-${generateId().slice(-6).toLowerCase()}`, roles: ['READER'] } });
    const [admin, member, outsider] = await Promise.all([mk('admin'), mk('member'), mk('outsider')]);
    await db.orgMember.create({ data: { organizationId: org.id, userId: admin.id, role: 'ADMIN' } });
    await db.orgMember.create({ data: { organizationId: org.id, userId: member.id, role: 'READER' } });
    const adminCtx = uctx(admin.id);
    const first = await M.createAgent({}, { orgRef: org.id, name: 'First' }, adminCtx);
    const { app } = await createDbAppWithKey(db, 'rg-app', org.id);
    const { app: otherApp } = await createDbAppWithKey(db, 'rg-other', org.id);
    await createDbAppAgent(db, app.id, first.id);
    const know = await db.memory.create({ data: { id: generateId(), name: 'know', urn: `${org.urn}:know`, class: 'knowledge', organizationId: org.id, visibility: 'ORGANIZATION' } as never });
    const s1 = await schedule(app.id, org.id);
    const s2 = await schedule(app.id, org.id);
    r = { org, app, otherApp, admin, member, outsider, know, first, s1, s2, adminCtx };
    await node(know.id, 'tasks:report');
    await node(know.id, 'other:x');
  });

  // 2883: "CONTROL: before any grant the run is refused the unlinked knowledge memory" and "after give the run reads the prefix;
  // after revoke the next read is refused" (memory.read has no prefix in this slice: it reads the whole memory, #5412).
  it('before a grant the run is refused; with one it reads the whole memory; after revoke the next read is refused', async () => {
    const x = await run('SCHEDULE', r.s1.id);
    expect(await readable(x)).toBe(false);
    const g = await give();
    expect(((await readAs(x, r.know.urn, 'tasks:report')) as { content: string }).content).toBe('body of tasks:report');
    expect(await readable(x, 'other:x')).toBe(true);
    await revokeGrantRow(g, r.admin.id);
    expect(await readable(x)).toBe(false);
  });

  // 2883: "another automation of the same App, a MANUAL run and a bare App key are refused" and "runs the trigger starts carry the
  // root trigger's grant (SPAWN child); a webhook with the same id string does not". RULING CHANGE: memory.read is held by the App,
  // not an automation, so EVERY userless run of the App reads; a bare key without the grant:read scope still reads nothing.
  it('every userless run of the App reads (any schedule, a webhook, a MANUAL run, a SPAWN child); a bare key does not', async () => {
    await give();
    const root = await run('SCHEDULE', r.s1.id);
    expect(await readable(root)).toBe(true);
    expect(await readable(await run('SCHEDULE', r.s2.id))).toBe(true);
    expect(await readable(await run('MANUAL', null))).toBe(true);
    expect(await readable(await run('SPAWN', root.id, root.id))).toBe(true);
    const wh = await db.agentWebhook.create({ data: { id: generateId(), organizationId: r.org.id, appId: r.app.id, name: 'W', secret: generateId(), entryNodeUrn: ENTRY } });
    expect(await readable(await run('WEBHOOK', wh.id))).toBe(true);
    const key = { appId: r.app.id, appKeyId: generateId(), organizationId: r.org.id, roles: [] } as never;
    expect(await canReadMemory(db, key, r.know.id)).toBe(false);
  });

  // 2883: "a user-backed run still needs the user layer" and "runHoldsReadGrant, user-backed branch (positive pin)". RULING CHANGE
  // (#5404 folded #2883 into memory.read): a user-backed run reads as its user and gains NOTHING from the App's grant.
  it('a user-backed run gains nothing from the App\'s grant: an outsider\'s run is refused, a member\'s reads as the member', async () => {
    await give();
    expect(await readable(await run('SCHEDULE', r.s1.id, null, r.outsider.id))).toBe(false);
    await db.orgMember.delete({ where: { organizationId_userId: { organizationId: r.org.id, userId: r.member.id } } });
    expect(await readable(await run('SCHEDULE', r.s1.id, null, r.member.id))).toBe(false);
  });

  // 2883: "an uninstalled App stops the read (judged live)"
  it('an uninstalled App stops the read (judged live)', async () => {
    const x = await run('SCHEDULE', r.s1.id);
    await give();
    expect(await readable(x)).toBe(true);
    await db.app.update({ where: { id: r.app.id }, data: { uninstalledAt: new Date() } });
    expect(await readable(x)).toBe(false);
  });

  // 2883: "the grant is read-only: a write through it is refused and writes nothing"
  it('the grant is read-only: a write through it is refused and writes nothing', async () => {
    await give();
    const x = await run('SCHEDULE', r.s1.id);
    const runRow = await db.appRun.findUniqueOrThrow({ where: { id: x.id } });
    const principal = { db, appId: r.app.id, organizationId: r.org.id, clientId: `${RUN_CLIENT_PREFIX}${x.id}`, roles: [] } as unknown as Context;
    const before = await db.node.count({ where: { memoryId: r.know.id } });
    await expect(hadronCreateNode.execute({ log: () => undefined, db, run: runRow, principal } as never, { urn: `hrn:node:${r.know.urn}:tasks:new`, name: 'n' })).rejects.toBeTruthy();
    expect(await db.node.count({ where: { memoryId: r.know.id } })).toBe(before);
  });

  describe('#1329 an author task the run reads through its grant (2883)', () => {
    const setUp = async () => {
      const t = await db.node.findUniqueOrThrow({ where: { loc_memoryId: { loc: 'tasks:report', memoryId: r.know.id } } });
      await db.node.update({ where: { id: t.id }, data: { isRunnable: true } });
      const dest = await db.memory.create({ data: { id: generateId(), name: 'dest', urn: `${r.org.urn}:dest`, class: 'knowledge', visibility: 'PUBLIC', organizationId: r.org.id } });
      await activeMemoryWriteGrant(r.app.id, dest.id, { issuerUserId: r.admin.id, prefix: 'reports' });
      await db.node.create({ data: { id: generateId(), memoryId: dest.id, loc: 'reports:a', name: 'a', content: 'initial', role: 'guide' } });
      const cfg = await db.memoryConfig.create({ data: { id: generateId(), memoryId: dest.id } });
      await db.nodeRoleRule.create({ data: { id: generateId(), configId: cfg.id, role: 'guide', authorTaskId: t.id, authorTaskRequired: true } });
      const x = await run('SCHEDULE', r.s1.id);
      const principal = { db, appId: x.appId, organizationId: r.org.id, clientId: `${RUN_CLIENT_PREFIX}${x.id}`, roles: [] } as unknown as Context;
      const write = (authoredWith?: { task: string; revision: number }) => hadronUpdateNode.execute(
        { db, run: x, principal, log: () => {} } as never,
        { urn: `hrn:node:${dest.urn}:reports:a`, content: 'updated', ...(authoredWith ? { authoredWith } : {}) },
      );
      return { t, dest, write, claim: { task: t.id, revision: t.revSeq } };
    };
    const refusal = (p: Promise<unknown>) => p.then(() => null, (e: { message?: string; extensions?: Record<string, unknown> }) => e.extensions ?? { thrown: e.message });

    // 2883: "a live covering grant reads the task, so the refusal gives it and an exact claim writes"
    it('a live read grant reads the task, so the refusal gives it and an exact claim writes', async () => {
      const { t, dest, write, claim } = await setUp();
      await give();
      expect(await refusal(write())).toMatchObject({ code: 'AUTHORING_ATTESTATION_MISSING', taskAccess: 'READABLE', taskId: t.id });
      await write(claim);
      expect(await db.node.findFirstOrThrow({ where: { memoryId: dest.id, loc: 'reports:a' } })).toMatchObject({ content: 'updated', authoredByTask: t.id });
    });

    // 2883: "a grant that does not cover the task, and a revoked one, read as unavailable" (no prefix form in this slice: a grant on
    // another memory stands in for the non-covering one)
    it('no grant on the task\'s memory, and a revoked one, read as unavailable', async () => {
      const { write, claim } = await setUp();
      const unavailable = { code: 'AUTHOR_TASK_BROKEN', taskAccess: 'UNAVAILABLE', task: null };
      const elsewhere = await db.memory.create({ data: { id: generateId(), name: 'else', urn: `${r.org.urn}:else`, class: 'knowledge', visibility: 'ORGANIZATION', organizationId: r.org.id } as never });
      await give(elsewhere.id);
      expect(await refusal(write(claim))).toMatchObject(unavailable);
      const covering = await give();
      await revokeGrantRow(covering, r.admin.id);
      expect(await refusal(write(claim))).toMatchObject(unavailable);
    });

    // 2883: "a run never outruns its own read: another App's personal memory the on-behalf-of user owns is unavailable" (no grant)
    it('a run never outruns its own read: another App\'s personal memory the on-behalf-of user owns is unavailable', async () => {
      const owned = (slug: string, appId: string) => db.memory.create({ data: {
        id: generateId(), name: slug, urn: `${r.org.urn}:${slug}`, class: 'personal', organizationId: r.org.id,
        userId: r.member.id, appId, userMemoryOfAgentId: r.first.id,
      } });
      const dest = await owned('mine', r.app.id);
      const elsewhere = await owned('elsewhere', r.otherApp.id);
      const hidden = await db.node.create({ data: { id: generateId(), memoryId: elsewhere.id, loc: 'hidden', name: 'Hidden', isRunnable: true } });
      await db.node.create({ data: { id: generateId(), memoryId: dest.id, loc: 'a', name: 'a', content: 'initial', role: 'guide' } });
      const cfg = await db.memoryConfig.create({ data: { id: generateId(), memoryId: dest.id } });
      await db.nodeRoleRule.create({ data: { id: generateId(), configId: cfg.id, role: 'guide', authorTaskId: hidden.id, authorTaskRequired: true } });
      const x = await run('SCHEDULE', r.s1.id, null, r.member.id);
      await expect(readAs(x, elsewhere.urn, 'hidden')).rejects.toThrow();
      const principal = { db, appId: x.appId, userId: r.member.id, organizationId: r.org.id, clientId: `${RUN_CLIENT_PREFIX}${x.id}`, roles: [] } as unknown as Context;
      expect(await isMemoryReadableFresh(principal, elsewhere.id)).toBe(true);
      const judged = (claim: { task: string; revision: number } | null) => db.$transaction((tx) => judgeAuthoring(tx, dest.id, {
        priorRole: 'guide', priorRunnable: false, role: 'guide', runnable: false, mintHuman: true, authoredChange: true,
      }, runAuthoring(principal, x, claim)));
      const unavailable = { refused: 'AUTHOR_TASK_BROKEN', recovery: { taskAccess: 'UNAVAILABLE', task: null, taskId: null } };
      expect(await judged(null)).toMatchObject(unavailable);
      expect(await judged({ task: hidden.id, revision: hidden.revSeq })).toMatchObject(unavailable);
    });

    // 2883: "a user-backed run does not reach another org through its user's membership"
    it('a user-backed run does not reach another org through its user\'s membership', async () => {
      const org = await db.organization.create({ data: { id: generateId(), name: 'rg-other-org', urn: 'rg-other-org' } });
      await db.orgMember.create({ data: { organizationId: org.id, userId: r.member.id, role: 'CONTRIBUTOR' } });
      const other = await db.memory.create({ data: { id: generateId(), name: 'other', urn: 'rg-other-org:other', class: 'knowledge', organizationId: org.id } });
      const x = await run('SCHEDULE', r.s1.id, null, r.member.id);
      const principal = { db, appId: null, userId: r.member.id, organizationId: r.org.id, clientId: `${RUN_CLIENT_PREFIX}${x.id}`, roles: [] } as unknown as Context;
      expect(await canReadMemory(db, { userId: r.member.id, roles: [] } as never, other.id)).toBe(true);
      expect(await runReadsNode(db, principal, x, other.id, 'x')).toBe(false);
    });

    // 2883: "runs are unavailable on encrypted memories, even PUBLIC knowledge in another org"
    it('runs are unavailable on encrypted memories, even PUBLIC knowledge in another org', async () => {
      const org = await db.organization.create({ data: { id: generateId(), name: 'rg-enc', urn: 'rg-enc' } });
      const open = await db.memory.create({ data: { id: generateId(), name: 'open', urn: 'rg-enc:open', class: 'knowledge', visibility: 'PUBLIC', organizationId: org.id } });
      const sealed = await db.memory.create({ data: { id: generateId(), name: 'sealed', urn: 'rg-enc:sealed', class: 'knowledge', visibility: 'PUBLIC', organizationId: org.id, isEncrypted: true } });
      const x = await run('SCHEDULE', r.s1.id);
      const principal = { db, appId: x.appId, organizationId: r.org.id, clientId: `${RUN_CLIENT_PREFIX}${x.id}`, roles: [] } as unknown as Context;
      expect(await runReadsNode(db, principal, x, open.id, 'x')).toBe(true);
      expect(await runReadsNode(db, principal, x, sealed.id, 'x')).toBe(false);
    });
  });
});
