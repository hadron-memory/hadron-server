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
const typedTaskSchema = {
  objectTypes: {
    task: {
      strict: true,
      fields: {
        title: { type: 'text', required: true },
        exports: { type: 'text', required: true },
      },
    },
  },
};
const skillExports = { claudeSkill: { name: 'typed-task', description: 'Use when testing typed tasks.', enable: true } };

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

describe('platform-owned exports on typed nodes (#1286)', () => {
  it('allows task-door create/update under a strict collection that declares required text exports', async () => {
    await (resolvers.Mutation as any).updateMemory(null, { id: memId, schema: typedTaskSchema }, admin());
    const mutation = resolvers.Mutation as any;
    const node = await mutation.createTaskNode(null, {
      input: { memoryId: memId, loc: 'tasks:typed', name: 'Typed', isRunnable: true, objectType: 'task', properties: { title: 'T' } },
    }, admin());
    expect(node.properties).toEqual({ title: 'T' }); // collection-required exports has no authority

    await mutation.updateTaskNode(null, {
      input: { id: node.id, properties: { title: 'T', exports: skillExports } },
    }, admin());
    expect((await db.node.findUniqueOrThrow({ where: { id: node.id } })).properties).toEqual({ title: 'T', exports: skillExports });

    await mutation.updateTaskNode(null, {
      input: { id: node.id, properties: { title: 'T', exports: { claudeSkill: [] } } },
    }, admin());
    const plan = await (resolvers.Query as any).skillPlan(null, { input: { intent: 'LINT' } }, admin());
    const entry = plan.entries.find((item: { urn: string }) => item.urn.endsWith('tasks:typed'));
    expect(entry.findings).toEqual(expect.arrayContaining([expect.objectContaining({ rule: 'skill-declaration-malformed', severity: 'error' })]));

    await expect(mutation.updateTaskNode(null, {
      input: { id: node.id, properties: { title: 'T', exports: skillExports, unrelated: true } },
    }, admin())).rejects.toMatchObject({ extensions: { code: 'BAD_USER_INPUT' } });
  });
});

describe('replaceSubtree — retired bulk path', () => {
  it('refuses before interpreting even a schema-invalid payload', async () => {
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
    ).rejects.toMatchObject({ extensions: { code: 'REPLACE_SUBTREE_RETIRED' } });
    expect(await db.node.count({ where: { memoryId: memId, loc: 'imp' } })).toBe(0);
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

  it('accepts exports on strict typed create/update while still rejecting unrelated fields', async () => {
    await (resolvers.Mutation as any).updateMemory(null, { id: memId, schema: {
      objectTypes: { competitor: { strict: true, fields: { name: { type: 'text', required: true } } } },
    } }, admin());
    const urn = emitNodeUrnV2(memUrn, 'c.exports');
    expect(await call({ urn, name: 'C', objectType: 'competitor', properties: { name: 'C', exports: skillExports } }))
      .not.toContain('Schema violation');
    const server = createTestableMcpServer(adminAuth());
    expect(await server.callToolText('hadron_update_node', { urn, properties: { name: 'C', exports: { claudeSkill: [] } } }))
      .not.toContain('Schema violation');
    expect(await server.callToolText('hadron_update_node', { urn, properties: { name: 'C', exports: skillExports, extra: 1 } }))
      .toContain('Schema violation');
  });
});
