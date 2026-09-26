/**
 * #1330 — the MCP node writers are PARITY implementations of writeNodeCore,
 * not delegates, so the H1 strict-sub-role gate is repeated in them.
 * hadron_create_node and hadron_update_node must refuse an undeclared
 * sub-role under a strict parent exactly as the GraphQL path does.
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
vi.mock('../integrations/github/syncGraphFromGithub.js', () => ({
  syncGraphFromGithub: vi.fn().mockResolvedValue({ error: null }),
}));

let admin: { id: string };
let memory: { id: string; urn: string };
const auth = (): AuthContext => ({ userId: admin.id, roles: ['ADMIN'], clientId: `user:${admin.id}` });
const urn = (loc: string) => `hrn:node:${memory.urn}:${loc}`;

beforeEach(async () => {
  await cleanDb(db);
  const org = await db.organization.create({ data: { id: generateId(), name: 'ss-mcp', urn: 'ss-mcp' } });
  admin = await db.user.create({ data: { githubId: 13301, githubUsername: 'ss-mcp-admin', roles: ['ADMIN'] } });
  await db.orgMember.create({ data: { organizationId: org.id, userId: admin.id, role: 'ADMIN' } });
  memory = await resolvers.Mutation.createMemory({}, { orgId: org.id, name: 'docs' }, { db, roles: ['ADMIN'], userId: admin.id } as Context);
  const config = await db.memoryConfig.create({ data: { id: generateId(), memoryId: memory.id } });
  await db.nodeRoleRule.create({ data: { id: generateId(), configId: config.id, role: 'doc', strictSubRoles: true } });
  await db.nodeRoleRule.create({ data: { id: generateId(), configId: config.id, role: 'doc.guide' } });
});

describe('#1330 — MCP writers enforce strictSubRoles', () => {
  it('hadron_create_node refuses an undeclared sub-role and writes nothing; a declared one saves', async () => {
    const srv = createTestableMcpServer(auth());
    const refused = await srv.callToolText('hadron_create_node', { urn: urn('a'), name: 'A', role: 'doc.unknown', content: 'x' });
    expect(refused).toMatch(/^\[role_not_declared\].*"doc\.unknown".*"doc"/);
    expect(await db.node.count({ where: { memoryId: memory.id, loc: 'a' } })).toBe(0);
    expect(await srv.callToolText('hadron_create_node', { urn: urn('b'), name: 'B', role: 'doc.guide', content: 'x' })).toMatch(/Node saved/);
  });

  it('hadron_update_node refuses assigning one, and leaves a legacy role alone on an unrelated edit', async () => {
    const srv = createTestableMcpServer(auth());
    await db.node.create({ data: { id: generateId(), memoryId: memory.id, loc: 'n', name: 'N', role: 'doc.legacy', content: 'x' } });
    const refused = await srv.callToolText('hadron_update_node', { urn: urn('n'), role: 'doc.other' });
    expect(refused).toMatch(/^\[role_not_declared\]/);
    expect((await db.node.findFirstOrThrow({ where: { memoryId: memory.id, loc: 'n' } })).role).toBe('doc.legacy');
    expect(await srv.callToolText('hadron_update_node', { urn: urn('n'), content: 'edited' })).toMatch(/Node updated/);
  });
});
