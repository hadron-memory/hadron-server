/**
 * #719 — the `where` structured predicate on the MCP hadron_find_nodes tool.
 * Delegates to resolvers.Query.findNodes (validated + executed there); this
 * pins the MCP surface: the predicate filters, the datetime guard drops junk,
 * and a malformed tree surfaces as tool-error text (not a crash).
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
const adminAuth = (): AuthContext => ({ userId: adminId, roles: ['ADMIN'], clientId: `user:${adminId}` });
const call = (args: Record<string, unknown>) => createTestableMcpServer(adminAuth()).callToolText('hadron_find_nodes', args);

beforeEach(async () => {
  await cleanDb(db);
  const org = await db.organization.create({ data: { id: generateId(), name: 'mw-org', urn: 'mw-org' } });
  const admin = await db.user.create({ data: { githubId: 9701, githubUsername: 'mw-admin', roles: ['ADMIN'] } });
  await db.orgMember.create({ data: { organizationId: org.id, userId: admin.id, role: 'ADMIN' } });
  adminId = admin.id;
  const mem = await resolvers.Mutation.createMemory(
    {},
    { orgId: org.id, name: 'intel' },
    { db, roles: ['ADMIN'], userId: admin.id } as Context,
  );
  memUrn = mem.urn;
  memId = mem.id;
  const mk = (loc: string, name: string, properties: Record<string, unknown>) =>
    db.node.create({ data: { id: generateId(), memoryId: memId, loc, name, properties } as any });
  await mk('insight.a', 'Letta insight', { sourceKind: 'substack', extractedAt: '2026-07-10T00:00:00Z' });
  await mk('insight.b', 'Reddit insight', { sourceKind: 'reddit', extractedAt: '2026-06-01T00:00:00Z' });
  await mk('insight.c', 'Substack junk', { sourceKind: 'substack', extractedAt: 'not-a-date' });
});

describe('hadron_find_nodes — where predicate (#719)', () => {
  it('survey/browse + where filters by a property', async () => {
    const text = await call({ query: '*', memoryUrn: memUrn, where: { path: ['sourceKind'], eq: 'substack' } });
    expect(text).toContain('insight.a');
    expect(text).toContain('insight.c');
    expect(text).not.toContain('insight.b'); // reddit filtered out
  });

  it('datetime range drops junk/missing dates (guard end-to-end, no error text)', async () => {
    const text = await call({
      query: '*',
      memoryUrn: memUrn,
      where: {
        and: [
          { path: ['sourceKind'], eq: 'substack' },
          { path: ['extractedAt'], as: 'datetime', gte: '2026-07-01T00:00:00Z' },
        ],
      },
    });
    expect(text).toContain('insight.a'); // 2026-07-10, in range
    expect(text).not.toContain('insight.c'); // 'not-a-date' dropped by the guard
    expect(text).not.toContain('insight.b');
  });

  it('a malformed where surfaces as tool-error text, not a crash', async () => {
    const text = await call({ query: '*', memoryUrn: memUrn, where: { path: ['x'], eq: 'a', ne: 'b' } });
    expect(text.toLowerCase()).toMatch(/where|operator/);
  });
});
