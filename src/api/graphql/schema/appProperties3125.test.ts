/**
 * #3125 S1 — `App.properties`, `setAppProperties` and the task-integration namespace (cor:dmo:050:02, cor:dmo:050:20,
 * cor:agt:120:01; V33, V34, V43, V44, V47; Ask 5).
 */
import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { buildSchema, type GraphQLObjectType } from 'graphql';
import { ApolloServer } from '@apollo/server';
import { canonicalJson } from '../../../lib/agentTasks/properties.js';
import { APP_PROPERTIES_MAX_BYTES, checkAppPropertiesShape } from '../../../lib/appProperties.js';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { runAsActor } from '../../../lib/requestActor.js';
import { WORKER_SIGNATURE_DEFAULTS } from '../../../lib/workerSignature.js';
import { composeWorkerUrn } from '../../../lib/entityRef/workerRef.js';
import { typeDefs } from './typeDefs.js';
import { resolvers, type Context } from './resolvers.js';

vi.mock('../../../integrations/github/writeNodeToGit.js', () => ({ writeNodeToGit: vi.fn().mockResolvedValue(undefined) }));

const M = resolvers.Mutation as any;
const A = (resolvers as any).App ?? {};

let orgId: string, appId: string, appUrn: string, otherAppId: string, personalAppId: string, agentId: string;
let manager: { id: string }, owner: { id: string }, member: { id: string }, outsider: { id: string }, personalOwner: { id: string };
let ada: { id: string; slug: string }, marco: { id: string; slug: string }, foreignWorker: { id: string; slug: string }, retired: { id: string };

const ctx = (userId?: string, extra: Partial<Context> = {}): Context => ({ db, userId, roles: ['READER'], ...extra });
const set = (properties: unknown, c = ctx(manager.id), appRef = appId, expectedRevision?: number) =>
  Promise.resolve().then(() => M.setAppProperties({}, { appRef, properties, expectedRevision }, c));
const read = async (c = ctx(manager.id), id = appId) => {
  const row = await db.app.findUniqueOrThrow({ where: { id } });
  return { properties: await A.properties(row, {}, c), revision: await A.propertiesRevision(row, {}, c) };
};
const events = () => db.agentTeamEvent.findMany({ where: { appId, type: 'app.properties-changed' }, orderBy: { createdAt: 'asc' } });
const stored = async (id = appId) => db.app.findUniqueOrThrow({ where: { id }, select: { properties: true, propertiesRevision: true } });
async function refused(p: Promise<unknown>, code: string, path?: string) {
  const e = await p.then(() => null, (err) => err);
  expect(e, `expected ${code}`).not.toBeNull();
  expect(e.extensions?.code).toBe(code);
  if (path !== undefined) expect(e.extensions?.path).toBe(path);
  return e as Error;
}

const integration = (over: Record<string, unknown> = {}) => ({
  name: 'github', provider: 'github',
  repositories: ['Hadron-Memory/Hadron-Server', 'hadron-memory/hadron-cli'],
  readyLabel: 'cleared', excludeLabels: ['wontfix', 'Epic'],
  teams: [{ lead: 'Ada', label: 'team-ada' }],
  ...over,
});

beforeEach(async () => {
  await cleanDb(db);
  const org = await db.organization.create({ data: { name: 'Props', urn: `props-${generateId()}.example` } });
  orgId = org.id;
  const user = () => db.user.create({ data: { handle: `props-${generateId()}`, roles: ['READER'] } });
  [manager, owner, member, outsider, personalOwner] = await Promise.all([user(), user(), user(), user(), user()]);
  await db.orgMember.create({ data: { organizationId: orgId, userId: manager.id, role: 'ADMIN' } });
  appUrn = `${org.urn}:team`;
  appId = (await db.app.create({ data: { name: 'Team', urn: appUrn, organizationId: orgId } })).id;
  otherAppId = (await db.app.create({ data: { name: 'Other', urn: `${org.urn}:other`, organizationId: orgId } })).id;
  personalAppId = (await db.app.create({ data: { name: 'Mine', urn: `mine-${generateId()}:mine`, ownerUserId: personalOwner.id } })).id;
  await db.appMember.create({ data: { appId, userId: owner.id, role: 'owner' } });
  await db.appMember.create({ data: { appId, userId: member.id, role: 'member' } });
  agentId = (await db.agent.create({ data: { name: 'Agent', urn: `${org.urn}:agent`, organizationId: orgId } })).id;
  const worker = (app: string, name: string, slug: string, extra: Record<string, unknown> = {}) =>
    db.worker.create({ data: { ...WORKER_SIGNATURE_DEFAULTS, appId: app, agentId, name, slug, heldByUserId: manager.id, heldAt: new Date(), ...extra }, select: { id: true, slug: true } });
  ada = await worker(appId, 'Ada', 'ada');
  marco = await worker(appId, 'Marco', 'marco');
  retired = await worker(appId, 'Old', 'old', { retiredAt: new Date() });
  foreignWorker = await worker(otherAppId, 'Ada', 'ada');
});

describe('#3125 S1 SDL', () => {
  it('App carries properties and propertiesRevision, and setAppProperties takes appRef, properties and expectedRevision', () => {
    const schema = buildSchema(typeDefs);
    const app = schema.getType('App') as GraphQLObjectType;
    expect(String(app.getFields().properties?.type)).toBe('JSON');
    expect(String(app.getFields().propertiesRevision?.type)).toBe('Int!');
    const m = schema.getMutationType()!.getFields().setAppProperties!;
    expect(m.args.map((a) => `${a.name}:${String(a.type)}`)).toEqual(['appRef:String!', 'properties:JSON', 'expectedRevision:Int']);
    expect(String(m.type)).toBe('App!');
  });
});

describe('#3125 S1 round trip (V34)', () => {
  it('a manager writes an object, a reader of the App reads it back, and null clears it', async () => {
    const value = { notes: { tone: 'dry' }, [`taskIntegrations`]: [integration()] };
    const out = await set(value);
    expect(out.id).toBe(appId);
    const { properties, revision } = await read();
    expect(revision).toBe(1);
    expect(properties).toEqual({
      notes: { tone: 'dry' },
      taskIntegrations: [{
        name: 'github', provider: 'github',
        repositories: ['hadron-memory/hadron-server', 'hadron-memory/hadron-cli'],
        readyLabel: 'cleared', excludeLabels: ['wontfix', 'Epic'],
        teams: [{ lead: composeWorkerUrn(appUrn, 'ada'), label: 'team-ada' }],
      }],
    });
    // Stored by worker id, so a rename never breaks the team map.
    expect((await stored()).properties).toMatchObject({ taskIntegrations: [{ teams: [{ lead: ada.id }] }] });
    await db.worker.update({ where: { id: ada.id }, data: { name: 'Ada Lovelace' } });
    expect((await read()).properties).toMatchObject({ taskIntegrations: [{ teams: [{ lead: composeWorkerUrn(appUrn, 'ada') }] }] });
    await set(null);
    expect(await read()).toEqual({ properties: null, revision: 2 });
    expect(await stored()).toEqual({ properties: null, propertiesRevision: 2 });
  });

  it('every manager arm writes; an App owner-member and an org admin both count', async () => {
    await set({ a: 1 }, ctx(owner.id));
    await set({ a: 2 }, ctx(manager.id));
    expect((await stored()).properties).toEqual({ a: 2 });
  });

  it('a lead may be named by URN, id or name', async () => {
    for (const lead of [composeWorkerUrn(appUrn, 'marco'), marco.id, 'Marco']) {
      await set({ taskIntegrations: [integration({ teams: [{ lead, label: 'team-marco' }] })] });
      expect((await stored()).properties).toMatchObject({ taskIntegrations: [{ teams: [{ lead: marco.id }] }] });
    }
  });
});

describe('#3125 S1 write gate (V33, cor:dmo:050:20)', () => {
  const bad = { taskIntegrations: [{ name: 'BAD NAME', provider: 'nope' }], secret: 'must-not-echo' };
  it.each([
    ['an App member', () => ctx(member.id), 'FORBIDDEN'],
    ['a non-participant', () => ctx(outsider.id), 'APP_NOT_FOUND'],
    ['an impersonated manager', () => ctx(manager.id, { impersonation: { orgId, sessionId: generateId(), actorUserId: outsider.id, expiresAt: new Date(Date.now() + 60000) } } as Partial<Context>), 'FORBIDDEN'],
  ] as const)('%s is refused the same way whatever the object holds, and nothing is written', async (_who, c, code) => {
    for (const value of [{ ok: true }, bad, 'not an object']) await refused(set(value, c()), code);
    expect(await stored()).toEqual({ properties: null, propertiesRevision: 0 });
    expect(await events()).toEqual([]);
  });

  it('a manager\'s worker session is refused', async () => {
    for (const value of [{ ok: true }, bad]) await refused(runAsActor({ workerId: ada.id, agentId }, () => set(value)), 'FORBIDDEN');
    expect(await stored()).toEqual({ properties: null, propertiesRevision: 0 });
  });

  it('an App key is refused as a missing App', async () => {
    const key = await db.appKey.create({ data: { appId, label: 'Host', keyHash: generateId(), keyPreview: 'test' } });
    await refused(set({ ok: true }, ctx(undefined, { appId, appKeyId: key.id } as Partial<Context>)), 'APP_NOT_FOUND');
    expect(await stored()).toEqual({ properties: null, propertiesRevision: 0 });
  });
});

describe('#3125 S1 validation (V44, V47)', () => {
  it('a non-object is refused', async () => {
    for (const value of [[1], 'x', 3, true]) await refused(set(value), 'PROPERTIES_NOT_AN_OBJECT');
  });

  it('over 16 KiB is refused, and over 64 levels names the path', async () => {
    await refused(set({ big: 'x'.repeat(16 * 1024) }), 'PROPERTIES_TOO_LARGE');
    let deep: Record<string, unknown> = {};
    const root = deep;
    for (let i = 0; i < 64; i++) { const next = {}; deep.n = next; deep = next; }
    const e = await refused(set(root), 'PROPERTIES_TOO_LARGE');
    expect((e as any).extensions.path).toBe(Array(64).fill('n').join('.'));
    expect(await stored()).toEqual({ properties: null, propertiesRevision: 0 });
  });

  it.each([
    ['an unknown provider', { provider: 'gitlab' }, 'taskIntegrations[0].provider'],
    ['a bad name', { name: 'Has Space' }, 'taskIntegrations[0].name'],
    ['no repositories', { repositories: [] }, 'taskIntegrations[0].repositories'],
    ['a malformed repository', { repositories: ['secret-value'] }, 'taskIntegrations[0].repositories[0]'],
    ['a repository listed twice in another case', { repositories: ['a/b', 'A/B'] }, 'taskIntegrations[0].repositories[1]'],
    ['a Cf character in a label', { readyLabel: 'clea\u200Bred' }, 'taskIntegrations[0].readyLabel'],
    ['a control character in a label', { excludeLabels: ['ok', 'bad\nlabel'] }, 'taskIntegrations[0].excludeLabels[1]'],
    ['an over-long label', { readyLabel: 'x'.repeat(101) }, 'taskIntegrations[0].readyLabel'],
    ['an unknown field', { token: 'secret-value' }, 'taskIntegrations[0]'],
    ['an unknown lead', { teams: [{ lead: 'Nobody', label: 'team-x' }] }, 'taskIntegrations[0].teams[0].lead'],
    ['a lead listed twice', { teams: [{ lead: 'Ada', label: 'a' }, { lead: 'ada', label: 'b' }] }, 'taskIntegrations[0].teams[1].lead'],
  ])('%s is refused with the path, never the value, and nothing is written', async (_what, over, path) => {
    const e = await refused(set({ taskIntegrations: [integration(over)] }), 'TASK_INTEGRATION_INVALID', path);
    expect(e.message).not.toContain('secret-value');
    expect(e.message).not.toContain('\u200B');
    expect(await stored()).toEqual({ properties: null, propertiesRevision: 0 });
    expect(await events()).toEqual([]);
  });

  it('a duplicate integration name is refused', async () => {
    await refused(set({ taskIntegrations: [integration(), integration()] }), 'TASK_INTEGRATION_INVALID', 'taskIntegrations[1].name');
  });

  it('another App\'s worker, a retired worker and an unknown worker answer the same refusal', async () => {
    const messages: string[] = [];
    for (const lead of [composeWorkerUrn(`${appUrn.split(':')[0]}:other`, 'ada'), foreignWorker.id, retired.id, 'Nobody', 'hrn:worker:nowhere.example:x:y']) {
      const e = await refused(set({ taskIntegrations: [integration({ teams: [{ lead, label: 't' }] })] }), 'TASK_INTEGRATION_INVALID', 'taskIntegrations[0].teams[0].lead');
      messages.push(e.message);
    }
    expect(new Set(messages).size).toBe(1);
  });
});

describe('#3125 Ask 5: an App with no organization holds no task integration', () => {
  it('its owner may write other keys, but taskIntegrations is refused with a typed code', async () => {
    await set({ notes: 1 }, ctx(personalOwner.id), personalAppId);
    await refused(set({ notes: 2, taskIntegrations: [] }, ctx(personalOwner.id), personalAppId), 'TASK_INTEGRATION_ORG_REQUIRED');
    expect(await stored(personalAppId)).toEqual({ properties: { notes: 1 }, propertiesRevision: 1 });
  });
});

describe('#3125 S1 expected revision (V34)', () => {
  it('a stale expectedRevision is refused and a current one is accepted', async () => {
    await set({ a: 1 });
    await refused(set({ a: 2 }, ctx(manager.id), appId, 0), 'APP_PROPERTIES_CONFLICT');
    expect((await stored()).properties).toEqual({ a: 1 });
    await set({ a: 2 }, ctx(manager.id), appId, 1);
    expect(await stored()).toEqual({ properties: { a: 2 }, propertiesRevision: 2 });
  });

  it('two concurrent writes with the same expectedRevision: exactly one wins', async () => {
    const results = await Promise.allSettled([
      set({ who: 'first' }, ctx(manager.id), appId, 0),
      set({ who: 'second' }, ctx(owner.id), appId, 0),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const loser = results.find((r) => r.status === 'rejected') as PromiseRejectedResult;
    expect(loser.reason.extensions.code).toBe('APP_PROPERTIES_CONFLICT');
    expect((await stored()).propertiesRevision).toBe(1);
  });

  it('an identical write changes no revision', async () => {
    await set({ a: 1, b: [1, 2] });
    await set({ b: [1, 2], a: 1 }, ctx(manager.id), appId, 1);
    await set({}, ctx(manager.id), appId, 1);
    await set(null, ctx(manager.id), appId, 2);
    expect((await stored()).propertiesRevision).toBe(2);
  });

  // PR #3131 blind P2 (Atilla): change detection must look at OWN keys only. With `in`, a prototype-named key read as
  // present on an empty object, so its write or removal was dropped as a no-op.
  for (const key of ['constructor', 'toString', 'hasOwnProperty', 'valueOf', '__defineGetter__']) {
    it(`a top-level key named ${key} is stored, bumps the revision and records an event, on write and on removal`, async () => {
      const value = JSON.parse(`{"${key}": {}}`); // own key, as a GraphQL variable or MCP JSON arrives
      await set(value);
      const after = await stored();
      expect(after.propertiesRevision).toBe(1);
      expect(JSON.stringify(after.properties)).toBe(`{"${key}":{}}`);
      await set({}, ctx(manager.id), appId, 1);
      expect(await stored()).toEqual({ properties: null, propertiesRevision: 2 });
      expect((await events()).map((r) => (r.payload as any).keys)).toEqual([[key], [key]]);
    });
  }

  // The Prisma JSON writer drops an own `__proto__` key, so it could never be stored as sent: refused at any depth,
  // naming the path, nothing written and no event. A non-manager still gets the manager-gate refusal first.
  for (const [json, path] of [
    ['{"__proto__": {}}', '__proto__'],
    ['{"a": {"b": [1, {"__proto__": 1}]}}', 'a.b[1].__proto__'],
    ['{"taskIntegrations": [], "__proto__": null}', '__proto__'],
  ] as const) {
    it(`refuses a key named __proto__ (${path}) with PROPERTIES_KEY_RESERVED and writes nothing`, async () => {
      await set({ keep: 1 });
      const e = await refused(set(JSON.parse(json), ctx(manager.id), appId, 1), 'PROPERTIES_KEY_RESERVED', path);
      expect(e.message).not.toMatch(/"/);
      expect(await stored()).toEqual({ properties: { keep: 1 }, propertiesRevision: 1 });
      expect(await events()).toHaveLength(1);
      const other = await set(JSON.parse(json), ctx(member.id)).then(() => null, (err) => err);
      expect(other?.extensions?.code).not.toBe('PROPERTIES_KEY_RESERVED');
    });
  }
});

describe('#3125 S1 audit event (V43)', () => {
  it('one event per changing write names exactly the changed top-level keys and the writer, never a value', async () => {
    await set({ a: 1, b: { deep: 'visible-value-1' } });
    await set({ a: 1, b: { deep: 'visible-value-2' }, c: true }, ctx(owner.id));
    await set({ b: { deep: 'visible-value-2' }, c: true, a: 1 }); // identical: no event
    await set({ c: true });
    await set(null);
    await set(null); // already clear: no event
    const rows = await events();
    expect(rows.map((r) => (r.payload as any).keys)).toEqual([['a', 'b'], ['b', 'c'], ['a', 'b'], ['c']]);
    expect(rows.map((r) => r.actorUserId)).toEqual([manager.id, owner.id, manager.id, manager.id]);
    expect(rows.every((r) => r.actorWorkerId === null)).toBe(true);
    expect(JSON.stringify(rows.map((r) => r.payload))).not.toContain('visible-value');
  });

  it('a refused write records nothing', async () => {
    await refused(set({ taskIntegrations: 'x' }), 'TASK_INTEGRATION_INVALID');
    await refused(set({ a: 1 }, ctx(member.id)), 'FORBIDDEN');
    await set({ a: 1 });
    await refused(set({ a: 2 }, ctx(manager.id), appId, 0), 'APP_PROPERTIES_CONFLICT');
    expect((await events()).map((r) => (r.payload as any).keys)).toEqual([['a']]);
  });
});

describe('#3125 S1 database invariant', () => {
  it('the migration carries a byte-identical copy of the invariants file', () => {
    const source = readFileSync(new URL('../../../../prisma/app-properties-invariants.sql', import.meta.url), 'utf8');
    const migration = readFileSync(new URL('../../../../prisma/migrations/20261101150000_app_properties/migration.sql', import.meta.url), 'utf8');
    expect(migration.endsWith(source)).toBe(true);
  });

  it('the CHECK refuses a non-object and a negative revision', async () => {
    await expect(db.$executeRawUnsafe(`UPDATE apps SET properties = '[1]'::jsonb WHERE id = '${appId}'`)).rejects.toThrow(/chk_apps_properties/);
    await expect(db.$executeRawUnsafe(`UPDATE apps SET properties_revision = -1 WHERE id = '${appId}'`)).rejects.toThrow(/chk_apps_properties/);
  });
});

describe('#3125 S1 size cap after normalisation (PR #3131 local P2)', () => {
  it('an object within 16 KiB as sent but over it once leads become worker ids is refused, and nothing is written', async () => {
    const value: Record<string, unknown> = {
      pad: '',
      taskIntegrations: [integration({ teams: [{ lead: 'Ada', label: 'a' }, { lead: 'Marco', label: 'm' }] })],
    };
    value.pad = 'x'.repeat(APP_PROPERTIES_MAX_BYTES - Buffer.byteLength(canonicalJson(value), 'utf8'));
    expect(Buffer.byteLength(canonicalJson(value), 'utf8')).toBe(APP_PROPERTIES_MAX_BYTES);
    expect(() => checkAppPropertiesShape(value)).not.toThrow();
    await refused(set(value), 'PROPERTIES_TOO_LARGE', '');
    expect(await stored()).toEqual({ properties: null, propertiesRevision: 0 });
    expect(await events()).toEqual([]);
  });

  it('the same object with leads sent as worker ids (no growth) at exactly 16 KiB is stored', async () => {
    const value: Record<string, unknown> = {
      pad: '',
      taskIntegrations: [integration({ repositories: ['hadron-memory/hadron-server'], teams: [{ lead: ada.id, label: 'a' }, { lead: marco.id, label: 'm' }] })],
    };
    value.pad = 'x'.repeat(APP_PROPERTIES_MAX_BYTES - Buffer.byteLength(canonicalJson(value), 'utf8'));
    await set(value);
    expect((await stored()).propertiesRevision).toBe(1);
  });
});

describe('#3125 S1 read gate (PR #3131 security P2-1): App.properties reads like app(ref:)', () => {
  const apollo = new ApolloServer<Context>({ typeDefs, resolvers });
  const viaTickers = async (c: Context) => {
    const res = await apollo.executeOperation({
      query: 'query($a: String!) { tickers(appRef: $a) { app { id properties propertiesRevision } } }',
      variables: { a: appId },
    }, { contextValue: c });
    if (res.body.kind !== 'single') throw new Error('unexpected incremental response');
    return res.body.singleResult;
  };
  beforeEach(async () => {
    await set({ taskIntegrations: [integration()], notes: 'team-only' });
    await db.ticker.create({ data: { tickCode: 'tick.props', appId, name: 'props', slug: 'props', cadenceSeconds: 600, ownerUserId: manager.id } });
  });

  it('an App member who is not an org member reads null through tickers { app }', async () => {
    const out = await viaTickers(ctx(member.id));
    expect(out.errors).toBeUndefined();
    expect((out.data as any).tickers).toHaveLength(1);
    expect((out.data as any).tickers[0].app).toMatchObject({ id: appId, properties: null, propertiesRevision: null });
  });

  it('an App key of the App (host key or not) reads null; an outsider reads null', async () => {
    const key = await db.appKey.create({ data: { appId, label: 'Host', keyHash: generateId(), keyPreview: 'test' } });
    for (const c of [ctx(undefined, { appId, appKeyId: key.id } as Partial<Context>), ctx(outsider.id)]) {
      expect(await read(c)).toEqual({ properties: null, revision: null });
    }
  });

  it('an org member, the org admin, an App owner-member and the user-owner read the value', async () => {
    const reader = await db.user.create({ data: { handle: `props-${generateId()}`, roles: ['READER'] } });
    await db.orgMember.create({ data: { organizationId: orgId, userId: reader.id, role: 'READER' } });
    for (const u of [reader.id, manager.id, owner.id]) {
      const r = await read(ctx(u));
      expect(r.revision).toBe(1);
      expect(r.properties).toMatchObject({ notes: 'team-only' });
    }
    const out = await viaTickers(ctx(manager.id));
    expect((out.data as any).tickers[0].app).toMatchObject({ propertiesRevision: 1, properties: { notes: 'team-only' } });
    await set({ mine: true }, ctx(personalOwner.id), personalAppId);
    expect(await read(ctx(personalOwner.id), personalAppId)).toEqual({ properties: { mine: true }, revision: 1 });
    expect(await read(ctx(manager.id), personalAppId)).toEqual({ properties: null, revision: null });
  });

  it('setAppProperties returns an App its writer can read back, even an App owner-member outside the org', async () => {
    const res = await apollo.executeOperation({
      query: 'mutation($a: String!, $p: JSON) { setAppProperties(appRef: $a, properties: $p) { properties propertiesRevision } }',
      variables: { a: appId, p: { notes: 'owner-wrote' } },
    }, { contextValue: ctx(owner.id) });
    if (res.body.kind !== 'single') throw new Error('unexpected incremental response');
    expect(res.body.singleResult.errors).toBeUndefined();
    expect((res.body.singleResult.data as any).setAppProperties).toEqual({ properties: { notes: 'owner-wrote' }, propertiesRevision: 2 });
  });
});
