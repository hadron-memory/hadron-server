/**
 * #5074 (Billing F1): daily quota counters for a person (cor:acl:050:04), and the owner-aware doors.
 *
 * Pins: the `user` scope and its seeds; the launch gate and per-hop record take an owner; `quotaCounters` and
 * `setQuotaLimit` with `appRef` alone or `userRef` alone; every denial on the `appRef`-alone door answers the bytes of an
 * unknown ref (cor:api:120:01); `userRef` is FORBIDDEN with one message; the organization forms are unchanged.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { resolvers, type Context } from './resolvers.js';
import {
  consumeRunLaunchQuota,
  defaultQuotaLimit,
  quotaScopeOf,
  recordRunTokenUsage,
  RunLaunchDeniedError,
  setQuotaLimit as setLimit,
} from '../../../jobs/appRuns.js';

vi.mock('../../../lib/bus/index.js', () => ({ getBusClient: vi.fn(async () => null) }));

type U = { id: string };
let owner: U, member: U, ordinary: U, stranger: U, admin: U, gone: U;
let org: { id: string; urn: string };
let personApp: { id: string; urn: string };
let orgApp: { id: string; urn: string };

const ctxOf = (u: U | null, extra: Partial<Context> = {}): Context =>
  ({ db, roles: ['READER'], ...(u ? { userId: u.id } : {}), ...extra }) as Context;
const rows = (c: Context, args: Record<string, unknown>) => resolvers.Query.quotaCounters({}, args, c);
const set = (c: Context, input: Record<string, unknown>) => resolvers.Mutation.setQuotaLimit({}, { input }, c);
const caught = async (p: Promise<unknown>) => p.then(() => null, (e: { message: string; extensions?: { code?: string } }) => ({ message: e.message, code: e.extensions?.code }));
const count = (scopeKind: string, scopeId?: string) => db.quotaCounter.count({ where: { scopeKind, ...(scopeId ? { scopeId } : {}) } });

beforeEach(async () => {
  await cleanDb(db);
  const mk = (h: string, roles: string[] = []) => db.user.create({ data: { handle: `q5074-${h}-${generateId().slice(-5)}`, roles: roles as never } });
  [owner, member, ordinary, stranger, admin, gone] = await Promise.all([mk('own'), mk('mem'), mk('ord'), mk('str'), mk('adm', ['ADMIN']), mk('gone')]);
  await db.user.update({ where: { id: gone.id }, data: { deletedAt: new Date() } });
  org = await db.organization.create({ data: { id: generateId(), name: 'q5074-org', urn: `q5074-org-${generateId().slice(-5)}` } });
  await db.orgMember.create({ data: { organizationId: org.id, userId: ordinary.id, role: 'READER' } });
  personApp = await db.app.create({ data: { id: generateId(), ownerUserId: owner.id, name: 'pa', urn: `u-q5074::pa-${generateId().slice(-5)}` } as never });
  orgApp = await db.app.create({ data: { id: generateId(), organizationId: org.id, name: 'oa', urn: `${org.urn}::oa` } });
  await db.appMember.create({ data: { appId: personApp.id, userId: member.id, role: 'owner' } });
  await db.appMember.create({ data: { appId: personApp.id, userId: ordinary.id, role: 'member' } });
});

describe('the person-owned App door (appRef alone)', () => {
  it('the owner reads four app rows and four user rows with the seed limits, and sets the App limit', async () => {
    const r = await rows(ctxOf(owner), { appRef: personApp.id });
    expect(r.filter((x: { scopeKind: string }) => x.scopeKind === 'app')).toHaveLength(4);
    const user = r.filter((x: { scopeKind: string }) => x.scopeKind === 'user');
    expect(user).toHaveLength(4);
    expect(user.every((x: { scopeId: string }) => x.scopeId === owner.id)).toBe(true);
    expect(user.find((x: { action: string }) => x.action === 'run.execute')?.limit).toBe(1000);
    const s = await set(ctxOf(owner), { appRef: personApp.id, action: 'run.execute', limit: 5 });
    expect(s).toMatchObject({ scopeKind: 'app', scopeId: personApp.id, limit: 5 });
  });

  it('an owner-role member reads and sets the App rows, and does not receive the owner user rows', async () => {
    const r = await rows(ctxOf(member), { appRef: personApp.id });
    expect(r).toHaveLength(4);
    expect(r.every((x: { scopeKind: string }) => x.scopeKind === 'app')).toBe(true);
    expect(await set(ctxOf(member), { appRef: personApp.id, action: 'llm.tokens', limit: 7 })).toMatchObject({ limit: 7 });
    expect(await count('user')).toBe(0);
  });

  it('a platform admin reads both kinds of row and sets the App limit', async () => {
    const r = await rows(ctxOf(admin, { roles: ['ADMIN'] }), { appRef: personApp.id });
    expect(r).toHaveLength(8);
    expect(await set(ctxOf(admin, { roles: ['ADMIN'] }), { appRef: personApp.id, action: 'sms.send', limit: 3 })).toMatchObject({ limit: 3 });
  });

  const denied: Array<[string, () => Context]> = [
    ['an ordinary member', () => ctxOf(ordinary)],
    ['another user', () => ctxOf(stranger)],
    ["the App's own key (no user)", () => ({ db, roles: [], appId: personApp.id }) as Context],
    ['an impersonated session of the owner', () => ctxOf(owner, { impersonation: { sessionId: 's', actorUserId: admin.id, orgId: org.id, expiresAt: new Date(Date.now() + 60_000) } } as never)],
    ['a run acting for the owner', () => ({ ...ctxOf(owner), clientId: 'run:abc', appId: personApp.id }) as Context],
    ['the owner as a non-admin outside any session (no user)', () => ctxOf(null)],
  ];
  for (const [label, mk] of denied) {
    it(`${label}: NOT_FOUND with the bytes of an unknown ref, on both doors, and no row is created`, async () => {
      const unknown = generateId();
      const wantRead = await caught(rows(ctxOf(stranger), { appRef: unknown }));
      const wantSet = await caught(set(ctxOf(stranger), { appRef: unknown, action: 'run.execute', limit: 1 }));
      expect(wantRead).toEqual({ message: 'App not found.', code: 'NOT_FOUND' });
      expect(await caught(rows(mk(), { appRef: personApp.id }))).toEqual(wantRead);
      expect(await caught(set(mk(), { appRef: personApp.id, action: 'run.execute', limit: 1 }))).toEqual(wantSet);
      expect(await count('app')).toBe(0);
      expect(await count('user')).toBe(0);
    });
  }
});

describe('the organization-owned App door (appRef alone)', () => {
  it('an organization READER and a stranger get the bytes of an unknown ref', async () => {
    const want = await caught(rows(ctxOf(stranger), { appRef: generateId() }));
    expect(await caught(rows(ctxOf(ordinary), { appRef: orgApp.id }))).toEqual(want);
    expect(await caught(rows(ctxOf(stranger), { appRef: orgApp.id }))).toEqual(want);
    const wantSet = await caught(set(ctxOf(stranger), { appRef: generateId(), action: 'run.execute', limit: 1 }));
    expect(await caught(set(ctxOf(ordinary), { appRef: orgApp.id, action: 'run.execute', limit: 1 }))).toEqual(wantSet);
    expect(await count('app')).toBe(0);
  });

  it('a platform admin reads the App and its organization rows', async () => {
    const r = await rows(ctxOf(admin, { roles: ['ADMIN'] }), { appRef: orgApp.id });
    expect(r.map((x: { scopeKind: string }) => x.scopeKind).sort()).toEqual(['app', 'app', 'app', 'app', 'org', 'org', 'org', 'org']);
  });

  it('the orgRef forms keep their answers: READER is FORBIDDEN, admin reads', async () => {
    expect(await caught(rows(ctxOf(ordinary), { orgRef: org.id }))).toMatchObject({ code: 'FORBIDDEN' });
    expect(await rows(ctxOf(admin, { roles: ['ADMIN'] }), { orgRef: org.id, appRef: orgApp.id })).toHaveLength(8);
  });
});

describe('the userRef door', () => {
  it('a person reads four user rows of their own', async () => {
    const r = await rows(ctxOf(owner), { userRef: owner.id });
    expect(r).toHaveLength(4);
    expect(r.every((x: { scopeKind: string; scopeId: string }) => x.scopeKind === 'user' && x.scopeId === owner.id)).toBe(true);
    expect(await set(ctxOf(owner), { userRef: owner.id, action: 'run.execute', limit: 9 })).toMatchObject({ scopeKind: 'user', limit: 9 });
  });

  it('a platform admin reads and sets any live person; a missing or deleted person is NOT_FOUND "User not found." and creates no row', async () => {
    const a = ctxOf(admin, { roles: ['ADMIN'] });
    expect(await rows(a, { userRef: stranger.id })).toHaveLength(4);
    expect(await set(a, { userRef: stranger.id, action: 'email.send', limit: 2 })).toMatchObject({ limit: 2 });
    for (const ref of [generateId(), gone.id]) {
      expect(await caught(rows(a, { userRef: ref }))).toEqual({ message: 'User not found.', code: 'NOT_FOUND' });
      expect(await caught(set(a, { userRef: ref, action: 'run.execute', limit: 1 }))).toEqual({ message: 'User not found.', code: 'NOT_FOUND' });
    }
    expect(await count('user', gone.id)).toBe(0);
  });

  it('a non-admin naming another user, or nobody, gets one FORBIDDEN message and no row; a refused principal is FORBIDDEN even for self', async () => {
    const a = await caught(rows(ctxOf(stranger), { userRef: owner.id }));
    const b = await caught(rows(ctxOf(stranger), { userRef: generateId() }));
    expect(a).toMatchObject({ code: 'FORBIDDEN' });
    expect(b).toEqual(a);
    expect(await caught(set(ctxOf(stranger), { userRef: owner.id, action: 'run.execute', limit: 1 }))).toMatchObject({ code: 'FORBIDDEN' });
    const imp = ctxOf(owner, { impersonation: { sessionId: 's', actorUserId: admin.id, orgId: org.id, expiresAt: new Date(Date.now() + 60_000) } } as never);
    expect(await caught(rows(imp, { userRef: owner.id }))).toMatchObject({ code: 'FORBIDDEN' });
    expect(await caught(rows({ ...ctxOf(owner), clientId: 'run:x' } as Context, { userRef: owner.id }))).toMatchObject({ code: 'FORBIDDEN' });
    expect(await count('user')).toBe(0);
  });

  it('no ref, orgRef with userRef, and appRef with userRef are BAD_USER_INPUT before any lookup', async () => {
    const a = ctxOf(admin, { roles: ['ADMIN'] });
    for (const args of [{}, { orgRef: org.id, userRef: owner.id }, { appRef: personApp.id, userRef: owner.id }]) {
      expect(await caught(rows(a, args))).toMatchObject({ code: 'BAD_USER_INPUT' });
      expect(await caught(set(a, { ...args, action: 'run.execute', limit: 1 }))).toMatchObject({ code: 'BAD_USER_INPUT' });
    }
  });
});

describe('review pins (#5074 LOCAL F1-F3, BLIND P2-2)', () => {
  const orgAdmin = async () => {
    const u = await db.user.create({ data: { handle: `q5074-oa-${generateId().slice(-5)}`, roles: [] as never } });
    await db.orgMember.create({ data: { organizationId: org.id, userId: u.id, role: 'ADMIN' } });
    return u;
  };

  it('the four organization denial texts, compared as strings', async () => {
    const msg = (p: Promise<unknown>) => p.then(() => null, (e: Error) => e.message);
    await setLimit(db, 'org', org.id, 'llm.tokens', 0);
    expect(await msg(consumeRunLaunchQuota(db, { appId: orgApp.id, owner: { organizationId: org.id } }))).toBe('Organization token quota exhausted for today.');
    await setLimit(db, 'org', org.id, 'llm.tokens', 100);
    await setLimit(db, 'app', orgApp.id, 'llm.tokens', 0);
    expect(await msg(consumeRunLaunchQuota(db, { appId: orgApp.id, owner: { organizationId: org.id } }))).toBe('App token quota exhausted for today.');
  });

  it('a plain organization ADMIN reads the App and its organization rows through appRef alone, and the set lands on the App, not the organization', async () => {
    const oa = await orgAdmin();
    const r = await rows(ctxOf(oa), { appRef: orgApp.id });
    expect(r).toHaveLength(8);
    const s = await set(ctxOf(oa), { appRef: orgApp.id, action: 'run.execute', limit: 11 });
    expect(s).toMatchObject({ scopeKind: 'app', scopeId: orgApp.id, limit: 11 });
    const orgRow = await db.quotaCounter.findFirstOrThrow({ where: { scopeKind: 'org', scopeId: org.id, action: 'run.execute' } });
    expect(orgRow.limit).toBe(1000);
  });

  it('an App-member owner who is not an organization ADMIN gets the unknown-ref bytes on an organization App', async () => {
    await db.appMember.create({ data: { appId: orgApp.id, userId: member.id, role: 'owner' } });
    const want = await caught(rows(ctxOf(stranger), { appRef: generateId() }));
    expect(await caught(rows(ctxOf(member), { appRef: orgApp.id }))).toEqual(want);
  });

  it('an impersonated session keeps the orgRef answers: inside its organization it reads as main does, outside it is refused', async () => {
    const oa = await orgAdmin();
    const inside = ctxOf(oa, { impersonation: { sessionId: 's', actorUserId: admin.id, orgId: org.id, expiresAt: new Date(Date.now() + 60_000) } } as never);
    const other = await db.organization.create({ data: { id: generateId(), name: 'q5074-other', urn: `q5074-other-${generateId().slice(-5)}` } });
    const outside = ctxOf(oa, { impersonation: { sessionId: 's', actorUserId: admin.id, orgId: other.id, expiresAt: new Date(Date.now() + 60_000) } } as never);
    const a = await caught(rows(inside, { orgRef: org.id }));
    const b = await caught(rows(outside, { orgRef: org.id }));
    expect(b).not.toBeNull();
    expect(a === null || a.code === 'FORBIDDEN').toBe(true);
    // The App-alone door gives the same answer as the orgRef form, folded to the unknown-ref bytes when refused.
    const wantUnknown = await caught(rows(ctxOf(stranger), { appRef: generateId() }));
    expect((await caught(rows(outside, { appRef: orgApp.id })))).toEqual(wantUnknown);
  });

  it('an unstorable userRef (NUL, lone surrogate) from a platform admin is User not found, not a driver error', async () => {
    const a = ctxOf(admin, { roles: ['ADMIN'] });
    for (const ref of ['a\u0000b', 'x\uD800y']) {
      expect(await caught(rows(a, { userRef: ref }))).toEqual({ message: 'User not found.', code: 'NOT_FOUND' });
    }
  });

  it('an App of a soft-deleted organization is not found for a platform admin, as the orgRef form refuses it', async () => {
    await db.organization.update({ where: { id: org.id }, data: { deletedAt: new Date() } });
    const want = await caught(rows(ctxOf(stranger), { appRef: generateId() }));
    expect(await caught(rows(ctxOf(admin, { roles: ['ADMIN'] }), { appRef: orgApp.id }))).toEqual(want);
    expect(await count('org')).toBe(0);
  });

  it('one quota.limit.changed line per set, ids and numbers only', async () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    try {
      await set(ctxOf(owner), { appRef: personApp.id, action: 'run.execute', limit: 5 });
      await set(ctxOf(owner), { appRef: personApp.id, action: 'run.execute', limit: 6 });
      const lines = info.mock.calls.map((c) => JSON.parse(String(c[0]))).filter((l) => l.event === 'quota.limit.changed');
      expect(lines).toHaveLength(2);
      expect(lines[1]).toEqual({ event: 'quota.limit.changed', actor: owner.id, scopeKind: 'app', scopeId: personApp.id, action: 'run.execute', oldLimit: 5, newLimit: 6 });
    } finally {
      info.mockRestore();
    }
  });
});

describe('the launch gate takes an owner', () => {
  it('a person limit of 1 passes once; a second App of the same person is refused with the owner message and its own counter is given back', async () => {
    const second = await db.app.create({ data: { id: generateId(), ownerUserId: owner.id, name: 'pb', urn: `u-q5074::pb-${generateId().slice(-5)}` } as never });
    await setLimit(db, 'user', owner.id, 'run.execute', 1);
    await consumeRunLaunchQuota(db, { appId: personApp.id, owner: { userId: owner.id } });
    const err = await consumeRunLaunchQuota(db, { appId: second.id, owner: { userId: owner.id } }).then(() => null, (e: unknown) => e);
    expect(err).toBeInstanceOf(RunLaunchDeniedError);
    expect(err).toMatchObject({ code: 'QUOTA_EXCEEDED', message: "The App owner's run quota is exhausted for today." });
    const own = await db.quotaCounter.findFirstOrThrow({ where: { scopeKind: 'app', scopeId: second.id, action: 'run.execute' } });
    expect(own.used).toBe(0);
  });

  it('a person token ledger at its limit refuses the next launch with the owner token message', async () => {
    await setLimit(db, 'user', owner.id, 'llm.tokens', 10);
    await recordRunTokenUsage(db, { appId: personApp.id, owner: { userId: owner.id } }, 10);
    const err = await consumeRunLaunchQuota(db, { appId: personApp.id, owner: { userId: owner.id } }).then(() => null, (e: unknown) => e);
    expect(err).toMatchObject({ code: 'QUOTA_EXCEEDED', message: "The App owner's token quota is exhausted for today." });
  });

  it('recordRunTokenUsage adds to the App and the person llm.tokens rows', async () => {
    await recordRunTokenUsage(db, { appId: personApp.id, owner: { userId: owner.id } }, 42);
    const used = async (kind: string, id: string) => (await db.quotaCounter.findFirstOrThrow({ where: { scopeKind: kind, scopeId: id, action: 'llm.tokens' } })).used;
    expect(await used('app', personApp.id)).toBe(42);
    expect(await used('user', owner.id)).toBe(42);
  });

  it('the organization texts are unchanged', async () => {
    await setLimit(db, 'org', org.id, 'run.execute', 0);
    expect(await consumeRunLaunchQuota(db, { appId: orgApp.id, owner: { organizationId: org.id } }).then(() => null, (e: Error) => e.message)).toBe('Organization run quota exhausted for today.');
    await setLimit(db, 'app', orgApp.id, 'run.execute', 0);
    expect(await consumeRunLaunchQuota(db, { appId: orgApp.id, owner: { organizationId: org.id } }).then(() => null, (e: Error) => e.message)).toBe('App run quota exhausted for today.');
  });

  it('quotaScopeOf maps an owner to its scope', () => {
    expect(quotaScopeOf({ userId: 'u' })).toEqual({ scopeKind: 'user', scopeId: 'u' });
    expect(quotaScopeOf({ organizationId: 'o' })).toEqual({ scopeKind: 'org', scopeId: 'o' });
  });
});

describe('seeds for a person', () => {
  it('default to the organization numbers per action', () => {
    for (const a of ['run.execute', 'llm.tokens', 'sms.send', 'email.send'] as const) {
      expect(defaultQuotaLimit('user', a)).toBe(defaultQuotaLimit('org', a));
    }
    expect(defaultQuotaLimit('user', 'sms.send')).toBe(200);
    expect(defaultQuotaLimit('user', 'email.send')).toBe(100);
  });

  it('QUOTA_RUNS_PER_DAY_USER sets the seed; non-numeric, zero and negative fall back silently', async () => {
    const orig = process.env.QUOTA_RUNS_PER_DAY_USER;
    const seed = async (v: string) => {
      process.env.QUOTA_RUNS_PER_DAY_USER = v;
      vi.resetModules();
      return (await import('../../../jobs/appRuns.js')).defaultQuotaLimit('user', 'run.execute');
    };
    try {
      expect(await seed('37')).toBe(37);
      for (const bad of ['abc', '0', '-4']) expect(await seed(bad)).toBe(1000);
    } finally {
      if (orig === undefined) delete process.env.QUOTA_RUNS_PER_DAY_USER;
      else process.env.QUOTA_RUNS_PER_DAY_USER = orig;
      vi.resetModules();
    }
  });
});
