/**
 * #3287 — `Query.actionRegisterIndex`: the code-to-task index computed at read
 * (rulings 0101, 0102, 0106 A, 0107 A; cor:agt:110:03, cor:agt:110:04).
 * Real-Postgres pins. Every "empty" answer is compared byte-for-byte with the
 * same App when it has no Team Agent (ruling 0060's empty answer).
 */
import { GraphQLError } from 'graphql';
import { formatGraphQLError } from '../formatError.js';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { WORKER_SIGNATURE_DEFAULTS } from '../../../lib/workerSignature.js';
import { requestActorStorage } from '../../../lib/requestActor.js';
import { typeDefs } from './typeDefs.js';
import { emitActionUrnV2, emitEntityUrnV2 } from '../../../lib/urnEmit.js';
import { resolvers, type Context } from './resolvers.js';

vi.mock('../../../integrations/github/writeNodeToGit.js', () => ({ writeNodeToGit: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../../../integrations/github/syncGraphFromGithub.js', () => ({ syncGraphFromGithub: vi.fn().mockResolvedValue({ error: null }) }));

const M = resolvers.Mutation as any;
const ctx = (userId: string, dbc: any = db): Context => ({ db: dbc, userId, roles: ['READER'] });

let org: { id: string; urn: string };
let foreignOrg: { id: string; urn: string };
let admin: { id: string };
let outsider: { id: string };
let foreignOwner: { id: string };
let app: { id: string };
type A = { id: string; urn: string; memoryId: string };
let teamBase: A, team: A, engineer: A, coder: A;
let coderWorker: { id: string };

async function agent(name: string, opts: { orgId?: string; userId?: string; parent?: string } = {}): Promise<A> {
  const a = await M.createAgent({}, { orgId: opts.orgId ?? org.id, name }, ctx(opts.userId ?? admin.id));
  if (opts.parent) await db.agent.update({ where: { id: a.id }, data: { extendsAgentId: opts.parent } });
  const row = await db.agent.findUniqueOrThrow({ where: { id: a.id } });
  return { id: a.id, urn: row.urn, memoryId: row.systemMemoryId as string };
}
const foreignAgent = (name: string, parent?: string) => agent(name, { orgId: foreignOrg.id, userId: foreignOwner.id, parent });
async function node(memoryId: string, loc: string, extra: Record<string, unknown> = {}) {
  return db.node.create({ data: { id: generateId(), memoryId, loc, name: loc, content: '# x', ...extra } });
}
const entry = (memoryId: string, code: string, taskLoc: unknown, entryCode: string = code) =>
  node(memoryId, `register:${code}`, { data: { registerEntry: { code: entryCode, taskLoc } } });
const task = (memoryId: string, loc: string, extra: Record<string, unknown> = {}) => node(memoryId, loc, { isRunnable: true, ...extra });
const memUrn = async (memoryId: string) => (await db.memory.findUniqueOrThrow({ where: { id: memoryId } })).urn;
const actionUrn = (agentUrn: string, code: string) => emitActionUrnV2(agentUrn, code);
const agentUrn = (a: A) => emitEntityUrnV2('agent', a.urn);

const index = (args: Record<string, unknown> = {}, c: Context = ctx(admin.id)) =>
  (resolvers.Query as any).actionRegisterIndex({}, { appRef: app.id, agentRef: coder.id, ...args }, c);
/** As a bound worker session of `agentId` (the request actor), held by admin. */
const asWorker = (agentId: string, fn: () => Promise<any>): Promise<any> =>
  requestActorStorage.run({ workerId: coderWorker.id, agentId }, fn);
const refusal = async (p: Promise<unknown>) => {
  try { await p; } catch (e: any) { return JSON.stringify({ message: e.message, extensions: e.extensions ?? null, name: e.name }); }
  throw new Error('expected a refusal');
};
/** The App's answer with no Team Agent at all (ruling 0060), for the same arguments. */
async function noTeamAnswer(args: Record<string, unknown> = {}) {
  const marker = await db.node.findFirstOrThrow({ where: { memoryId: team.memoryId, loc: 'roles' } });
  await db.node.update({ where: { id: marker.id }, data: { deletedAt: new Date() } });
  try { return JSON.stringify(await index(args)); }
  finally { await db.node.update({ where: { id: marker.id }, data: { deletedAt: null } }); }
}

beforeEach(async () => {
  await cleanDb(db);
  const s = generateId().toLowerCase();
  org = await db.organization.create({ data: { id: generateId(), name: 'ari-org', urn: `ari-${s}.example` } });
  foreignOrg = await db.organization.create({ data: { id: generateId(), name: 'ari-foreign', urn: `arf-${s}.example` } });
  admin = await db.user.create({ data: { handle: `ari-admin-${s}` } });
  outsider = await db.user.create({ data: { handle: `ari-out-${s}` } });
  foreignOwner = await db.user.create({ data: { handle: `ari-fown-${s}` } });
  await db.orgMember.create({ data: { organizationId: org.id, userId: admin.id, role: 'ADMIN' } });
  await db.orgMember.create({ data: { organizationId: foreignOrg.id, userId: foreignOwner.id, role: 'ADMIN' } });
  app = await db.app.create({ data: { id: generateId(), organizationId: org.id, name: 'Team', urn: `${org.urn}:team` } });

  // Team Agent chain: Team -> TeamBase. Asking chain: Coder -> Engineer.
  teamBase = await agent('Team Base');
  team = await agent('Team Agent', { parent: teamBase.id });
  engineer = await agent('Engineer');
  coder = await agent('Coder', { parent: engineer.id });
  await db.appAgent.create({ data: { appId: app.id, agentId: team.id } });
  await db.appAgent.create({ data: { appId: app.id, agentId: engineer.id } });
  await node(team.memoryId, 'roles'); // the Team Agent marker
  coderWorker = await db.worker.create({ data: { ...WORKER_SIGNATURE_DEFAULTS, id: generateId(), appId: app.id, agentId: coder.id, name: 'Liam', slug: 'liam' }, select: { id: true } });

  await entry(teamBase.memoryId, 'a.base', 'tasks:alpha');      // inherited, not overridden
  await entry(teamBase.memoryId, 'b.over', 'tasks:base-b');     // overridden by Team
  await entry(team.memoryId, 'b.over', 'tasks:beta');
  await entry(teamBase.memoryId, 'c.unres', 'tasks:none');      // no task anywhere
  await entry(teamBase.memoryId, 'd.bad', 'tasks:alpha', 'x');  // malformed: code mismatch
  await task(engineer.memoryId, 'tasks:alpha');
  await task(engineer.memoryId, 'tasks:beta');
  await task(engineer.memoryId, 'tasks:base-b');
  await task(coder.memoryId, 'tasks:alpha');                     // Coder's own override
});

describe('#3287 resolution and states (acceptance 1, 2)', () => {
  it('lists one row per code in code order: base entry inherited, child override wins, nearest task per asking Agent', async () => {
    const r = await index();
    expect(r.total).toBe(4);
    expect(r.hasMore).toBe(false);
    const teamBaseMem = await memUrn(teamBase.memoryId), teamMem = await memUrn(team.memoryId);
    expect(r.entries).toEqual([
      { code: 'a.base', state: 'MAPPED', actionUrn: actionUrn(teamBase.urn, 'a.base'), entryUrn: `hrn:node:${teamBaseMem}:register:a.base`,
        definedBy: agentUrn(teamBase), taskLoc: 'tasks:alpha', taskUrn: `hrn:node:${await memUrn(coder.memoryId)}:tasks:alpha` },
      { code: 'b.over', state: 'MAPPED', actionUrn: actionUrn(team.urn, 'b.over'), entryUrn: `hrn:node:${teamMem}:register:b.over`,
        definedBy: agentUrn(team), taskLoc: 'tasks:beta', taskUrn: `hrn:node:${await memUrn(engineer.memoryId)}:tasks:beta` },
      { code: 'c.unres', state: 'UNRESOLVED', actionUrn: actionUrn(teamBase.urn, 'c.unres'), entryUrn: `hrn:node:${teamBaseMem}:register:c.unres`,
        definedBy: agentUrn(teamBase), taskLoc: 'tasks:none', taskUrn: null },
      { code: 'd.bad', state: 'UNMAPPED', actionUrn: null, entryUrn: null, definedBy: null, taskLoc: null, taskUrn: null },
    ]);
  });

  it('a base boot-prompt entry is not inherited; the same node in the own memory is listed (a comment cannot be an entry: COMMENT_INVARIANT)', async () => {
    await entry(teamBase.memoryId, 'g.boot', 'tasks:alpha').then((n) => db.node.update({ where: { id: n.id }, data: { role: 'boot-prompt' } }));
    await entry(teamBase.memoryId, 'h.bootsub', 'tasks:alpha').then((n) => db.node.update({ where: { id: n.id }, data: { role: 'boot-prompt.coder' } }));
    const r = await index();
    expect(r.total).toBe(4);
    expect(r.entries.map((e: any) => e.code)).toEqual(['a.base', 'b.over', 'c.unres', 'd.bad']);
    await entry(team.memoryId, 'g.boot', 'tasks:alpha').then((n) => db.node.update({ where: { id: n.id }, data: { role: 'boot-prompt' } }));
    const own = await index({ code: 'g.boot' });
    expect(own.entries).toEqual([expect.objectContaining({ code: 'g.boot', state: 'MAPPED', definedBy: agentUrn(team) })]);
  });

  it('the base asking resolves its own task, not the child override', async () => {
    const r = await index({ agentRef: engineer.id, code: 'a.base' });
    expect(r.entries[0].taskUrn).toBe(`hrn:node:${await memUrn(engineer.memoryId)}:tasks:alpha`);
  });

  it('a nearest malformed entry is UNMAPPED: the farther well-formed one is never used', async () => {
    await entry(team.memoryId, 'a.base', '', 'a.base');
    const r = await index({ code: 'a.base' });
    expect(r.entries).toEqual([{ code: 'a.base', state: 'UNMAPPED', actionUrn: null, entryUrn: null, definedBy: null, taskLoc: null, taskUrn: null }]);
  });

  it('a nearest non-runnable task is UNRESOLVED (no farther task), identical to the task deleted and to no task', async () => {
    await db.node.updateMany({ where: { memoryId: coder.memoryId, loc: 'tasks:alpha' }, data: { isRunnable: false } });
    const notRunnable = JSON.stringify(await index({ code: 'a.base' }));
    expect(JSON.parse(notRunnable).entries[0]).toMatchObject({ state: 'UNRESOLVED', taskLoc: 'tasks:alpha', taskUrn: null });
    // Same fixture, the nearest task deleted as well as the farther one: the same answer.
    await db.node.updateMany({ where: { loc: 'tasks:alpha', memoryId: { in: [coder.memoryId, engineer.memoryId] } }, data: { deletedAt: new Date() } });
    expect(JSON.stringify(await index({ code: 'a.base' }))).toBe(notRunnable);
  });

  it('an entry in the App install memory is never read (present vs deleted gives the same page at limit 1 and at a boundary)', async () => {
    const install = await db.memory.create({ data: { id: generateId(), name: 'Install', urn: `${org.urn}:install`, class: 'system', appId: app.id, isInstallMemory: true, installOfAgentId: team.id, organizationId: org.id } });
    const stray = await entry(install.id, 'a0.install', 'tasks:alpha');
    await entry(install.id, 'b.over', 'tasks:alpha'); // would override if the install memory were searched
    const present = [JSON.stringify(await index({ limit: 1 })), JSON.stringify(await index({ limit: 2, offset: 2 })), JSON.stringify(await index())];
    await db.node.updateMany({ where: { memoryId: install.id }, data: { deletedAt: new Date() } });
    const absent = [JSON.stringify(await index({ limit: 1 })), JSON.stringify(await index({ limit: 2, offset: 2 })), JSON.stringify(await index())];
    expect(present).toEqual(absent);
    expect(JSON.parse(present[0]!).entries[0].code).toBe('a.base');
    expect(stray.id).toBeTruthy();
  });
});

describe('#3287 whole-chain gate, ruling 0107 (acceptance 3, 5a)', () => {
  const pages = [{}, { limit: 1 }, { limit: 2, offset: 2 }];
  async function expectEmptyAsNoTeam(args: Record<string, unknown> = {}) {
    for (const p of pages) {
      const got = JSON.stringify(await index({ ...p, ...args }));
      expect(got).toBe(await noTeamAnswer({ ...p, ...args }));
      expect(JSON.parse(got)).toEqual({ entries: [], total: 0, hasMore: false });
    }
  }

  it('the baseline really has rows (so each empty page below is the gate)', async () => {
    expect((await index({ limit: 1 })).hasMore).toBe(true);
  });

  it('position 1: the Team Agent system memory unreadable (a foreign Team Agent) empties the page', async () => {
    const ft = await foreignAgent('Foreign Team', teamBase.id);
    await node(ft.memoryId, 'roles');
    await entry(ft.memoryId, 'b.over', 'tasks:beta');
    await db.appAgent.delete({ where: { appId_agentId: { appId: app.id, agentId: team.id } } });
    await db.appAgent.create({ data: { appId: app.id, agentId: ft.id } });
    for (const p of pages) expect(await index(p)).toEqual({ entries: [], total: 0, hasMore: false });
    // and it is the no-Team-Agent answer
    await db.node.updateMany({ where: { memoryId: ft.memoryId, loc: 'roles' }, data: { deletedAt: new Date() } });
    const none = JSON.stringify(await index());
    await db.node.updateMany({ where: { memoryId: ft.memoryId, loc: 'roles' }, data: { deletedAt: null } });
    expect(JSON.stringify(await index())).toBe(none);
  });

  it('position 2: a base on the Team Agent chain unreadable (foreign, beyond the readable base) empties the page', async () => {
    const fb = await foreignAgent('Foreign Base');
    await entry(fb.memoryId, 'z.far', 'tasks:alpha');
    await db.agent.update({ where: { id: teamBase.id }, data: { extendsAgentId: fb.id } });
    await expectEmptyAsNoTeam();
  });

  it('position 3: the asking Agent system memory unreadable (a PUBLIC foreign Agent installed in the App) empties the page', async () => {
    const fp = await foreignAgent('Foreign Public');
    await db.agent.update({ where: { id: fp.id }, data: { visibility: 'PUBLIC' } });
    await db.appAgent.create({ data: { appId: app.id, agentId: fp.id } });
    await task(fp.memoryId, 'tasks:alpha');
    await expectEmptyAsNoTeam({ agentRef: fp.id });
  });

  it('position 4: a base on the asking Agent chain unreadable empties the page', async () => {
    const fb = await foreignAgent('Foreign Asking Base');
    await task(fb.memoryId, 'tasks:none');
    await db.agent.update({ where: { id: engineer.id }, data: { extendsAgentId: fb.id } });
    await expectEmptyAsNoTeam();
  });

  it('a soft-deleted system memory on a chain counts as unreadable', async () => {
    await db.memory.update({ where: { id: engineer.memoryId }, data: { deletedAt: new Date() } });
    await expectEmptyAsNoTeam();
  });

  it('a soft-deleted system memory empties the page even for a platform admin, whose access reads it', async () => {
    const platform: Context = { db, userId: admin.id, roles: ['ADMIN'] };
    expect((await index({}, platform)).total).toBe(4);
    const empty = await noTeamAnswer();
    await db.memory.update({ where: { id: engineer.memoryId }, data: { deletedAt: new Date() } });
    expect(JSON.stringify(await index({}, platform))).toBe(empty);
    await db.memory.update({ where: { id: engineer.memoryId }, data: { deletedAt: null } });
    await db.memory.update({ where: { id: teamBase.memoryId }, data: { deletedAt: new Date() } });
    expect(JSON.stringify(await index({}, platform))).toBe(empty);
  });
});

describe('#3287 filters (acceptance 4)', () => {
  it('taskLoc keeps exactly the codes whose entry names that loc; code keeps one row', async () => {
    const byLoc = await index({ taskLoc: 'tasks:none' });
    expect(byLoc.entries.map((e: any) => e.code)).toEqual(['c.unres']);
    expect(byLoc.total).toBe(1);
    await entry(team.memoryId, 'e.two', 'tasks:none');
    expect((await index({ taskLoc: 'tasks:none' })).entries.map((e: any) => e.code)).toEqual(['c.unres', 'e.two']);
    const byCode = await index({ code: 'b.over' });
    expect(byCode.entries.map((e: any) => e.code)).toEqual(['b.over']);
    expect(byCode.total).toBe(1);
  });

  it('a filter naming nothing, the overridden base loc, or a malformed entry gives the same empty page as no Team Agent', async () => {
    const empty = await noTeamAnswer();
    for (const f of [{ taskLoc: 'tasks:nothing' }, { taskLoc: 'tasks:base-b' }, { code: 'zz.none' }, { code: 'b.over', taskLoc: 'tasks:none' }]) {
      expect(JSON.stringify(await index(f))).toBe(empty);
    }
  });
});

describe('#3287 the asking Agent (acceptance 5, ruling 0106)', () => {
  it('a worker session with no agentRef resolves through its own Agent', async () => {
    const r = await asWorker(coder.id, () => index({ agentRef: undefined, code: 'a.base' }));
    expect(r.entries[0].taskUrn).toBe(`hrn:node:${await memUrn(coder.memoryId)}:tasks:alpha`);
    const viaEngineer = await asWorker(engineer.id, () => index({ agentRef: undefined, code: 'a.base' }));
    expect(viaEngineer.entries[0].taskUrn).toBe(`hrn:node:${await memUrn(engineer.memoryId)}:tasks:alpha`);
  });

  it('a person with no agentRef is refused BAD_USER_INPUT', async () => {
    await expect(index({ agentRef: undefined })).rejects.toMatchObject({ extensions: { code: 'BAD_USER_INPUT' } });
  });

  it('a cast worker Agent not installed in the App may be named', async () => {
    const r = await index({ agentRef: agentUrn(coder), code: 'a.base' });
    expect(r.entries[0].taskUrn).toBe(`hrn:node:${await memUrn(coder.memoryId)}:tasks:alpha`);
  });

  it('a retired worker no longer admits its Agent: refused like an unknown Agent', async () => {
    await db.worker.update({ where: { id: coderWorker.id }, data: { retiredAt: new Date() } });
    const unknown = generateId();
    const shape = async (ref: string) => (await refusal(index({ agentRef: ref }))).replaceAll(ref, '<ref>');
    expect(await shape(coder.id)).toBe(await shape(unknown));
  });

  it('unknown, unreadable, readable-but-outside-the-App and other-tenant Agents answer byte-identically, with no fallback', async () => {
    const ref = (id: string) => ({ agentRef: id });
    const unknown = generateId();
    const shape = async (agentRef: string, wrap = (p: Promise<unknown>) => p) =>
      (await refusal(wrap(index(ref(agentRef))))).replaceAll(agentRef, '<ref>');
    const base = await shape(unknown);
    // unreadable: a private foreign Agent installed in the App
    const priv = await foreignAgent('Foreign Private'); await db.appAgent.create({ data: { appId: app.id, agentId: priv.id } });
    expect(await shape(priv.id)).toBe(base);
    // readable, but neither installed in the App nor a cast worker's Agent
    const other = await agent('Not Installed'); await task(other.memoryId, 'tasks:alpha');
    expect(await shape(other.id)).toBe(base);
    // readable only through another tenant (the caller is a member there), outside this App
    await db.orgMember.create({ data: { organizationId: foreignOrg.id, userId: admin.id, role: 'ADMIN' } });
    const tenant = await foreignAgent('Other Tenant'); await task(tenant.memoryId, 'tasks:alpha');
    expect(await shape(tenant.id)).toBe(base);
    // a worker session naming an unknown Agent is refused too: never its own Agent instead
    expect(await shape(unknown, (p) => p)).toBe(base);
    expect(await refusal(asWorker(coder.id, () => index(ref(unknown))))).toBe(await refusal(index(ref(unknown))));
  });
});

describe('#3359 implicit asking Agent membership (ruling 0120)', () => {
  const wireRefusal = async (p: Promise<unknown>) => {
    try { await p; } catch (e: any) {
      const error = new GraphQLError(e.message, { originalError: e, path: ['actionRegisterIndex'] });
      const formatted = formatGraphQLError(error.toJSON(), error);
      return JSON.stringify({ message: formatted.message, extensions: formatted.extensions });
    }
    throw new Error('expected a refusal');
  };
  const implicit = () => index({ agentRef: undefined });
  const asRun = (agentId: string, fn: () => Promise<any>) =>
    requestActorStorage.run({ workerId: null, agentId }, fn);

  it.each(['worker', 'run'])('refuses an outside implicit %s Agent byte-identically to its named URN', async (kind) => {
    const outside = await agent('Outside Asking');
    const wrap = kind === 'worker' ? asWorker : asRun;
    const named = await wireRefusal(index({ agentRef: agentUrn(outside) }));
    expect(JSON.parse(named)).toMatchObject({ message: expect.stringContaining(agentUrn(outside)), extensions: { code: 'AGENT_NOT_FOUND' } });
    expect(await wireRefusal(wrap(outside.id, implicit))).toBe(named);
  });

  it.each(['worker', 'run'])('allows the implicit %s Agent when installed or cast-only', async (kind) => {
    const wrap = kind === 'worker' ? asWorker : asRun;
    for (const a of [engineer, coder]) {
      expect(await wrap(a.id, implicit)).toEqual(await index({ agentRef: agentUrn(a) }));
      expect((await wrap(a.id, implicit)).total).toBe(4);
    }
  });

  it('refuses a retired-only implicit cast, but an installation still admits it', async () => {
    await db.worker.update({ where: { id: coderWorker.id }, data: { retiredAt: new Date() } });
    const outside = await agent('Outside Retired Control');
    const named = (await wireRefusal(index({ agentRef: agentUrn(outside) }))).replaceAll(agentUrn(outside), agentUrn(coder));
    expect(await wireRefusal(asRun(coder.id, implicit))).toBe(named);
    await db.appAgent.create({ data: { appId: app.id, agentId: coder.id } });
    expect((await asRun(coder.id, implicit)).total).toBe(4);
  });

  it('orders App admission before asking Agent, and asking Agent before Team/chain/memory reads', async () => {
    const outside = await agent('Outside Before Team');
    const reads: string[] = [];
    const counted = db.$extends({ query: { $allModels: { async $allOperations({ model, operation, args, query }) {
      reads.push(`${model}.${operation}`);
      return query(args);
    } } } });
    const c = ctx(admin.id, counted);
    const call = (appRef: string) => asRun(outside.id, () => index({ appRef, agentRef: undefined }, c));
    const missingApp = JSON.parse(await wireRefusal(call(generateId())));
    expect(missingApp.extensions.code).toBe('APP_NOT_FOUND');
    expect(reads.some((r) => /^(Agent|Memory|Node)\./.test(r))).toBe(false);
    reads.length = 0;
    await db.node.updateMany({ where: { memoryId: team.memoryId, loc: 'roles' }, data: { deletedAt: new Date() } });
    expect(JSON.parse(await wireRefusal(call(app.id))).extensions.code).toBe('AGENT_NOT_FOUND');
    expect(reads.filter((r) => r.startsWith('Agent.'))).toHaveLength(1);
    expect(reads.some((r) => /^(Memory|Node)\./.test(r))).toBe(false);
  });
});

describe('#3287 Team Agent and App gate (acceptance 6, 7)', () => {
  it('two Team Agents give the same empty page as none', async () => {
    const none = await noTeamAnswer();
    const second = await agent('Second Team'); await node(second.memoryId, 'roles');
    await db.appAgent.create({ data: { appId: app.id, agentId: second.id } });
    expect(JSON.stringify(await index())).toBe(none);
    expect(JSON.parse(none)).toEqual({ entries: [], total: 0, hasMore: false });
  });

  it('an unknown, foreign or non-participant App is refused byte-identically', async () => {
    const shape = async (appRef: string, userId = admin.id) =>
      (await refusal(index({ appRef }, ctx(userId)))).replaceAll(appRef, '<ref>');
    const base = await shape(generateId());
    const foreignApp = await db.app.create({ data: { id: generateId(), organizationId: foreignOrg.id, name: 'F', urn: `${foreignOrg.urn}:f` } });
    expect(await shape(foreignApp.id)).toBe(base);
    expect(await shape(app.id, outsider.id)).toBe(base);
    expect(base).toContain('APP_NOT_FOUND');
  });
});

describe('#3287 bounds, no writes, SDL (acceptance 8, 9, 11)', () => {
  it('limit 0 is count-only; 200 and 201 both serve at most 200; offset pages', async () => {
    for (let i = 0; i < 205; i++) await entry(team.memoryId, `p.${String(i).padStart(3, '0')}`, 'tasks:alpha');
    const zero = await index({ limit: 0 });
    expect(zero).toEqual({ entries: [], total: 209, hasMore: true });
    const two = await index({ limit: 200 }), over = await index({ limit: 201 });
    expect(two.entries).toHaveLength(200); expect(JSON.stringify(over)).toBe(JSON.stringify(two));
    expect(two.hasMore).toBe(true);
    const tail = await index({ limit: 200, offset: 200 });
    expect(tail.entries).toHaveLength(9); expect(tail.hasMore).toBe(false);
    expect((await index()).entries).toHaveLength(20);
  }, 60000);

  function counted() {
    let n = 0;
    const bump = async ({ args, query }: any) => { n++; return query(args); };
    const spy = db.$extends({ query: { $allOperations: bump, $queryRaw: bump, $queryRawUnsafe: bump } as any });
    return { c: ctx(admin.id, spy), count: () => n };
  }
  async function queriesFor(codes: number, depth: number) {
    // Team chain of `depth` extra bases; asking chain the same depth. Each base holds entries and tasks.
    let parent = teamBase.id, asking = engineer.id;
    for (let d = 1; d < depth; d++) {
      const tb = await agent(`TB${codes}-${d}`); await db.agent.update({ where: { id: parent }, data: { extendsAgentId: tb.id } }); parent = tb.id;
      const ab = await agent(`AB${codes}-${d}`); await db.agent.update({ where: { id: asking }, data: { extendsAgentId: ab.id } }); asking = ab.id;
      await entry(tb.memoryId, `deep${codes}x${depth}.${d}`, `tasks:deep-${codes}x${depth}-${d}`); await task(ab.memoryId, `tasks:deep-${codes}x${depth}-${d}`);
    }
    for (let i = 0; i < codes; i++) { await entry(team.memoryId, `n${codes}x${depth}.${i}`, `tasks:n-${codes}x${depth}-${i}`); await task(engineer.memoryId, `tasks:n-${codes}x${depth}-${i}`); }
    const { c, count } = counted();
    const r = await index({ limit: 200 }, c);
    expect(r.entries.filter((e: any) => e.code.startsWith(`n${codes}x${depth}.`) && e.state === 'MAPPED')).toHaveLength(codes);
    expect(r.entries.filter((e: any) => e.code.startsWith(`deep${codes}x${depth}.`) && e.state === 'MAPPED')).toHaveLength(depth - 1);
    return count();
  }
  it('the query count is flat from 3 to 30 codes and from depth 1 to depth 3', async () => {
    const small = await queriesFor(3, 1);
    const many = await queriesFor(30, 1);
    expect(many).toBe(small);
    const deep = await queriesFor(3, 3);
    expect(deep).toBe(small);
    expect(small).toBeLessThanOrEqual(60); // 49 at the build head: mostly the shared memory-access gate's fixed reads
  }, 60000);

  it('a read writes nothing', async () => {
    const before = [await db.node.count(), await db.edge.count(), await db.agentTeamEvent.count()];
    await index(); await index({ agentRef: engineer.id, taskLoc: 'tasks:alpha' });
    expect([await db.node.count(), await db.edge.count(), await db.agentTeamEvent.count()]).toEqual(before);
  });

  it('the SDL documents the field with its citations, states and refusals', () => {
    const doc = typeDefs.slice(Math.max(0, typeDefs.indexOf('actionRegisterIndex(') - 3000), typeDefs.indexOf('actionRegisterIndex(') + 200);
    for (const s of ['hrn:node:hadronmemory.com:specs:cor:agt:110:03', 'hrn:node:hadronmemory.com:specs:cor:agt:110:04', '0101', '0102', '0106', '0107', 'MAPPED', 'UNRESOLVED', 'UNMAPPED', 'BAD_USER_INPUT', 'APP_NOT_FOUND'])
      expect(doc).toContain(s);
    expect(typeDefs).toMatch(/enum ActionRegisterIndexState \{\s*MAPPED\s*UNRESOLVED\s*UNMAPPED\s*\}/);
  });
});

// #3319 (follow-up pins from #3312's review; behavior unchanged): the task-side inheritance
// exclusion and the two soft-delete filters, each killed by its own mutant at the call site.
describe('#3319 task-side inheritance and soft-delete pins', () => {
  it('a base boot-prompt task is not inherited: the farther eligible task is MAPPED; the own memory serves the same role', async () => {
    // Asking chain: Coder -> Engineer -> EngBase. The nearer base (Engineer) holds the excluded role.
    const engBase = await agent('Eng Base');
    await db.agent.update({ where: { id: engineer.id }, data: { extendsAgentId: engBase.id } });
    await entry(teamBase.memoryId, 'p.boot', 'tasks:p');
    await task(engineer.memoryId, 'tasks:p', { role: 'boot-prompt' });     // nearer, not inheritable
    await task(engBase.memoryId, 'tasks:p');                               // farther, eligible
    const r = await index({ code: 'p.boot' });
    expect(r.entries).toEqual([expect.objectContaining({ code: 'p.boot', state: 'MAPPED', taskUrn: `hrn:node:${await memUrn(engBase.memoryId)}:tasks:p` })]);

    // The asking Agent's OWN memory serves anything, the excluded role included.
    await entry(teamBase.memoryId, 'q.own', 'tasks:q');
    await task(coder.memoryId, 'tasks:q', { role: 'boot-prompt' });
    const own = await index({ code: 'q.own' });
    expect(own.entries).toEqual([expect.objectContaining({ code: 'q.own', state: 'MAPPED', taskUrn: `hrn:node:${await memUrn(coder.memoryId)}:tasks:q` })]);
  });

  it('a soft-deleted nearer task is absent, not non-runnable: the base task is MAPPED (not UNRESOLVED, not the deleted node)', async () => {
    await db.node.updateMany({ where: { memoryId: coder.memoryId, loc: 'tasks:alpha' }, data: { deletedAt: new Date() } });
    const r = await index({ code: 'a.base' });
    expect(r.entries).toEqual([expect.objectContaining({ code: 'a.base', state: 'MAPPED', taskUrn: `hrn:node:${await memUrn(engineer.memoryId)}:tasks:alpha` })]);
  });

  it('a soft-deleted entry in the Team Agent own memory is absent: unlisted with no other entry, the base entry shows through otherwise', async () => {
    const only = await entry(team.memoryId, 'e.only', 'tasks:alpha');
    expect((await index()).total).toBe(5);
    await db.node.update({ where: { id: only.id }, data: { deletedAt: new Date() } });
    const gone = await index();
    expect(gone.total).toBe(4);
    expect(gone.entries.map((e: any) => e.code)).not.toContain('e.only');

    // b.over is defined in Team over TeamBase's tasks:base-b; deleting Team's entry reveals the base's.
    await db.node.updateMany({ where: { memoryId: team.memoryId, loc: 'register:b.over' }, data: { deletedAt: new Date() } });
    const shown = await index({ code: 'b.over' });
    expect(shown.entries).toEqual([expect.objectContaining({
      code: 'b.over', state: 'MAPPED', definedBy: agentUrn(teamBase), taskLoc: 'tasks:base-b',
      entryUrn: `hrn:node:${await memUrn(teamBase.memoryId)}:register:b.over`,
      taskUrn: `hrn:node:${await memUrn(engineer.memoryId)}:tasks:base-b`,
    })]);
  });
});
