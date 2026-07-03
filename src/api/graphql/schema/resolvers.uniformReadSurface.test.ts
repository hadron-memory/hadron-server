/**
 * #473 — the uniform base read surface: per entity, a find-one taking
 * `ref` (PK or fully-qualified URN), a paginated find-many returning the
 * { items, total } envelope, and the cor:api:100:01 orgId scope (member →
 * scope, non-member → empty page, no disclosure, no admin bypass).
 *
 * Migrated legacy suites cover the semantics the new queries inherited
 * (myMemories→memories, myApps→apps, searchUsers→users, …); this file
 * covers what is NEW: the Edge and Agent surfaces, user(ref), the
 * aiServiceConfig find-one, node(ref) full-URN dispatch, the PUBLIC
 * marketplace slice of memories(), and the envelope/limit contract.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { resolvers, type Context } from './resolvers.js';

const Q = resolvers.Query as any;

let orgA: { id: string; urn: string };
let orgB: { id: string; urn: string };
let member: { id: string };   // member of orgA only
let stranger: { id: string }; // member of NO org
let admin: { id: string };    // platform ADMIN, member of nothing
let memA: { id: string; urn: string };
let nodeA1: { id: string; loc: string };
let nodeA2: { id: string; loc: string };
let edgeA: { id: string; loc: string };
let agentA: { id: string; urn: string };

const ctx = (userId?: string, roles: Context['roles'] = ['READER']): Context =>
  ({ db, userId, roles });

beforeEach(async () => {
  await cleanDb(db);
  orgA = await db.organization.create({
    data: { id: generateId(), name: 'uni-a', urn: `uni-a-${Date.now()}` },
  });
  orgB = await db.organization.create({
    data: { id: generateId(), name: 'uni-b', urn: `uni-b-${Date.now()}` },
  });
  member = await db.user.create({
    data: { id: generateId(), githubId: 47101, githubUsername: 'uni-member', handle: 'uni-member' },
  });
  stranger = await db.user.create({
    data: { id: generateId(), githubId: 47102, githubUsername: 'uni-stranger', handle: 'uni-stranger' },
  });
  admin = await db.user.create({
    data: { id: generateId(), githubId: 47103, githubUsername: 'uni-admin', roles: ['ADMIN'] },
  });
  await db.orgMember.create({
    data: { id: generateId(), organizationId: orgA.id, userId: member.id, role: 'READER' },
  });
  memA = await db.memory.create({
    data: {
      id: generateId(), organizationId: orgA.id, urn: `${orgA.urn}:mem-a`,
      name: 'mem-a', class: 'knowledge', visibility: 'ORGANIZATION',
    },
  });
  nodeA1 = await db.node.create({
    data: { id: generateId(), memoryId: memA.id, loc: 'uni:start', name: 'start' },
  });
  nodeA2 = await db.node.create({
    data: { id: generateId(), memoryId: memA.id, loc: 'uni:next', name: 'next' },
  });
  edgeA = await db.edge.create({
    data: {
      id: generateId(), memoryId: memA.id, sourceId: nodeA1.id, targetId: nodeA2.id,
      loc: 'uni:start:next', name: 'next',
    },
  });
  agentA = await db.agent.create({
    data: {
      id: generateId(), organizationId: orgA.id, urn: `${orgA.urn}:uni-agent`,
      name: 'Uni Agent', visibility: 'ORGANIZATION',
    },
  });
});

// ---------------------------------------------------------------------------
// Edge
// ---------------------------------------------------------------------------

describe('Query.edge(ref) — the uniform single-edge read', () => {
  it('resolves by PK and by canonical hrn:edge URN', async () => {
    expect((await Q.edge(null, { ref: edgeA.id }, ctx(member.id)))?.id).toBe(edgeA.id);
    const urn = `hrn:edge:${memA.urn.replace(':', '::')}::${edgeA.loc}`;
    expect((await Q.edge(null, { ref: urn }, ctx(member.id)))?.id).toBe(edgeA.id);
  });

  it('returns null for a non-member (denied ≡ not-found) and for a missing edge', async () => {
    expect(await Q.edge(null, { ref: edgeA.id }, ctx(stranger.id))).toBeNull();
    expect(await Q.edge(null, { ref: generateId() }, ctx(member.id))).toBeNull();
  });
});

describe('Query.edges — the uniform paginated edge list', () => {
  it('returns the member-readable edges in the { items, total } envelope', async () => {
    const page = await Q.edges(null, {}, ctx(member.id));
    expect(page.total).toBe(1);
    expect(page.items.map((e: { id: string }) => e.id)).toEqual([edgeA.id]);
  });

  it('a stranger gets an empty page', async () => {
    expect(await Q.edges(null, {}, ctx(stranger.id))).toEqual({ items: [], total: 0 });
  });

  it('filters by memoryId (ID or URN), sourceNodeId, targetNodeId', async () => {
    expect((await Q.edges(null, { filter: { memoryId: memA.urn } }, ctx(member.id))).total).toBe(1);
    expect(
      (await Q.edges(null, { filter: { sourceNodeId: nodeA1.id } }, ctx(member.id))).total,
    ).toBe(1);
    expect(
      (await Q.edges(null, { filter: { targetNodeId: nodeA1.id } }, ctx(member.id))).total,
    ).toBe(0);
  });

  it('orgId: member → scoped, non-member → empty page (no disclosure)', async () => {
    expect((await Q.edges(null, { orgId: orgA.id }, ctx(member.id))).total).toBe(1);
    expect(await Q.edges(null, { orgId: orgB.id }, ctx(member.id))).toEqual({ items: [], total: 0 });
    expect(await Q.edges(null, { orgId: 'no-such-org' }, ctx(member.id))).toEqual({ items: [], total: 0 });
  });

  it('excludes soft-deleted edges unless filter.includeDeleted', async () => {
    await db.edge.update({ where: { id: edgeA.id }, data: { deletedAt: new Date() } });
    expect((await Q.edges(null, {}, ctx(member.id))).total).toBe(0);
    expect(
      (await Q.edges(null, { filter: { includeDeleted: true } }, ctx(member.id))).total,
    ).toBe(1);
  });

  it('limit: 0 is the count-only page', async () => {
    expect(await Q.edges(null, { limit: 0 }, ctx(member.id))).toEqual({ items: [], total: 1 });
  });
});

// ---------------------------------------------------------------------------
// Agent
// ---------------------------------------------------------------------------

describe('Query.agent(ref) — the uniform single-agent read', () => {
  it('resolves by PK and by URN for an org member and a platform admin', async () => {
    expect((await Q.agent(null, { ref: agentA.id }, ctx(member.id)))?.id).toBe(agentA.id);
    expect((await Q.agent(null, { ref: `urn:agent:${agentA.urn}` }, ctx(member.id)))?.id).toBe(agentA.id);
    expect((await Q.agent(null, { ref: agentA.id }, ctx(admin.id, ['ADMIN'])))?.id).toBe(agentA.id);
  });

  it('throws Forbidden for a non-member; null for a missing agent', async () => {
    await expect(Q.agent(null, { ref: agentA.id }, ctx(stranger.id))).rejects.toThrow('Forbidden');
    expect(await Q.agent(null, { ref: generateId() }, ctx(member.id))).toBeNull();
  });

  it('a REVOKED (soft-deleted) membership no longer authorizes agent(ref) / app(ref) (PR-475 review, Codex P1)', async () => {
    const app = await db.app.create({
      data: { id: generateId(), organizationId: orgA.id, urn: `${orgA.urn}:uni-app`, name: 'Uni App' },
    });
    // Sanity: while the membership is live, both reads succeed.
    expect((await Q.agent(null, { ref: agentA.id }, ctx(member.id)))?.id).toBe(agentA.id);
    expect((await Q.app(null, { ref: app.id }, ctx(member.id)))?.id).toBe(app.id);
    // Revoke (soft-delete) the membership — requireOrgRole must now deny.
    await db.orgMember.updateMany({
      where: { organizationId: orgA.id, userId: member.id },
      data: { deletedAt: new Date() },
    });
    await expect(Q.agent(null, { ref: agentA.id }, ctx(member.id))).rejects.toThrow('Forbidden');
    await expect(Q.app(null, { ref: app.id }, ctx(member.id))).rejects.toThrow('Forbidden');
  });
});

describe('Query.agents — the uniform paginated agent list', () => {
  it('member sees their orgs agents; stranger an empty page; admin everything', async () => {
    await db.agent.create({
      data: { id: generateId(), organizationId: orgB.id, urn: `${orgB.urn}:b-agent`, name: 'B Agent' },
    });
    expect((await Q.agents(null, {}, ctx(member.id))).total).toBe(1);
    expect(await Q.agents(null, {}, ctx(stranger.id))).toEqual({ items: [], total: 0 });
    expect((await Q.agents(null, {}, ctx(admin.id, ['ADMIN']))).total).toBe(2);
  });

  it('orgId: member → scoped; non-member → empty; NO admin bypass', async () => {
    expect((await Q.agents(null, { orgId: orgA.urn }, ctx(member.id))).total).toBe(1);
    expect(await Q.agents(null, { orgId: orgB.id }, ctx(member.id))).toEqual({ items: [], total: 0 });
    // The admin is not a member of orgA — scoping is a membership concept.
    expect(await Q.agents(null, { orgId: orgA.id }, ctx(admin.id, ['ADMIN']))).toEqual({ items: [], total: 0 });
  });

  it('filter narrows by visibility', async () => {
    await db.agent.create({
      data: {
        id: generateId(), organizationId: orgA.id, urn: `${orgA.urn}:pub-agent`,
        name: 'Pub Agent', visibility: 'PUBLIC',
      },
    });
    const page = await Q.agents(null, { filter: { visibility: 'PUBLIC' } }, ctx(member.id));
    expect(page.total).toBe(1);
    expect(page.items[0].visibility).toBe('PUBLIC');
  });
});

// ---------------------------------------------------------------------------
// User
// ---------------------------------------------------------------------------

describe('Query.user(ref) — the uniform single-user read', () => {
  it('resolves self, a co-member, and any user for a platform admin (PK or handle URN)', async () => {
    expect((await Q.user(null, { ref: member.id }, ctx(member.id)))?.id).toBe(member.id);
    const coMember = await db.user.create({
      data: { id: generateId(), githubId: 47104, githubUsername: 'uni-co', handle: 'uni-co' },
    });
    await db.orgMember.create({
      data: { id: generateId(), organizationId: orgA.id, userId: coMember.id, role: 'READER' },
    });
    expect((await Q.user(null, { ref: 'hrn:user:uni-co' }, ctx(member.id)))?.id).toBe(coMember.id);
    expect((await Q.user(null, { ref: stranger.id }, ctx(admin.id, ['ADMIN'])))?.id).toBe(stranger.id);
  });

  it('a stranger gets null — denied and missing are indistinguishable (#384)', async () => {
    expect(await Q.user(null, { ref: member.id }, ctx(stranger.id))).toBeNull();
    expect(await Q.user(null, { ref: 'hrn:user:no-such-handle' }, ctx(member.id))).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Memory — the PUBLIC marketplace slice + envelope/limit contract
// ---------------------------------------------------------------------------

describe('Query.memories — scope slices and the envelope contract', () => {
  it('filter.visibility: PUBLIC is the marketplace slice (the old publicMemories)', async () => {
    const pub = await db.memory.create({
      data: {
        id: generateId(), organizationId: orgB.id, urn: `${orgB.urn}:pub`,
        name: 'pub', class: 'knowledge', visibility: 'PUBLIC',
      },
    });
    // The stranger is in no org: default union is empty, PUBLIC slice is not.
    expect((await Q.memories(null, {}, ctx(stranger.id))).total).toBe(0);
    const marketplace = await Q.memories(null, { filter: { visibility: 'PUBLIC' } }, ctx(stranger.id));
    expect(marketplace.items.map((m: { id: string }) => m.id)).toEqual([pub.id]);
  });

  it('paginates deterministically with an exact total; limit: 0 = count only', async () => {
    for (const n of ['aa', 'bb', 'cc']) {
      await db.memory.create({
        data: {
          id: generateId(), organizationId: orgA.id, urn: `${orgA.urn}:${n}`,
          name: n, class: 'knowledge',
        },
      });
    }
    const page1 = await Q.memories(null, { limit: 2, offset: 0 }, ctx(member.id));
    const page2 = await Q.memories(null, { limit: 2, offset: 2 }, ctx(member.id));
    expect(page1.total).toBe(4); // mem-a + aa + bb + cc
    expect(page1.items).toHaveLength(2);
    expect(page2.items).toHaveLength(2);
    const names = [...page1.items, ...page2.items].map((m: { name: string }) => m.name);
    expect(names).toEqual(['aa', 'bb', 'cc', 'mem-a']); // name-asc, no dup/drop
    expect(await Q.memories(null, { limit: 0 }, ctx(member.id))).toMatchObject({ items: [], total: 4 });
  });
});

// ---------------------------------------------------------------------------
// Node — ref dispatch forms not covered by the migrated #335/#391 suites
// ---------------------------------------------------------------------------

describe('Query.node(ref) — URN dispatch', () => {
  it('resolves an explicit canonical hrn:node URN and a bare full URN', async () => {
    const canonical = `hrn:node:${memA.urn.replace(':', '::')}::${nodeA1.loc}`;
    expect((await Q.node(null, { ref: canonical }, ctx(member.id)))?.id).toBe(nodeA1.id);
    const bare = `${memA.urn.replace(':', '::')}::${nodeA1.loc}`;
    expect((await Q.node(null, { ref: bare }, ctx(member.id)))?.id).toBe(nodeA1.id);
  });

  it('URN-resolved reads still respect the access gate (denied ≡ null)', async () => {
    const canonical = `hrn:node:${memA.urn.replace(':', '::')}::${nodeA1.loc}`;
    expect(await Q.node(null, { ref: canonical }, ctx(stranger.id))).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// AiServiceConfig — find-one + the unfiltered admin list
// ---------------------------------------------------------------------------

describe('Query.aiServiceConfig(ref) + unfiltered aiServiceConfigs', () => {
  let orgAdmin: { id: string };
  let cfg: { id: string };

  beforeEach(async () => {
    orgAdmin = await db.user.create({
      data: { id: generateId(), githubId: 47105, githubUsername: 'uni-org-admin' },
    });
    await db.orgMember.create({
      data: { id: generateId(), organizationId: orgA.id, userId: orgAdmin.id, role: 'ADMIN' },
    });
    cfg = await db.aiServiceConfig.create({
      data: {
        id: generateId(), organizationId: orgA.id, name: 'default',
        provider: 'anthropic', model: 'claude-sonnet-5',
      },
    });
  });

  it('org ADMIN of the owning org reads the masked config; missing id is null', async () => {
    const out = await Q.aiServiceConfig(null, { ref: cfg.id }, ctx(orgAdmin.id));
    expect(out?.id).toBe(cfg.id);
    expect(out?.ownerType).toBe('ORGANIZATION');
    expect(JSON.stringify(out)).not.toContain('apiKeyEncrypted');
    expect(await Q.aiServiceConfig(null, { ref: generateId() }, ctx(orgAdmin.id))).toBeNull();
  });

  it('a plain member is denied (org-ADMIN bar, mirroring the list gate)', async () => {
    await expect(Q.aiServiceConfig(null, { ref: cfg.id }, ctx(member.id))).rejects.toThrow('Forbidden');
  });

  it('unfiltered aiServiceConfigs is the platform-admin cross-owner view only', async () => {
    const page = await Q.aiServiceConfigs(null, {}, ctx(admin.id, ['ADMIN']));
    expect(page.total).toBe(1);
    expect(page.items[0].id).toBe(cfg.id);
    await expect(Q.aiServiceConfigs(null, {}, ctx(orgAdmin.id))).rejects.toThrow('Forbidden');
  });
});

// ---------------------------------------------------------------------------
// Organizations / Users — envelope + admin reach (the merged my* semantics)
// ---------------------------------------------------------------------------

describe('Query.organizations / Query.users — merged list semantics', () => {
  it('organizations: member → memberships; admin → all; envelope shape', async () => {
    const mine = await Q.organizations(null, {}, ctx(member.id));
    expect(mine.total).toBe(1);
    expect(mine.items[0].id).toBe(orgA.id);
    expect((await Q.organizations(null, {}, ctx(admin.id, ['ADMIN']))).total).toBe(2);
    expect(await Q.organizations(null, { limit: 0 }, ctx(member.id))).toMatchObject({ total: 1 });
  });

  it('users: admin full list is paginated with an exact total', async () => {
    const page = await Q.users(null, { limit: 2 }, ctx(admin.id, ['ADMIN']));
    expect(page.total).toBe(3); // member, stranger, admin
    expect(page.items).toHaveLength(2);
  });
});
