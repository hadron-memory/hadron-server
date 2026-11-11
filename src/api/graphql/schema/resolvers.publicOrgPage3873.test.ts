/**
 * #3873 (cor:api:120:04, cor:acl:080:02) — `PublicOrganization.publicMemories` / `publicAgents` were unbounded lists
 * (every public row of an org, no `take`). Each now has a paged sibling (`publicMemoriesPage`, `publicAgentsPage`) in the
 * shared `{ items, total, hasMore }` envelope, and the plain field is bounded to the default page.
 *
 * Red on main: the plain fields return every row of an org with more public rows than the cap, and the page fields do not exist.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { resolvers, type Context } from './resolvers.js';

const Q = resolvers.Query as any;
const PubOrg = (resolvers as any).PublicOrganization;

const PUBLIC_COUNT = 205; // over the 200 cap
let stranger: { id: string };
let org: { id: string; urn: string };
const ctx = (): Context => ({ db, userId: stranger.id, roles: [] });
const parent = async () => Q.publicOrganization({}, { ref: org.id }, ctx());

async function seed() {
  const slug = `pg3873-${generateId()}`;
  org = await db.organization.create({ data: { id: generateId(), name: slug, urn: slug, listedOnMarketplace: true } });
  const app = await db.app.create({ data: { id: generateId(), organizationId: org.id, urn: `${org.urn}:app`, name: 'app' } });
  // Every public row shares ONE name, so ordering is decided by the id tiebreak alone.
  await db.memory.createMany({
    data: Array.from({ length: PUBLIC_COUNT }, () => ({
      id: generateId(), organizationId: org.id, urn: `${org.urn}:m-${generateId()}`, name: 'same', class: 'knowledge' as const, visibility: 'PUBLIC' as const,
    })),
  });
  await db.agent.createMany({
    data: Array.from({ length: PUBLIC_COUNT }, () => ({
      id: generateId(), organizationId: org.id, urn: `${org.urn}:a-${generateId()}`, name: 'same', visibility: 'PUBLIC' as const,
    })),
  });
  // Rows that must never appear in items or total.
  await db.memory.create({ data: { id: generateId(), organizationId: org.id, urn: `${org.urn}:priv`, name: 'priv', class: 'knowledge', visibility: 'ORGANIZATION' } });
  await db.memory.create({ data: { id: generateId(), organizationId: org.id, urn: `${org.urn}:appm`, name: 'appm', class: 'knowledge', visibility: 'PUBLIC', appId: app.id } });
  await db.agent.create({ data: { id: generateId(), organizationId: org.id, urn: `${org.urn}:pa`, name: 'pa', visibility: 'ORGANIZATION' } });
  await db.agent.create({ data: { id: generateId(), organizationId: org.id, urn: `${org.urn}:da`, name: 'da', visibility: 'PUBLIC', deletedAt: new Date() } });
}

beforeEach(async () => {
  await cleanDb(db);
  stranger = await db.user.create({ data: { id: generateId(), githubId: 73873, githubUsername: 'pg3873-stranger', roles: [] } });
  await seed();
});

const ids = (rows: Array<{ id: string }>) => rows.map(r => r.id);
const KINDS = [
  ['publicMemories', 'publicMemoriesPage'],
  ['publicAgents', 'publicAgentsPage'],
] as const;

describe.each(KINDS)('PublicOrganization.%s / %s (#3873)', (plain, paged) => {
  it('the plain field is bounded to the default page of 20, never the whole footprint', async () => {
    const rows = await PubOrg[plain](await parent(), {}, ctx());
    expect(rows).toHaveLength(20);
  });

  it('the page defaults to 20, with the exact gated total and hasMore', async () => {
    const page = await PubOrg[paged](await parent(), {}, ctx());
    expect(page.items).toHaveLength(20);
    expect(page.total).toBe(PUBLIC_COUNT); // private, app-scoped, non-PUBLIC and soft-deleted rows are not counted
    expect(page.hasMore).toBe(true);
  });

  it('a limit above the cap returns the cap, never a refusal', async () => {
    const page = await PubOrg[paged](await parent(), { limit: 100000 }, ctx());
    expect(page.items).toHaveLength(200);
    expect(page.hasMore).toBe(true);
  });

  it('walking the pages yields every public row exactly once in (name, id) order, and hasMore ends on the last page', async () => {
    const seen: string[] = [];
    let offset = 0;
    for (;;) {
      const page = await PubOrg[paged](await parent(), { limit: 50, offset }, ctx());
      seen.push(...ids(page.items));
      offset += page.items.length;
      if (!page.hasMore) { expect(offset).toBe(PUBLIC_COUNT); break; }
      expect(page.items).toHaveLength(50);
    }
    expect(new Set(seen).size).toBe(PUBLIC_COUNT);
    expect(seen).toEqual([...seen].sort()); // every name is equal, so (name, id) order is id order
  });

  it('a zero or negative limit and a negative offset are clamped, not errors', async () => {
    const zero = await PubOrg[paged](await parent(), { limit: 0 }, ctx());
    expect(zero.items).toEqual([]);
    expect(zero.total).toBe(PUBLIC_COUNT);
    const neg = await PubOrg[paged](await parent(), { limit: -5, offset: -9 }, ctx());
    expect(neg.items).toEqual([]);
    const off = await PubOrg[paged](await parent(), { limit: 3, offset: -9 }, ctx());
    expect(ids(off.items)).toEqual(ids((await PubOrg[paged](await parent(), { limit: 3, offset: 0 }, ctx())).items));
  });

  it('items keep the sanitized projection and nothing more', async () => {
    const page = await PubOrg[paged](await parent(), { limit: 1 }, ctx());
    expect(Object.keys(page.items[0]).sort()).toEqual(['description', 'id', 'name', 'urn']);
  });

  it('an offset past the end is an empty page with the real total and hasMore false', async () => {
    const page = await PubOrg[paged](await parent(), { offset: 100000 }, ctx());
    expect(page.items).toEqual([]);
    expect(page.total).toBe(PUBLIC_COUNT);
    expect(page.hasMore).toBe(false);
  });
});

describe('the parent gate is unchanged (cor:acl:080:02)', () => {
  it('a non-discoverable org and a missing org answer the same null', async () => {
    const hidden = await db.organization.create({ data: { id: generateId(), name: 'hid', urn: `hid-${generateId()}` } });
    const a = await Q.publicOrganization({}, { ref: hidden.id }, ctx());
    const b = await Q.publicOrganization({}, { ref: generateId() }, ctx());
    expect(a).toBeNull();
    expect(b).toBeNull();
  });
});
