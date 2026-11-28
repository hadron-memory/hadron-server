/**
 * #4225 S4a (epic #4229) — a host reports a worker's context size with its terminal report
 * (`setHostWorkerTerminals`), and `Worker.terminal` / the roster show it with the time it was measured.
 * Reporting only: nothing here enforces a cap (S4b). Gate: cor:agt:070:04; read gate: cor:dmo:050:11.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { GraphQLError, parse, buildASTSchema } from 'graphql';
import { randomBytes } from 'node:crypto';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { APP_KEY_PREFIX, hashAppKey } from '../../../middleware/auth.js';
import { WORKER_SIGNATURE_DEFAULTS } from '../../../lib/workerSignature.js';
import { resolvers, type Context } from './resolvers.js';
import { typeDefs } from './typeDefs.js';
import { joinHostForKey } from '../../../test/agentTeamHost.js';

vi.mock('../../../integrations/github/writeNodeToGit.js', () => ({ writeNodeToGit: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../../../lib/bus/index.js', () => ({ getBusClient: vi.fn(async () => null) }));

const M = resolvers.Mutation as any;
const Q = resolvers.Query as any;
const F = resolvers as any;

const ctx = (userId?: string): Context => ({ db, userId, roles: ['READER'] }) as Context;
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
let manager: { id: string };
let outsider: { id: string };
let kit: { id: string };
let ada: { id: string };
let lone: { id: string };
let orca1: { id: string };
let orca2: { id: string };

async function mkKey(appId: string, label: string) {
  const raw = `${APP_KEY_PREFIX}${randomBytes(32).toString('hex')}`;
  return db.appKey.create({ data: { id: generateId(), appId, keyHash: hashAppKey(raw), keyPreview: raw.slice(-4), label }, select: { id: true } });
}
const keyCtx = (k: { id: string }): Context => ({ db, appId: app.id, appKeyId: k.id, organizationId: org.id, roles: [] }) as Context;
const ago = (min: number) => new Date(Date.now() - min * 60_000);
const rep = (worker: string, extra: Record<string, unknown> = {}) => ({
  worker, status: 'idle', prompt: 'empty', reason: null, lastTurnAt: ago(2), checkedAt: ago(1), ...extra,
});
const send = (k: { id: string }, reports: unknown[]) => M.setHostWorkerTerminals({}, { input: { appRef: app.id, reports } }, keyCtx(k));
const stored = (id: string) => db.worker.findUniqueOrThrow({ where: { id }, select: { terminal: true } }).then((w) => w.terminal as any);
const row = (id: string) => db.worker.findUniqueOrThrow({ where: { id } });

beforeEach(async () => {
  await cleanDb(db);
  const n = Math.floor(Math.random() * 1_000_000);
  org = await db.organization.create({ data: { name: 'Context', urn: `ctx-${n}.example` }, select: { id: true, urn: true } });
  const u = (k: number, name: string) =>
    db.user.create({ data: { githubId: k * 1_000_000 + n, githubUsername: `cx-${name}-${n}`, roles: ['READER'] }, select: { id: true } });
  manager = await u(71, 'manager');
  outsider = await u(72, 'outsider');
  await db.orgMember.create({ data: { organizationId: org.id, userId: manager.id, role: 'ADMIN' } });
  const agent = await M.createAgent({}, { orgRef: org.id, name: 'Team Agent' }, ctx(manager.id));
  app = await db.app.create({ data: { organizationId: org.id, name: 'Team', urn: `${org.urn}:team` }, select: { id: true, urn: true } });
  const w = (name: string) =>
    db.worker.create({ data: { ...WORKER_SIGNATURE_DEFAULTS, appId: app.id, agentId: agent.id, name, slug: name.toLowerCase(), role: 'server-engineer' }, select: { id: true } });
  kit = await w('Kit');
  ada = await w('Ada');
  lone = await w('Lone');
  orca1 = await mkKey(app.id, 'orca1');
  orca2 = await mkKey(app.id, 'orca2');
  await joinHostForKey(db, orca1.id, 'orca1');
  await M.grantAppKeyScope({}, { id: orca1.id, scope: 'host:operate', hostId: 'orca1' }, ctx(manager.id));
  await joinHostForKey(db, orca2.id, 'orca2');
  await M.grantAppKeyScope({}, { id: orca2.id, scope: 'host:operate', hostId: 'orca2' }, ctx(manager.id));
  const register = (k: { id: string }, label: string, workers: unknown[]) =>
    M.registerHost({}, { input: { appRef: app.id, label, pollIntervalSeconds: 60, workers } }, keyCtx(k));
  await register(orca1, 'Orca One', [{ worker: kit.id, family: 'claude' }, { worker: ada.id, family: 'claude' }]);
  await register(orca2, 'Orca Two', [{ worker: lone.id, family: 'claude' }]);
});

describe('a host reports context size with the terminal report', () => {
  it('stores contextTokens and contextMeasuredAt, and Worker.terminal and the roster read them back', async () => {
    const measuredAt = ago(1);
    const r = await send(orca1, [rep(kit.id, { contextTokens: 183_412, contextMeasuredAt: measuredAt })]);
    expect(r.refused).toEqual([]);
    expect(await stored(kit.id)).toMatchObject({ contextTokens: 183_412, contextMeasuredAt: measuredAt.toISOString() });
    const t = await F.Worker.terminal(await row(kit.id), {}, ctx(manager.id));
    expect(t.contextTokens).toBe(183_412);
    expect(t.contextMeasuredAt).toEqual(measuredAt);
    const roster = await Q.teamRoster({}, { appRef: app.id }, ctx(manager.id));
    const view = F.TeamRosterEntry.terminal(roster.workers.find((e: any) => e.workerId === kit.id));
    expect(view.contextTokens).toBe(183_412);
    expect(view.contextMeasuredAt).toEqual(measuredAt);
  });

  it('a family the host cannot measure is stored as null, never 0: omitted and explicit null alike', async () => {
    await send(orca1, [rep(kit.id), rep(ada.id, { contextTokens: null, contextMeasuredAt: null })]);
    for (const id of [kit.id, ada.id]) {
      const s = await stored(id);
      expect(s).toHaveProperty('contextTokens', null);
      expect(s).toHaveProperty('contextMeasuredAt', null);
      const t = await F.Worker.terminal(await row(id), {}, ctx(manager.id));
      expect(t.contextTokens).toBeNull();
      expect(t.contextMeasuredAt).toBeNull();
    }
  });

  it('a later report without a measurement replaces the earlier one: no stale size is kept', async () => {
    await send(orca1, [rep(kit.id, { checkedAt: ago(3), lastTurnAt: null, contextTokens: 90_000, contextMeasuredAt: ago(3) })]);
    await send(orca1, [rep(kit.id)]);
    expect(await stored(kit.id)).toMatchObject({ contextTokens: null, contextMeasuredAt: null });
  });

  it('an older report is skipped TERMINAL_REPORT_STALE and the stored size stands', async () => {
    await send(orca1, [rep(kit.id, { contextTokens: 90_000, contextMeasuredAt: ago(1) })]);
    const r = await send(orca1, [rep(kit.id, { checkedAt: ago(9), lastTurnAt: null, contextTokens: 5, contextMeasuredAt: ago(9) })]);
    expect(r.refused).toEqual([{ worker: kit.id, code: 'TERMINAL_REPORT_STALE' }]);
    expect((await stored(kit.id)).contextTokens).toBe(90_000);
  });

  it('a worker this host does not run is refused for that row only, and its size is not stored', async () => {
    const r = await send(orca1, [
      rep(lone.id, { contextTokens: 77_000, contextMeasuredAt: ago(1) }),
      rep(kit.id, { contextTokens: 12_000, contextMeasuredAt: ago(1) }),
    ]);
    expect(r.refused).toEqual([{ worker: lone.id, code: 'WORKER_NOT_FOUND' }]);
    expect(r.stored.map((s: any) => s.id)).toEqual([kit.id]);
    expect(await stored(lone.id)).toBeNull();
    expect((await stored(kit.id)).contextTokens).toBe(12_000);
  });

  it('a reader who fails the working-state gate sees no size', async () => {
    await send(orca1, [rep(kit.id, { contextTokens: 12_000, contextMeasuredAt: ago(1) })]);
    expect(await F.Worker.terminal(await row(kit.id), {}, ctx(outsider.id))).toBeNull();
    expect(await F.Worker.terminal(await row(kit.id), {}, ctx())).toBeNull();
  });
});

describe('a malformed size is the sender\'s bug: the batch is refused and nothing is stored', () => {
  const bad: [string, () => Record<string, unknown>][] = [
    ['zero tokens', () => ({ contextTokens: 0, contextMeasuredAt: ago(1) })],
    ['negative tokens', () => ({ contextTokens: -4, contextMeasuredAt: ago(1) })],
    ['fractional tokens', () => ({ contextTokens: 1200.5, contextMeasuredAt: ago(1) })],
    ['tokens over the 32-bit range', () => ({ contextTokens: 2 ** 31, contextMeasuredAt: ago(1) })],
    ['tokens that are not a number', () => ({ contextTokens: '1200', contextMeasuredAt: ago(1) })],
    ['tokens with no measuredAt', () => ({ contextTokens: 1200 })],
    ['measuredAt with no tokens', () => ({ contextMeasuredAt: ago(1) })],
    ['measuredAt that is not a time', () => ({ contextTokens: 1200, contextMeasuredAt: 'yesterday' })],
    ['measuredAt over 2 minutes ahead', () => ({ contextTokens: 1200, contextMeasuredAt: new Date(Date.now() + 3 * 60_000) })],
  ];
  for (const [name, extra] of bad) {
    it(name, async () => {
      expect(await code(send(orca1, [rep(kit.id), rep(ada.id, extra())]))).toBe('BAD_USER_INPUT');
      expect(await stored(kit.id)).toBeNull();
      expect(await stored(ada.id)).toBeNull();
    });
  }
});

describe('the database refuses a raw write the resolver would not make', () => {
  const raw = (v: unknown) => db.$executeRaw`UPDATE workers SET terminal = ${JSON.stringify(v)}::jsonb WHERE id = ${kit.id}`;
  const legacy = {
    host: { id: 'orca1', label: 'Orca' }, status: 'idle', prompt: 'empty', reason: null,
    lastTurnAt: null, checkedAt: new Date().toISOString(), reportedAt: new Date().toISOString(),
  };
  const at = new Date().toISOString();
  it('accepts a measured report, an unmeasured one, and a row stored before #4225 (no size keys)', async () => {
    await expect(raw({ ...legacy, contextTokens: 150_000, contextMeasuredAt: at })).resolves.toBe(1);
    await expect(raw({ ...legacy, contextTokens: null, contextMeasuredAt: null })).resolves.toBe(1);
    await expect(raw(legacy)).resolves.toBe(1);
  });
  it('rejects 0, a fraction, a string size, a size with no time, a time with no size, and transcript text', async () => {
    const no = /chk_workers_terminal_shape/;
    await expect(raw({ ...legacy, contextTokens: 0, contextMeasuredAt: at })).rejects.toThrow(no);
    await expect(raw({ ...legacy, contextTokens: 10.5, contextMeasuredAt: at })).rejects.toThrow(no);
    await expect(raw({ ...legacy, contextTokens: 3_000_000_000, contextMeasuredAt: at })).rejects.toThrow(no);
    await expect(raw({ ...legacy, contextTokens: '150000', contextMeasuredAt: at })).rejects.toThrow(no);
    await expect(raw({ ...legacy, contextTokens: 150_000, contextMeasuredAt: null })).rejects.toThrow(no);
    await expect(raw({ ...legacy, contextTokens: 150_000 })).rejects.toThrow(no);
    await expect(raw({ ...legacy, contextTokens: null, contextMeasuredAt: at })).rejects.toThrow(no);
    await expect(raw({ ...legacy, contextMeasuredAt: at })).rejects.toThrow(no);
    await expect(raw({ ...legacy, contextTokens: 150_000, contextMeasuredAt: at, contextText: 'the last turn said' })).rejects.toThrow(no);
  });
});

describe('the SDL: a number and an instant, no text', () => {
  const schema = buildASTSchema(parse(typeDefs));
  it('the report input carries contextTokens: Int and contextMeasuredAt: DateTime, both optional', () => {
    const input = (schema.getType('WorkerTerminalReportInput') as any).getFields();
    expect(String(input.contextTokens?.type)).toBe('Int');
    expect(String(input.contextMeasuredAt?.type)).toBe('DateTime');
    const strings = Object.keys(input).filter((k) => String(input[k].type).replace('!', '') === 'String');
    expect(strings).toEqual(['worker']);
  });
  it('WorkerTerminal carries both, nullable', () => {
    const t = (schema.getType('WorkerTerminal') as any).getFields();
    expect(String(t.contextTokens?.type)).toBe('Int');
    expect(String(t.contextMeasuredAt?.type)).toBe('DateTime');
  });
});
