/**
 * #725 PR B — Memory.schema: updateMemory validates + stores the property schema,
 * rejects malformed input, clears with null, and the MCP memory listing surfaces
 * it read-only for discovery.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { resolvers, type Context } from './resolvers.js';
import { createTestableMcpServer } from '../../../mcp/server.js';
import type { AuthContext } from '../../../middleware/auth.js';
import { generateId } from '../../../lib/id.js';
import { cloneMemoryGraph } from '../../../controller/operations/cloneMemory.js';

vi.mock('../../../integrations/github/writeNodeToGit.js', () => ({
  writeNodeToGit: vi.fn().mockResolvedValue(undefined),
}));

const validSchema = {
  objectTypes: {
    competitor: {
      fields: {
        name: { type: 'text', required: true },
        stage: { type: 'enum', values: ['seed', 'series-a'] },
      },
    },
  },
};

let adminId: string;
let memId: string;
let memUrn: string;
const admin = (): Context => ({ db, roles: ['ADMIN'], userId: adminId } as Context);
const adminAuth = (): AuthContext => ({ userId: adminId, roles: ['ADMIN'], clientId: `user:${adminId}` });
const updateMemory = (input: Record<string, unknown>) => (resolvers.Mutation as any).updateMemory(null, input, admin());

beforeEach(async () => {
  await cleanDb(db);
  const org = await db.organization.create({ data: { id: generateId(), name: 'ms-org', urn: 'ms-org' } });
  const a = await db.user.create({ data: { githubId: 9811, githubUsername: 'ms-admin', roles: ['ADMIN'] } });
  await db.orgMember.create({ data: { organizationId: org.id, userId: a.id, role: 'ADMIN' } });
  adminId = a.id;
  const mem = await resolvers.Mutation.createMemory({}, { orgId: org.id, name: 'intel' }, admin());
  memId = mem.id;
  memUrn = mem.urn;
});

describe('Memory.schema — write + validation', () => {
  it('stores a valid schema (normalized)', async () => {
    const m = await updateMemory({ id: memId, schema: validSchema });
    expect(m.schema.objectTypes.competitor.fields.name).toEqual({ type: 'text', required: true });
    expect(m.schema.objectTypes.competitor.fields.stage.values).toEqual(['seed', 'series-a']);
  });

  it('rejects a malformed schema (bad field type) as BAD_USER_INPUT', async () => {
    await expect(
      updateMemory({ id: memId, schema: { objectTypes: { c: { fields: { a: { type: 'json' } } } } } }),
    ).rejects.toMatchObject({ extensions: { code: 'BAD_USER_INPUT' } });
  });

  it('rejects an unknown field-def key (typo) as BAD_USER_INPUT', async () => {
    await expect(
      updateMemory({ id: memId, schema: { objectTypes: { c: { fields: { a: { type: 'text', requird: true } } } } } }),
    ).rejects.toMatchObject({ extensions: { code: 'BAD_USER_INPUT' } });
  });

  it('clears the schema with null', async () => {
    await updateMemory({ id: memId, schema: validSchema });
    const cleared = await updateMemory({ id: memId, schema: null });
    expect(cleared.schema).toBeNull();
  });

  it('a rejected write does not persist (memory keeps the prior schema)', async () => {
    await updateMemory({ id: memId, schema: validSchema });
    await expect(updateMemory({ id: memId, schema: { objectTypes: {} } })).rejects.toMatchObject({
      extensions: { code: 'BAD_USER_INPUT' },
    });
    const row = await db.memory.findUniqueOrThrow({ where: { id: memId } });
    expect((row.schema as any).objectTypes.competitor).toBeDefined();
  });
});

describe('Memory.schema — carried through a memory clone', () => {
  it('cloneMemoryGraph copies the schema to the clone', async () => {
    await updateMemory({ id: memId, schema: validSchema });
    const orgId = (await db.memory.findUniqueOrThrow({ where: { id: memId } })).organizationId!;
    const { memoryId: cloneId } = await cloneMemoryGraph(db, {
      sourceMemoryId: memId,
      name: 'intel-copy',
      newUrn: 'ms-org:intel-copy',
      targetOrganizationId: orgId,
      ownerUserId: null,
      groupOwnerUserId: null,
      actorId: adminId,
      copierReadableMemoryIds: null,
    });
    const clone = await db.memory.findUniqueOrThrow({ where: { id: cloneId } });
    expect((clone.schema as any).objectTypes.competitor.fields.name).toEqual({ type: 'text', required: true });
  });

  it('carries only verified, unchanged authorship through rewritten and raw-edited clones', async () => {
    const stamp = {
      authorshipKind: 'TASK' as const,
      authoredByTask: generateId(),
      authoredByRevision: 1,
      authoredAt: new Date('2026-09-26T20:00:00Z'),
    };
    const make = (loc: string, content: string, objectType?: string) => db.node.create({
      data: { id: generateId(), memoryId: memId, loc, name: loc, content, objectType, ...stamp },
    });
    const rewritten = await make('rewritten', 'See ms-org:intel:guide');
    const drifted = await make('drifted', 'old body');
    await make('unchanged', 'stable body', 'competitor');
    await db.node.update({ where: { id: drifted.id }, data: { content: 'raw edited body' } });
    const orgId = (await db.memory.findUniqueOrThrow({ where: { id: memId } })).organizationId!;
    const { memoryId: cloneId } = await cloneMemoryGraph(db, {
      sourceMemoryId: memId, name: 'intel-copy', newUrn: 'ms-org:intel-copy',
      targetOrganizationId: orgId, ownerUserId: null, groupOwnerUserId: null, actorId: adminId, copierReadableMemoryIds: null,
    });
    const copies = await db.node.findMany({ where: { memoryId: cloneId } });
    const byLoc = new Map(copies.map((n) => [n.loc, n]));
    expect(byLoc.get('rewritten')).toMatchObject({ content: 'See ms-org:intel-copy:guide', authorshipKind: null });
    expect(byLoc.get('drifted')).toMatchObject({ content: 'raw edited body', authorshipKind: null });
    expect(byLoc.get('unchanged')).toMatchObject({ content: 'stable body', objectType: 'competitor', ...stamp });
    expect(await db.node.findUniqueOrThrow({ where: { id: rewritten.id } })).toMatchObject(stamp);
    expect(await db.node.findUniqueOrThrow({ where: { id: drifted.id } })).toMatchObject({ authorshipKind: null, revSeq: 2 });
  });
});

describe('Memory.schema — MCP discovery (read-only)', () => {
  it('hadron_list_memories surfaces the schema', async () => {
    await updateMemory({ id: memId, schema: validSchema });
    const text = await createTestableMcpServer(adminAuth()).callToolText('hadron_list_memories', {});
    expect(text).toContain(memUrn);
    expect(text).toContain('schema:');
    expect(text).toContain('competitor');
  });
});
