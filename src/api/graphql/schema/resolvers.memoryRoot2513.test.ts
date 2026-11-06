/** #2513: describe new scaffold roots without changing sparse checks or placement. */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { createTestableMcpServer } from '../../../mcp/server.js';
import { resolvers, type Context } from './resolvers.js';

vi.mock('../../../integrations/github/writeNodeToGit.js', () => ({
  writeNodeToGit: vi.fn().mockResolvedValue(undefined),
}));

let orgId: string;
let userId: string;
const orgUrn = 'root-2513';
const memoryName = 'notes';
const memoryUrn = `hrn:mem:${orgUrn}:${memoryName}`;

const ctx = (): Context => ({ db, userId, roles: ['ADMIN'] });
const server = () => createTestableMcpServer({ userId, roles: ['ADMIN'], clientId: `user:${userId}` });
const createMemory = (name = memoryName) => resolvers.Mutation.createMemory(
  {}, { orgId, name, vectorIndexEnabled: false }, ctx(),
);

beforeEach(async () => {
  await cleanDb(db);
  const org = await db.organization.create({
    data: { id: generateId(), name: orgUrn, urn: orgUrn },
  });
  orgId = org.id;
  const user = await db.user.create({
    data: { id: generateId(), githubId: 2513, githubUsername: 'root-admin', roles: ['ADMIN'] },
  });
  userId = user.id;
  await db.orgMember.create({ data: { organizationId: orgId, userId, role: 'ADMIN' } });
});

describe('createMemory scaffold root (#2513)', () => {
  it('gives a new root a nonempty one-line description, preserving its loc and name', async () => {
    const memory = await createMemory();
    const roots = await db.node.findMany({ where: { memoryId: memory.id } });
    expect(roots).toHaveLength(1);
    expect(roots[0]).toMatchObject({ loc: memoryName, name: memoryName, content: null, abstract: null });
    expect(roots[0]!.description, 'new scaffold root must carry a description (#2513)').toEqual(expect.any(String));
    expect(roots[0]!.description!.trim()).not.toBe('');
    expect(roots[0]!.description).not.toMatch(/[\r\n]/);
  });

  it('does not report the fresh scaffold as sparse through hadron_validate', async () => {
    await createMemory();
    const result = await server().callToolText('hadron_validate', { memoryUrn });
    expect(result, 'fresh createMemory root must not be [sparse] (#2513)').not.toContain('[sparse]');
    expect(result).toContain('Validated 1 nodes. No issues found.');
  });

  it('still flags a name-only node as sparse', async () => {
    const memory = await createMemory();
    await db.node.create({
      data: { id: generateId(), memoryId: memory.id, loc: 'name-only', name: 'Name only' },
    });
    const result = await server().callToolText('hadron_validate', { memoryUrn });
    expect(result).toContain(`[sparse] hrn:node:${orgUrn}:${memoryName}:name-only`);
    expect(result).toContain('no description, content, or abstract');
  });

  it('keeps bare MCP node and parent locs beside the scaffold root', async () => {
    const memory = await createMemory();
    const mcp = server();
    await mcp.callToolText('hadron_create_node', {
      urn: `hrn:node:${orgUrn}:${memoryName}:facts`, name: 'Facts', content: 'A fact.',
    });
    await mcp.callToolText('hadron_create_parent_node', {
      urn: `hrn:node:${orgUrn}:${memoryName}:sections`, name: 'Sections',
    });
    const nodes = await db.node.findMany({ where: { memoryId: memory.id }, orderBy: { loc: 'asc' } });
    expect(nodes.map(n => ({ loc: n.loc, name: n.name }))).toEqual([
      { loc: 'facts', name: 'Facts' },
      { loc: memoryName, name: memoryName },
      { loc: 'sections', name: 'Sections' },
    ]);
  });

  it('does not backfill an existing name-only root when creating another memory', async () => {
    const legacy = await db.memory.create({
      data: { id: generateId(), organizationId: orgId, urn: `${orgUrn}:legacy`, name: 'legacy', class: 'knowledge' },
    });
    const root = await db.node.create({
      data: { id: generateId(), memoryId: legacy.id, loc: 'legacy', name: 'legacy' },
    });
    await createMemory();
    expect(await db.node.findUniqueOrThrow({ where: { id: root.id } })).toEqual(root);
    const result = await server().callToolText('hadron_validate', { memoryUrn: `hrn:mem:${orgUrn}:legacy` });
    expect(result).toContain(`[sparse] hrn:node:${orgUrn}:legacy:legacy`);
  });
});
