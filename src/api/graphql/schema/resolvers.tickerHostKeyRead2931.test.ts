import { WORKER_SIGNATURE_DEFAULTS } from '../../../lib/workerSignature.js';
/**
 * #2931 (V6, Holger 2026-10-31) — the App's own live `host:operate` key READS the tickers and subscriptions of the
 * workers ITS HOST registers, and nothing else (cor:agt:070:04, :07, cor:agt:080:18, :22).
 *
 * Cast: orca1 (hostKey) registers Ada; orca2 (otherHostKey) registers Kit. `shared` is subscribed by Ada and Kit,
 * `kitOnly` by Kit, `adaEnded` had Ada until she was unsubscribed, `adaDeleted` is deleted, `onY` is another App's.
 * Every refusal is compared with what a non-participant gets (byte-identical: message and extensions), not just a code.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GraphQLError, buildSchema, getNamedType, isLeafType, isObjectType, type GraphQLObjectType } from 'graphql';
import { ApolloServer } from '@apollo/server';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { runAsActor } from '../../../lib/requestActor.js';
import { lockAuthorityAnchors } from '../../../lib/auth/authorityAnchors.js';
import { createMcpServerInstance } from '../../../mcp/server.js';
import type { AuthContext } from '../../../middleware/auth.js';
import { resolvers, type Context } from './resolvers.js';
import { teamChatMutations } from './resolvers.teamChat.js';
import { typeDefs } from './typeDefs.js';

vi.mock('../../../integrations/github/writeNodeToGit.js', () => ({ writeNodeToGit: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../../../integrations/github/syncGraphFromGithub.js', () => ({ syncGraphFromGithub: vi.fn().mockResolvedValue({ error: null }) }));
vi.mock('../../../lib/bus/index.js', () => ({ getBusClient: vi.fn(async () => null) }));

const M = resolvers.Mutation as any;
const Q = resolvers.Query as any;
const F = resolvers as any;

let org: { id: string; urn: string };
let admin: { id: string };
let member: { id: string };
let outsider: { id: string };
let agentId: string;
let appX: { id: string; urn: string };
let appY: { id: string; urn: string };
let ada: { id: string };
let kit: { id: string };
let zed: { id: string };
let hostKey: { id: string };
let otherHostKey: { id: string };
let plainKey: { id: string };
let deliverKey: { id: string };
let revokedScopeKey: { id: string };
let revokedKey: { id: string };
let shared: { id: string };
let kitOnly: { id: string };
let adaEnded: { id: string };
let adaDeleted: { id: string };
let onY: { id: string };
let setupUses: string[];

const ctx = (userId?: string, extra: Partial<Context> = {}): Context => ({ db, userId, roles: ['READER'], ...extra });
const keyCtx = (k: { id: string }, extra: Partial<Context> = {}): Context => ({ db, appId: appX.id, appKeyId: k.id, roles: [], ...extra });

async function refusal(p: Promise<unknown>): Promise<{ message: string; extensions: unknown }> {
  try { await p; } catch (e) {
    expect(e).toBeInstanceOf(GraphQLError);
    return { message: (e as GraphQLError).message, extensions: (e as GraphQLError).extensions };
  }
  throw new Error('expected a refusal');
}

const tickers = (c: Context, appRef = appX.id) => Q.tickers({}, { appRef }, c);
const tickersPage = (c: Context, appRef = appX.id, extra: Record<string, unknown> = {}) => Q.tickersPage({}, { appRef, ...extra }, c);
const ticker = (c: Context, ref: string) => Q.ticker({}, { ref }, c);
const subscribers = (c: Context, t: { id: string }, a: Record<string, unknown> = {}) => F.Ticker.subscribers(t, a, c);
const ids = (rows: { id: string }[]) => rows.map((r) => r.id);

let post: ReturnType<typeof vi.spyOn>;

beforeEach(async () => {
  await cleanDb(db);
  post = vi.spyOn(teamChatMutations, 'createTeamChatMessage').mockResolvedValue({} as never);
  const n = Math.floor(Math.random() * 1_000_000);
  org = await db.organization.create({ data: { id: generateId(), name: 'hk', urn: `hk2931-${n}.example` }, select: { id: true, urn: true } });
  const u = (k: number, name: string) =>
    db.user.create({ data: { id: generateId(), githubId: 29_310_000 + k * 1000 + (n % 1000), githubUsername: `hk-${name}-${n}`, handle: `hk-${name}-${n}`, roles: ['READER'] }, select: { id: true } });
  admin = await u(1, 'admin');
  member = await u(2, 'member');
  outsider = await u(3, 'outsider');
  await db.orgMember.create({ data: { id: generateId(), organizationId: org.id, userId: admin.id, role: 'ADMIN' } });
  agentId = (await M.createAgent({}, { orgId: org.id, name: 'Team Agent' }, ctx(admin.id))).id;
  appX = await db.app.create({ data: { id: generateId(), organizationId: org.id, name: 'X', urn: `${org.urn}:x` }, select: { id: true, urn: true } });
  appY = await db.app.create({ data: { id: generateId(), organizationId: org.id, name: 'Y', urn: `${org.urn}:y` }, select: { id: true, urn: true } });
  await db.appMember.create({ data: { appId: appX.id, userId: member.id, role: 'member' } });
  const w = (appId: string, name: string) =>
    db.worker.create({ data: { ...WORKER_SIGNATURE_DEFAULTS, id: generateId(), appId, agentId, name, slug: name.toLowerCase(), heldByUserId: member.id, heldAt: new Date() }, select: { id: true } });
  ada = await w(appX.id, 'Ada');
  kit = await w(appX.id, 'Kit');
  zed = await w(appY.id, 'Zed');

  const mkKey = (appId: string, label: string) =>
    db.appKey.create({ data: { id: generateId(), appId, keyHash: `h-${generateId()}`, keyPreview: 'abcd', label }, select: { id: true } });
  hostKey = await mkKey(appX.id, 'orca1');
  otherHostKey = await mkKey(appX.id, 'orca2');
  plainKey = await mkKey(appX.id, 'plain');
  deliverKey = await mkKey(appX.id, 'deliver');
  revokedScopeKey = await mkKey(appX.id, 'revoked-scope');
  revokedKey = await mkKey(appX.id, 'revoked');
  await M.grantAppKeyScope({}, { id: hostKey.id, scope: 'host:operate', hostId: 'orca1' }, ctx(admin.id));
  await M.grantAppKeyScope({}, { id: otherHostKey.id, scope: 'host:operate', hostId: 'orca2' }, ctx(admin.id));
  await M.grantAppKeyScope({}, { id: deliverKey.id, scope: 'attention:deliver' }, ctx(admin.id));
  await M.grantAppKeyScope({}, { id: revokedScopeKey.id, scope: 'host:operate', hostId: 'orca1' }, ctx(admin.id));
  await M.grantAppKeyScope({}, { id: revokedKey.id, scope: 'host:operate', hostId: 'orca1' }, ctx(admin.id));
  await M.registerHost({}, { input: { appRef: appX.id, label: 'Orca 1', pollIntervalSeconds: 600, workers: [{ worker: ada.id, family: 'claude' }] } }, keyCtx(hostKey));
  await M.registerHost({}, { input: { appRef: appX.id, label: 'Orca 2', pollIntervalSeconds: 600, workers: [{ worker: kit.id, family: 'claude' }] } }, keyCtx(otherHostKey));
  await M.revokeAppKeyScope({}, { id: revokedScopeKey.id, scope: 'host:operate' }, ctx(admin.id));
  await db.appKey.update({ where: { id: revokedKey.id }, data: { revokedAt: new Date() } });

  const mk = (name: string, appRef = appX.id) => M.createTicker({}, { appRef, input: { name, cadenceSeconds: 600 } }, ctx(admin.id));
  const sub = (t: { id: string }, wk: { id: string }) => M.subscribeWorker({}, { tickerRef: t.id, workerRef: wk.id }, ctx(admin.id));
  shared = await mk('Shared');
  kitOnly = await mk('Kit only');
  adaEnded = await mk('Ada ended');
  adaDeleted = await mk('Ada deleted');
  await sub(shared, ada);
  await sub(shared, kit);
  await sub(kitOnly, kit);
  await sub(adaEnded, ada);
  await M.unsubscribeWorker({}, { tickerRef: adaEnded.id, workerRef: ada.id }, ctx(admin.id));
  await sub(adaDeleted, ada);
  await M.deleteTicker({}, { ref: adaDeleted.id }, ctx(admin.id));
  await db.appMember.create({ data: { appId: appY.id, userId: admin.id, role: 'owner' } });
  onY = await mk('On Y', appY.id);
  await sub(onY, zed);
  // Host key uses are append-only: the setup's own (registrations) are excluded by id.
  setupUses = (await db.hostKeyUse.findMany({ select: { id: true } })).map((r) => r.id);
});

afterEach(() => {
  post.mockRestore();
});

describe('#2931 admit — a live host key reads its own host workers\' tickers (red on main)', () => {
  it('P1: tickers lists exactly the tickers a worker of its host subscribes to', async () => {
    expect(ids(await tickers(keyCtx(hostKey)))).toEqual([shared.id]);
    // orca2's key sees its own host's worker's tickers, in the participant order.
    expect(ids(await tickers(keyCtx(otherHostKey)))).toEqual([shared.id, kitOnly.id]);
    // A participant still sees every live ticker.
    expect(ids(await tickers(ctx(member.id)))).toEqual([shared.id, kitOnly.id, adaEnded.id]);
  });

  it('P3: tickersPage follows tickers: the same rows and a total of the same rows', async () => {
    const page = await tickersPage(keyCtx(otherHostKey));
    expect(ids(page.items)).toEqual([shared.id, kitOnly.id]);
    expect(page.total).toBe(2);
    const second = await tickersPage(keyCtx(otherHostKey), appX.id, { limit: 1, offset: 1 });
    expect(ids(second.items)).toEqual([kitOnly.id]);
    expect(second.total).toBe(2);
    const counted = await tickersPage(keyCtx(hostKey), appX.id, { limit: 0 });
    expect(counted.items).toEqual([]);
    expect(counted.total).toBe(1);
  });

  it('P2: ticker(ref) reads a host-subscribed ticker by id and by URN; any other answers null', async () => {
    expect((await ticker(keyCtx(hostKey), shared.id))?.id).toBe(shared.id);
    const urn = await F.Ticker.urn(await db.ticker.findUnique({ where: { id: shared.id } }), {}, ctx(admin.id));
    expect(urn).toMatch(/^hrn:ticker:/);
    expect((await ticker(keyCtx(hostKey), urn))?.id).toBe(shared.id);
    for (const t of [kitOnly, adaEnded, adaDeleted, onY]) expect(await ticker(keyCtx(hostKey), t.id)).toBeNull();
    expect(await ticker(keyCtx(hostKey), 'no-such-ticker')).toBeNull();
  });

  it('P2: subscribers lists only the host\'s own workers\' subscriptions', async () => {
    const t = await ticker(keyCtx(hostKey), shared.id);
    const page = await subscribers(keyCtx(hostKey), t);
    expect(page.items.map((s: { workerId: string }) => s.workerId)).toEqual([ada.id]);
    expect(page.hasNextPage).toBe(false);
    // The same ticker, read by orca2: only Kit. A participant: both.
    expect((await subscribers(keyCtx(otherHostKey), t)).items.map((s: { workerId: string }) => s.workerId)).toEqual([kit.id]);
    expect((await subscribers(ctx(member.id), t)).items.map((s: { workerId: string }) => s.workerId)).toEqual([ada.id, kit.id]);
  });
});

describe('#2931 refusals, byte-identical to a non-participant\'s', () => {
  it('G1: the host key on another App\'s ref, or an unknown ref, is refused as a non-participant is', async () => {
    for (const ref of [appY.id, appY.urn, 'hrn:app:nowhere.example:none']) {
      const today = await refusal(tickers(ctx(outsider.id), ref));
      expect(today.extensions).toMatchObject({ code: 'APP_NOT_FOUND' });
      expect(await refusal(tickers(keyCtx(hostKey), ref))).toEqual(today);
      expect(await refusal(tickersPage(keyCtx(hostKey), ref))).toEqual(await refusal(tickersPage(ctx(outsider.id), ref)));
    }
    expect(await ticker(keyCtx(hostKey), onY.id)).toBeNull();
  });

  it('G2: an attention:deliver-only key, an unscoped key, a revoked scope and a revoked key are refused as today', async () => {
    const today = await refusal(tickers(ctx(outsider.id)));
    const todayPage = await refusal(tickersPage(ctx(outsider.id)));
    for (const k of [deliverKey, plainKey, revokedScopeKey, revokedKey]) {
      expect(await refusal(tickers(keyCtx(k)))).toEqual(today);
      expect(await refusal(tickersPage(keyCtx(k)))).toEqual(todayPage);
      expect(await ticker(keyCtx(k), shared.id)).toBeNull();
      expect((await subscribers(keyCtx(k), { id: shared.id })).items).toEqual([]);
    }
  });

  it('G3: an uninstalled App, a deleted App and a deleted org refuse the host key; participants keep reading an uninstalled App', async () => {
    await db.app.update({ where: { id: appX.id }, data: { uninstalledAt: new Date() } });
    const today = await refusal(tickers(ctx(outsider.id)));
    expect(await refusal(tickers(keyCtx(hostKey)))).toEqual(today);
    expect(await ticker(keyCtx(hostKey), shared.id)).toBeNull();
    expect(ids(await tickers(ctx(member.id)))).toEqual([shared.id, kitOnly.id, adaEnded.id]);
    await db.app.update({ where: { id: appX.id }, data: { uninstalledAt: null } });

    await db.organization.update({ where: { id: org.id }, data: { deletedAt: new Date() } });
    expect(await refusal(tickers(keyCtx(hostKey)))).toEqual(today);
    expect(await ticker(keyCtx(hostKey), shared.id)).toBeNull();
    await db.organization.update({ where: { id: org.id }, data: { deletedAt: null } });

    await db.app.update({ where: { id: appX.id }, data: { deletedAt: new Date() } });
    expect(await refusal(tickers(keyCtx(hostKey)))).toEqual(await refusal(tickers(ctx(outsider.id))));
    expect(await ticker(keyCtx(hostKey), shared.id)).toBeNull();
  });

  it('G4: a session-bound host key is refused APP_KEY_SESSION_BOUND, judged after the own App and the scope', async () => {
    for (const extra of [{ sessionId: 's-1' }, { sessionBindingRefused: true }] as Partial<Context>[]) {
      expect((await refusal(tickers(keyCtx(hostKey, extra)))).extensions).toMatchObject({ code: 'APP_KEY_SESSION_BOUND' });
      expect((await refusal(tickersPage(keyCtx(hostKey, extra)))).extensions).toMatchObject({ code: 'APP_KEY_SESSION_BOUND' });
      expect((await refusal(ticker(keyCtx(hostKey, extra), shared.id))).extensions).toMatchObject({ code: 'APP_KEY_SESSION_BOUND' });
      // A session never turns a scope-less key, or another App's ref, into anything but today's answer.
      expect(await refusal(tickers(keyCtx(plainKey, extra)))).toEqual(await refusal(tickers(ctx(outsider.id))));
      expect(await ticker(keyCtx(plainKey, extra), shared.id)).toBeNull();
      expect(await refusal(tickers(keyCtx(hostKey, extra), appY.id))).toEqual(await refusal(tickers(ctx(outsider.id), appY.id)));
      expect(await ticker(keyCtx(hostKey, extra), onY.id)).toBeNull();
    }
    const asAda = await refusal(runAsActor({ workerId: ada.id, agentId }, () => tickers(keyCtx(hostKey))));
    expect(asAda.extensions).toMatchObject({ code: 'APP_KEY_SESSION_BOUND' });
  });

  it('G5: every ticker write with the host key is refused exactly as an unscoped key is, and writes nothing', async () => {
    const counts = async () => [await db.ticker.count(), await db.tickerSubscription.count(), await db.appGrant.count(), await db.workerWakeSettings.count()];
    const before = await counts();
    const writes: Array<[string, (c: Context) => Promise<unknown>]> = [
      ['createTicker', (c) => M.createTicker({}, { appRef: appX.id, input: { name: 'New', cadenceSeconds: 600 } }, c)],
      ['updateTicker', (c) => M.updateTicker({}, { ref: shared.id, input: { name: 'Renamed' } }, c)],
      ['deleteTicker', (c) => M.deleteTicker({}, { ref: shared.id }, c)],
      ['subscribeWorker', (c) => M.subscribeWorker({}, { tickerRef: kitOnly.id, workerRef: ada.id }, c)],
      ['unsubscribeWorker', (c) => M.unsubscribeWorker({}, { tickerRef: shared.id, workerRef: ada.id }, c)],
      ['setAppTickerSettings', (c) => M.setAppTickerSettings({}, { appRef: appX.id, input: { liveTickerCap: 5 } }, c)],
      ['setAppDeliverySettings', (c) => M.setAppDeliverySettings({}, { appRef: appX.id, input: { batchWindowSeconds: 900 } }, c)],
      ['setTeamPause', (c) => M.setTeamPause({}, { appRef: appX.id, paused: true }, c)],
      ['grantApp', (c) => M.grantApp({}, { appRef: appX.id, workerRef: ada.id, name: 'TICKER_SUBSCRIBE_WORKERS' }, c)],
      ['revokeAppGrant', (c) => M.revokeAppGrant({}, { appRef: appX.id, workerRef: ada.id, name: 'TICKER_SUBSCRIBE_WORKERS' }, c)],
      ['setWorkerWakeSettings', (c) => M.setWorkerWakeSettings({}, { workerRef: ada.id, input: { mentions: 'OFF' } }, c)],
      ['isolateWorker', (c) => M.isolateWorker({}, { workerRef: ada.id }, c)],
      ['clearWorkerIsolation', (c) => M.clearWorkerIsolation({}, { workerRef: ada.id }, c)],
      ['applyAgentTickerTemplates', (c) => M.applyAgentTickerTemplates({}, { workerRef: ada.id }, c)],
    ];
    for (const [name, call] of writes) {
      const unscoped = await refusal(call(keyCtx(plainKey)));
      const host = await refusal(call(keyCtx(hostKey)));
      expect({ name, ...host }).toEqual({ name, ...unscoped });
      expect(String((host.extensions as { code?: string }).code)).toMatch(/_NOT_FOUND$|^FORBIDDEN$|^UNAUTHENTICATED$/);
    }
    expect(await counts()).toEqual(before);
  });

  it('G6: the reads that stay out of scope keep refusing the host key', async () => {
    expect(await refusal(Q.appTickerSettings({}, { appRef: appX.id }, keyCtx(hostKey))))
      .toEqual(await refusal(Q.appTickerSettings({}, { appRef: appX.id }, ctx(outsider.id))));
    expect((await refusal(Q.workerWakeSettings({}, { workerRef: ada.id }, keyCtx(hostKey)))).extensions).toMatchObject({ code: 'WORKER_NOT_FOUND' });
  });
});

describe('#2931 every host-key read is a recorded use (cor:agt:070:07)', () => {
  const uses = (k: { id: string }) =>
    db.hostKeyUse.findMany({ where: { appKeyId: k.id, id: { notIn: setupUses } }, orderBy: [{ usedAt: 'asc' }, { id: 'asc' }], select: { action: true, hostId: true, count: true, refusedCode: true } });

  it('P4: one read use per admitted call, with its count', async () => {
    await tickers(keyCtx(otherHostKey));
    await tickersPage(keyCtx(otherHostKey), appX.id, { limit: 1 });
    await ticker(keyCtx(otherHostKey), kitOnly.id);
    expect(await uses(otherHostKey)).toEqual([
      { action: 'read', hostId: 'orca2', count: 2, refusedCode: null },
      { action: 'read', hostId: 'orca2', count: 1, refusedCode: null },
      { action: 'read', hostId: 'orca2', count: 1, refusedCode: null },
    ]);
  });

  it('P4: a refused read by a key that is or was a host key is recorded with its code; other callers record nothing', async () => {
    await refusal(tickers(keyCtx(revokedScopeKey)));
    expect(await uses(revokedScopeKey)).toEqual([{ action: 'read', hostId: 'orca1', count: null, refusedCode: 'APP_NOT_FOUND' }]);
    expect(await ticker(keyCtx(hostKey), kitOnly.id)).toBeNull();
    expect(await uses(hostKey)).toEqual([{ action: 'read', hostId: 'orca1', count: null, refusedCode: 'TICKER_NOT_FOUND' }]);
    await refusal(tickers(keyCtx(plainKey)));
    await tickers(ctx(member.id));
    expect(await db.hostKeyUse.count({ where: { appKeyId: { notIn: [revokedScopeKey.id, hostKey.id] }, id: { notIn: setupUses } } })).toBe(0);
  });
});

describe('#2931 the anchor re-check: a scope revoked while the read waits refuses it', () => {
  it('a revocation committed under the App\'s exclusive anchor is seen by the read that waited for it', async () => {
    let release!: () => void;
    const held = new Promise<void>((r) => { release = r; });
    let locked!: () => void;
    const isLocked = new Promise<void>((r) => { locked = r; });
    const revoker = db.$transaction(async (tx) => {
      await lockAuthorityAnchors(tx, [{ kind: 'app', id: appX.id }, { kind: 'org', id: org.id }], 'exclusive');
      await tx.appKeyScope.updateMany({ where: { appKeyId: hostKey.id, scope: 'host:operate', revokedAt: null }, data: { revokedAt: new Date(), revokedByUserId: admin.id } });
      locked();
      await held;
    }, { timeout: 20_000 });
    await isLocked;
    const read = tickers(keyCtx(hostKey)).then((r: unknown) => ({ ok: r }), (e: unknown) => ({ err: e }));
    await new Promise((r) => setTimeout(r, 300));
    release();
    await revoker;
    const out = await read as { ok?: unknown; err?: GraphQLError };
    expect(out.err?.extensions?.code).toBe('APP_NOT_FOUND');
  });
});

/** Every field of a type an unprivileged selection can name at depth one: leaves by name, objects by __typename. */
function selectionOf(type: GraphQLObjectType): string {
  return Object.values(type.getFields())
    .filter((f) => !f.args.some((a) => a.type.toString().endsWith('!') && a.defaultValue === undefined))
    .map((f) => (isLeafType(getNamedType(f.type)) ? f.name : `${f.name} { __typename }`))
    .join(' ');
}

describe('#2931 the nested surface is no wider than today (executable schema)', () => {
  const schema = buildSchema(typeDefs);
  const appType = schema.getType('App');
  const workerType = schema.getType('Worker');
  if (!isObjectType(appType) || !isObjectType(workerType)) throw new Error('App and Worker are object types');
  const run = async (api: ApolloServer<Context>, query: string, c: Context, variables: Record<string, unknown> = {}) => {
    const r = await api.executeOperation({ query, variables }, { contextValue: c });
    if (r.body.kind !== 'single') throw new Error('unexpected body');
    const { data, errors } = r.body.singleResult;
    return { data, errors: (errors ?? []).map((e) => ({ path: (e.path ?? []).slice(-1).join('.'), code: e.extensions?.code })).sort((a, b) => a.path.localeCompare(b.path)) };
  };
  let api: ApolloServer<Context>;
  beforeEach(async () => { api = new ApolloServer<Context>({ typeDefs, resolvers }); await api.start(); });
  afterEach(async () => { await api.stop(); });

  it('P-N1/P-N2: Ticker.app gives the host key what myApp gives it, field by field, errors included', async () => {
    const sel = selectionOf(appType);
    const viaTicker = await run(api, `query($r:String!){ ticker(ref:$r){ app { ${sel} } } }`, keyCtx(hostKey), { r: shared.id });
    const viaMyApp = await run(api, `query{ myApp { ${sel} } }`, keyCtx(hostKey));
    expect((viaTicker.data as any)?.ticker?.app).not.toBeNull();
    expect((viaTicker.data as any).ticker.app).toEqual((viaMyApp.data as any).myApp);
    expect(viaTicker.errors).toEqual(viaMyApp.errors);
    const explicit = await run(api, `query($r:String!){ ticker(ref:$r){ app { viewerManages memberCount members { __typename } } } }`, keyCtx(hostKey), { r: shared.id });
    expect((explicit.data as any).ticker.app).toEqual({ viewerManages: false, memberCount: 0, members: [] });
    const keys = await run(api, `query($r:String!){ ticker(ref:$r){ app { keys { __typename } } } }`, keyCtx(hostKey), { r: shared.id });
    const myKeys = await run(api, `query{ myApp { keys { __typename } } }`, keyCtx(hostKey));
    expect(keys.errors.length).toBeGreaterThan(0);
    expect(keys.errors).toEqual(myKeys.errors);
  });

  it('P-N3/P-N5: a subscriber\'s worker equals worker(ref) for the key; owner and createdBy name a person as a participant sees them', async () => {
    const sel = selectionOf(workerType);
    const viaTicker = await run(api, `query($r:String!){ ticker(ref:$r){ owner { id name urn } subscribers { items { createdBy { id name urn } worker { ${sel} } } } } }`, keyCtx(hostKey), { r: shared.id });
    const direct = await run(api, `query($w:ID!){ worker(ref:$w){ ${sel} } }`, keyCtx(hostKey), { w: ada.id });
    const items = (viaTicker.data as any).ticker.subscribers.items;
    expect(items).toHaveLength(1);
    expect(items[0].worker).toEqual((direct.data as any).worker);
    const asMember = await run(api, `query($r:String!){ ticker(ref:$r){ owner { id name urn } subscribers { items { createdBy { id name urn } } } } }`, ctx(member.id), { r: shared.id });
    expect((viaTicker.data as any).ticker.owner).toEqual((asMember.data as any).ticker.owner);
    expect(items[0].createdBy).toEqual((asMember.data as any).ticker.subscribers.items[0].createdBy);
    expect((viaTicker.data as any).ticker.owner).toMatchObject({ id: admin.id, urn: null });
  });

  it('a subscription\'s ticker, read back through the key, still lists only the host\'s workers', async () => {
    const r = await run(api, `query($r:String!){ ticker(ref:$r){ subscribers { items { ticker { subscribers { items { worker { id } } } } } } } }`, keyCtx(hostKey), { r: shared.id });
    expect((r.data as any).ticker.subscribers.items[0].ticker.subscribers.items).toEqual([{ worker: { id: ada.id } }]);
  });
});

describe('#2931 no MCP (R-e): an MCP connection authenticated by the host key is refused as today', () => {
  it('G7: hadron_ticker_list over a host-key connection answers what an unscoped key\'s connection answers', async () => {
    const call = async (k: { id: string }) => {
      const server = createMcpServerInstance({ appId: appX.id, appKeyId: k.id, roles: [] } as unknown as AuthContext, () => undefined, { kind: 'multi-app' } as never);
      const client = new Client({ name: 'hk2931', version: '1' });
      const [local, remote] = InMemoryTransport.createLinkedPair();
      await server.connect(remote); await client.connect(local);
      try {
        const r = await client.callTool({ name: 'hadron_ticker_list', arguments: { appRef: appX.id } });
        return { isError: r.isError, text: (r.content as Array<{ text: string }>).map((i) => i.text).join('\n') };
      } finally { await client.close(); await server.close(); }
    };
    const host = await call(hostKey);
    expect(host.isError).toBe(true);
    expect(host.text).toMatch(/app_not_found/i);
    expect(host).toEqual(await call(plainKey));
  });
});
