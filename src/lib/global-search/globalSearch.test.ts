/**
 * Engine + access coverage for global search. Drives the real adapters against
 * a live test DB with hand-built principals (the unit-of-engine), plus a couple
 * of cases through the GraphQL resolver to pin the principal wiring
 * (getAccessibleMemoryIds + getMemberOrgIds) end-to-end.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { db } from '../../integrations/db/client.js';
import { cleanDb } from '../../test/helpers.js';
import { generateId } from '../id.js';
import { resolvers, type Context } from '../../api/graphql/schema/resolvers.js';
import { globalSearch } from './index.js';
import type { GlobalSearchHit, SearchEntityType, SearchPrincipal } from './types.js';

interface Fx {
  orgA: string;
  orgB: string;
  viewer: string;
  admin: string;
  memoryA: string;
  memoryB: string;
  memoryEnc: string;
  memoryC: string;
  nodeA: string;
  nodeC: string;
  agentA: string;
  agentB: string;
  agentDraft: string;
  appA: string;
  aiConfigA: string;
  aiConfigB: string;
  userNeedle: string;
}
let fx: Fx;

function viewerP(): SearchPrincipal {
  return {
    viewerUserId: fx.viewer,
    isPlatformAdmin: false,
    accessibleMemoryIds: [fx.memoryA, fx.memoryEnc, fx.memoryC],
    orgIds: [fx.orgA],
  };
}
function adminP(): SearchPrincipal {
  return { viewerUserId: fx.admin, isPlatformAdmin: true, accessibleMemoryIds: null, orgIds: null };
}
function anonP(): SearchPrincipal {
  return { viewerUserId: null, isPlatformAdmin: false, accessibleMemoryIds: [], orgIds: [] };
}

const byType = (hits: GlobalSearchHit[], t: SearchEntityType) => hits.filter((h) => h.entityType === t);
const ids = (hits: GlobalSearchHit[]) => new Set(hits.map((h) => h.id));

beforeEach(async () => {
  await cleanDb(db);

  const orgA = await db.organization.create({ data: { id: generateId(), name: 'Org A', urn: 'org-a' } });
  const orgB = await db.organization.create({ data: { id: generateId(), name: 'Org B', urn: 'org-b' } });
  const viewer = await db.user.create({ data: { githubId: 7001, githubUsername: 'gs-viewer', roles: [] } });
  const admin = await db.user.create({ data: { githubId: 7002, githubUsername: 'gs-admin', roles: ['ADMIN'] } });
  await db.orgMember.create({ data: { organizationId: orgA.id, userId: viewer.id, role: 'CONTRIBUTOR' } });

  const memoryA = await db.memory.create({
    data: { id: generateId(), organizationId: orgA.id, urn: 'org-a:alpha', name: 'Alpha Memory', description: 'the first memory', class: 'knowledge' },
  });
  const memoryB = await db.memory.create({
    data: { id: generateId(), organizationId: orgB.id, urn: 'org-b:beta', name: 'Beta Memory', description: 'the second memory', class: 'knowledge' },
  });
  const memoryEnc = await db.memory.create({
    data: { id: generateId(), organizationId: orgA.id, urn: 'org-a:vault', name: 'Vault Memory', class: 'knowledge', isEncrypted: true },
  });

  // Second accessible memory sharing nodeA's loc tail — exercises node-URN
  // precision (a full node-URN query must NOT false-match the same loc here).
  const memoryC = await db.memory.create({
    data: { id: generateId(), organizationId: orgA.id, urn: 'org-a:other', name: 'Other Memory', class: 'knowledge' },
  });

  const nodeA = await db.node.create({
    data: { id: generateId(), memoryId: memoryA.id, loc: 'guide:intro', name: 'Intro Guide', description: 'getting started', content: 'topsecret keyword body', tags: [] },
  });
  const nodeC = await db.node.create({
    data: { id: generateId(), memoryId: memoryC.id, loc: 'guide:intro', name: 'Other Intro', tags: [] },
  });
  await db.node.create({
    data: { id: generateId(), memoryId: memoryEnc.id, loc: 'sealed', name: 'Sealed Node', content: 'topsecret keyword body', tags: [] },
  });

  const agentA = await db.agent.create({
    data: { id: generateId(), organizationId: orgA.id, urn: 'org-a:juno', name: 'Juno Agent', description: 'an assistant agent', visibility: 'ORGANIZATION' },
  });
  const agentB = await db.agent.create({
    data: { id: generateId(), organizationId: orgB.id, urn: 'org-b:atlas', name: 'Atlas Agent', description: 'another agent', visibility: 'ORGANIZATION' },
  });
  // PERSONAL (creator-only draft) agent owned by viewer.
  const agentDraft = await db.agent.create({
    data: { id: generateId(), organizationId: orgA.id, urn: 'org-a:draft', name: 'Draft Agent', visibility: 'PERSONAL', createdBy: viewer.id },
  });

  const appA = await db.app.create({ data: { id: generateId(), organizationId: orgA.id, urn: 'org-a:portal', name: 'Portal App' } });
  // Uninstalled history row — must be excluded.
  await db.app.create({
    data: { id: generateId(), organizationId: orgA.id, urn: 'org-a:portal', name: 'Portal Legacy', uninstalledAt: new Date() },
  });

  const aiConfigA = await db.aiServiceConfig.create({
    data: { id: generateId(), name: 'default', organizationId: orgA.id, provider: 'anthropic', model: 'claude-x' },
  });
  const aiConfigB = await db.aiServiceConfig.create({
    data: { id: generateId(), name: 'frontier', organizationId: orgB.id, provider: 'anthropic', model: 'claude-x' },
  });

  const userNeedle = await db.user.create({
    data: { githubId: 7003, githubUsername: 'gh-needle', handle: 'needle', name: 'Search Needle' },
  });

  fx = {
    orgA: orgA.id, orgB: orgB.id, viewer: viewer.id, admin: admin.id,
    memoryA: memoryA.id, memoryB: memoryB.id, memoryEnc: memoryEnc.id, memoryC: memoryC.id,
    nodeA: nodeA.id, nodeC: nodeC.id,
    agentA: agentA.id, agentB: agentB.id, agentDraft: agentDraft.id, appA: appA.id,
    aiConfigA: aiConfigA.id, aiConfigB: aiConfigB.id, userNeedle: userNeedle.id,
  };
});

describe('globalSearch — smart-sniff', () => {
  it('free-text matches by name', async () => {
    const { hits } = await globalSearch(db, { query: 'Alpha' }, viewerP());
    expect(ids(byType(hits, 'memory'))).toContain(fx.memoryA);
    expect(byType(hits, 'memory')[0].matchedField).toBe('name');
  });

  it('PK-shaped input does an exact id lookup (and respects access)', async () => {
    const accessible = await globalSearch(db, { query: fx.memoryA }, viewerP());
    expect(byType(accessible.hits, 'memory').map((h) => h.id)).toEqual([fx.memoryA]);
    expect(byType(accessible.hits, 'memory')[0].matchedField).toBe('pk');

    const denied = await globalSearch(db, { query: fx.memoryB }, viewerP());
    expect(byType(denied.hits, 'memory')).toHaveLength(0);

    const asAdmin = await globalSearch(db, { query: fx.memoryB }, adminP());
    expect(ids(byType(asAdmin.hits, 'memory'))).toContain(fx.memoryB);
  });

  it('URN-shaped input matches URNs, separator-agnostically', async () => {
    const legacy = await globalSearch(db, { query: 'org-a:alpha' }, viewerP());
    expect(ids(byType(legacy.hits, 'memory'))).toContain(fx.memoryA);
    expect(byType(legacy.hits, 'memory')[0].matchedField).toBe('urn');

    const canonical = await globalSearch(db, { query: 'org-a::alpha' }, viewerP());
    expect(ids(byType(canonical.hits, 'memory'))).toContain(fx.memoryA);
  });

  it('node-URN search is anchored on the full URN, not just the loc', async () => {
    // nodeA (org-a:alpha) and nodeC (org-a:other) share loc "guide:intro".
    // A full node-URN query must hit only the one in the named memory.
    const { hits } = await globalSearch(db, { query: 'org-a:alpha:guide:intro' }, viewerP());
    expect(ids(byType(hits, 'node'))).toEqual(new Set([fx.nodeA]));
  });

  it('bare-loc search finds its node even amid many same-tail locs (#301)', async () => {
    // Regression: the loc predicate once fell back to the query's LAST atom
    // ("01"), which matches a huge fraction of a spec corpus. With take: 100
    // and no ORDER BY, that flooded the candidate set and crowded the real
    // exact match out before scoring, so the search returned nothing.
    for (let i = 0; i < 200; i++) {
      await db.node.create({
        data: { id: generateId(), memoryId: fx.memoryA, loc: `cor:api:${100 + i}:01`, name: `decoy ${i}`, tags: [] },
      });
    }
    const target = await db.node.create({
      data: { id: generateId(), memoryId: fx.memoryA, loc: 'cor:brd:010:01', name: 'BRD 10', tags: [] },
    });
    const { hits } = await globalSearch(db, { query: 'cor:brd:010:01' }, viewerP());
    const nodeHits = byType(hits, 'node');
    expect(ids(nodeHits)).toContain(target.id);
    expect(nodeHits[0].matchedField).toBe('urn');
  });

  it('partial-loc search finds its node even amid many same-tail locs (#301)', async () => {
    // A partial loc like `brd:010:01` (a substring of the stored loc, with the
    // leading atom dropped) must still hit. locSuffix mis-strips it to `01`;
    // that fallback is matched with startsWith, so it can't re-flood the cap the
    // way a `contains '01'` substring would.
    await Promise.all(
      Array.from({ length: 200 }, (_, i) =>
        db.node.create({
          data: { id: generateId(), memoryId: fx.memoryA, loc: `cor:api:${100 + i}:01`, name: `decoy ${i}`, tags: [] },
        }),
      ),
    );
    const target = await db.node.create({
      data: { id: generateId(), memoryId: fx.memoryA, loc: 'cor:brd:010:01', name: 'BRD 10', tags: [] },
    });
    for (const query of ['brd:010:01', '010:01', 'cor:brd']) {
      const { hits } = await globalSearch(db, { query }, viewerP());
      expect(ids(byType(hits, 'node'))).toContain(target.id);
    }
  });

  it('full node-URN query finds its node across canonical, legacy, and mixed separators', async () => {
    // memoryA.urn is "org-a:alpha"; the node loc is the colon-path below. The
    // loc-suffix recovery must strip the org + memory atoms regardless of which
    // separator style the caller pastes (mixed `::`/`:` included).
    const target = await db.node.create({
      data: { id: generateId(), memoryId: fx.memoryA, loc: 'cor:brd:010:02', name: 'BRD 10.2', tags: [] },
    });
    for (const query of [
      'org-a::alpha::cor:brd:010:02', // canonical hierarchy, colon loc leaf
      'org-a:alpha:cor:brd:010:02', // legacy single-colon throughout
      'org-a::alpha:cor:brd:010:02', // mixed: canonical prefix, colon loc
    ]) {
      const { hits } = await globalSearch(db, { query }, viewerP());
      expect(ids(byType(hits, 'node'))).toContain(target.id);
    }
  });
});

describe('globalSearch — access scope', () => {
  it('org-rooted entities are scoped to the caller orgs', async () => {
    // viewer (orgA member): the org-visible Juno + their own PERSONAL draft.
    const v = await globalSearch(db, { query: 'Agent' }, viewerP());
    expect(ids(byType(v.hits, 'agent'))).toEqual(new Set([fx.agentA, fx.agentDraft]));

    // admin: all orgs' non-PERSONAL agents; the other user's draft stays hidden.
    const a = await globalSearch(db, { query: 'Agent' }, adminP());
    expect(ids(byType(a.hits, 'agent'))).toEqual(new Set([fx.agentA, fx.agentB]));
  });

  it('excludes uninstalled apps', async () => {
    const { hits } = await globalSearch(db, { query: 'Portal' }, viewerP());
    expect(ids(byType(hits, 'app'))).toEqual(new Set([fx.appA]));
  });

  it("excludes other users' PERSONAL draft agents — even from admins", async () => {
    // Owner (viewer) sees their own PERSONAL draft.
    expect(ids(byType((await globalSearch(db, { query: 'Draft' }, viewerP())).hits, 'agent'))).toContain(fx.agentDraft);
    // Admin must NOT see it (mirrors Organization.agents — carve-out by viewer, not role).
    expect(byType((await globalSearch(db, { query: 'Draft' }, adminP())).hits, 'agent')).toHaveLength(0);
  });

  it('AiServiceConfig is scoped to owner org', async () => {
    expect(byType((await globalSearch(db, { query: 'frontier' }, viewerP())).hits, 'aiServiceConfig')).toHaveLength(0);
    expect(ids(byType((await globalSearch(db, { query: 'default' }, viewerP())).hits, 'aiServiceConfig'))).toContain(fx.aiConfigA);
    expect(ids(byType((await globalSearch(db, { query: 'frontier' }, adminP())).hits, 'aiServiceConfig'))).toContain(fx.aiConfigB);
  });

  it('users are searchable by an authenticated viewer only', async () => {
    expect(ids(byType((await globalSearch(db, { query: 'Needle' }, viewerP())).hits, 'user'))).toContain(fx.userNeedle);
    expect(byType((await globalSearch(db, { query: 'Needle' }, anonP())).hits, 'user')).toHaveLength(0);
  });
});

describe('globalSearch — fields + entityTypes', () => {
  it('entityTypes restricts the kinds searched', async () => {
    const { hits } = await globalSearch(db, { query: 'Juno', entityTypes: ['memory'] }, viewerP());
    expect(byType(hits, 'agent')).toHaveLength(0);
  });

  it('explicit fields override the sniff', async () => {
    const byDesc = await globalSearch(db, { query: 'first', fields: ['description'] }, viewerP());
    expect(ids(byType(byDesc.hits, 'memory'))).toContain(fx.memoryA);

    const byName = await globalSearch(db, { query: 'first', fields: ['name'] }, viewerP());
    expect(byType(byName.hits, 'memory')).toHaveLength(0);
  });

  it('content search hits plaintext nodes, skips encrypted with a degraded note', async () => {
    const { hits, degraded } = await globalSearch(db, { query: 'topsecret', fields: ['content'] }, viewerP());
    const nodeHits = byType(hits, 'node');
    expect(ids(nodeHits)).toEqual(new Set([fx.nodeA]));
    expect(nodeHits[0].matchedField).toBe('content');
    expect(degraded.join(' ')).toMatch(/encrypted/i);
  });
});

describe('globalSearch — GraphQL resolver wiring', () => {
  const ctxFor = (userId: string, admin = false): Context => ({ db, userId, roles: admin ? ['ADMIN'] : [] });

  it('scopes via the real ctx gates', async () => {
    const r = await resolvers.Query.globalSearch({}, { query: 'Alpha' }, ctxFor(fx.viewer));
    expect(r.hits.some((h) => h.id === fx.memoryA)).toBe(true);

    const denied = await resolvers.Query.globalSearch({}, { query: 'Beta' }, ctxFor(fx.viewer));
    expect(denied.hits.some((h) => h.entityType === 'memory')).toBe(false);

    const asAdmin = await resolvers.Query.globalSearch({}, { query: 'Beta' }, ctxFor(fx.admin, true));
    expect(asAdmin.hits.some((h) => h.id === fx.memoryB)).toBe(true);
  });
});
