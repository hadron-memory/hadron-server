/**
 * #2109 — `App.viewerManages`: the caller's own fact "do I manage this App",
 * exposed from the shared `managesApp` predicate (cor:dmo:050:12).
 *
 * Real GraphQL execution. True/false is a known fact for an admitted App;
 * it is not permission for any operation. A pure App key, an impersonated
 * session, an AppRun and a worker-bound request all read false.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ApolloServer } from '@apollo/server';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { requestActorStorage, emptyActor, publishAmbiguousActor } from '../../../lib/requestActor.js';
import { managesApp, managesAppBatch } from '../../../lib/auth/appManagement.js';
import { resolvers, type Context } from './resolvers.js';
import { typeDefs } from './typeDefs.js';

vi.mock('../../../integrations/github/writeNodeToGit.js', () => ({ writeNodeToGit: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../../../integrations/github/syncGraphFromGithub.js', () => ({ syncGraphFromGithub: vi.fn().mockResolvedValue({ error: null }) }));

const server = new ApolloServer({ typeDefs, resolvers });

type Body = { data?: Record<string, any> | null; errors?: Array<{ message: string }> };
async function gql(query: string, ctx: Context, variables: Record<string, unknown> = {}): Promise<Body> {
  const result = await server.executeOperation({ query, variables }, { contextValue: ctx });
  return (result.body as { singleResult: Body }).singleResult;
}
const LIST = '{ apps(limit: 100) { total items { id viewerManages } } }';
const fact = (body: Body, appId: string): boolean | undefined =>
  (body.data?.apps.items as Array<{ id: string; viewerManages: boolean }>).find((a) => a.id === appId)?.viewerManages;

const ctxFor = (userId: string | undefined, over: Partial<Context> = {}): Context =>
  ({ db, userId, roles: ['READER'], ...over }) as Context;

let platformAdmin: string;
let orgAdmin: string;
let orgMember: string;
let appOwnerRole: string;
let userOwner: string;
let stranger: string;
let guideMember: string; // org member AND a non-owner member of orgApp
let orgO: string;
let orgX: string;
let orgApp: string; // org-owned, in O
let orgApp2: string; // org-owned, in O
let userApp: string; // user-owned by userOwner
let foreignApp: string; // org-owned, in X

const mkUser = async (label: string, roles: Array<'READER' | 'ADMIN'> = ['READER']) =>
  (await db.user.create({ data: { id: generateId(), name: label, handle: `${label}${generateId().slice(-6)}`, roles } })).id;
const mkApp = async (data: Record<string, unknown>) => {
  const id = generateId();
  await db.app.create({ data: { id, name: `App ${id}`, urn: `app-${id}`, ...data } as never });
  return id;
};

beforeEach(async () => {
  await cleanDb(db);
  platformAdmin = await mkUser('padmin', ['ADMIN']);
  orgAdmin = await mkUser('oadmin');
  orgMember = await mkUser('omember');
  appOwnerRole = await mkUser('aowner');
  userOwner = await mkUser('uowner');
  stranger = await mkUser('stranger');
  guideMember = await mkUser('guide');
  orgO = (await db.organization.create({ data: { id: generateId(), name: 'O', urn: `o-${generateId()}` } })).id;
  orgX = (await db.organization.create({ data: { id: generateId(), name: 'X', urn: `x-${generateId()}` } })).id;
  await db.orgMember.create({ data: { id: generateId(), organizationId: orgO, userId: orgAdmin, role: 'ADMIN' } });
  await db.orgMember.create({ data: { id: generateId(), organizationId: orgO, userId: orgMember, role: 'READER' } });
  await db.orgMember.create({ data: { id: generateId(), organizationId: orgO, userId: appOwnerRole, role: 'READER' } });
  await db.orgMember.create({ data: { id: generateId(), organizationId: orgO, userId: guideMember, role: 'READER' } });
  orgApp = await mkApp({ organizationId: orgO });
  orgApp2 = await mkApp({ organizationId: orgO });
  userApp = await mkApp({ ownerUserId: userOwner });
  foreignApp = await mkApp({ organizationId: orgX });
  await db.appMember.create({ data: { appId: orgApp, userId: appOwnerRole, role: 'owner' } });
  await db.appMember.create({ data: { appId: orgApp, userId: guideMember, role: 'guide' } });
  await db.appMember.create({ data: { appId: userApp, userId: userOwner, role: 'owner' } });
});

describe('App.viewerManages — the shared predicate, read as a caller-scoped fact', () => {
  it('an org ADMIN, an owner-role member and a platform admin manage an org-owned App; a plain org member does not', async () => {
    const asAdmin = await gql(LIST, ctxFor(orgAdmin));
    expect(asAdmin.errors).toBeUndefined();
    expect(fact(asAdmin, orgApp)).toBe(true);
    expect(fact(asAdmin, orgApp2)).toBe(true);

    const asOwnerRole = await gql(LIST, ctxFor(appOwnerRole));
    expect(fact(asOwnerRole, orgApp)).toBe(true);
    expect(fact(asOwnerRole, orgApp2)).toBe(false);

    // A non-owner App member is a participant, not a manager.
    const asGuide = await gql(LIST, ctxFor(guideMember));
    expect(fact(asGuide, orgApp)).toBe(false);

    const asMember = await gql(LIST, ctxFor(orgMember));
    expect(fact(asMember, orgApp)).toBe(false);
    expect(fact(asMember, orgApp2)).toBe(false);

    const asPlatform = await gql(LIST, ctxFor(platformAdmin, { roles: ['ADMIN'] }));
    expect(fact(asPlatform, orgApp)).toBe(true);
    expect(fact(asPlatform, foreignApp)).toBe(true);
  });

  it('a user-owned App is its owner’s alone: platform admin alone never manages it', async () => {
    expect(fact(await gql(LIST, ctxFor(userOwner)), userApp)).toBe(true);
    const point = await gql('query($r: ID!) { app(ref: $r) { id viewerManages } }', ctxFor(platformAdmin, { roles: ['ADMIN'] }), { r: userApp });
    // Not readable to a platform admin at all (strict ownership): concealed, not false.
    expect(point.data?.app ?? null).toBeNull();
  });

  it('point, list and nested reads agree', async () => {
    const ctx = ctxFor(orgAdmin);
    const point = await gql('query($r: ID!) { app(ref: $r) { id viewerManages } }', ctx, { r: orgApp });
    expect(point.errors).toBeUndefined();
    expect(point.data?.app.viewerManages).toBe(true);
    const nested = await gql('query($r: ID!) { organization(ref: $r) { apps { id viewerManages } } }', ctxFor(orgMember), { r: orgO });
    expect(nested.errors).toBeUndefined();
    const rows = nested.data?.organization.apps as Array<{ id: string; viewerManages: boolean }>;
    expect(rows.find((a) => a.id === orgApp)?.viewerManages).toBe(false);
    expect(rows.every((a) => a.viewerManages === false)).toBe(true);
  });

  it('is false, not an error, for principals that are not the direct user', async () => {
    // Pure App key (no user): the list read is the existing admission; the fact is false.
    const key = await gql(LIST, { db, appId: orgApp, roles: ['READER'] } as Context);
    expect(key.errors).toBeUndefined();
    expect(key.data?.apps.items.length).toBeGreaterThan(0);
    for (const item of key.data?.apps.items ?? []) expect(item.viewerManages).toBe(false);

    // An AppRun carrying its on-behalf-of user: that user manages the App directly, the run does not.
    const run = await gql(LIST, ctxFor(orgAdmin, { appId: orgApp, clientId: `run:${generateId()}` }));
    expect(run.errors).toBeUndefined();
    for (const item of run.data?.apps.items ?? []) expect(item.viewerManages).toBe(false);

    // A request bound to a worker session (provisional with the App-key refusal, cor:dmo:050:05).
    const bound = await requestActorStorage.run({ ...emptyActor(), workerId: generateId() }, () => gql(LIST, ctxFor(orgAdmin)));
    expect(bound.errors).toBeUndefined();
    for (const item of bound.data?.apps.items ?? []) expect(item.viewerManages).toBe(false);
    // A refused session binding and an ambiguous worker actor are not the direct user either.
    const refused = await gql(LIST, ctxFor(orgAdmin, { sessionBindingRefused: true }));
    expect(refused.errors).toBeUndefined();
    for (const item of refused.data?.apps.items ?? []) expect(item.viewerManages).toBe(false);
    const ambiguous = await requestActorStorage.run(emptyActor(), () => {
      publishAmbiguousActor([generateId(), generateId()]);
      return gql(LIST, ctxFor(orgAdmin));
    });
    expect(ambiguous.errors).toBeUndefined();
    for (const item of ambiguous.data?.apps.items ?? []) expect(item.viewerManages).toBe(false);
    // The same user without the binding is still a manager.
    expect(fact(await gql(LIST, ctxFor(orgAdmin)), orgApp)).toBe(true);
  });

  it('an impersonated session reads false', async () => {
    const res = await gql(LIST, ctxFor(orgAdmin, { impersonation: { orgId: orgO } as never }));
    expect(res.errors).toBeUndefined();
    expect(res.data?.apps.items.length).toBeGreaterThan(0);
    for (const item of res.data?.apps.items ?? []) expect(item.viewerManages).toBe(false);
  });

  it('parent admission is unchanged: selecting the field changes neither the concealment nor the error of a foreign or missing App', async () => {
    for (const ref of [foreignApp, generateId()]) {
      const without = await gql('query($r: ID!) { app(ref: $r) { id } }', ctxFor(orgMember), { r: ref });
      const withField = await gql('query($r: ID!) { app(ref: $r) { id viewerManages } }', ctxFor(orgMember), { r: ref });
      expect(withField.data?.app ?? null).toBeNull();
      expect(withField.data).toEqual(without.data);
      expect(withField.errors?.map((e) => e.message)).toEqual(without.errors?.map((e) => e.message));
    }
  });
});

describe('App.viewerManages — freshness and isolation', () => {
  it('uses live platform roles, not the token’s: a stale ADMIN token grants nothing, a promoted user is seen', async () => {
    const stale = await gql(LIST, ctxFor(stranger, { roles: ['ADMIN'] }));
    // The stranger is no org member and sees no org App; but platform-wide reads aside, the fact must be false everywhere.
    for (const item of stale.data?.apps.items ?? []) expect(item.viewerManages).toBe(false);

    await db.user.update({ where: { id: orgMember }, data: { roles: ['ADMIN'] } });
    const promoted = await gql(LIST, ctxFor(orgMember, { roles: ['READER'] }));
    expect(fact(promoted, orgApp)).toBe(true);
  });

  it('a demotion or removal committed before the load reads false on a fresh request', async () => {
    expect(fact(await gql(LIST, ctxFor(orgAdmin)), orgApp)).toBe(true);
    await db.orgMember.updateMany({ where: { organizationId: orgO, userId: orgAdmin }, data: { role: 'READER' } });
    expect(fact(await gql(LIST, ctxFor(orgAdmin)), orgApp)).toBe(false);

    expect(fact(await gql(LIST, ctxFor(appOwnerRole)), orgApp)).toBe(true);
    await db.appMember.delete({ where: { appId_userId: { appId: orgApp, userId: appOwnerRole } } });
    expect(fact(await gql(LIST, ctxFor(appOwnerRole)), orgApp)).toBe(false);
  });

  it('distinct callers never share a result, and one caller’s list mixes ownership classes correctly', async () => {
    const [a, b] = await Promise.all([gql(LIST, ctxFor(orgAdmin)), gql(LIST, ctxFor(orgMember))]);
    expect(fact(a, orgApp)).toBe(true);
    expect(fact(b, orgApp)).toBe(false);
    const owner = await gql(LIST, ctxFor(userOwner));
    expect(fact(owner, userApp)).toBe(true);
  });

  it('answers a list with a bounded number of membership queries, not one per App', async () => {
    for (let i = 0; i < 12; i += 1) await mkApp({ organizationId: orgO });
    const calls: string[] = [];
    const counted = new Proxy(db, {
      get(target, key) {
        const value = Reflect.get(target, key);
        if ((key === 'orgMember' || key === 'appMember' || key === 'user') && value && typeof value === 'object') {
          return new Proxy(value as object, {
            get(model, method) {
              const fn = Reflect.get(model, method);
              return typeof fn === 'function' ? (...args: unknown[]) => { calls.push(`${String(key)}.${String(method)}`); return fn.apply(model, args); } : fn;
            },
          });
        }
        return value;
      },
    });
    const baseline: Body = await gql('{ apps(limit: 100) { total items { id } } }', { ...ctxFor(orgMember), db: counted } as Context);
    const baselineCalls = calls.length;
    calls.length = 0;
    const res = await gql(LIST, { ...ctxFor(orgMember), db: counted } as Context);
    expect(res.errors).toBeUndefined();
    expect(res.data?.apps.items.length).toBe(baseline.data?.apps.items.length);
    expect(res.data?.apps.items.length).toBeGreaterThan(12);
    // The field adds at most the roles read plus one batch per membership table.
    expect(calls.length - baselineCalls).toBeLessThanOrEqual(3);
  });
});

describe('the shared fold: managesApp and managesAppBatch agree on every ownership class', () => {
  it('a platform ADMIN never manages a user-owned App, and the single and batch forms give the same answers', async () => {
    // A revoked org ADMIN row and a soft-deleted-org admin must not count in either form.
    const revokedAdmin = await mkUser('revoked');
    await db.orgMember.create({ data: { id: generateId(), organizationId: orgO, userId: revokedAdmin, role: 'ADMIN', deletedAt: new Date() } });
    const apps = await db.app.findMany({ select: { id: true, organizationId: true, ownerUserId: true } });
    for (const [userId, roles] of [[platformAdmin, ['ADMIN']], [orgAdmin, ['READER']], [appOwnerRole, ['READER']], [guideMember, ['READER']], [revokedAdmin, ['READER']], [userOwner, ['READER']], [stranger, ['READER']]] as const) {
      const caller = { db, userId, roles };
      const batch = await managesAppBatch(caller, apps);
      for (const app of apps) expect(batch.get(app.id), `${userId} on ${app.id}`).toBe(await managesApp(caller, app));
    }
    expect((await managesAppBatch({ db, userId: revokedAdmin, roles: ['READER'] }, apps)).get(orgApp)).toBe(false);
    const userOwned = apps.find((a) => a.id === userApp)!;
    expect(await managesApp({ db, userId: platformAdmin, roles: ['ADMIN'] }, userOwned)).toBe(false);
    expect((await managesAppBatch({ db, userId: platformAdmin, roles: ['ADMIN'] }, [userOwned])).get(userApp)).toBe(false);
  });
});
