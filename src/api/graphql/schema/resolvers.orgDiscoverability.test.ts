/**
 * cor:acl:080:02 (#610 Phase 3) — non-member organization discoverability.
 *   - Query.publicOrganization returns a sanitized view ONLY for a discoverable
 *     org (activated + public footprint), else null (anti-enumeration).
 *   - It never exposes members / private memories / apps / credentials.
 *   - globalSearch surfaces a discoverable org to a non-member.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { resolvers, type Context } from './resolvers.js';

const Q = resolvers.Query as any;
const PubOrg = (resolvers as any).PublicOrganization;

let stranger: { id: string }; // member of NO org
const ctx = (): Context => ({ db, userId: stranger.id, roles: [] });

async function mkOrg(opts: { name?: string; isVisible?: boolean | null; listed?: boolean } = {}) {
  const slug = `disco-${generateId()}`;
  return db.organization.create({
    data: {
      id: generateId(),
      name: opts.name ?? slug,
      urn: slug,
      isVisible: opts.isVisible === undefined ? true : opts.isVisible,
      listedOnMarketplace: opts.listed ?? false,
    },
  });
}
const pubMemory = (org: { id: string; urn: string }, opts: { appId?: string | null; visibility?: string } = {}) =>
  db.memory.create({
    data: {
      id: generateId(), organizationId: org.id, urn: `${org.urn}:mem-${generateId()}`, name: 'pub-mem',
      class: 'knowledge', visibility: (opts.visibility ?? 'PUBLIC') as never, appId: opts.appId ?? null,
      shortDescription: 'a public memory',
    },
  });
const pubAgent = (org: { id: string; urn: string }, visibility = 'PUBLIC') =>
  db.agent.create({
    data: { id: generateId(), organizationId: org.id, urn: `${org.urn}:agent-${generateId()}`, name: 'pub-agent', visibility: visibility as never, description: 'a public agent' },
  });

beforeEach(async () => {
  await cleanDb(db);
  stranger = await db.user.create({ data: { id: generateId(), githubId: 71001, githubUsername: 'disco-stranger', roles: [] } });
});

describe('Query.publicOrganization — the discoverability gate', () => {
  it('null for an activated org with no public footprint and not listed', async () => {
    const org = await mkOrg();
    expect(await Q.publicOrganization({}, { ref: org.id }, ctx())).toBeNull();
  });

  it('returns the sanitized org when listedOnMarketplace', async () => {
    const org = await mkOrg({ listed: true });
    const res = await Q.publicOrganization({}, { ref: org.id }, ctx());
    expect(res?.id).toBe(org.id);
    expect(res?.listedOnMarketplace).toBe(true);
  });

  it('discoverable via a PUBLIC memory or a PUBLIC agent', async () => {
    const a = await mkOrg();
    await pubMemory(a);
    expect((await Q.publicOrganization({}, { ref: a.id }, ctx()))?.id).toBe(a.id);
    const b = await mkOrg();
    await pubAgent(b);
    expect((await Q.publicOrganization({}, { ref: b.id }, ctx()))?.id).toBe(b.id);
  });

  it('NULL for a hidden org even with a PUBLIC memory (activation precondition)', async () => {
    const org = await mkOrg({ isVisible: false });
    await pubMemory(org);
    expect(await Q.publicOrganization({}, { ref: org.id }, ctx())).toBeNull();
  });

  it('an app-scoped PUBLIC memory does not make the org discoverable', async () => {
    const org = await mkOrg();
    const app = await db.app.create({ data: { id: generateId(), organizationId: org.id, urn: `${org.urn}:app`, name: 'app' } });
    await pubMemory(org, { appId: app.id }); // app-scoped: never public-readable
    expect(await Q.publicOrganization({}, { ref: org.id }, ctx())).toBeNull();
  });

  it('a per-user holding (userMemoryOfAgentId set) mis-set to PUBLIC is not a footprint (review)', async () => {
    const org = await mkOrg();
    const agent = await db.agent.create({ data: { id: generateId(), organizationId: org.id, urn: `${org.urn}:ag`, name: 'ag', visibility: 'ORGANIZATION' } });
    await db.memory.create({
      data: { id: generateId(), organizationId: org.id, urn: `${org.urn}:holding`, name: 'holding', class: 'knowledge', visibility: 'PUBLIC', userMemoryOfAgentId: agent.id },
    });
    // The canonical public-read predicate excludes per-user holdings even at
    // PUBLIC — so this must NOT make the org discoverable.
    expect(await Q.publicOrganization({}, { ref: org.id }, ctx())).toBeNull();
  });

  it('unresolvable / malformed ref → null', async () => {
    expect(await Q.publicOrganization({}, { ref: 'no-such-org' }, ctx())).toBeNull();
  });
});

describe('PublicOrganization field resolvers — sanitized footprint only', () => {
  it('publicMemories/publicAgents list only PUBLIC, non-app resources', async () => {
    const org = await mkOrg({ listed: true });
    const pm = await pubMemory(org);
    await pubMemory(org, { visibility: 'ORGANIZATION' }); // excluded (not PUBLIC)
    const app = await db.app.create({ data: { id: generateId(), organizationId: org.id, urn: `${org.urn}:app`, name: 'app' } });
    await pubMemory(org, { appId: app.id }); // excluded (app-scoped)
    const pa = await pubAgent(org);
    await pubAgent(org, 'ORGANIZATION'); // excluded (not PUBLIC)

    const res = await Q.publicOrganization({}, { ref: org.id }, ctx());
    const mems = await PubOrg.publicMemories(res, {}, ctx());
    const agents = await PubOrg.publicAgents(res, {}, ctx());
    expect(mems.map((m: { id: string }) => m.id)).toEqual([pm.id]);
    expect(mems[0]).toMatchObject({ name: 'pub-mem', description: 'a public memory' });
    expect(agents.map((a: { id: string }) => a.id)).toEqual([pa.id]);
    // The sanitized type carries no members/private/credential fields.
    expect(Object.keys(mems[0]).sort()).toEqual(['description', 'id', 'name', 'urn']);
  });
});

describe('globalSearch — a non-member discovers a public org (#610)', () => {
  it('finds a discoverable org, not a non-discoverable one', async () => {
    const pub = await mkOrg({ name: 'Zenith Discoverable Co', listed: true });
    const priv = await mkOrg({ name: 'Zenith Private Co' }); // activated but no footprint
    const found = await Q.globalSearch({}, { query: 'Zenith' }, ctx());
    const orgHits = new Set(found.hits.filter((h: { entityType: string }) => h.entityType === 'organization').map((h: { id: string }) => h.id));
    expect(orgHits).toContain(pub.id);
    expect(orgHits).not.toContain(priv.id);
  });
});

describe('marketplace catalogue queries (listedOnMarketplace only, cor:acl:080:04)', () => {
  let org: { id: string; urn: string };
  beforeEach(async () => {
    org = await mkOrg({ listed: true }); // listed + activated
  });

  it('marketplaceOrganizations: listed + activated only; flat refs; { items, total }', async () => {
    const publicUnlisted = await mkOrg();
    await pubMemory(publicUnlisted); // discoverable but NOT listed
    const hiddenListed = await mkOrg({ isVisible: false, listed: true }); // listed but not activated
    const page = await Q.marketplaceOrganizations({}, {}, ctx());
    const ids = new Set(page.items.map((o: { id: string }) => o.id));
    expect(ids).toContain(org.id);
    expect(ids).not.toContain(publicUnlisted.id);
    expect(ids).not.toContain(hiddenListed.id);
    expect(page.total).toBe(1);
    // Catalogue org entry is a FLAT ref — no nested publicMemories/publicAgents
    // (which would advertise unlisted resources). Drill-down is publicOrganization.
    expect(Object.keys(page.items[0]).sort()).toEqual(['description', 'id', 'name', 'urn']);
  });

  it('marketplaceAgents: only listed + PUBLIC', async () => {
    const listedPub = await db.agent.create({ data: { id: generateId(), organizationId: org.id, urn: `${org.urn}:ag1`, name: 'listed-pub', visibility: 'PUBLIC', listedOnMarketplace: true, description: 'd' } });
    await db.agent.create({ data: { id: generateId(), organizationId: org.id, urn: `${org.urn}:ag2`, name: 'listed-org', visibility: 'ORGANIZATION', listedOnMarketplace: true } }); // not PUBLIC
    await db.agent.create({ data: { id: generateId(), organizationId: org.id, urn: `${org.urn}:ag3`, name: 'unlisted-pub', visibility: 'PUBLIC', listedOnMarketplace: false } }); // not listed
    const page = await Q.marketplaceAgents({}, {}, ctx());
    expect(page.items.map((a: { id: string }) => a.id)).toEqual([listedPub.id]);
    expect(page.total).toBe(1);
  });

  it('marketplaceMemories: only listed + public-readable (excludes unlisted / non-public / app-scoped)', async () => {
    const listedPub = await db.memory.create({ data: { id: generateId(), organizationId: org.id, urn: `${org.urn}:m1`, name: 'listed-pub', class: 'knowledge', visibility: 'PUBLIC', listedOnMarketplace: true, shortDescription: 'a listed public memory' } });
    await db.memory.create({ data: { id: generateId(), organizationId: org.id, urn: `${org.urn}:m2`, name: 'listed-org', class: 'knowledge', visibility: 'ORGANIZATION', listedOnMarketplace: true } }); // not PUBLIC
    await db.memory.create({ data: { id: generateId(), organizationId: org.id, urn: `${org.urn}:m3`, name: 'unlisted-pub', class: 'knowledge', visibility: 'PUBLIC', listedOnMarketplace: false } }); // not listed
    const app = await db.app.create({ data: { id: generateId(), organizationId: org.id, urn: `${org.urn}:app`, name: 'app' } });
    await db.memory.create({ data: { id: generateId(), organizationId: org.id, urn: `${org.urn}:m4`, name: 'listed-app', class: 'knowledge', visibility: 'PUBLIC', appId: app.id, listedOnMarketplace: true } }); // app-scoped
    const page = await Q.marketplaceMemories({}, {}, ctx());
    expect(page.items.map((m: { id: string }) => m.id)).toEqual([listedPub.id]);
    expect(page.items[0]).toMatchObject({ name: 'listed-pub', description: 'a listed public memory' });
    expect(page.total).toBe(1);
  });

  it('paginates: limit/offset slice a stable (name,id)-ordered list with the full total', async () => {
    // 3 listed public agents named A/B/C → deterministic order.
    for (const n of ['Agent A', 'Agent B', 'Agent C']) {
      await db.agent.create({ data: { id: generateId(), organizationId: org.id, urn: `${org.urn}:${generateId()}`, name: n, visibility: 'PUBLIC', listedOnMarketplace: true } });
    }
    const p1 = await Q.marketplaceAgents({}, { limit: 2, offset: 0 }, ctx());
    const p2 = await Q.marketplaceAgents({}, { limit: 2, offset: 2 }, ctx());
    expect([p1.total, p2.total]).toEqual([3, 3]);
    expect(p1.items.map((a: { name: string }) => a.name)).toEqual(['Agent A', 'Agent B']);
    expect(p2.items.map((a: { name: string }) => a.name)).toEqual(['Agent C']);
    // limit: 0 → count-only page
    expect(await Q.marketplaceAgents({}, { limit: 0 }, ctx())).toMatchObject({ items: [], total: 3 });
  });
});
