/**
 * #497 — hadron_find_nodes relevance-floor + confidence surfacing.
 *
 * Covers the MCP-surface behavior added for the dogfood friction issue:
 *   - tighter default page size for a query (10) vs survey mode (50)
 *   - each scored hit shows its score as a fraction of the top hit ("% of top")
 *   - a "[weak_results]" note when the scored hits sit in a narrow band and the
 *     ranking didn't single out a clear best match (the "50 plausible-looking
 *     rows but nothing relevant" failure)
 *   - the opt-in `minScore` absolute floor, exercised through the tool
 *
 * All keyword mode — no embedding stub required. Uses createTestableMcpServer
 * to drive the real production tool closure (auth + rendering) directly.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { db } from '../integrations/db/client.js';
import { cleanDb } from '../test/helpers.js';
import { resolvers, type Context } from '../api/graphql/schema/resolvers.js';
import { createTestableMcpServer } from './server.js';
import type { AuthContext } from '../middleware/auth.js';
import { generateId } from '../lib/id.js';

vi.mock('../integrations/github/writeNodeToGit.js', () => ({
  writeNodeToGit: vi.fn().mockResolvedValue(undefined),
}));

let adminId: string;
let memUrn: string;
let memId: string;

function adminAuth(): AuthContext {
  return { userId: adminId, roles: ['ADMIN'], clientId: `user:${adminId}` };
}

async function seed(loc: string, name: string, content?: string) {
  return db.node.create({
    data: { id: generateId(), memoryId: memId, loc, name, content: content ?? null },
  });
}

function find(args: Record<string, unknown>) {
  return createTestableMcpServer(adminAuth()).callToolText('hadron_find_nodes', {
    memoryUrn: memUrn,
    ...args,
  });
}

beforeEach(async () => {
  await cleanDb(db);
  const org = await db.organization.create({
    data: { id: generateId(), name: 'floor-org', urn: 'floor-org' },
  });
  const admin = await db.user.create({
    data: { githubId: 7497, githubUsername: 'floor-admin', roles: ['ADMIN'] },
  });
  await db.orgMember.create({ data: { organizationId: org.id, userId: admin.id, role: 'ADMIN' } });
  adminId = admin.id;
  const mem = await resolvers.Mutation.createMemory(
    {},
    { orgId: org.id, name: 'floor-mem' },
    { db, roles: ['ADMIN'], userId: admin.id } as Context,
  );
  memId = mem.id;
  memUrn = mem.urn;
  // createMemory seeds a memory-root node; clear it so node counts below are
  // exactly the nodes each test seeds.
  await db.node.deleteMany({ where: { memoryId: memId } });
});

describe('#497 — default page size', () => {
  it('a query defaults to 10 hits; survey mode ("*") is not capped at 10', async () => {
    for (let i = 0; i < 15; i++) await seed(`w${i}`, `widget number ${i}`);

    const queried = await find({ query: 'widget', mode: 'keyword' });
    expect(queried).toContain('Found 10 node(s)');

    const survey = await find({ query: '*' });
    expect(survey).toContain('Found 15 node(s)');
  });

  it('an explicit limit overrides the default', async () => {
    for (let i = 0; i < 15; i++) await seed(`w${i}`, `widget number ${i}`);
    const out = await find({ query: 'widget', mode: 'keyword', limit: 15 });
    expect(out).toContain('Found 15 node(s)');
  });
});

describe('#497 — relative score surfacing', () => {
  it('the top hit renders "100% of top" and a weaker hit renders a lower fraction', async () => {
    await seed('strong', 'zebra zebra zebra');
    await seed(
      'weak',
      'Grocery list',
      'a long note mentioning zebra exactly once, buried deep. ' + 'lorem ipsum dolor. '.repeat(60),
    );
    const out = await find({ query: 'zebra', mode: 'keyword' });
    expect(out).toContain('100% of top');
    // The weak hit is present and carries a non-100 relative figure.
    const pcts = [...out.matchAll(/(\d+)% of top/g)].map((m) => Number(m[1]));
    expect(pcts).toContain(100);
    expect(pcts.some((p) => p < 100)).toBe(true);
  });
});

describe('#497 — weak-results note', () => {
  it('flags a flat band of many similarly-scored hits', async () => {
    // Six structurally-identical nodes → identical ts_rank → a maximally flat
    // band (weakest is 100% of top), which is exactly the "nothing stands out"
    // signal the note is for.
    for (let i = 0; i < 6; i++) await seed(`flat${i}`, 'signal signal signal');
    const out = await find({ query: 'signal', mode: 'keyword' });
    expect(out).toContain('[weak_results]');
  });

  it('does NOT flag a small, well-separated result set', async () => {
    await seed('strong', 'penguin penguin penguin');
    await seed('weak', 'Notes', 'penguin once, buried. ' + 'filler words here. '.repeat(60));
    const out = await find({ query: 'penguin', mode: 'keyword' });
    // Only two scored hits (< 5) → the heuristic never fires.
    expect(out).not.toContain('[weak_results]');
  });
});

describe('#497 — minScore floor through the tool', () => {
  it('drops sub-floor hits and can empty the result set', async () => {
    await seed('a', 'aardvark');
    await seed('b', 'aardvark');
    // A floor above any attainable ts_rank empties the set (proves the param is
    // wired through; selective mid-floor filtering is covered at the resolver level).
    const out = await find({ query: 'aardvark', mode: 'keyword', minScore: 1e9 });
    expect(out).toContain('No nodes found');
  });

  it('a floor is ignored in survey mode (unscored list)', async () => {
    for (let i = 0; i < 3; i++) await seed(`s${i}`, `node ${i}`);
    const out = await find({ query: '*', minScore: 999 });
    expect(out).toContain('Found 3 node(s)');
  });
});
