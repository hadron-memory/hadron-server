/**
 * #5393 (hrn:node:hadronmemory.com:specs:cor:dmo:060:22, hrn:node:hadronmemory.com:specs:cor:api:120:02): the
 * attachable-memory picker's server-side search door, `attachableMemories(appRef, query, limit, offset)`.
 *
 * The seven acceptance pins of the issue, in its order. Pin 1 is the parity pin: the door enumerates the SAME own-right read
 * judgment `attachMemoryToApp` applies one memory at a time, so it can neither offer a memory attach refuses nor hide one
 * attach accepts (bar the two exclusions the door adds on purpose: class `app` per R3, and an existing link).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApolloServer } from '@apollo/server';
import { db } from '../../../integrations/db/client.js';
import { cleanDb, createDbOrgAndGraph } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { seedRateConfig } from '../../../lib/rateLimit/index.js';
import { getAccessibleMemoryIds, memoryIdsHeldIndependently, holdsContentReadIndependently } from './resolvers.helpers.js';
import { typeDefs } from './typeDefs.js';
import { resolvers, type Context } from './resolvers.js';

vi.mock('../../../integrations/github/writeNodeToGit.js', () => ({
  writeNodeToGit: vi.fn().mockResolvedValue(undefined),
}));

const server = new ApolloServer<Context>({ typeDefs, resolvers });
const M = resolvers.Mutation as any;

let org: { id: string; urn: string };
let base: { id: string }; // the org's own knowledge memory createDbOrgAndGraph makes; alice reads it
let otherOrg: { id: string; urn: string };
let alice: string; // org READER, member of orgApp and appB: the picker's user
let bob: string; // org READER, member of orgApp: another attacher
let carol: string; // outsider, member of no App
let otto: string; // owns a user-owned memory nobody else reads
let admin: string; // platform ADMIN, member of orgApp
let orgApp: { id: string; urn: string };
let appB: { id: string; urn: string }; // no links: the differential's clean App
let otherApp: { id: string; urn: string };

const asUser = (userId: string, extra: Partial<Context> = {}): Context => ({ db, userId, roles: [], ...extra } as Context);

const Q = `query($appRef: ID!, $query: String, $limit: Int, $offset: Int) {
  attachableMemories(appRef: $appRef, query: $query, limit: $limit, offset: $offset) { total items { id name urn class } }
}`;

async function gql(ctx: Context, variables: Record<string, unknown>) {
  const r = await server.executeOperation({ query: Q, variables }, { contextValue: ctx });
  if (r.body.kind !== 'single') throw new Error('single response required');
  return r.body.singleResult as { data?: any; errors?: Array<{ message: string; extensions?: Record<string, unknown> }> };
}
async function page(ctx: Context, variables: Record<string, unknown>) {
  const r = await gql(ctx, variables);
  expect(r.errors).toBeUndefined();
  return r.data.attachableMemories as { total: number; items: Array<{ id: string; name: string; urn: string; class: string }> };
}
async function refusal(ctx: Context, variables: Record<string, unknown>) {
  const r = await gql(ctx, variables);
  expect(r.data?.attachableMemories ?? null).toBeNull();
  const e = r.errors?.[0];
  return e ? { code: e.extensions?.code, message: e.message } : null;
}
/** Every row the door offers, walked with a small page so the walk itself is exercised. */
async function walk(ctx: Context, appRef: string, query?: string) {
  const out: string[] = [];
  for (let offset = 0; ; offset += 3) {
    const p = await page(ctx, { appRef, query, limit: 3, offset });
    out.push(...p.items.map((m) => m.id));
    if (p.items.length < 3) return out;
  }
}
const attach = (c: Context, memoryRef: string, appRef: string) =>
  M.attachMemoryToApp(null, { memoryRef, appRef }, c).then(() => true, () => false);

async function memory(data: Record<string, unknown>) {
  return db.memory.create({
    data: { id: generateId(), name: 'm', urn: `${org.urn}:m-${generateId().slice(-8)}`, class: 'knowledge', visibility: 'ORGANIZATION', organizationId: org.id, ...data } as never,
  });
}

beforeEach(async () => {
  await cleanDb(db);
  ({ org, graph: base } = await createDbOrgAndGraph(db, { orgName: 'attachable5393', graphName: 'base' }));
  otherOrg = (await createDbOrgAndGraph(db, { orgName: 'elsewhere5393', graphName: 'base' })).org;
  const person = async (n: number, h: string, roles: string[] = []) =>
    (await db.user.create({ data: { id: generateId(), githubId: 5_393_000 + n, githubUsername: h, handle: `${h}-${generateId().slice(-6)}`, roles } as never })).id;
  [alice, bob, carol, otto, admin] = [
    await person(1, 'alice'), await person(2, 'bob'), await person(3, 'carol'), await person(4, 'otto'), await person(5, 'adm', ['ADMIN']),
  ];
  for (const u of [alice, bob]) await db.orgMember.create({ data: { organizationId: org.id, userId: u, role: 'READER' } });
  const app = (name: string, organizationId: string, urn: string) =>
    db.app.create({ data: { id: generateId(), organizationId, name, urn } as never }) as unknown as Promise<{ id: string; urn: string }>;
  orgApp = await app('OrgApp', org.id, `${org.urn}:orgapp`);
  appB = await app('AppB', org.id, `${org.urn}:appb`);
  otherApp = await app('Other', org.id, `${org.urn}:other`);
  for (const u of [alice, bob, admin]) await db.appMember.create({ data: { appId: orgApp.id, userId: u, role: 'member' } });
  await db.appMember.create({ data: { appId: appB.id, userId: alice, role: 'member' } });
  await db.appMember.create({ data: { appId: otherApp.id, userId: alice, role: 'member' } });
});

/** The fixture every pin reads: one of each shape the read judgment and the door's filter distinguish. */
async function fixture() {
  const m = {
    knowledge: await memory({ name: 'Alpha Knowledge' }),
    group: await memory({ name: 'Beta Group', class: 'group', visibility: 'GROUP' }),
    personal: await memory({ name: 'Gamma Personal', class: 'personal', userId: alice, visibility: null }),
    privateOwn: await memory({ name: 'Delta Private', class: 'private', userId: alice, visibility: null }),
    userOwned: await memory({ name: 'Epsilon Mine', organizationId: null, ownerUserId: alice, urn: `alice-${generateId().slice(-6)}:mine` }),
    publicElsewhere: await memory({ name: 'Zeta Public', organizationId: otherOrg.id, visibility: 'PUBLIC', urn: `${otherOrg.urn}:pub` }),
    system: await memory({ name: 'Eta System', class: 'system', visibility: null }),
    appClass: await memory({ name: 'Theta App', class: 'app', appId: orgApp.id, visibility: null }),
    viaOtherAppOnly: await memory({ name: 'Iota Other App', class: 'app', appId: otherApp.id, visibility: null }),
    // #653: a knowledge memory provisioned inside another App: alice reaches it only through that App, never in her own right
    knowledgeOfOtherApp: await memory({ name: 'Iota Knowledge Other App', appId: otherApp.id }),
    ottos: await memory({ name: 'Kappa Otto', class: 'personal', userId: otto, organizationId: null, ownerUserId: otto, visibility: null, urn: `otto-${generateId().slice(-6)}:p` }),
    foreignOrg: await memory({ name: 'Lambda Foreign', organizationId: otherOrg.id, urn: `${otherOrg.urn}:k` }),
    deleted: await memory({ name: 'Mu Deleted', deletedAt: new Date() }),
    linkedByBob: await memory({ name: 'Nu Linked' }),
    linkedInactive: await memory({ name: 'Xi Inactive' }),
  };
  await db.memoryMember.create({ data: { memoryId: m.group.id, userId: alice, role: 'reader' } as never });
  await db.appMemoryLink.create({ data: { appId: orgApp.id, memoryId: m.linkedByBob.id, attachedBy: bob } });
  // carol reads nothing of this memory in her own right: the link exists and is INACTIVE (cor:dmo:060:22).
  await db.appMemoryLink.create({ data: { appId: orgApp.id, memoryId: m.linkedInactive.id, attachedBy: carol } });
  return m;
}

describe('#5393 pin 1: the differential — the door and attachMemoryToApp cannot diverge', () => {
  it('every offered memory is accepted by attach, and every memory attach would accept (bar class app) is offered', async () => {
    await fixture();
    for (const caller of [alice, admin]) {
      const ctx = asUser(caller, caller === admin ? { roles: ['ADMIN'] } : {});
      if (caller === admin) await db.appMember.create({ data: { appId: appB.id, userId: admin, role: 'member' } });
      const offered = new Set(await walk(ctx, appB.id));
      expect(offered.size).toBeGreaterThan(0);
      const all = await db.memory.findMany({ select: { id: true, class: true } });
      // Judge attach on a clean App per caller, AFTER the door answered (attach writes links).
      for (const mem of all) {
        const accepted = await attach(ctx, mem.id, appB.id);
        if (offered.has(mem.id)) expect({ id: mem.id, accepted }).toEqual({ id: mem.id, accepted: true });
        else if (mem.class !== 'app') expect({ id: mem.id, class: mem.class, accepted }).toEqual({ id: mem.id, class: mem.class, accepted: false });
      }
      await db.appMemoryLink.deleteMany({ where: { appId: appB.id } });
    }
  });

  it('offers exactly the own-right readable set for alice (org knowledge, group member, personal, private, user-owned, PUBLIC elsewhere)', async () => {
    const m = await fixture();
    const offered = new Set(await walk(asUser(alice), orgApp.id));
    expect([...offered].sort()).toEqual(
      [base, m.knowledge, m.group, m.personal, m.privateOwn, m.userOwned, m.publicElsewhere].map((x) => x.id).sort(),
    );
  });
});

describe('#5393 pin 1b: the shared own-right enumeration', () => {
  it('memoryIdsHeldIndependently leaves out what alice reaches only through an App, and agrees row by row with holdsContentReadIndependently', async () => {
    const m = await fixture();
    const ctx = asUser(alice);
    // the fixture is meaningful: alice's App-inclusive reach does contain the other App's memory
    expect(await getAccessibleMemoryIds(ctx)).toContain(m.viaOtherAppOnly.id);
    const held = await memoryIdsHeldIndependently(ctx);
    expect(held).not.toContain(m.viaOtherAppOnly.id);
    for (const mem of await db.memory.findMany({ select: { id: true } })) {
      expect({ id: mem.id, held: held.includes(mem.id) }).toEqual({ id: mem.id, held: await holdsContentReadIndependently(ctx, mem.id) });
    }
  });
});

describe('#5393 pin 2: already-linked exclusion', () => {
  it('a memory linked by another attacher, and one whose link is inactive, are not offered; the same memory is offered for an App it is not linked to', async () => {
    const m = await fixture();
    const offered = new Set(await walk(asUser(alice), orgApp.id));
    expect(offered.has(m.linkedByBob.id)).toBe(false);
    expect(offered.has(m.linkedInactive.id)).toBe(false);
    const elsewhere = new Set(await walk(asUser(alice), appB.id));
    expect(elsewhere.has(m.linkedByBob.id)).toBe(true);
    expect(elsewhere.has(m.linkedInactive.id)).toBe(true);
  });

  it("a memory the caller's own attach links leaves the list", async () => {
    const m = await fixture();
    expect(new Set(await walk(asUser(alice), appB.id)).has(m.knowledge.id)).toBe(true);
    await M.attachMemoryToApp(null, { memoryRef: m.knowledge.id, appRef: appB.id }, asUser(alice));
    expect(new Set(await walk(asUser(alice), appB.id)).has(m.knowledge.id)).toBe(false);
  });
});

describe('#5393 pin 3: class filter (no system, no app — R3)', () => {
  it('a platform admin, who reads system and app memories in their own right, is offered neither', async () => {
    const m = await fixture();
    const offered = await page(asUser(admin, { roles: ['ADMIN'] }), { appRef: orgApp.id, limit: 200 });
    const classes = new Set(offered.items.map((x) => x.class));
    expect(classes.has('system')).toBe(false);
    expect(classes.has('app')).toBe(false);
    // the admin reads them: attach accepts the app-class one today (the mutation's own R3 tightening is out of scope)
    expect(await attach(asUser(admin, { roles: ['ADMIN'] }), m.viaOtherAppOnly.id, orgApp.id)).toBe(true);
    expect(offered.items.some((x) => x.id === m.knowledge.id)).toBe(true);
  });
});

describe('#5393 pin 4: refusals mirror attachMemoryToApp', () => {
  it('no user is UNAUTHENTICATED', async () => {
    expect(await refusal({ db, roles: [] } as Context, { appRef: orgApp.id })).toMatchObject({ code: 'UNAUTHENTICATED' });
  });

  it('an App key, a worker session, a refused binding, an impersonation and a run are one FORBIDDEN', async () => {
    const shapes: Array<Partial<Context>> = [
      { appKeyId: 'k1' }, { sessionId: 's1' }, { sessionBindingRefused: true }, { impersonation: { orgId: org.id } as never },
      { clientId: 'run:r1' },
    ];
    for (const s of shapes) expect(await refusal(asUser(alice, s), { appRef: orgApp.id })).toEqual({ code: 'FORBIDDEN', message: 'Forbidden' });
  });

  it('unknown, deleted and not-a-member are the same FORBIDDEN bytes; a member of an uninstalled App gets APP_UNINSTALLED', async () => {
    await fixture();
    const deleted = await db.app.create({ data: { id: generateId(), organizationId: org.id, name: 'Gone', urn: `${org.urn}:gone`, deletedAt: new Date() } as never });
    await db.appMember.create({ data: { appId: deleted.id, userId: alice, role: 'member' } });
    const nonMember = await refusal(asUser(carol), { appRef: orgApp.id });
    expect(nonMember).toEqual({ code: 'FORBIDDEN', message: 'Forbidden' });
    expect(await refusal(asUser(alice), { appRef: generateId() })).toEqual(nonMember);
    expect(await refusal(asUser(alice), { appRef: `${org.urn}:no-such-app` })).toEqual(nonMember);
    expect(await refusal(asUser(alice), { appRef: deleted.id })).toEqual(nonMember);
    await db.app.update({ where: { id: orgApp.id }, data: { uninstalledAt: new Date() } });
    expect(await refusal(asUser(alice), { appRef: orgApp.id })).toMatchObject({ code: 'APP_UNINSTALLED' });
    expect(await refusal(asUser(carol), { appRef: orgApp.id })).toEqual(nonMember);
  });

  it('a platform admin who is not an App member is refused (no admin bypass, as attach)', async () => {
    expect(await refusal(asUser(admin, { roles: ['ADMIN'] }), { appRef: appB.id })).toEqual({ code: 'FORBIDDEN', message: 'Forbidden' });
  });

  it('the App is accepted by URN as well as id', async () => {
    const m = await fixture();
    const byUrn = await page(asUser(alice), { appRef: orgApp.urn, limit: 200 });
    expect(byUrn.items.some((x) => x.id === m.knowledge.id)).toBe(true);
  });
});

describe('#5393 pin 5: paging (cor:api:120:02)', () => {
  it('exact total, limit 0 count-only, name then id order, and a full offset walk with no drop or duplicate', async () => {
    const twins = [];
    for (let i = 0; i < 5; i++) twins.push(await memory({ name: 'Same Name' }));
    await memory({ name: 'Aardvark' });
    await memory({ name: 'Zebra' });
    const ctx = asUser(alice);
    const count = await page(ctx, { appRef: orgApp.id, limit: 0 });
    expect(count).toEqual({ total: 8, items: [] }); // the seven above and the org's base memory
    const first = await page(ctx, { appRef: orgApp.id, limit: 200 });
    expect(first.total).toBe(8);
    const expected = await db.memory.findMany({
      where: { organizationId: org.id, deletedAt: null }, orderBy: [{ name: 'asc' }, { id: 'asc' }], select: { id: true },
    });
    expect(first.items.map((x) => x.id)).toEqual(expected.map((x) => x.id));
    const walked = await walk(ctx, orgApp.id);
    expect(walked).toEqual(expected.map((x) => x.id));
    expect(new Set(walked).size).toBe(8);
    // default page is 20, cap 200
    for (let i = 0; i < 20; i++) await memory({ name: `Filler ${String(i).padStart(2, '0')}` });
    expect((await page(ctx, { appRef: orgApp.id })).items).toHaveLength(20);
    expect((await page(ctx, { appRef: orgApp.id, limit: 1000 })).items).toHaveLength(28);
  });
});

describe('#5393 pin 6: text match', () => {
  it('case-insensitive contains on name and on urn; an empty or blank query is the unfiltered first page', async () => {
    const byName = await memory({ name: 'Quarterly Report' });
    const byUrn = await memory({ name: 'Plain', urn: `${org.urn}:quarterly-archive` });
    await memory({ name: 'Unrelated' });
    const ctx = asUser(alice);
    const hit = await page(ctx, { appRef: orgApp.id, query: 'QUARTERLY', limit: 200 });
    expect(hit.items.map((x) => x.id).sort()).toEqual([byName.id, byUrn.id].sort());
    expect(hit.total).toBe(2);
    expect((await page(ctx, { appRef: orgApp.id, query: 'rTeRlY rEp' })).items.map((x) => x.id)).toEqual([byName.id]);
    // the URN as clients render it (hrn:mem:<stored urn>) finds the memory too
    expect((await page(ctx, { appRef: orgApp.id, query: `HRN:MEM:${org.urn}:quarterly` })).items.map((x) => x.id)).toEqual([byUrn.id]);
    // a LIKE wildcard in the query is matched literally, never as a pattern
    expect((await page(ctx, { appRef: orgApp.id, query: '%' })).total).toBe(0);
    expect((await page(ctx, { appRef: orgApp.id, query: '_' })).total).toBe(0);
    const unfiltered = await page(ctx, { appRef: orgApp.id });
    expect(unfiltered.total).toBe(4); // the three above and the org's base memory
    expect(await page(ctx, { appRef: orgApp.id, query: '' })).toEqual(unfiltered);
    expect(await page(ctx, { appRef: orgApp.id, query: '   ' })).toEqual(unfiltered);
  });
});

describe('#5393 pin 7: rate admission', () => {
  it('one FAN_OUT_READS admission per call; a rate-refused call reads nothing', async () => {
    await fixture();
    await db.$transaction(seedRateConfig);
    await page(asUser(alice), { appRef: orgApp.id, limit: 0 });
    const buckets = await db.rateLimitBucket.findMany({ where: { fieldClass: 'FAN_OUT_READS', dimension: 'principal' } });
    expect(buckets.map((b) => b.used)).toEqual([1n]);
    await db.rateLimitPolicy.update({ where: { fieldClass: 'FAN_OUT_READS' }, data: { principalLimit: 1, enforcementMode: 'ENFORCING' } });
    let memoryReads = 0;
    const counted = new Proxy(db, {
      get(target, key, receiver) {
        if (key === 'memory' || key === 'app' || key === 'appMember') memoryReads++;
        return Reflect.get(target, key, receiver);
      },
    });
    const refused = await refusal(asUser(alice, { db: counted as never }), { appRef: orgApp.id });
    expect(refused).toMatchObject({ code: 'RATE_LIMITED' });
    expect(memoryReads).toBe(0);
  });
});
