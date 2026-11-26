import { WORKER_SIGNATURE_DEFAULTS } from '../../../lib/workerSignature.js';
/**
 * #5259 (V1 of #5209) — the platform's own record of each host of a team App (`AgentTeamHost`), joining a machine as a
 * host (`joinAgentTeamHost`: the record, a key, `host:operate` and `attention:deliver`, the raw key once), its settings
 * (`updateAgentTeamHost`), removing it (`removeAgentTeamHost`: keys revoked, registration ended, assignments removed,
 * open operations failed), the two reads, and the doors that now need a live host (`assignHostWorker`,
 * `grantAppKeyScope(host:operate)`).
 *
 * Specs (all Proposed by SP1 on #5259): hrn:node:hadronmemory.com:specs:cor:agt:070:01 (the host and its settings),
 * hrn:node:hadronmemory.com:specs:cor:agt:070:02 (removal fails the host's open operations),
 * hrn:node:hadronmemory.com:specs:cor:agt:070:04 (a host key reads its own record), hrn:node:hadronmemory.com:specs:cor:agt:070:07
 * (joining is issuing the host's key, removing revokes it; a person who manages the App, as themselves).
 * Gate decisions Q1-Q7 and builder's notes N1-N3: the CHECKED verdict on #5259.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { GraphQLError } from 'graphql';
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { Client } from 'pg';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { runAsActor } from '../../../lib/requestActor.js';
import { APP_KEY_PREFIX, hashAppKey } from '../../../middleware/auth.js';
import { resolvers, type Context } from './resolvers.js';
import { loadLaunchableFamilies } from '../../../lib/agentTasks/hosts.js';

vi.mock('../../../integrations/github/writeNodeToGit.js', () => ({ writeNodeToGit: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../../../lib/bus/index.js', () => ({ getBusClient: vi.fn(async () => null) }));

const M = resolvers.Mutation as any;
const Q = resolvers.Query as any;

const ctx = (userId?: string, extra: Partial<Context> = {}): Context => ({ db, userId, roles: ['READER'], ...extra }) as Context;
async function refusal(p: Promise<unknown>): Promise<{ code?: string; message?: string; extensions?: Record<string, unknown> }> {
  try {
    await p;
  } catch (e) {
    expect(e).toBeInstanceOf(GraphQLError);
    const g = e as GraphQLError;
    return { code: g.extensions?.code as string, message: g.message, extensions: g.extensions as Record<string, unknown> };
  }
  return {};
}
const code = async (p: Promise<unknown>) => (await refusal(p)).code;

let org: { id: string; urn: string };
let app: { id: string; urn: string };
let agentId: string;
let manager: { id: string };
let holder: { id: string };
let member: { id: string };
let kit: { id: string };

const keyCtx = (keyId: string, appId = app.id): Context => ({ db, appId, appKeyId: keyId, organizationId: org.id, roles: [] }) as Context;
const asWorker = <T>(w: { id: string }, fn: () => Promise<T>): Promise<T> => runAsActor({ workerId: w.id, agentId }, fn);
async function mkKey(appId: string, label: string) {
  const raw = `${APP_KEY_PREFIX}${randomBytes(32).toString('hex')}`;
  return db.appKey.create({ data: { id: generateId(), appId, keyHash: hashAppKey(raw), keyPreview: raw.slice(-4), label }, select: { id: true } });
}

const join = (input: Record<string, unknown>, c: Context = ctx(manager.id)) =>
  M.joinAgentTeamHost({}, { input: { appRef: app.id, ...input } }, c);
const update = (input: Record<string, unknown>, c: Context = ctx(manager.id), instruction?: unknown) =>
  M.updateAgentTeamHost({}, { input: { appRef: app.id, ...input }, ...(instruction ? { instruction } : {}) }, c);
const remove = (input: Record<string, unknown>, c: Context = ctx(manager.id)) =>
  M.removeAgentTeamHost({}, { input: { appRef: app.id, ...input } }, c);
const hosts = (c: Context) => Q.agentTeamHosts({}, { appRef: app.id }, c);
const host = (hostId: string, c: Context) => Q.agentTeamHost({}, { appRef: app.id, hostId }, c);
/** The key id a raw key maps to (the join's response carries the raw key and the host, never the key row). */
const keyIdOf = async (rawKey: string) => (await db.appKey.findUniqueOrThrow({ where: { keyHash: hashAppKey(rawKey) }, select: { id: true } })).id;
/** A worker.start of Kit on `hostId`, with the hold that authorized it (chk_host_operations_hold). */
const startOp = (hostId: string, over: Record<string, unknown> = {}) => db.hostOperation.create({ data: {
  id: generateId(), appId: app.id, hostId, type: 'worker.start', args: { workerId: kit.id, worktree: 'hadron-server/kit', family: 'claude' },
  workerId: kit.id, issuedBy: 'platform', holdUserId: holder.id, holdAt: new Date(), ...over,
} });
/** A session of Kit launched on `hostId` by a start that succeeded (chk_sessions_launch names all three launch columns). */
async function launchedSession(hostId: string, over: Record<string, unknown> = {}) {
  const op = await startOp(hostId, { status: 'succeeded', finishedAt: new Date() });
  return db.session.create({ data: { id: generateId(), appId: app.id, agentId, workerId: kit.id, userId: holder.id, tool: 'vitest',
    launchHostId: hostId, launchOperationId: op.id, launchIssuedBy: 'platform', ...over } });
}
const register = (keyId: string, workers: unknown[] = []) =>
  M.registerHost({}, { input: { appRef: app.id, label: 'Mac', pollIntervalSeconds: 600, workers } }, keyCtx(keyId));

beforeEach(async () => {
  await cleanDb(db);
  const n = Math.floor(Math.random() * 1_000_000);
  org = await db.organization.create({ data: { name: 'Hosts', urn: `teamhost-${n}.example` }, select: { id: true, urn: true } });
  const u = (k: number, name: string) =>
    db.user.create({ data: { githubId: k * 1_000_000 + n, githubUsername: `th-${name}-${n}`, roles: ['READER'] }, select: { id: true } });
  manager = await u(91, 'manager');
  holder = await u(92, 'holder');
  member = await u(93, 'member');
  await db.orgMember.create({ data: { organizationId: org.id, userId: manager.id, role: 'ADMIN' } });
  const agent = await M.createAgent({}, { orgRef: org.id, name: 'Team Agent' }, ctx(manager.id));
  agentId = agent.id;
  app = await db.app.create({ data: { organizationId: org.id, name: 'Team', urn: `${org.urn}:team` }, select: { id: true, urn: true } });
  for (const id of [holder.id, member.id]) await db.appMember.create({ data: { appId: app.id, userId: id, role: 'member' } });
  kit = await db.worker.create({ data: { ...WORKER_SIGNATURE_DEFAULTS, appId: app.id, agentId, name: 'Kit', slug: 'kit', heldByUserId: holder.id, heldAt: new Date() }, select: { id: true } });
});

describe('the record and its invariants file', () => {
  it('the migration carries a byte-identical copy of the invariants file and post-push includes it', () => {
    const source = readFileSync(new URL('../../../../prisma/agent-team-host-invariants.sql', import.meta.url), 'utf8');
    const migration = readFileSync(new URL('../../../../prisma/migrations/20261126160000_agent_team_hosts/migration.sql', import.meta.url), 'utf8');
    expect(migration.endsWith(`\n${source}`)).toBe(true);
    expect(readFileSync(new URL('../../../../prisma/post-push.sql', import.meta.url), 'utf8')).toContain('\\ir agent-team-host-invariants.sql');
  });

  it('the database refuses a host id that is not a token, an empty or long label, an interval out of range, and half a removal', async () => {
    const base = { id: generateId(), appId: app.id, hostId: 'mac1', label: 'Mac' };
    for (const bad of [{ hostId: '../mac' }, { label: '' }, { label: 'x'.repeat(129) }, { pollIntervalSeconds: 0 }, { pollIntervalSeconds: 86_401 },
      { removedAt: new Date() }, { removedByUserId: manager.id }]) {
      await expect(db.agentTeamHost.create({ data: { ...base, id: generateId(), ...bad } })).rejects.toThrow();
    }
    await db.agentTeamHost.create({ data: { ...base, pollIntervalSeconds: 86_400 } });
  });
});

describe('joinAgentTeamHost: the record, a key and its two scopes, the raw key once (A1)', () => {
  it('a manager joins mac1: the row, a key that registers as mac1, collects, and reads its own row', async () => {
    const out = await join({ hostId: 'mac1', label: 'Studio Mac' });
    expect(out.rawKey).toMatch(/^hdr_app_[0-9a-f]{64}$/);
    expect(out.host).toMatchObject({ hostId: 'mac1', label: 'Studio Mac', pollIntervalSeconds: null, deliveryEnabled: null });
    const row = await db.agentTeamHost.findUniqueOrThrow({ where: { appId_hostId: { appId: app.id, hostId: 'mac1' } } });
    expect(row).toMatchObject({ createdByUserId: manager.id, removedAt: null });
    const keyId = await keyIdOf(out.rawKey);
    const scopes = await db.appKeyScope.findMany({ where: { appKeyId: keyId, revokedAt: null }, orderBy: { scope: 'asc' } });
    expect(scopes.map((s) => [s.scope, s.hostId, s.grantedByUserId])).toEqual([
      ['attention:deliver', null, manager.id], ['host:operate', 'mac1', manager.id],
    ]);
    const reg = await register(keyId);
    expect(reg).toMatchObject({ hostId: 'mac1' });
    expect(await M.collectHostOperations({}, { appRef: app.id }, keyCtx(keyId))).toEqual([]);
    expect(await host('mac1', keyCtx(keyId))).toMatchObject({ hostId: 'mac1', label: 'Studio Mac' });
    expect((await hosts(keyCtx(keyId))).map((h: any) => h.hostId)).toEqual(['mac1']);
  });

  it('the host id defaults to a slug of the label, and the label to the host id', async () => {
    expect((await join({ label: '  Studio Mac #2 ' })).host).toMatchObject({ hostId: 'studio-mac-2', label: 'Studio Mac #2' });
    expect((await join({ hostId: 'orca1' })).host).toMatchObject({ hostId: 'orca1', label: 'orca1' });
  });

  it('BAD_AGENT_TEAM_HOST_ARGS for a host id that is not a token, a label out of range, or neither given, writing nothing', async () => {
    for (const input of [{ hostId: '../x' }, { hostId: 'mac1', label: 'x'.repeat(129) }, {}, { label: '###' }, { hostId: 'mac1', label: '   ' }]) {
      const r = await refusal(join(input));
      expect(r.code).toBe('BAD_AGENT_TEAM_HOST_ARGS');
    }
    expect(await db.agentTeamHost.count()).toBe(0);
    expect(await db.appKey.count({ where: { appId: app.id } })).toBe(0);
  });
});

describe('who may join: exactly createAppKey\'s gate (A2, Q1)', () => {
  it('a participant who does not manage the App gets createAppKey\'s refusal, byte for byte, and nothing is written', async () => {
    const want = await refusal(M.createAppKey({}, { appRef: app.id, label: 'x' }, ctx(member.id)));
    expect(want.code).toBe('FORBIDDEN');
    expect(await refusal(join({ hostId: 'mac1' }, ctx(member.id)))).toEqual(want);
    expect(await db.agentTeamHost.count()).toBe(0);
  });

  it('a bound worker (its holder managing the App) and an App key are refused alike', async () => {
    const boss = await db.worker.create({ data: { ...WORKER_SIGNATURE_DEFAULTS, appId: app.id, agentId, name: 'Boss', slug: 'boss', heldByUserId: manager.id, heldAt: new Date() }, select: { id: true } });
    const s = await db.session.create({ data: { id: generateId(), appId: app.id, agentId, workerId: boss.id, userId: manager.id, tool: 'vitest' }, select: { id: true } });
    const want = await refusal(M.createAppKey({}, { appRef: app.id }, ctx(member.id)));
    expect(await refusal(asWorker(boss, () => join({ hostId: 'mac1' }, ctx(manager.id, { sessionId: s.id }))))).toEqual(want);
    const k = await mkKey(app.id, 'plain');
    expect(await code(join({ hostId: 'mac1' }, keyCtx(k.id)))).toBe('FORBIDDEN');
    expect(await db.agentTeamHost.count()).toBe(0);
  });
});

describe('joining an existing host (A3, Q6, N2)', () => {
  it('AGENT_TEAM_HOST_EXISTS without replace; with replace the old key stops working at its next call, and one live key remains', async () => {
    const first = await join({ hostId: 'mac1' });
    const old = await keyIdOf(first.rawKey);
    const r = await refusal(join({ hostId: 'mac1' }));
    expect(r.code).toBe('AGENT_TEAM_HOST_EXISTS');
    expect(r.message).not.toContain('mac1');
    const second = await join({ hostId: 'mac1', replace: true });
    expect(second.rawKey).not.toBe(first.rawKey);
    expect(await code(register(old))).toBe('APP_KEY_SCOPE_REQUIRED');
    await register(await keyIdOf(second.rawKey));
    const live = await db.appKeyScope.count({ where: { scope: 'host:operate', hostId: 'mac1', revokedAt: null, appKey: { revokedAt: null } } });
    expect(live).toBe(1);
  });

  it('a joined host whose keys were all revoked by hand is still AGENT_TEAM_HOST_EXISTS without replace', async () => {
    const keyId = await keyIdOf((await join({ hostId: 'mac1' })).rawKey);
    await M.revokeAppKey({}, { id: keyId }, ctx(manager.id));
    expect(await code(join({ hostId: 'mac1' }))).toBe('AGENT_TEAM_HOST_EXISTS');
    await join({ hostId: 'mac1', replace: true });
  });

  it('N2: a live host key with no record (a rollout or rollback) answers AGENT_TEAM_HOST_EXISTS; replace revokes it', async () => {
    const stray = await mkKey(app.id, 'stray');
    await db.appKeyScope.create({ data: { id: generateId(), appKeyId: stray.id, scope: 'host:operate', hostId: 'mac1', grantedByUserId: manager.id } });
    expect(await code(join({ hostId: 'mac1' }))).toBe('AGENT_TEAM_HOST_EXISTS');
    expect(await db.agentTeamHost.count()).toBe(0);
    await join({ hostId: 'mac1', replace: true });
    expect((await db.appKey.findUniqueOrThrow({ where: { id: stray.id } })).revokedAt).not.toBeNull();
  });

  it('Q6: joining a removed host revives its row (label from the input, settings reset, the joiner its creator), no replace needed', async () => {
    await join({ hostId: 'mac1', label: 'Old' });
    await update({ hostId: 'mac1', pollIntervalSeconds: 30, deliveryEnabled: false });
    await remove({ hostId: 'mac1' });
    await db.appMember.update({ where: { appId_userId: { appId: app.id, userId: holder.id } }, data: { role: 'owner' } });
    const back = await join({ hostId: 'mac1', label: 'New' }, ctx(holder.id));
    expect(back.host).toMatchObject({ hostId: 'mac1', label: 'New', pollIntervalSeconds: null, deliveryEnabled: null });
    expect(await db.agentTeamHost.findUniqueOrThrow({ where: { appId_hostId: { appId: app.id, hostId: 'mac1' } } }))
      .toMatchObject({ removedAt: null, removedByUserId: null, createdByUserId: holder.id });
    expect(await db.agentTeamHost.count()).toBe(1);
  });
});

describe('two concurrent joins of one host id (A4)', () => {
  it('give one row and one live key; the other is AGENT_TEAM_HOST_EXISTS', async () => {
    const results = await Promise.allSettled([join({ hostId: 'mac1' }), join({ hostId: 'mac1' })]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const lost = results.find((r) => r.status === 'rejected') as PromiseRejectedResult;
    expect((lost.reason as GraphQLError).extensions?.code).toBe('AGENT_TEAM_HOST_EXISTS');
    expect(await db.agentTeamHost.count()).toBe(1);
    expect(await db.appKey.count({ where: { appId: app.id, revokedAt: null } })).toBe(1);
  });

  it('two concurrent replaces leave exactly one live key', async () => {
    await join({ hostId: 'mac1' });
    await Promise.all([join({ hostId: 'mac1', replace: true }), join({ hostId: 'mac1', replace: true })]);
    expect(await db.appKey.count({ where: { appId: app.id, revokedAt: null } })).toBe(1);
  });
});

describe('the reads (A5, cor:agt:070:04)', () => {
  it('a participant reads the live hosts; a removed one is left out', async () => {
    await join({ hostId: 'mac1' });
    await join({ hostId: 'mac2' });
    await remove({ hostId: 'mac2' });
    expect((await hosts(ctx(member.id))).map((h: any) => h.hostId)).toEqual(['mac1']);
    expect(await code(host('mac2', ctx(member.id)))).toBe('HOST_NOT_FOUND');
  });

  it('a host key reading another host\'s row gets exactly the unknown host\'s answer, and every read is in its use record', async () => {
    const mine = await keyIdOf((await join({ hostId: 'mac1' })).rawKey);
    await join({ hostId: 'mac2' });
    const other = await refusal(host('mac2', keyCtx(mine)));
    const unknown = await refusal(host('nope', keyCtx(mine)));
    expect(other.code).toBe('HOST_NOT_FOUND');
    expect(other).toEqual(unknown);
    expect(JSON.stringify(other)).not.toContain('mac2');
    await host('mac1', keyCtx(mine));
    expect((await hosts(keyCtx(mine))).map((h: any) => h.hostId)).toEqual(['mac1']);
    const uses = await db.hostKeyUse.findMany({ where: { appKeyId: mine, action: 'read' }, orderBy: { usedAt: 'asc' } });
    expect(uses.map((u) => [u.hostId, u.refusedCode])).toEqual([['mac1', 'HOST_NOT_FOUND'], ['mac1', 'HOST_NOT_FOUND'], ['mac1', null], ['mac1', null]]);
  });

  it('the not-found read\'s use record is its own write after the rollback, not inside the read', async () => {
    const mine = await keyIdOf((await join({ hostId: 'mac1' })).rawKey);
    const order: string[] = [];
    const real = db.hostKeyUse.create.bind(db.hostKeyUse);
    const spy = vi.spyOn(db.hostKeyUse, 'create').mockImplementation(((args: any) => { order.push('use'); return real(args); }) as any);
    try {
      expect(await code(host('mac2', keyCtx(mine)))).toBe('HOST_NOT_FOUND');
    } finally {
      spy.mockRestore();
    }
    // Written through the root client (the call's own write), never through a transaction client of the read: a use
    // written inside the read's transaction would not reach this spy, and would be rolled back with the refusal.
    expect(order).toEqual(['use']);
    expect(await db.hostKeyUse.count({ where: { appKeyId: mine, refusedCode: 'HOST_NOT_FOUND' } })).toBe(1);
  });
});

describe('updateAgentTeamHost: settings, not keys', () => {
  it('omitted keeps, null clears to the default; label cannot be cleared', async () => {
    await join({ hostId: 'mac1', label: 'Mac' });
    expect(await update({ hostId: 'mac1', pollIntervalSeconds: 30, deliveryEnabled: false })).toMatchObject({ label: 'Mac', pollIntervalSeconds: 30, deliveryEnabled: false });
    expect(await update({ hostId: 'mac1', label: 'Studio' })).toMatchObject({ label: 'Studio', pollIntervalSeconds: 30, deliveryEnabled: false });
    expect(await update({ hostId: 'mac1', pollIntervalSeconds: null })).toMatchObject({ pollIntervalSeconds: null, deliveryEnabled: false });
    expect(await code(update({ hostId: 'mac1', label: null }))).toBe('BAD_AGENT_TEAM_HOST_ARGS');
    expect(await code(update({ hostId: 'mac1', pollIntervalSeconds: 0 }))).toBe('BAD_AGENT_TEAM_HOST_ARGS');
  });

  it('an App key and a non-manager: AGENT_TEAM_HOST_NOT_PERMITTED; a missing or removed host: HOST_NOT_FOUND', async () => {
    await join({ hostId: 'mac1' });
    const k = await mkKey(app.id, 'plain');
    expect(await code(update({ hostId: 'mac1', label: 'x' }, keyCtx(k.id)))).toBe('AGENT_TEAM_HOST_NOT_PERMITTED');
    expect(await code(update({ hostId: 'mac1', label: 'x' }, ctx(member.id)))).toBe('AGENT_TEAM_HOST_NOT_PERMITTED');
    expect(await code(update({ hostId: 'nope', label: 'x' }))).toBe('HOST_NOT_FOUND');
    await remove({ hostId: 'mac1' });
    expect(await code(update({ hostId: 'mac1', label: 'x' }))).toBe('HOST_NOT_FOUND');
  });

  it('a held worker on its holder\'s instruction is admitted, with one manager-act record', async () => {
    await join({ hostId: 'mac1' });
    const boss = await db.worker.create({ data: { ...WORKER_SIGNATURE_DEFAULTS, appId: app.id, agentId, name: 'Boss', slug: 'boss', heldByUserId: manager.id, heldAt: new Date() }, select: { id: true } });
    const s = await db.session.create({ data: { id: generateId(), appId: app.id, agentId, workerId: boss.id, userId: manager.id, tool: 'vitest' }, select: { id: true } });
    const live = { kind: 'LIVE_CHAT', ref: 'client-chat:turn-5259' };
    expect(await asWorker(boss, () => update({ hostId: 'mac1', label: 'By Boss' }, ctx(manager.id, { sessionId: s.id }), live))).toMatchObject({ label: 'By Boss' });
    const acts = await db.agentTeamEvent.findMany({ where: { type: 'app.manager-act' } });
    expect(acts.map((a) => (a.payload as any).act)).toEqual(['agent-team-host.update']);
  });
});

describe('removeAgentTeamHost: person-only (A6), and what it ends (A7, A8)', () => {
  it('a held worker on an instruction, an App key and a non-manager are refused as a refused join is; a manager removes', async () => {
    await join({ hostId: 'mac1' });
    const want = await refusal(join({ hostId: 'mac9' }, ctx(member.id)));
    const boss = await db.worker.create({ data: { ...WORKER_SIGNATURE_DEFAULTS, appId: app.id, agentId, name: 'Boss', slug: 'boss', heldByUserId: manager.id, heldAt: new Date() }, select: { id: true } });
    const s = await db.session.create({ data: { id: generateId(), appId: app.id, agentId, workerId: boss.id, userId: manager.id, tool: 'vitest' }, select: { id: true } });
    expect(await refusal(asWorker(boss, () => remove({ hostId: 'mac1' }, ctx(manager.id, { sessionId: s.id }))))).toEqual(want);
    const k = await mkKey(app.id, 'plain');
    expect(await refusal(remove({ hostId: 'mac1' }, keyCtx(k.id)))).toEqual(want);
    expect(await refusal(remove({ hostId: 'mac1' }, ctx(member.id)))).toEqual(want);
    expect((await db.agentTeamHost.findFirstOrThrow()).removedAt).toBeNull();
    expect(await remove({ hostId: 'mac1' })).toBe(true);
    expect(await db.agentTeamHost.findFirstOrThrow()).toMatchObject({ removedByUserId: manager.id });
    expect(await code(remove({ hostId: 'mac1' }))).toBe('HOST_NOT_FOUND');
  });

  it('revokes the host\'s keys, removes its assignments and ends its registration (host.lost), in one act', async () => {
    const keyId = await keyIdOf((await join({ hostId: 'mac1' })).rawKey);
    await M.assignHostWorker({}, { input: { appRef: app.id, hostId: 'mac1', worker: 'Kit', workdir: 'hadron-server/kit', family: 'claude' } }, ctx(manager.id));
    await register(keyId, [{ worker: 'Kit', family: 'claude', worktrees: ['hadron-server/kit'] }]);
    await remove({ hostId: 'mac1' });
    expect((await db.appKey.findUniqueOrThrow({ where: { id: keyId } })).revokedAt).not.toBeNull();
    expect(await db.hostWorkerAssignment.count({ where: { hostId: 'mac1' } })).toBe(0);
    expect((await db.hostRegistration.findFirstOrThrow({ where: { hostId: 'mac1' } })).lostAt).not.toBeNull();
    const types = (await db.agentTeamEvent.findMany({ where: { appId: app.id, type: { startsWith: 'host.' } }, orderBy: { id: 'asc' } })).map((e) => e.type);
    expect(types).toEqual(expect.arrayContaining(['host.joined', 'host.lost', 'host.removed']));
    expect(await code(register(keyId))).toBe('APP_KEY_SCOPE_REQUIRED');
  });

  it('A7: a task assigned to the host\'s worker right after the removal issues no worker.start to it', async () => {
    const keyId = await keyIdOf((await join({ hostId: 'mac1' })).rawKey);
    await register(keyId, [{ worker: 'Kit', family: 'claude', worktrees: ['hadron-server/kit'] }]);
    await remove({ hostId: 'mac1' });
    // Each reader of launchability on its own: the matcher's (loadLaunchable) and the start's (liveRegistrationsFor).
    expect((await loadLaunchableFamilies(db, { appId: app.id }, new Date())).size).toBe(0);
    await M.createAgentTask({}, { input: { appRef: app.id, title: 'Work', assignee: { worker: kit.id }, closeSessionWhenDone: false } }, ctx(manager.id));
    expect(await db.hostOperation.count({ where: { hostId: 'mac1', type: 'worker.start' } })).toBe(0);
  });

  it('positive control for A7: before the removal the same worker is launchable through the host', async () => {
    const keyId = await keyIdOf((await join({ hostId: 'mac1' })).rawKey);
    await register(keyId, [{ worker: 'Kit', family: 'claude', worktrees: ['hadron-server/kit'] }]);
    expect((await loadLaunchableFamilies(db, { appId: app.id }, new Date())).get(kit.id)).toEqual(['claude']);
  });

  it('a removed host that joins again and registers with its new key is live and launchable again (registerHost clears lost_at)', async () => {
    const first = await keyIdOf((await join({ hostId: 'mac1' })).rawKey);
    await register(first, [{ worker: 'Kit', family: 'claude', worktrees: ['hadron-server/kit'] }]);
    await remove({ hostId: 'mac1' });
    const again = await keyIdOf((await join({ hostId: 'mac1' })).rawKey);
    // The removal revoked the old key and removed the assignment, so the rejoined host is assigned and registers afresh.
    await M.assignHostWorker({}, { input: { appRef: app.id, hostId: 'mac1', worker: 'Kit', workdir: 'hadron-server/kit', family: 'claude' } }, ctx(manager.id));
    expect((await loadLaunchableFamilies(db, { appId: app.id }, new Date())).size).toBe(0);
    await register(again, [{ worker: 'Kit', family: 'claude', worktrees: ['hadron-server/kit'] }]);
    expect((await db.hostRegistration.findFirstOrThrow({ where: { hostId: 'mac1' } })).lostAt).toBeNull();
    expect(await db.hostRegistration.count({ where: { hostId: 'mac1' } })).toBe(1);
    expect((await loadLaunchableFamilies(db, { appId: app.id }, new Date())).get(kit.id)).toEqual(['claude']);
  });

  it('A8 (N1): the host\'s issued and collected operations fail in the removal with a reason naming it; a start whose session bound reads succeeded', async () => {
    const keyId = await keyIdOf((await join({ hostId: 'mac1' })).rawKey);
    await register(keyId, [{ worker: 'Kit', family: 'claude', worktrees: ['hadron-server/kit'] }]);
    const op = (over: Record<string, unknown>) => db.hostOperation.create({ data: {
      id: generateId(), appId: app.id, hostId: 'mac1', type: 'worktree.create', args: { workerId: kit.id, repo: 'hadron-server', baseBranch: 'main', branchName: 'kit-5259', label: 'kit' },
      workerId: kit.id, issuedBy: 'platform', ...over,
    } });
    const issued = await op({});
    const collected = await op({ status: 'collected', collectedAt: new Date() });
    const done = await op({ status: 'succeeded', finishedAt: new Date() });
    const started = await startOp('mac1', { status: 'collected', collectedAt: new Date() });
    await db.session.create({ data: { id: generateId(), appId: app.id, agentId, workerId: kit.id, userId: holder.id, tool: 'vitest',
      launchHostId: 'mac1', launchOperationId: started.id, launchIssuedBy: 'platform' } });
    await remove({ hostId: 'mac1', force: true });
    const after = Object.fromEntries((await db.hostOperation.findMany()).map((o) => [o.id, o]));
    expect(after[issued.id]).toMatchObject({ status: 'failed' });
    expect(after[collected.id]).toMatchObject({ status: 'failed' });
    expect(after[issued.id]!.failureReason).toMatch(/^HOST_REMOVED\b/);
    expect(after[collected.id]!.failureReason).toMatch(/^HOST_REMOVED\b/);
    expect(after[done.id]).toMatchObject({ status: 'succeeded', failureReason: null });
    expect(after[started.id]).toMatchObject({ status: 'succeeded' });
  });

  it('refused while a worker of that host has an open session, unless forced (Q4: sessionRunsOn\'s rule)', async () => {
    const keyId = await keyIdOf((await join({ hostId: 'mac1' })).rawKey);
    await register(keyId, [{ worker: 'Kit', family: 'claude', worktrees: ['hadron-server/kit'] }]);
    await launchedSession('mac1');
    const r = await refusal(remove({ hostId: 'mac1' }));
    expect(r.code).toBe('AGENT_TEAM_HOST_HAS_OPEN_SESSIONS');
    expect(r.message).not.toContain('mac1');
    expect((await db.agentTeamHost.findFirstOrThrow()).removedAt).toBeNull();
    expect((await db.appKey.findUniqueOrThrow({ where: { id: keyId } })).revokedAt).toBeNull();
    expect(await remove({ hostId: 'mac1', force: true })).toBe(true);
  });

  it('a session launched on another host, or ended, does not hold the removal', async () => {
    const keyId = await keyIdOf((await join({ hostId: 'mac1' })).rawKey);
    await register(keyId, [{ worker: 'Kit', family: 'claude', worktrees: ['hadron-server/kit'] }]);
    await launchedSession('mac2');
    await launchedSession('mac1', { endedAt: new Date() });
    expect(await remove({ hostId: 'mac1' })).toBe(true);
  });
});

describe('the doors that now need a live host (HOST_NOT_FOUND)', () => {
  const assign = (hostId: string) =>
    M.assignHostWorker({}, { input: { appRef: app.id, hostId, worker: 'Kit', workdir: 'hadron-server/kit', family: 'claude' } }, ctx(manager.id));
  it('assignHostWorker refuses a host with no live record, and admits a joined one', async () => {
    expect(await code(assign('mac1'))).toBe('HOST_NOT_FOUND');
    await join({ hostId: 'mac1' });
    await assign('mac1');
    await remove({ hostId: 'mac1' });
    expect(await code(assign('mac1'))).toBe('HOST_NOT_FOUND');
  });

  it('grantAppKeyScope(host:operate) refuses a host with no live record, and admits a joined one; attention:deliver needs none', async () => {
    const k = await mkKey(app.id, 'k');
    const grant = (scope: string, hostId?: string) => M.grantAppKeyScope({}, { id: k.id, scope, ...(hostId ? { hostId } : {}) }, ctx(manager.id));
    const r = await refusal(grant('host:operate', 'mac1'));
    expect(r.code).toBe('HOST_NOT_FOUND');
    expect(r.message).not.toContain('mac1');
    await grant('attention:deliver');
    await join({ hostId: 'mac1' });
    await grant('host:operate', 'mac1');
  });
});

describe('the raw key (A10)', () => {
  it('appears in no log line, no event, no use record and no other response than the join\'s', async () => {
    const lines: string[] = [];
    const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((m) =>
      vi.spyOn(console, m).mockImplementation((...a: unknown[]) => { lines.push(a.map(String).join(' ')); }));
    let raw = '';
    try {
      raw = (await join({ hostId: 'mac1' })).rawKey;
      await join({ hostId: 'mac1', replace: true });
      await host('mac1', ctx(member.id));
    } finally {
      for (const s of spies) s.mockRestore();
    }
    expect(lines.join('\n')).not.toContain('hdr_app_');
    const events = await db.agentTeamEvent.findMany({ where: { appId: app.id } });
    expect(JSON.stringify(events)).not.toContain('hdr_app_');
    expect(JSON.stringify(await db.agentTeamHost.findMany())).not.toContain(raw.slice(8));
    expect(JSON.stringify(await hosts(ctx(member.id)))).not.toContain('hdr_app_');
  });
});

describe('removal ends the registration for every reader of liveness', () => {
  it('the registration listing reads the removed host as not live, inside its refresh window', async () => {
    const keyId = await keyIdOf((await join({ hostId: 'mac1' })).rawKey);
    await register(keyId);
    expect((await Q.hostRegistrations({}, { appRef: app.id }, ctx(manager.id))).map((r: any) => [r.hostId, r.live])).toEqual([['mac1', true]]);
    await remove({ hostId: 'mac1' });
    expect((await Q.hostRegistrations({}, { appRef: app.id }, ctx(manager.id))).map((r: any) => [r.hostId, r.live])).toEqual([['mac1', false]]);
  });
});

describe('the guarded insert, without the doors\' locks (findings: resolver-race-pin-can-miss-the-consume-guard)', () => {
  it('a writer that meets an uncommitted insert of the same host waits for it, then locks that row: one row, created once', async () => {
    const { insertOrLockTeamHost } = await import('../../../lib/hostOperations/teamHosts.js');
    const first = new Client({ connectionString: process.env.DATABASE_URL });
    const probe = new Client({ connectionString: process.env.DATABASE_URL });
    await first.connect();
    await probe.connect();
    try {
      await first.query('BEGIN');
      await first.query(`INSERT INTO agent_team_hosts (id, app_id, host_id, label, created_by_user_id) VALUES ($1, $2, 'mac1', 'First', $3)`, [generateId(), app.id, manager.id]);
      const pids: number[] = [];
      // The second writer cannot see the uncommitted row; it must wait on it rather than insert a second, or fail.
      const second = db.$transaction(async (tx) => {
        const [{ pid }] = await tx.$queryRaw<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`;
        pids.push(pid);
        return insertOrLockTeamHost(tx, { appId: app.id, hostId: 'mac1', label: 'Second', createdByUserId: holder.id, now: new Date() });
      });
      for (let i = 0; i < 400; i++) {
        if (pids.length && (await probe.query('SELECT 1 FROM pg_locks WHERE pid = $1 AND NOT granted', [pids[0]])).rowCount) break;
        await new Promise((r) => setTimeout(r, 25));
        if (i === 399) throw new Error('the second writer never waited');
      }
      await first.query('COMMIT');
      const r = await second;
      expect(r.created).toBe(false);
      expect(r.row.label).toBe('First');
      expect(await db.agentTeamHost.count()).toBe(1);
    } finally {
      await first.query('ROLLBACK').catch(() => undefined);
      await first.end();
      await probe.end();
    }
  });
});

describe('the backfill (A9; gate decisions Q2 and Q6)', () => {
  const migration = () => readFileSync(new URL('../../../../prisma/migrations/20261126160000_agent_team_hosts/migration.sql', import.meta.url), 'utf8');
  const backfill = () => {
    const sql = migration();
    const start = sql.indexOf('WITH sources AS');
    const end = sql.indexOf('ON CONFLICT (app_id, host_id) DO NOTHING;', start) + 'ON CONFLICT (app_id, host_id) DO NOTHING'.length;
    expect(start).toBeGreaterThan(0);
    return db.$executeRawUnsafe(sql.slice(start, end));
  };
  const scope = (keyId: string, hostId: string, over: Record<string, unknown> = {}) =>
    db.appKeyScope.create({ data: { id: generateId(), appKeyId: keyId, scope: 'host:operate', hostId, grantedByUserId: manager.id, ...over } });

  it('one row per (App, host) from live scopes on live keys, registrations and assignments; revoked-only pairs get none', async () => {
    const live = await mkKey(app.id, 'live');
    await scope(live.id, 'h-scope');
    const both = await mkKey(app.id, 'both');
    await scope(both.id, 'h-both', { grantedAt: new Date(Date.now() - 60_000) });
    const revokedScope = await mkKey(app.id, 'rs');
    await scope(revokedScope.id, 'h-revoked', { revokedAt: new Date(), revokedByUserId: manager.id });
    const revokedKey = await db.appKey.update({ where: { id: (await mkKey(app.id, 'rk')).id }, data: { revokedAt: new Date() } });
    await scope(revokedKey.id, 'h-revkey');
    const reg = (hostId: string, label: string, poll: number) => db.hostRegistration.create({ data: { appId: app.id, hostId, label, pollIntervalSeconds: poll, refreshedAt: new Date() } });
    await reg('h-reg', 'Reg Label', 300);
    await reg('h-both', 'Both Label', 120);
    await db.hostWorkerAssignment.create({ data: { id: generateId(), appId: app.id, hostId: 'h-assign', workerId: kit.id, workdir: 'hadron-server/kit', family: 'claude', createdByUserId: holder.id } });
    expect(await backfill()).toBe(4);
    const rows = await db.agentTeamHost.findMany({ orderBy: { hostId: 'asc' } });
    expect(rows.map((r) => [r.hostId, r.label, r.pollIntervalSeconds, r.createdByUserId, r.removedAt])).toEqual([
      ['h-assign', 'h-assign', null, holder.id, null],
      ['h-both', 'Both Label', 120, manager.id, null],
      ['h-reg', 'Reg Label', 300, null, null],
      ['h-scope', 'h-scope', null, manager.id, null],
    ]);
    // Re-runnable: a pair that has a row is left alone.
    expect(await backfill()).toBe(0);
  });

  it('after the backfill a host that registered before keeps working: its key registers, and it can be granted and assigned', async () => {
    const k = await mkKey(app.id, 'old');
    await scope(k.id, 'orca1');
    await register(k.id, [{ worker: 'Kit', family: 'claude', worktrees: ['hadron-server/kit'] }]);
    await backfill();
    await register(k.id, [{ worker: 'Kit', family: 'claude', worktrees: ['hadron-server/kit'] }]);
    await M.assignHostWorker({}, { input: { appRef: app.id, hostId: 'orca1', worker: 'Kit', workdir: 'hadron-server/kit', family: 'claude' } }, ctx(manager.id));
    expect((await hosts(keyCtx(k.id))).map((h: any) => [h.hostId, h.label])).toEqual([['orca1', 'Mac']]);
  });

  it('the migration carries no box-drawing characters (a pasted Prisma banner breaks migrate deploy)', () => {
    expect(/[─-╿]/.test(migration())).toBe(false);
  });
});
