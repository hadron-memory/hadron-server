/** #1322 — MCP role-family filtering delegates the GraphQL query contract. */
import { beforeEach, describe, expect, it, vi } from 'vitest';
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

const adminAuth = (): AuthContext => ({
  userId: adminId,
  roles: ['ADMIN'],
  clientId: `user:${adminId}`,
});
const call = (args: Record<string, unknown>) =>
  createTestableMcpServer(adminAuth()).callToolText('hadron_find_nodes', args);

beforeEach(async () => {
  await cleanDb(db);
  const org = await db.organization.create({
    data: { id: generateId(), name: 'role-org', urn: 'role-org' },
  });
  const admin = await db.user.create({
    data: { githubId: 132201, githubUsername: 'role-admin', roles: ['ADMIN'] },
  });
  await db.orgMember.create({
    data: { organizationId: org.id, userId: admin.id, role: 'ADMIN' },
  });
  adminId = admin.id;
  const memory = await resolvers.Mutation.createMemory(
    {},
    { orgId: org.id, name: 'roles' },
    { db, roles: ['ADMIN'], userId: admin.id } as Context,
  );
  memUrn = memory.urn;
  memId = memory.id;
  await db.node.createMany({
    data: [
      { id: generateId(), memoryId: memId, loc: 'r:spec', name: 'spec', role: 'spec' },
      { id: generateId(), memoryId: memId, loc: 'r:rule', name: 'rule', role: 'spec.rule' },
      { id: generateId(), memoryId: memId, loc: 'r:detail', name: 'detail', role: 'spec.rule.detail' },
      { id: generateId(), memoryId: memId, loc: 'r:special', name: 'special', role: 'special' },
      { id: generateId(), memoryId: memId, loc: 'r:specification', name: 'specification', role: 'specification' },
    ],
  });
});

describe('hadron_find_nodes — dotted role family (#1322)', () => {
  it('matches the exact role and descendants, never textual-prefix near misses', async () => {
    const text = await call({ query: '*', memoryUrn: memUrn, role: 'spec.rule' });
    expect(text).toContain('r:rule');
    expect(text).toContain('r:detail');
    expect(text).not.toContain('r:spec\n');
    expect(text).not.toContain('r:special');
    expect(text).not.toContain('r:specification');
  });
});
