/**
 * #4558 — `WorkerTerminalReason` gains `no_screen` (Orca gives no rendered screen) and
 * `multiple_terminals` (more than one agent terminal bound to the worker), for hadron-cli#2677.
 *
 * The closed list lives in FOUR places and all four change in one PR: the SDL enum, `TERMINAL_REASONS`
 * (`src/lib/workerTerminal.ts`), the CHECK on `workers.terminal` (its canonical copy for test databases is
 * `prisma/host-operation-invariants.sql`, which `prisma/post-push.sql` applies to every test template; the
 * migration re-adds the same CHECK for production), and the CLI contract (downstream, hadron-cli#2677).
 *
 * The CLI reports both new reasons with `locked`, as it does `unrecognized` (Xan's FIT answer on the issue); like every
 * reason, the server accepts them with `locked` or `dark`, and no pairing is enforced (gate a pins both). The stored
 * status is unchanged and no terminal-status event follows — that event is not built at all (cor:agt:050:11,
 * slice S1c deferred to #2926), and this file pins that adding reasons does not sneak one in.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { GraphQLError } from 'graphql';
import { parse, buildASTSchema } from 'graphql';
import { ApolloServer } from '@apollo/server';
import { randomBytes } from 'node:crypto';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { APP_KEY_PREFIX, hashAppKey } from '../../../middleware/auth.js';
import { WORKER_SIGNATURE_DEFAULTS } from '../../../lib/workerSignature.js';
import { TERMINAL_REASONS } from '../../../lib/workerTerminal.js';
import { resolvers, type Context } from './resolvers.js';
import { typeDefs } from './typeDefs.js';
import { deploymentSchema } from './deploymentSchema.js';
import { joinHostForKey } from '../../../test/agentTeamHost.js';

vi.mock('../../../integrations/github/writeNodeToGit.js', () => ({ writeNodeToGit: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../../../lib/bus/index.js', () => ({ getBusClient: vi.fn(async () => null) }));

const M = resolvers.Mutation as any;
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
let manager: { id: string };
let kit: { id: string };
let ada: { id: string };
let orca1: { id: string };

async function mkKey(appId: string, label: string) {
  const raw = `${APP_KEY_PREFIX}${randomBytes(32).toString('hex')}`;
  return db.appKey.create({ data: { id: generateId(), appId, keyHash: hashAppKey(raw), keyPreview: raw.slice(-4), label }, select: { id: true } });
}
const keyCtx = (k: { id: string }, appId = app.id): Context => ({ db, appId, appKeyId: k.id, organizationId: org.id, roles: [] }) as Context;

const register = (k: { id: string }, workers: unknown[]) =>
  M.registerHost({}, { input: { appRef: app.id, label: 'Orca One', pollIntervalSeconds: 60, workers } }, keyCtx(k));

// Report times strictly increase within a test, so acceptance never rests on two `new Date()` calls differing
// (#4566 BLIND P3). They start 50 s ago, after every report's lastTurnAt (2 min ago), and step 1 s.
let clock = 0;
const NOW = () => new Date(clock += 1000);
const ago = (min: number) => new Date(Date.now() - min * 60_000);
const rep = (worker: string, extra: Record<string, unknown> = {}) => ({
  worker, status: 'idle', prompt: 'empty', reason: null, lastTurnAt: ago(2), checkedAt: ago(1), ...extra,
});
const send = (k: { id: string }, reports: unknown[]) => M.setHostWorkerTerminals({}, { input: { appRef: app.id, reports } }, keyCtx(k));
const stored = (id: string) => db.worker.findUniqueOrThrow({ where: { id }, select: { terminal: true } }).then((w) => w.terminal as any);

beforeEach(async () => {
  clock = Date.now() - 50_000;
  await cleanDb(db);
  const n = Math.floor(Math.random() * 1_000_000);
  org = await db.organization.create({ data: { name: 'Reasons', urn: `rsn-${n}.example` }, select: { id: true, urn: true } });
  manager = await db.user.create({ data: { githubId: 81_000_000 + n, githubUsername: `rsn-mgr-${n}`, roles: ['READER'] }, select: { id: true } });
  await db.orgMember.create({ data: { organizationId: org.id, userId: manager.id, role: 'ADMIN' } });
  const agent = await M.createAgent({}, { orgRef: org.id, name: 'Team Agent' }, ctx(manager.id));
  app = await db.app.create({ data: { organizationId: org.id, name: 'Team', urn: `${org.urn}:team` }, select: { id: true, urn: true } });
  const w = (name: string) =>
    db.worker.create({ data: { ...WORKER_SIGNATURE_DEFAULTS, appId: app.id, agentId: agent.id, name, slug: name.toLowerCase() }, select: { id: true } });
  kit = await w('Kit');
  ada = await w('Ada');
  orca1 = await mkKey(app.id, 'orca1');
  await joinHostForKey(db, orca1.id, 'orca1');
  await M.grantAppKeyScope({}, { id: orca1.id, scope: 'host:operate', hostId: 'orca1' }, ctx(manager.id));
  await register(orca1, [{ worker: kit.id, family: 'glm' }, { worker: ada.id, family: 'glm' }]);
});

describe('#4558 the resolver accepts the two new reasons (gate a)', () => {
  it('no_screen and multiple_terminals are stored for locked and dark', async () => {
    for (const reason of ['no_screen', 'multiple_terminals'] as const) {
      for (const status of ['locked', 'dark'] as const) {
        const r = await send(orca1, [rep(kit.id, { status, reason, checkedAt: NOW() })]);
        expect(r.stored, `${status}/${reason}`).toHaveLength(1);
        expect(r.refused, `${status}/${reason}`).toEqual([]);
        expect(await stored(kit.id)).toMatchObject({ status, reason });
      }
    }
  });
});

describe('#4558 the database CHECK admits the two new reasons (gate b, raw write)', () => {
  const raw = (v: unknown) => db.$executeRaw`UPDATE workers SET terminal = ${JSON.stringify(v)}::jsonb WHERE id = ${kit.id}`;
  const good = {
    host: { id: 'orca1', label: 'Orca' }, status: 'locked', prompt: 'empty', reason: 'rate_limited',
    lastTurnAt: null, checkedAt: new Date().toISOString(), reportedAt: new Date().toISOString(),
  };
  it('a raw write with either new reason persists against chk_workers_terminal_shape', async () => {
    await expect(raw({ ...good, reason: 'no_screen' })).resolves.toBe(1);
    expect((await stored(kit.id)).reason).toBe('no_screen');
    await expect(raw({ ...good, reason: 'multiple_terminals' })).resolves.toBe(1);
    expect((await stored(kit.id)).reason).toBe('multiple_terminals');
  });
});

describe('#4558 a report with a new reason persists and reads back on Worker.terminal and the roster (gate b, read path)', () => {
  it('reads back through the GraphQL gate for a reader who passes it', async () => {
    const row = () => db.worker.findUniqueOrThrow({ where: { id: kit.id } });
    await send(orca1, [rep(kit.id, { status: 'locked', prompt: 'menu', reason: 'no_screen', checkedAt: NOW() })]);
    const t = await F.Worker.terminal(await row(), {}, ctx(manager.id));
    expect(t).toMatchObject({ host: { id: 'orca1', label: 'Orca One' }, status: 'locked', prompt: 'menu', reason: 'no_screen' });
    await send(orca1, [rep(ada.id, { status: 'locked', prompt: 'menu', reason: 'multiple_terminals', checkedAt: NOW() })]);
    const Q = resolvers as any;
    const roster = await Q.Query.teamRoster({}, { appRef: app.id }, ctx(manager.id));
    const byWorker = (id: string) => roster.workers.find((r: any) => r.workerId === id);
    expect(Q.TeamRosterEntry.terminal(byWorker(kit.id))).toMatchObject({ status: 'locked', reason: 'no_screen' });
    expect(Q.TeamRosterEntry.terminal(byWorker(ada.id))).toMatchObject({ status: 'locked', reason: 'multiple_terminals' });
  });
});

describe('#4558 the new reasons through the assembled schema (enum coercion and serialization)', () => {
  // #4566 BLIND P3: input coercion of the enum literals and output serialization, in one executed operation each,
  // through the construction src/server.ts uses (deploymentSchema's typeDefs + resolvers on one ApolloServer), so
  // the real DateTime scalar and enum wiring are in the path.
  const run = async (query: string, contextValue: Context, variables?: Record<string, unknown>) => {
    const wired = deploymentSchema();
    const server = new ApolloServer<Context>({ typeDefs: wired.typeDefs, resolvers: wired.resolvers });
    await server.start();
    try {
      const r = await server.executeOperation({ query, variables }, { contextValue });
      if (r.body.kind !== 'single') throw new Error('expected a single result');
      return r.body.singleResult;
    } finally {
      await server.stop();
    }
  };
  it('a mutation with both enum literals stores them and Query.worker reads them back as the same names', async () => {
    const at = (d: Date) => d.toISOString();
    const set = await run(`mutation($app: String!, $kit: String!, $ada: String!, $t1: DateTime!, $t2: DateTime!, $last: DateTime!) {
      setHostWorkerTerminals(input: { appRef: $app, reports: [
        { worker: $kit, status: locked, prompt: empty, reason: no_screen, lastTurnAt: $last, checkedAt: $t1 },
        { worker: $ada, status: locked, prompt: menu, reason: multiple_terminals, lastTurnAt: $last, checkedAt: $t2 }
      ] }) { stored { id } refused { worker } }
    }`, keyCtx(orca1), { app: app.id, kit: kit.id, ada: ada.id, t1: at(NOW()), t2: at(NOW()), last: at(ago(2)) });
    expect(set.errors).toBeUndefined();
    expect((set.data as any).setHostWorkerTerminals.refused).toEqual([]);
    expect((set.data as any).setHostWorkerTerminals.stored.map((r: { id: string }) => r.id).sort()).toEqual([kit.id, ada.id].sort());
    const read = await run(`query($kit: ID!, $ada: ID!) {
      kit: worker(ref: $kit) { terminal { status reason } }
      ada: worker(ref: $ada) { terminal { status reason } }
    }`, ctx(manager.id), { kit: kit.id, ada: ada.id });
    expect(read.errors).toBeUndefined();
    expect(read.data).toEqual({
      kit: { terminal: { status: 'locked', reason: 'no_screen' } },
      ada: { terminal: { status: 'locked', reason: 'multiple_terminals' } },
    });
  });
});

describe('#4558 a reason outside the list is still refused at both layers (gate c)', () => {
  const raw = (v: unknown) => db.$executeRaw`UPDATE workers SET terminal = ${JSON.stringify(v)}::jsonb WHERE id = ${kit.id}`;
  const good = {
    host: { id: 'orca1', label: 'Orca' }, status: 'locked', prompt: 'empty', reason: 'no_screen',
    lastTurnAt: null, checkedAt: new Date().toISOString(), reportedAt: new Date().toISOString(),
  };
  it('the CHECK refuses a stranger and the resolver refuses it BAD_USER_INPUT', async () => {
    await expect(raw({ ...good, reason: 'definitely_not_a_reason' })).rejects.toThrow(/chk_workers_terminal_shape/);
    expect(await code(send(orca1, [rep(kit.id, { status: 'locked', reason: 'definitely_not_a_reason', checkedAt: NOW() })]))).toBe('BAD_USER_INPUT');
    expect(await stored(kit.id)).toBeNull();
  });
});

describe('#4558 the four homes of the list stay one list (gate d)', () => {
  it('the SDL enum and TERMINAL_REASONS are the same 13 values: the eleven plus the two new', () => {
    const schema = buildASTSchema(parse(typeDefs));
    const sdl = (schema.getType('WorkerTerminalReason') as any).getValues().map((v: { name: string }) => v.name);
    expect([...sdl].sort()).toEqual([...TERMINAL_REASONS].sort());
    expect(TERMINAL_REASONS).toHaveLength(13);
    expect(TERMINAL_REASONS).toContain('no_screen');
    expect(TERMINAL_REASONS).toContain('multiple_terminals');
  });
});

describe('#4558 a locked report with a new reason decides nothing, exactly as unrecognized (Xan\'s FIT pin)', () => {
  it('no terminal-status event, no checkStatus or availability change — identical to unrecognized', async () => {
    const read = async (id: string) => ({
      check: await F.Worker.checkStatus({ id, appId: app.id }, {}, ctx(manager.id)),
      avail: await db.workerAvailability.findUnique({ where: { workerId: id } }),
      events: await db.agentTeamEvent.count({ where: { subjectWorkerId: id } }),
    });
    // The setup itself writes team events (a host registered); the pin is that the REPORTS add none.
    const eventsBefore = await db.agentTeamEvent.count();
    // The control: unrecognized, an existing locked reason.
    const beforeKit = await read(kit.id);
    await send(orca1, [rep(kit.id, { status: 'locked', reason: 'unrecognized', checkedAt: NOW() })]);
    expect(await read(kit.id)).toEqual(beforeKit);

    // The new reasons behave identically on both workers.
    const beforeAda = await read(ada.id);
    await send(orca1, [rep(kit.id, { status: 'locked', reason: 'no_screen', checkedAt: NOW() })]);
    expect(await read(kit.id)).toEqual(beforeKit);
    await send(orca1, [rep(ada.id, { status: 'locked', reason: 'multiple_terminals', checkedAt: NOW() })]);
    expect(await read(ada.id)).toEqual(beforeAda);

    // The stored status is locked and the reasons round-trip (the report IS stored; it just decides nothing).
    expect(await stored(kit.id)).toMatchObject({ status: 'locked', reason: 'no_screen' });
    expect(await stored(ada.id)).toMatchObject({ status: 'locked', reason: 'multiple_terminals' });
    expect(await db.agentTeamEvent.count()).toBe(eventsBefore);
  });
});
