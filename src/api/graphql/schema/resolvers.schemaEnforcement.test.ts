/**
 * #725 PR C1 — schema enforcement on node writes (GraphQL + MCP). A collection
 * member on a schema-governed memory is validated against its declared fields;
 * an unschema'd memory stays free-form.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { resolvers, type Context } from './resolvers.js';
import { createTestableMcpServer } from '../../../mcp/server.js';
import type { AuthContext } from '../../../middleware/auth.js';
import { generateId } from '../../../lib/id.js';
import { emitNodeUrnV2 } from '../../../lib/urnEmit.js';

vi.mock('../../../integrations/github/writeNodeToGit.js', () => ({
  writeNodeToGit: vi.fn().mockResolvedValue(undefined),
}));

const schema = {
  objectTypes: {
    competitor: {
      fields: {
        name: { type: 'text', required: true },
        stage: { type: 'enum', values: ['seed', 'series-a'] },
        funding: { type: 'number' },
      },
    },
  },
};

let adminId: string;
let memId: string; // schema-governed
let memUrn: string;
let freeMemId: string; // no schema
const admin = (): Context => ({ db, roles: ['ADMIN'], userId: adminId } as Context);
const adminAuth = (): AuthContext => ({ userId: adminId, roles: ['ADMIN'], clientId: `user:${adminId}` });
const createNode = (input: Record<string, unknown>) => (resolvers.Mutation as any).createNode(null, { input }, admin());

beforeEach(async () => {
  await cleanDb(db);
  const org = await db.organization.create({ data: { id: generateId(), name: 'se-org', urn: 'se-org' } });
  const a = await db.user.create({ data: { githubId: 9821, githubUsername: 'se-admin', roles: ['ADMIN'] } });
  await db.orgMember.create({ data: { organizationId: org.id, userId: a.id, role: 'ADMIN' } });
  adminId = a.id;
  const mem = await resolvers.Mutation.createMemory({}, { orgId: org.id, name: 'intel' }, admin());
  memId = mem.id;
  memUrn = mem.urn;
  await (resolvers.Mutation as any).updateMemory(null, { id: memId, schema }, admin());
  const free = await resolvers.Mutation.createMemory({}, { orgId: org.id, name: 'free' }, admin());
  freeMemId = free.id;
});

describe('createNode — schema enforcement (GraphQL)', () => {
  it('accepts a valid collection member', async () => {
    const n = await createNode({ memoryId: memId, loc: 'c.letta', name: 'Letta', objectType: 'competitor', properties: { name: 'Letta', stage: 'seed' } });
    expect(n.objectType).toBe('competitor');
  });

  it('rejects a missing required field', async () => {
    await expect(createNode({ memoryId: memId, loc: 'c.x', name: 'X', objectType: 'competitor', properties: { stage: 'seed' } }))
      .rejects.toMatchObject({ extensions: { code: 'BAD_USER_INPUT' } });
  });

  it('rejects an undeclared collection', async () => {
    await expect(createNode({ memoryId: memId, loc: 'g.x', name: 'X', objectType: 'gadget', properties: {} }))
      .rejects.toMatchObject({ extensions: { code: 'BAD_USER_INPUT' } });
  });

  it('rejects an out-of-range enum value', async () => {
    await expect(createNode({ memoryId: memId, loc: 'c.y', name: 'Y', objectType: 'competitor', properties: { name: 'Y', stage: 'series-z' } }))
      .rejects.toMatchObject({ extensions: { code: 'BAD_USER_INPUT' } });
  });

  it('rejects a non-numeric number field', async () => {
    await expect(createNode({ memoryId: memId, loc: 'c.z', name: 'Z', objectType: 'competitor', properties: { name: 'Z', funding: 'lots' } }))
      .rejects.toMatchObject({ extensions: { code: 'BAD_USER_INPUT' } });
  });

  it('a node without objectType is unaffected by the schema', async () => {
    const n = await createNode({ memoryId: memId, loc: 'plain', name: 'Plain', properties: { anything: 1 } });
    expect(n.objectType).toBeNull();
  });

  it('an unschema\'d memory keeps objectType free-form', async () => {
    const n = await createNode({ memoryId: freeMemId, loc: 'x', name: 'X', objectType: 'whatever', properties: {} });
    expect(n.objectType).toBe('whatever');
  });

  it('normalizes an empty objectType to null (no bypass)', async () => {
    const n = await createNode({ memoryId: memId, loc: 'empty', name: 'E', objectType: '  ', properties: { anything: 1 } });
    expect(n.objectType).toBeNull(); // stored as an ordinary node, not ""
  });

  it('a rejected update leaves no revision (validate before snapshot)', async () => {
    const n = await createNode({ memoryId: memId, loc: 'c.rev', name: 'R', objectType: 'competitor', properties: { name: 'R' } });
    await expect(
      (resolvers.Mutation as any).updateNode(null, { input: { memoryId: memId, loc: 'c.rev', properties: {} } }, admin()),
    ).rejects.toMatchObject({ extensions: { code: 'BAD_USER_INPUT' } });
    expect(await db.nodeRevision.count({ where: { nodeId: n.id } })).toBe(0);
  });
});

describe('replaceSubtree — schema enforcement (bulk path bypasses writeNodeCore)', () => {
  it('rejects an imported node that violates the schema', async () => {
    await expect(
      (resolvers.Mutation as any).replaceSubtree(
        null,
        {
          ownerRepo: 'acme/repo',
          memoryId: memId,
          nodes: [{ memoryId: memId, loc: 'imp', name: 'I', objectType: 'competitor', properties: {} }],
          edges: [],
        },
        admin(),
      ),
    ).rejects.toMatchObject({ extensions: { code: 'BAD_USER_INPUT' } });
  });
});

describe('hadron_create_node — schema enforcement (MCP)', () => {
  const call = (args: Record<string, unknown>) => createTestableMcpServer(adminAuth()).callToolText('hadron_create_node', args);

  it('accepts a valid collection member', async () => {
    const text = await call({ urn: emitNodeUrnV2(memUrn, 'c.mcp'), name: 'C', objectType: 'competitor', properties: { name: 'C', stage: 'seed' } });
    expect(text.toLowerCase()).not.toContain('schema violation');
  });

  it('surfaces a schema violation as tool-error text', async () => {
    const text = await call({ urn: emitNodeUrnV2(memUrn, 'c.bad'), name: 'B', objectType: 'competitor', properties: { stage: 'seed' } });
    expect(text).toContain('Schema violation');
  });
});
