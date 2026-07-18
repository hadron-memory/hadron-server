/**
 * #725 — the objectType collection facet on the MCP hadron_find_nodes tool.
 * (MCP write of objectType arrives with the schema/validation phase; here we
 * pin the read/filter surface agents use to list a collection.)
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
  const org = await db.organization.create({ data: { id: generateId(), name: 'ot-org', urn: 'ot-org' } });
  const admin = await db.user.create({ data: { githubId: 9801, githubUsername: 'ot-admin', roles: ['ADMIN'] } });
  await db.orgMember.create({ data: { organizationId: org.id, userId: admin.id, role: 'ADMIN' } });
  adminId = admin.id;
  const mem = await resolvers.Mutation.createMemory({}, { orgId: org.id, name: 'intel' }, { db, roles: ['ADMIN'], userId: admin.id } as Context);
  memUrn = mem.urn;
  memId = mem.id;
  const mk = (loc: string, objectType: string | null) =>
    db.node.create({ data: { id: generateId(), memoryId: memId, loc, name: loc, objectType } as any });
  await mk('c.letta', 'competitor');
  await mk('c.mem0', 'competitor');
  await mk('i.trend', 'insight');
  await mk('plain', null);
});

describe('hadron_find_nodes — objectType facet (#725)', () => {
  it('survey/browse filters to a single collection', async () => {
    const text = await call({ query: '*', memoryUrn: memUrn, objectType: 'competitor' });
    expect(text).toContain('c.letta');
    expect(text).toContain('c.mem0');
    expect(text).not.toContain('i.trend');
    expect(text).not.toContain('plain');
  });
});
