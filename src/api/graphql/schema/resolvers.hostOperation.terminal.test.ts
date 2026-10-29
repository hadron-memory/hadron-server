/**
 * #2771 (proposed cor:agt:070:09) — a host reports its workers' terminal status (`setHostWorkerTerminals`) and
 * `Worker.terminal`. Gate: cor:agt:070:04, :07; registration test: cor:agt:060:08; read gate: cor:dmo:050:11.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { GraphQLError, graphql, parse, buildASTSchema, isObjectType } from 'graphql';
import { randomBytes } from 'node:crypto';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { runAsActor } from '../../../lib/requestActor.js';
import { APP_KEY_PREFIX, hashAppKey } from '../../../middleware/auth.js';
import { WORKER_SIGNATURE_DEFAULTS } from '../../../lib/workerSignature.js';
import { renderTerminal, TERMINAL_REASONS } from '../../../lib/workerTerminal.js';
import { resolvers, type Context } from './resolvers.js';
import * as workerGate from './resolvers.worker.js';
import { typeDefs } from './typeDefs.js';

vi.mock('../../../integrations/github/writeNodeToGit.js', () => ({ writeNodeToGit: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../../../lib/bus/index.js', () => ({ getBusClient: vi.fn(async () => null) }));

const M = resolvers.Mutation as any;
const Q = resolvers.Query as any;
const F = resolvers as any;

const ctx = (userId?: string, extra: Partial<Context> = {}): Context => ({ db, userId, roles: ['READER'], ...extra }) as Context;
async function code(p: Promise<unknown>): Promise<string | undefined> {
  try {
    await p;
  } catch (e) {
    expect(e).toBeInstanceOf(GraphQLError);
    return (e as GraphQLError).extensions?.code as string;
  }
  return undefined;
}

let org: { id: string; urn: string };
let app: { id: string; urn: string };
let otherApp: { id: string };
let agentId: string;
let manager: { id: string };
let outsider: { id: string };
let coord: { id: string };
let kit: { id: string };
let ada: { id: string };
let gone: { id: string };
let zed: { id: string };
let orca1: { id: string };
let orca2: { id: string };
let plainKey: { id: string };
let foreignKey: { id: string };

async function mkKey(appId: string, label: string) {
  const raw = `${APP_KEY_PREFIX}${randomBytes(32).toString('hex')}`;
  return db.appKey.create({ data: { id: generateId(), appId, keyHash: hashAppKey(raw), keyPreview: raw.slice(-4), label }, select: { id: true } });
}
const keyCtx = (k: { id: string }, appId = app.id, extra: Partial<Context> = {}): Context =>
  ({ db, appId, appKeyId: k.id, organizationId: org.id, roles: [], ...extra }) as Context;

const register = (k: { id: string }, workers: unknown[]) =>
  M.registerHost({}, { input: { appRef: app.id, label: 'Orca One', pollIntervalSeconds: 60, workers } }, keyCtx(k));

const NOW = () => new Date();
const ago = (min: number) => new Date(Date.now() - min * 60_000);
const rep = (worker: string, extra: Record<string, unknown> = {}) => ({
  worker, status: 'idle', prompt: 'empty', reason: null, lastTurnAt: ago(2), checkedAt: ago(1), ...extra,
});
const send = (k: { id: string }, reports: unknown[], appRef: string = app.id, c?: Context) =>
  M.setHostWorkerTerminals({}, { input: { appRef, reports } }, c ?? keyCtx(k));
const stored = (id: string) => db.worker.findUniqueOrThrow({ where: { id }, select: { terminal: true } }).then((w) => w.terminal as any);

beforeEach(async () => {
  await cleanDb(db);
  const n = Math.floor(Math.random() * 1_000_000);
  org = await db.organization.create({ data: { name: 'Terminals', urn: `term-${n}.example` }, select: { id: true, urn: true } });
  const u = (k: number, name: string) =>
    db.user.create({ data: { githubId: k * 1_000_000 + n, githubUsername: `tm-${name}-${n}`, roles: ['READER'] }, select: { id: true } });
  manager = await u(81, 'manager');
  outsider = await u(82, 'outsider');
  await db.orgMember.create({ data: { organizationId: org.id, userId: manager.id, role: 'ADMIN' } });
  const agent = await M.createAgent({}, { orgId: org.id, name: 'Team Agent' }, ctx(manager.id));
  agentId = agent.id;
  app = await db.app.create({ data: { organizationId: org.id, name: 'Team', urn: `${org.urn}:team` }, select: { id: true, urn: true } });
  otherApp = await db.app.create({ data: { organizationId: org.id, name: 'Other', urn: `${org.urn}:other` }, select: { id: true } });
  const w = (appId: string, name: string, extra: Record<string, unknown> = {}) =>
    db.worker.create({ data: { ...WORKER_SIGNATURE_DEFAULTS, appId, agentId, name, slug: name.toLowerCase(), ...extra }, select: { id: true } });
  coord = await w(app.id, 'Mara', { role: 'Coordinator' });
  kit = await w(app.id, 'Kit', { role: 'server-engineer' });
  ada = await w(app.id, 'Ada', { role: 'qa' });
  gone = await w(app.id, 'Gone', { role: 'qa', retiredAt: new Date() });
  zed = await w(otherApp.id, 'Zed');
  orca1 = await mkKey(app.id, 'orca1');
  orca2 = await mkKey(app.id, 'orca2');
  plainKey = await mkKey(app.id, 'plain');
  foreignKey = await mkKey(otherApp.id, 'foreign');
  await M.grantAppKeyScope({}, { id: orca1.id, scope: 'host:operate', hostId: 'orca1' }, ctx(manager.id));
  await M.grantAppKeyScope({}, { id: orca2.id, scope: 'host:operate', hostId: 'orca2' }, ctx(manager.id));
  await M.grantAppKeyScope({}, { id: foreignKey.id, scope: 'host:operate', hostId: 'orca1' }, ctx(manager.id));
  await register(orca1, [{ worker: coord.id, family: 'claude' }, { worker: kit.id, family: 'claude' }, { worker: ada.id, family: 'claude' }]);
});

describe('a host stores a registered worker\'s report, and the server builds the object', () => {
  it('stores host, label and reportedAt from the server, not the request', async () => {
    const before = NOW();
    const r = await send(orca1, [rep(kit.id, { status: 'busy', prompt: 'not_empty' })]);
    expect(r.stored).toEqual([{ id: kit.id, urn: expect.stringContaining('kit') }]);
    expect(r.refused).toEqual([]);
    const t = await stored(kit.id);
    expect(t).toMatchObject({ host: { id: 'orca1', label: 'Orca One' }, status: 'busy', prompt: 'not_empty', reason: null });
    expect(Object.keys(t).sort()).toEqual(['checkedAt', 'host', 'lastTurnAt', 'prompt', 'reason', 'reportedAt', 'status']);
    expect(new Date(t.reportedAt).getTime()).toBeGreaterThanOrEqual(before.getTime());
    expect(await db.hostKeyUse.count({ where: { action: 'terminal', appKeyId: orca1.id, refusedCode: null, count: 1 } })).toBe(1);
  });

  it('a host key sends no host and the request has no field for one', async () => {
    expect(await code(send(orca1, [{ ...rep(kit.id), host: { id: 'evil', label: 'x' } }]))).toBe('BAD_USER_INPUT');
    expect(await stored(kit.id)).toBeNull();
  });

  it('two hosts listing one worker: the latest report replaces the earlier one and names its host', async () => {
    await M.registerHost({}, { input: { appRef: app.id, label: 'Orca Two', pollIntervalSeconds: 60, workers: [{ worker: kit.id, family: 'claude' }] } }, keyCtx(orca2));
    await send(orca1, [rep(kit.id, { checkedAt: ago(5), lastTurnAt: null })]);
    await send(orca2, [rep(kit.id, { status: 'locked', reason: 'rate_limited', checkedAt: ago(1) })]);
    expect(await stored(kit.id)).toMatchObject({ host: { id: 'orca2', label: 'Orca Two' }, status: 'locked', reason: 'rate_limited' });
  });
});

describe('a worker this host may not report refuses that item only', () => {
  it('non-registered, retired, another App\'s and unknown are refused WORKER_NOT_FOUND alike, the rest stored', async () => {
    await db.hostRegistrationWorker.deleteMany({ where: { workerId: ada.id } });
    const r = await send(orca1, [rep(kit.id), rep(ada.id), rep(gone.id), rep(zed.id), rep('nobody')]);
    expect(r.stored.map((s: any) => s.id)).toEqual([kit.id]);
    expect(r.refused).toEqual([
      { worker: ada.id, code: 'WORKER_NOT_FOUND' },
      { worker: gone.id, code: 'WORKER_NOT_FOUND' },
      { worker: zed.id, code: 'WORKER_NOT_FOUND' },
      { worker: 'nobody', code: 'WORKER_NOT_FOUND' },
    ]);
    expect(await stored(ada.id)).toBeNull();
    expect(await stored(zed.id)).toBeNull();
  });

  it('a retired worker the registration still lists is refused', async () => {
    await db.hostRegistrationWorker.create({ data: { registrationId: (await db.hostRegistration.findFirstOrThrow({ where: { appId: app.id, hostId: 'orca1' } })).id, workerId: gone.id, family: 'claude' } as any });
    expect((await send(orca1, [rep(gone.id)])).refused).toEqual([{ worker: gone.id, code: 'WORKER_NOT_FOUND' }]);
  });

  it('a lapsed registration still reports (lostAt is irrelevant, as in setHostWorkerAvailability)', async () => {
    await db.hostRegistration.updateMany({ where: { appId: app.id, hostId: 'orca1' }, data: { lostAt: new Date() } as any });
    expect((await send(orca1, [rep(kit.id)])).stored).toHaveLength(1);
  });

  it('another host\'s worker: orca2 registers none of them', async () => {
    await M.registerHost({}, { input: { appRef: app.id, label: 'Orca Two', pollIntervalSeconds: 60, workers: [] } }, keyCtx(orca2));
    expect((await send(orca2, [rep(kit.id)])).refused).toEqual([{ worker: kit.id, code: 'WORKER_NOT_FOUND' }]);
    expect(await stored(kit.id)).toBeNull();
  });
});

describe('a malformed input refuses the whole batch and stores nothing (D1, D4)', () => {
  const bad: [string, () => unknown[]][] = [
    ['an empty list', () => []],
    ['an unknown key', () => [rep('Kit'), { ...rep('Ada'), detail: 'a line of the screen' }]],
    ['a worker twice', () => [rep('Kit'), rep('Kit')]],
    ['one worker by id and by name', () => [rep('Kit'), rep(kit.id)]],
    ['locked without a reason', () => [rep('Kit'), rep('Ada', { status: 'locked' })]],
    ['dark without a reason', () => [rep('Kit'), rep('Ada', { status: 'dark' })]],
    ['busy with a reason', () => [rep('Kit'), rep('Ada', { status: 'busy', reason: 'rate_limited' })]],
    ['idle with a reason', () => [rep('Kit'), rep('Ada', { reason: 'bare_shell' })]],
    ['a reason that is a sentence', () => [rep('Kit'), rep('Ada', { status: 'locked', reason: 'You have hit your usage limit, try later' })]],
    ['a reason outside the closed list', () => [rep('Kit'), rep('Ada', { status: 'locked', reason: 'rate-limited' })]],
    ['an unknown status', () => [rep('Kit'), rep('Ada', { status: 'asleep' })]],
    ['an unknown prompt', () => [rep('Kit'), rep('Ada', { prompt: 'typing' })]],
    ['checkedAt over 2 minutes ahead', () => [rep('Kit'), rep('Ada', { checkedAt: new Date(Date.now() + 3 * 60_000), lastTurnAt: null })]],
    ['lastTurnAt after checkedAt', () => [rep('Kit'), rep('Ada', { checkedAt: ago(5), lastTurnAt: ago(1) })]],
    ['over the cap', () => Array.from({ length: 201 }, (_, i) => rep(`w${i}`))],
  ];
  for (const [name, reports] of bad) {
    it(name, async () => {
      expect(await code(send(orca1, reports()))).toBe('BAD_USER_INPUT');
      expect(await stored(kit.id)).toBeNull();
      expect(await stored(ada.id)).toBeNull();
    });
  }

  it('every closed reason is accepted for locked and dark', async () => {
    for (const reason of TERMINAL_REASONS) {
      const r = await send(orca1, [rep(kit.id, { status: 'dark', reason, checkedAt: NOW() })]);
      expect(r.stored).toHaveLength(1);
    }
  });

  it('a malformed call is recorded as a refused use', async () => {
    await code(send(orca1, []));
    expect(await db.hostKeyUse.findMany({ where: { action: 'terminal' } }).then((u) => u.map((x) => x.refusedCode))).toEqual(['BAD_USER_INPUT']);
  });
});

describe('the host-key gate, in the #1749 order, each refusal recorded (cor:agt:070:04, :07)', () => {
  it('refuses a person, a key without the scope, another App\'s key, a session-bound key, and a revoked scope', async () => {
    expect(await code(send(orca1, [rep(kit.id)], app.id, ctx(manager.id)))).toBe('HOST_KEY_REQUIRED');
    expect(await code(send(plainKey, [rep(kit.id)]))).toBe('APP_KEY_SCOPE_REQUIRED');
    expect(await code(send(foreignKey, [rep(kit.id)], app.id, keyCtx(foreignKey, otherApp.id)))).toBe('APP_NOT_FOUND');
    expect(await code(runAsActor({ workerId: kit.id, agentId }, () => send(orca1, [rep(kit.id)])))).toBe('APP_KEY_SESSION_BOUND');
    await M.revokeAppKeyScope({}, { id: orca1.id, scope: 'host:operate' }, ctx(manager.id));
    expect(await code(send(orca1, [rep(kit.id)]))).toBe('APP_KEY_SCOPE_REQUIRED');
    expect(await stored(kit.id)).toBeNull();
    const refused = await db.hostKeyUse.findMany({ where: { action: 'terminal', NOT: { refusedCode: null } }, orderBy: { usedAt: 'asc' } });
    expect(refused.map((u) => u.refusedCode)).toEqual(expect.arrayContaining(['APP_KEY_SCOPE_REQUIRED', 'APP_KEY_SESSION_BOUND']));
    expect(await db.hostKeyUse.count({ where: { action: 'terminal', refusedCode: null } })).toBe(0);
  });
});

describe('an older report does not overwrite a newer one', () => {
  it('skips with TERMINAL_REPORT_STALE and keeps the stored report', async () => {
    await send(orca1, [rep(kit.id, { status: 'locked', reason: 'rate_limited', checkedAt: ago(1), lastTurnAt: null })]);
    const r = await send(orca1, [rep(kit.id, { status: 'busy', checkedAt: ago(10), lastTurnAt: null }), rep(ada.id)]);
    expect(r.refused).toEqual([{ worker: kit.id, code: 'TERMINAL_REPORT_STALE' }]);
    expect(r.stored.map((s: any) => s.id)).toEqual([ada.id]);
    expect(await stored(kit.id)).toMatchObject({ status: 'locked', reason: 'rate_limited' });
  });
});

describe('the field decides nothing (D2)', () => {
  it('a locked report leaves checkStatus and availability unchanged', async () => {
    const read = async () => ({
      check: await F.Worker.checkStatus({ id: kit.id, appId: app.id }, {}, ctx(manager.id)),
      avail: await db.workerAvailability.findUnique({ where: { workerId: kit.id } }),
    });
    const before = await read();
    await send(orca1, [rep(kit.id, { status: 'locked', reason: 'model_at_capacity' })]);
    expect(await read()).toEqual(before);
  });
});

describe('the race with registerHost reaches the registration lock', () => {
  it('a batch over two workers waits behind a registration refresh, and both finish', async () => {
    const reg = await db.hostRegistration.findFirstOrThrow({ where: { appId: app.id, hostId: 'orca1' }, select: { id: true } });
    let release!: () => void;
    const held = new Promise<void>((r) => { release = r; });
    let locked!: () => void;
    const lockTaken = new Promise<void>((r) => { locked = r; });
    // What registerHost does: the listed workers FOR SHARE, then the registration FOR UPDATE.
    const refresh = db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM workers WHERE id IN (${kit.id}, ${ada.id}) ORDER BY id FOR SHARE`;
      await tx.$queryRaw`SELECT id FROM host_registrations WHERE id = ${reg.id} FOR UPDATE`;
      locked();
      await held;
    });
    await lockTaken;
    let done = false;
    const batch = send(orca1, [rep(kit.id), rep(ada.id)]).then((r: any) => { done = true; return r; });
    await new Promise((r) => setTimeout(r, 400));
    expect(done).toBe(false);
    release();
    await refresh;
    expect((await batch).stored).toHaveLength(2);
  });
});

describe('the alarm verdict is computed, returned, never stored (cor:agt:100:02)', () => {
  const lockedCoord = (extra: Record<string, unknown> = {}) => send(orca1, [rep(coord.id, { status: 'locked', reason: 'rate_limited', ...extra })]);

  it('lists a locked or dark coordinator this host registers, as references only', async () => {
    const r = await lockedCoord();
    expect(r.alarm).toEqual([{ worker: { id: coord.id, urn: expect.stringContaining('mara') }, status: 'locked', reason: 'rate_limited' }]);
    expect(r.noCoordinator).toBe(false);
    expect(Object.keys(r.alarm[0].worker).sort()).toEqual(['id', 'urn']);
    expect((await send(orca1, [rep(coord.id, { status: 'dark', reason: 'no_terminal', checkedAt: NOW() })])).alarm[0].status).toBe('dark');
  });

  it('omits an idle coordinator, a dark non-coordinator, and a coordinator registered only on another host', async () => {
    expect((await send(orca1, [rep(coord.id), rep(kit.id, { status: 'dark', reason: 'bare_shell' })])).alarm).toEqual([]);
    await db.hostRegistrationWorker.deleteMany({ where: { workerId: coord.id } });
    await M.registerHost({}, { input: { appRef: app.id, label: 'Orca Two', pollIntervalSeconds: 60, workers: [{ worker: coord.id, family: 'claude' }] } }, keyCtx(orca2));
    await send(orca2, [rep(coord.id, { status: 'locked', reason: 'bare_shell' })]);
    expect((await send(orca1, [rep(kit.id)])).alarm).toEqual([]);
  });

  it('omits a paused coordinator, a stopped team and a paused team', async () => {
    await db.workerWakeSettings.create({ data: { workerId: coord.id, pausedUntil: new Date(Date.now() + 30 * 60_000) } });
    expect((await lockedCoord()).alarm).toEqual([]);
    await db.workerWakeSettings.update({ where: { workerId: coord.id }, data: { pausedUntil: null } });
    expect((await lockedCoord({ checkedAt: NOW() })).alarm).toHaveLength(1);
    await db.app.update({ where: { id: app.id }, data: { teamPausedAt: new Date() } });
    expect((await lockedCoord({ checkedAt: NOW() })).alarm).toEqual([]);
  });

  it('sets noCoordinator when the App has no live coordinator, and stores no verdict', async () => {
    await db.worker.update({ where: { id: coord.id }, data: { retiredAt: new Date() } });
    const r = await send(orca1, [rep(kit.id)]);
    expect(r.noCoordinator).toBe(true);
    expect(r.alarm).toEqual([]);
    expect(Object.keys(await stored(kit.id)).sort()).toEqual(['checkedAt', 'host', 'lastTurnAt', 'prompt', 'reason', 'reportedAt', 'status']);
  });
});

describe('the database refuses a raw write the resolver would not make', () => {
  const raw = (v: unknown) => db.$executeRaw`UPDATE workers SET terminal = ${JSON.stringify(v)}::jsonb WHERE id = ${kit.id}`;
  const good = {
    host: { id: 'orca1', label: 'Orca' }, status: 'locked', prompt: 'empty', reason: 'rate_limited',
    lastTurnAt: null, checkedAt: new Date().toISOString(), reportedAt: new Date().toISOString(),
  };
  it('accepts the built shape', async () => {
    await expect(raw(good)).resolves.toBe(1);
  });
  it('rejects an unknown key, an unknown status, a sentence reason, a missing reason and a stray host key', async () => {
    await expect(raw({ ...good, detail: 'screen text' })).rejects.toThrow(/chk_workers_terminal_shape/);
    await expect(raw({ ...good, status: 'asleep' })).rejects.toThrow(/chk_workers_terminal_shape/);
    await expect(raw({ ...good, reason: 'You have hit your limit' })).rejects.toThrow(/chk_workers_terminal_shape/);
    await expect(raw({ ...good, reason: null })).rejects.toThrow(/chk_workers_terminal_shape/);
    await expect(raw({ ...good, status: 'idle', reason: 'rate_limited' })).rejects.toThrow(/chk_workers_terminal_shape/);
    await expect(raw({ ...good, host: { id: 'orca1', label: 'x', note: 'y' } })).rejects.toThrow(/chk_workers_terminal_shape/);
    const { reportedAt: _drop, ...partial } = good;
    await expect(raw(partial)).rejects.toThrow(/chk_workers_terminal_shape/);
  });
  it('a host key use may carry the terminal action', async () => {
    await send(orca1, [rep(kit.id)]);
    expect(await db.hostKeyUse.count({ where: { action: 'terminal' } })).toBe(1);
  });
});

describe('the read path: Worker.terminal and the roster, behind maySeeWorkerInternals (cor:dmo:050:11)', () => {
  it('reads back on the worker and on the roster for a reader who passes the gate; null before a host reports', async () => {
    const row = () => db.worker.findUniqueOrThrow({ where: { id: kit.id } });
    expect(await F.Worker.terminal(await row(), {}, ctx(manager.id))).toBeNull();
    await send(orca1, [rep(kit.id, { status: 'locked', reason: 'rate_limited', prompt: 'menu' })]);
    const t = await F.Worker.terminal(await row(), {}, ctx(manager.id));
    expect(t).toMatchObject({ host: { id: 'orca1', label: 'Orca One' }, status: 'locked', prompt: 'menu', reason: 'rate_limited' });
    expect(t.checkedAt).toBeInstanceOf(Date);
    const roster = await Q.teamRoster({}, { appRef: app.id }, ctx(manager.id));
    const kitRow = roster.workers.find((r: any) => r.workerId === kit.id);
    expect(F.TeamRosterEntry.terminal(kitRow)).toMatchObject({ status: 'locked', reason: 'rate_limited' });
    expect(F.TeamRosterEntry.terminal(roster.workers.find((r: any) => r.workerId === ada.id))).toBeNull();
  });

  it('a reader failing the gate sees null on the worker and the roster (GraphQL parity)', async () => {
    await send(orca1, [rep(kit.id, { status: 'dark', reason: 'bare_shell' })]);
    const row = await db.worker.findUniqueOrThrow({ where: { id: kit.id } });
    expect(await F.Worker.terminal(row, {}, ctx(outsider.id))).toBeNull();
    expect(await F.Worker.terminal(row, {}, ctx())).toBeNull();
    expect(await code(Q.teamRoster({}, { appRef: app.id }, ctx(outsider.id)))).toBe('APP_NOT_FOUND');
  });

  it('a participant who fails maySeeWorkerInternals sees a null terminal on every roster row', async () => {
    await send(orca1, [rep(kit.id, { status: 'dark', reason: 'bare_shell' })]);
    const spy = vi.spyOn(workerGate, 'maySeeWorkerInternals').mockResolvedValue(false);
    try {
      const r = await Q.teamRoster({}, { appRef: app.id }, ctx(manager.id));
      expect(r.workers.length).toBeGreaterThan(0);
      expect(r.workers.every((e: any) => e.terminal === null)).toBe(true);
    } finally { spy.mockRestore(); }
  });

  it('the roster query count does not grow with the reports it carries', async () => {
    const count = async () => {
      const traced: string[] = [];
      const t = db.$extends({ query: { $allOperations: async ({ args, query, model, operation }) => {
        traced.push(`${model}.${operation}`);
        return query(args);
      } } });
      await Q.teamRoster({}, { appRef: app.id }, { ...ctx(manager.id), db: t });
      return traced.length;
    };
    const none = await count();
    await send(orca1, [rep(kit.id), rep(ada.id), rep(coord.id)]);
    expect(await count()).toBe(none);
  });

  it('renders the MCP line read only', () => {
    expect(renderTerminal({ host: { id: 'orca1', label: 'orca1' }, status: 'dark', reason: 'no_turn_for_due_ticker', checkedAt: new Date(Date.now() - 4 * 60_000) }, new Date()))
      .toBe('terminal dark (no_turn_for_due_ticker) on orca1, checked 4m ago');
  });
});

describe('the SDL: results are references, not Worker objects (G1)', () => {
  const schema = buildASTSchema(parse(typeDefs));
  const fields = (t: string) => {
    const type = schema.getType(t);
    return isObjectType(type) ? Object.keys(type.getFields()).sort() : [];
  };
  it('stored and alarm entries are WorkerTerminalRef, not Worker', () => {
    const result = (schema.getType('SetHostWorkerTerminalsResult') as any).getFields();
    expect(String(result.stored.type)).toBe('[WorkerTerminalRef!]!');
    expect(String(result.refused.type)).toBe('[WorkerTerminalRefusal!]!');
    expect(String((schema.getType('WorkerTerminalAlarm') as any).getFields().worker.type)).toBe('WorkerTerminalRef!');
    expect(fields('WorkerTerminalRef')).toEqual(['id', 'urn']);
  });
  it('the report input has no free-text field', () => {
    const input = (schema.getType('WorkerTerminalReportInput') as any).getFields();
    expect(Object.keys(input).sort()).toEqual(['checkedAt', 'lastTurnAt', 'prompt', 'reason', 'status', 'worker']);
    expect(String(input.reason.type)).toBe('WorkerTerminalReason');
  });
  it('Worker and TeamRosterEntry carry terminal; the mutation is declared', () => {
    expect(fields('Worker')).toContain('terminal');
    expect(fields('TeamRosterEntry')).toContain('terminal');
    expect(Object.keys((schema.getMutationType() as any).getFields())).toContain('setHostWorkerTerminals');
    void graphql;
  });
});
