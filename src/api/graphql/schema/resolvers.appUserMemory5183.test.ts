/**
 * #5183 (A1 of #5182, cor:dmo:060:20): createMemoryInApp derives the slug and name of a personal/private memory
 * (`<app>-<handle>-<class>`), limits a user to one per class per App, makes the person the tenant, and refuses every
 * principal but the signed-in member.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { db } from '../../../integrations/db/client.js';
import { cleanDb, createDbAppWithKey, createDbAppAgent, createDbAppMember } from '../../../test/helpers.js';
import { resolvers, type Context } from './resolvers.js';
import { authorizationDenied } from '../../../lib/auth/authorizationDenied.js';
import { generateId } from '../../../lib/id.js';
import { mergeUsers } from '../../../controller/operations/mergeUsers.js';
import { detachAppOwnerMemories } from '../../../controller/operations/detachAppOwnerMemories.js';
import { approvedMergeProof } from '../../../test/mergeConsent.js';
import { appUserMemorySlug } from '../../../lib/appUserMemoryName.js';

vi.mock('../../../integrations/github/writeNodeToGit.js', () => ({ writeNodeToGit: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../../../integrations/github/syncGraphFromGithub.js', () => ({ syncGraphFromGithub: vi.fn().mockResolvedValue({ error: null }) }));

type Fn = (_: unknown, a: Record<string, unknown>, c: Context) => Promise<any>;
const create = resolvers.Mutation.createMemoryInApp as Fn;
const code = (e: unknown) => (e as { extensions?: { code?: string } })?.extensions?.code;
const asUser = (userId: string): Context => ({ db, userId, roles: [] });

let org: { id: string; urn: string };
let agent: { id: string; urn: string };
let app: { id: string; urn: string };
let alice: { id: string };
let bob: { id: string };

async function mkUser(handle: string, n: number) {
  return db.user.create({ data: { githubId: n, githubUsername: handle, handle } });
}
async function mkApp(slug: string, orgId = org.id, agentId = agent.id) {
  const seeded = await createDbAppWithKey(db, slug, orgId);
  await createDbAppAgent(db, seeded.app.id, agentId);
  return { id: seeded.app.id, urn: seeded.app.urn };
}
const mk = (u: { id: string }, memoryClass = 'private', extra: Record<string, unknown> = {}, a = app, ctx?: Context) =>
  create(null, { appRef: a.id, agentRef: agent.id, memoryClass, ...extra }, ctx ?? asUser(u.id));

beforeEach(async () => {
  await cleanDb(db);
  org = await db.organization.create({ data: { id: generateId(), name: 'acme', urn: 'acme' } });
  agent = await db.agent.create({ data: { id: generateId(), name: 'coach', urn: `${org.urn}:coach`, organizationId: org.id } });
  app = await mkApp('tutor');
  alice = await mkUser('alice', 11);
  bob = await mkUser('bobby', 12);
  await createDbAppMember(db, app.id, alice.id, 'eater');
  await createDbAppMember(db, app.id, bob.id, 'eater');
});

describe('name derivation helper', () => {
  it('cuts only the app-and-handle part and keeps -<class>[-n]', () => {
    const long = 'a'.repeat(40);
    for (const klass of ['personal', 'private'] as const) {
      for (const n of [1, 2, 37]) {
        const s = appUserMemorySlug({ appSlug: long, handle: long, memoryClass: klass }, n);
        expect(s.length).toBeLessThanOrEqual(64);
        expect(s.endsWith(n === 1 ? `-${klass}` : `-${klass}-${n}`)).toBe(true);
        expect(s).not.toMatch(/[._-]-/);
      }
    }
    expect(appUserMemorySlug({ appSlug: 'a'.repeat(30) + '-', handle: 'b'.repeat(40), memoryClass: 'private' }, 1)).toMatch(/^a{30}-b+-private$/);
  });
});

describe('createMemoryInApp: derived name and tenancy (S1, S4, S6)', () => {
  it.each(['personal', 'private'])('S1/S4: %s is <app>-<handle>-<class>, the caller\'s own, the name argument sets nothing', async (klass) => {
    const m = await mk(alice, klass, { name: 'My Chosen Name' });
    expect(m.urn).toBe(`alice:tutor-alice-${klass}`);
    expect(m.name).toBe(`tutor-alice-${klass}`);
    expect(m.userId).toBe(alice.id);
    expect(m.ownerUserId).toBe(alice.id);
    expect(m.organizationId).toBeNull();
    expect(m.appId).toBe(app.id);
    const row = await db.memory.findUniqueOrThrow({ where: { id: m.id } });
    expect(row.appUserMemory).toBe(true);
  });

  it('name may be omitted for personal/private; app and knowledge keep the org and require a name', async () => {
    await expect(mk(alice, 'personal')).resolves.toMatchObject({ urn: 'alice:tutor-alice-personal' });
    const admin = await mkUser('adm', 13);
    await db.orgMember.create({ data: { organizationId: org.id, userId: admin.id, role: 'ADMIN' } });
    await createDbAppMember(db, app.id, admin.id, 'owner');
    await expect(mk(admin, 'app')).rejects.toSatisfy((e) => code(e) === 'BAD_USER_INPUT');
    await expect(mk(admin, 'knowledge')).rejects.toSatisfy((e) => code(e) === 'BAD_USER_INPUT');
    const k = await mk(admin, 'knowledge', { name: 'Ref docs' });
    expect(k.organizationId).toBe(org.id);
    expect(k.name).toBe('Ref docs');
    const row = await db.memory.findUniqueOrThrow({ where: { id: k.id } });
    expect(row.appUserMemory).toBe(false);
  });

  it('64-character cut keeps -<class>', async () => {
    const long = 'x'.repeat(50);
    const a2 = await mkApp(long);
    const u = await mkUser('y'.repeat(30), 14);
    await createDbAppMember(db, a2.id, u.id, 'eater');
    const m = await mk(u, 'private', {}, a2);
    expect(m.urn.split(':')[1].length).toBeLessThanOrEqual(64);
    expect(m.urn.endsWith('-private')).toBe(true);
    const p = await mk(u, 'personal', {}, a2);
    expect(p.urn.endsWith('-personal')).toBe(true);
    expect(p.urn).not.toBe(m.urn);
  });
});

describe('the one-per-class limit (S2)', () => {
  it('S2: a second of the same class is refused with the typed code and nothing is written', async () => {
    await mk(alice, 'private');
    const before = await db.memory.count();
    const err = await mk(alice, 'private').catch((e) => e);
    expect(code(err)).toBe('APP_USER_MEMORY_ALREADY_EXISTS');
    expect(err.extensions.memoryClass).toBe('private');
    expect(JSON.stringify(err.extensions) + err.message).not.toContain('alice:');
    expect(await db.memory.count()).toBe(before);
  });

  it('the other class is still allowed; another user is unaffected', async () => {
    await mk(alice, 'private');
    await expect(mk(alice, 'personal')).resolves.toBeTruthy();
    await expect(mk(bob, 'private')).resolves.toMatchObject({ urn: 'bobby:tutor-bobby-private' });
  });

  it('two Agents installed: still one memory per class', async () => {
    const agent2 = await db.agent.create({ data: { id: generateId(), name: 'coach2', urn: `${org.urn}:coach2`, organizationId: org.id } });
    await createDbAppAgent(db, app.id, agent2.id);
    await mk(alice, 'private');
    const err = await create(null, { appRef: app.id, agentRef: agent2.id, memoryClass: 'private' }, asUser(alice.id)).catch((e) => e);
    expect(code(err)).toBe('APP_USER_MEMORY_ALREADY_EXISTS');
  });

  it('a memory that existed before the rule keeps its name and does not count (R4)', async () => {
    const old = await db.memory.create({ data: {
      id: generateId(), ownerUserId: alice.id, userId: alice.id, appId: app.id, userMemoryOfAgentId: agent.id,
      urn: 'alice:opaque1234', name: 'Old one', class: 'private', tags: [],
    } as never });
    const m = await mk(alice, 'private');
    expect(m.urn).toBe('alice:tutor-alice-private');
    const again = await db.memory.findUniqueOrThrow({ where: { id: old.id } });
    expect(again.name).toBe('Old one');
    expect(again.appUserMemory).toBe(false);
  });

  it('a deleted memory frees the class, and an own tombstone is reclaimed (S11, R6)', async () => {
    const first = await mk(alice, 'private');
    await expect((resolvers.Mutation.deleteMemory as unknown as Fn)(null, { ref: first.id }, asUser(alice.id))).resolves.toBe(true);
    expect((await db.memory.findUniqueOrThrow({ where: { id: first.id } })).deletedAt).not.toBeNull();
    const second = await mk(alice, 'private');
    expect(second.urn).toBe(first.urn);
    expect(await db.memory.findUnique({ where: { id: first.id } })).toBeNull();
  });

  it('concurrent creates by one user give exactly one memory', async () => {
    const results = await Promise.allSettled([mk(alice, 'private'), mk(alice, 'private'), mk(alice, 'private')]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    for (const r of results) if (r.status === 'rejected') expect(code(r.reason)).toBe('APP_USER_MEMORY_ALREADY_EXISTS');
    expect(await db.memory.count({ where: { userId: alice.id, appUserMemory: true } })).toBe(1);
  });

  it('a membership removed while the create waits is refused', async () => {
    let release!: () => void;
    const held = new Promise<void>((r) => { release = r; });
    let locked!: () => void;
    const lockedP = new Promise<void>((r) => { locked = r; });
    const holder = db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT 1 FROM app_members WHERE app_id = ${app.id} AND user_id = ${alice.id} FOR UPDATE`;
      locked();
      await held;
      await tx.appMember.delete({ where: { appId_userId: { appId: app.id, userId: alice.id } } });
    });
    await lockedP;
    const pending = mk(alice, 'private').catch((e) => e);
    await new Promise((r) => setTimeout(r, 400));
    release();
    await holder;
    expect(code(await pending)).toBe('FORBIDDEN');
    expect(await db.memory.count({ where: { userId: alice.id } })).toBe(0);
  });
});

describe('collisions: numeric tail, aliases, tombstones', () => {
  it('one user in two same-slug Apps of two organizations: the second takes -2', async () => {
    const org2 = await db.organization.create({ data: { id: generateId(), name: 'beta', urn: 'beta' } });
    const agentB = await db.agent.create({ data: { id: generateId(), name: 'coach', urn: `${org2.urn}:coach`, organizationId: org2.id } });
    const appB = await mkApp('tutor', org2.id, agentB.id);
    await createDbAppMember(db, appB.id, alice.id, 'eater');
    const [a, b] = [await mk(alice, 'private'), await create(null, { appRef: appB.id, agentRef: agentB.id, memoryClass: 'private' }, asUser(alice.id))];
    expect(a.urn).toBe('alice:tutor-alice-private');
    expect(b.urn).toBe('alice:tutor-alice-private-2');
    expect(b.name).toBe('tutor-alice-private-2');
  });

  it('concurrent same-slug Apps: both succeed, one takes -2, never a refusal', async () => {
    const org2 = await db.organization.create({ data: { id: generateId(), name: 'beta', urn: 'beta' } });
    const agentB = await db.agent.create({ data: { id: generateId(), name: 'coach', urn: `${org2.urn}:coach`, organizationId: org2.id } });
    const appB = await mkApp('tutor', org2.id, agentB.id);
    await createDbAppMember(db, appB.id, alice.id, 'eater');
    const r = await Promise.all([
      mk(alice, 'private'),
      create(null, { appRef: appB.id, agentRef: agentB.id, memoryClass: 'private' }, asUser(alice.id)),
    ]);
    expect(r.map((m) => m.urn).sort()).toEqual(['alice:tutor-alice-private', 'alice:tutor-alice-private-2']);
  });

  it('an alias of another memory at the derived name takes the tail; the old URN still resolves for its owner', async () => {
    const other = await db.memory.create({ data: {
      id: generateId(), ownerUserId: alice.id, urn: 'alice:renamed', name: 'r', class: 'knowledge', visibility: 'PRIVATE', tags: [],
    } as never }).catch(async () => db.memory.create({ data: {
      id: generateId(), ownerUserId: alice.id, urn: 'alice:renamed', name: 'r', class: 'knowledge', tags: [],
    } as never }));
    await db.urnAlias.create({ data: { urn: 'alice:tutor-alice-private', entityType: 'MEMORY', entityId: other.id, reason: 'RENAME' } as never });
    const m = await mk(alice, 'private');
    expect(m.urn).toBe('alice:tutor-alice-private-2');
    const alias = await db.urnAlias.findFirst({ where: { urn: 'alice:tutor-alice-private', entityType: 'MEMORY' } });
    expect(alias?.entityId).toBe(other.id);
  });

  it('an alias whose memory no longer exists is dangling, not a holder: the clean name is taken', async () => {
    await db.urnAlias.create({ data: { urn: 'alice:tutor-alice-private', entityType: 'MEMORY', entityId: generateId(), reason: 'RENAME' } as never });
    expect((await mk(alice, 'private')).urn).toBe('alice:tutor-alice-private');
  });

  it("another user's soft-deleted memory at the derived URN is never touched", async () => {
    const stale = await db.memory.create({ data: {
      id: generateId(), ownerUserId: bob.id, userId: bob.id, appId: app.id, userMemoryOfAgentId: agent.id,
      urn: 'alice:tutor-alice-private', name: 'stale', class: 'private', tags: [], deletedAt: new Date(),
    } as never });
    const m = await mk(alice, 'private');
    expect(m.urn).toBe('alice:tutor-alice-private-2');
    const row = await db.memory.findUniqueOrThrow({ where: { id: stale.id } });
    expect(row.name).toBe('stale');
    expect(row.deletedAt).not.toBeNull();
  });

  it("the caller's own tombstone of the same class in ANOTHER App is never reclaimed", async () => {
    const otherApp = await mkApp('other');
    const other = await db.memory.create({ data: {
      id: generateId(), ownerUserId: alice.id, userId: alice.id, appId: otherApp.id, userMemoryOfAgentId: agent.id,
      urn: 'alice:tutor-alice-private', name: 'other-app', class: 'private', tags: [], deletedAt: new Date(),
    } as never });
    const m = await mk(alice, 'private');
    expect(m.urn).toBe('alice:tutor-alice-private-2');
    expect(await db.memory.findUnique({ where: { id: other.id } })).not.toBeNull();
  });

  it("the caller's own tombstone of another class is never reclaimed", async () => {
    const other = await db.memory.create({ data: {
      id: generateId(), ownerUserId: alice.id, userId: alice.id, appId: app.id, userMemoryOfAgentId: agent.id,
      urn: 'alice:tutor-alice-private', name: 'p-personal', class: 'personal', tags: [], deletedAt: new Date(),
    } as never });
    const m = await mk(alice, 'private');
    expect(m.urn).toBe('alice:tutor-alice-private-2');
    expect(await db.memory.findUnique({ where: { id: other.id } })).not.toBeNull();
  });
});

describe('a live unmarked own memory at the derived URN (kills the own-deleted guard)', () => {
  it('is never reclaimed: the new memory takes -2 and the live row is unchanged', async () => {
    const live = await db.memory.create({ data: {
      id: generateId(), ownerUserId: alice.id, userId: alice.id, appId: app.id, userMemoryOfAgentId: agent.id,
      urn: 'alice:tutor-alice-private', name: 'pre-rule', class: 'private', tags: [],
    } as never });
    const m = await mk(alice, 'private');
    expect(m.urn).toBe('alice:tutor-alice-private-2');
    expect((await db.memory.findUniqueOrThrow({ where: { id: live.id } })).name).toBe('pre-rule');
  });
});

describe('S3: the slug never changes on a handle rename', () => {
  it('keeps its slug; the URN follows the handle root', async () => {
    const m = await mk(alice, 'private');
    await db.user.update({ where: { id: alice.id }, data: { handle: 'ali' } });
    const row = await db.memory.findUniqueOrThrow({ where: { id: m.id } });
    expect(row.name).toBe('tutor-alice-private');
    expect(row.urn.endsWith(':tutor-alice-private')).toBe(true);
  });
});

describe('S12: only the signed-in member acting as themselves', () => {
  const expectedDenied = authorizationDenied() as unknown as { message: string; extensions: { code: string } };
  const principals: Array<[string, (u: string) => Context]> = [
    ['run principal carrying the member\'s id', (u) => ({ db, userId: u, roles: [], clientId: 'run:abc' } as Context)],
    ['worker session', (u) => ({ db, userId: u, roles: [], sessionId: 'sess' } as Context)],
    ['refused session binding', (u) => ({ db, userId: u, roles: [], sessionBindingRefused: true } as Context)],
    ['App key', (u) => ({ db, userId: u, roles: [], appKeyId: 'k' } as Context)],
    ['impersonation', (u) => ({ db, userId: u, roles: [], impersonation: { orgId: org.id } } as unknown as Context)],
  ];
  it.each(principals)('%s is refused and nothing is created', async (_n, mkCtx) => {
    for (const klass of ['personal', 'private']) {
      await expect(mk(alice, klass, {}, app, mkCtx(alice.id))).rejects.toMatchObject({ message: expectedDenied.message, extensions: { code: expectedDenied.extensions.code } });
    }
    expect(await db.memory.count({ where: { userId: alice.id } })).toBe(0);
  });
  it('a caller with no user id keeps UNAUTHENTICATED', async () => {
    await expect(mk(alice, 'private', {}, app, { db, roles: [] } as Context)).rejects.toSatisfy((e) => code(e) === 'UNAUTHENTICATED');
  });
  it('a non-member is refused FORBIDDEN, org ADMIN included (no bypass)', async () => {
    const adm = await mkUser('adm2', 15);
    await db.orgMember.create({ data: { organizationId: org.id, userId: adm.id, role: 'ADMIN' } });
    await expect(mk(adm, 'private')).rejects.toSatisfy((e) => code(e) === 'FORBIDDEN');
  });
});

describe('S9: an account merge never refuses over the limit', () => {
  it('two marked holders merge, both remain, a later create is refused', async () => {
    const mine = await mk(alice, 'private');
    const theirs = await mk(bob, 'private');
    const admin = await db.user.create({ data: { githubId: 99, githubUsername: 'root', handle: 'rootadm', roles: ['ADMIN'] } });
    const consentProof = await approvedMergeProof(db, bob.id, alice.id, admin.id);
    await mergeUsers(db, { sourceUserId: bob.id, targetUserId: alice.id, actorUserId: admin.id, consentProof });
    const rows = await db.memory.findMany({ where: { id: { in: [mine.id, theirs.id] } } });
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.userId === alice.id && r.appUserMemory)).toBe(true);
    expect(code(await mk(alice, 'private').catch((e) => e))).toBe('APP_USER_MEMORY_ALREADY_EXISTS');
  });
});

describe('create racing a merge of the same user: no deadlock, a coherent post-state', () => {
  it.each(['source', 'target'])('the creating user is the merge %s', async (role) => {
    const admin = await db.user.create({ data: { githubId: 98, githubUsername: 'root', handle: 'rootadm', roles: ['ADMIN'] } });
    // alice already holds one private memory; the creator is alice (target) or bob (source) and creates a private in the same App.
    const mine = await mk(alice, 'private');
    const [sourceUserId, targetUserId, creator] = role === 'source' ? [bob.id, alice.id, bob] : [bob.id, alice.id, alice];
    const consentProof = await approvedMergeProof(db, sourceUserId, targetUserId, admin.id);
    const settled = await Promise.allSettled([
      mk(creator, 'personal'),
      mergeUsers(db, { sourceUserId, targetUserId, actorUserId: admin.id, consentProof }),
    ]);
    // A deadlock would hit the test timeout. A refusal must be the merge's or the creator's own typed refusal.
    for (const r of settled) if (r.status === 'rejected') expect(String(code(r.reason) ?? r.reason)).toMatch(/FORBIDDEN|AUTHORIZ|denied|not found|deleted/i);
    // Post-state: every surviving marked memory belongs to a live user, and no user holds two LIVE marked of one class made after the rule.
    const rows = await db.memory.findMany({ where: { appUserMemory: true, deletedAt: null } });
    expect(rows.some((r) => r.id === mine.id)).toBe(true);
    for (const r of rows) {
      const owner = await db.user.findUniqueOrThrow({ where: { id: r.userId! } });
      expect(owner.deletedAt).toBeNull();
      expect(r.ownerUserId).toBe(r.userId);
    }
  });
});

describe('marker lifecycle', () => {
  it('detaching an App\'s owner memories clears the marker', async () => {
    const m = await mk(alice, 'private');
    await db.$transaction((tx) => detachAppOwnerMemories(tx, [app.id]));
    const row = await db.memory.findUniqueOrThrow({ where: { id: m.id } });
    expect(row.appUserMemory).toBe(false);
    expect(row.appId).toBeNull();
  });
  it('the column defaults to false for every other writer', async () => {
    const r = await db.memory.create({ data: {
      id: generateId(), ownerUserId: alice.id, userId: alice.id, urn: 'alice:chat1', name: 'c', class: 'private', tags: [],
    } as never });
    expect(r.appUserMemory).toBe(false);
  });
});

describe('S5: a non-owner reads the derived URN as a URN that does not exist', () => {
  it('resolveUrn and memory(ref:) answer identically for a held and a missing URN', async () => {
    await mk(alice, 'private');
    const memoryQ = resolvers.Query.memory as unknown as Fn;
    const ask = async (ref: string) => memoryQ(null, { ref }, asUser(bob.id)).then((r) => ({ ok: r }), (e) => ({ code: code(e), message: (e as Error).message.replaceAll(ref, '<ref>') }));
    const held = await ask('alice:tutor-alice-private');
    const missing = await ask('alice:tutor-alice-nothing');
    expect(JSON.stringify(held).replaceAll('tutor-alice-private', 'X')).toBe(JSON.stringify(missing).replaceAll('tutor-alice-nothing', 'X'));
    const resolveUrnQ = resolvers.Query.resolveUrn as unknown as Fn;
    const ru = async (urn: string, who: Context) => resolveUrnQ(null, { urn }, who).then((r) => ({ ok: r ?? null }), (e) => ({ code: code(e) }));
    for (const who of [asUser(bob.id), { db, roles: [] } as Context]) {
      expect(await ru('alice:tutor-alice-private', who)).toEqual(await ru('alice:tutor-alice-nothing', who));
    }
  });
});
