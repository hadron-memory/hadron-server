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
  {}, { orgRef: orgId, name, vectorIndexEnabled: false }, ctx(),
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
  it('gives a new memory no scaffold root (#3952, R11)', async () => {
    const memory = await createMemory();
    expect(await db.node.findMany({ where: { memoryId: memory.id } })).toEqual([]);
  });

  it('validates a fresh memory as empty, with nothing sparse (#3952)', async () => {
    await createMemory();
    const result = await server().callToolText('hadron_validate', { memoryUrn });
    expect(result).not.toContain('[sparse]');
    expect(result).toContain('Validated 0 nodes. No issues found.');
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

  it('keeps bare MCP node and parent locs in a memory with no root', async () => {
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
