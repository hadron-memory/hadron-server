/**
 * Issue #355 — `findNodes(filter: { memoryIds })` plural memory-set scope.
 *
 * Lets the portal run one node-content search across an agent's / app's
 * SET of memories in a single round-trip, instead of one-memory-or-all.
 * Keyword mode is exercised here (no embedding backend required); the
 * scope-resolution branch under test is shared by vector/hybrid.
 *
 * (Migrated in PR3 from the removed `nodeSearch` query to `findNodes`. The
 * `memoryIds`-takes-precedence-over-`memoryUrn` case was dropped: findNodes has
 * no singular `memoryUrn` param — memory scope is only `filter.memoryIds`.)
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { resolvers, type Context } from './resolvers.js';

let orgId: string;
let adminId: string;

function adminCtx(): Context {
  return { db, roles: ['ADMIN'], userId: adminId };
}

interface Seeded {
  alphaId: string;
  alphaUrn: string;
  betaId: string;
  gammaId: string;
  gammaUrn: string;
}

async function seedThreeMemoriesEachWithMatch(): Promise<Seeded> {
  const seeds = await Promise.all(
    ['alpha', 'beta', 'gamma'].map(async (slug) => {
      const id = generateId();
      const urn = `s355-org:${slug}-${generateId().slice(0, 6)}`;
      await db.memory.create({
        data: { id, organizationId: orgId, urn, name: slug, class: 'knowledge' },
      });
      await db.node.create({
        data: {
          id: generateId(),
          memoryId: id,
          loc: 'start-here',
          name: `${slug} start-here`,
          description: `${slug} entry-point`,
          tags: [],
        },
      });
      return { id, urn, slug };
    }),
  );
  return {
    alphaId: seeds[0].id,
    alphaUrn: seeds[0].urn,
    betaId: seeds[1].id,
    gammaId: seeds[2].id,
    gammaUrn: seeds[2].urn,
  };
}

function memIdsOf(res: unknown): Set<string> {
  const hits = (res as { hits: Array<{ node: { memoryId: string } }> }).hits;
  return new Set(hits.map((h) => h.node.memoryId));
}

beforeEach(async () => {
  await cleanDb(db);
  const orgUrn = `s355-org-${generateId().slice(0, 8)}`;
  const org = await db.organization.create({
    data: { id: generateId(), name: orgUrn, urn: orgUrn },
  });
  orgId = org.id;
  const admin = await db.user.create({
    data: { githubId: 9931, githubUsername: 's355-admin', roles: ['ADMIN'] },
  });
  await db.orgMember.create({
    data: { organizationId: orgId, userId: admin.id, role: 'ADMIN' },
  });
  adminId = admin.id;
});

describe('findNodes filter.memoryIds (plural) scope — issue #355', () => {
  it('scopes keyword search to a subset of memories', async () => {
    const s = await seedThreeMemoriesEachWithMatch();
    const res = await resolvers.Query.findNodes(
      {},
      { query: 'start-here', mode: 'keyword', filter: { memoryIds: [s.alphaId, s.betaId] } },
      adminCtx(),
    );
    expect(memIdsOf(res)).toEqual(new Set([s.alphaId, s.betaId]));
  });

  it('drops ids outside the accessible set (no throw)', async () => {
    const s = await seedThreeMemoriesEachWithMatch();
    const res = await resolvers.Query.findNodes(
      {},
      { query: 'start-here', mode: 'keyword', filter: { memoryIds: [s.alphaId, generateId()] } },
      adminCtx(),
    );
    expect(memIdsOf(res)).toEqual(new Set([s.alphaId]));
  });

  it('an empty memoryIds array falls through to all accessible memories', async () => {
    const s = await seedThreeMemoriesEachWithMatch();
    const res = await resolvers.Query.findNodes(
      {},
      { query: 'start-here', mode: 'keyword', filter: { memoryIds: [] } },
      adminCtx(),
    );
    expect(memIdsOf(res)).toEqual(new Set([s.alphaId, s.betaId, s.gammaId]));
  });
});
