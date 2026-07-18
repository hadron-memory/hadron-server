/**
 * #725 PR C2 — the conformance audit (hadron_validate) + the enforcement seam
 * folded into the remaining direct-write paths (#737: restoreNodeRevision,
 * mergeMemories).
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { resolvers, type Context } from './resolvers.js';
import { createTestableMcpServer } from '../../../mcp/server.js';
import type { AuthContext } from '../../../middleware/auth.js';
import { generateId } from '../../../lib/id.js';

vi.mock('../../../integrations/github/writeNodeToGit.js', () => ({
  writeNodeToGit: vi.fn().mockResolvedValue(undefined),
}));

const competitorSchema = { objectTypes: { competitor: { fields: { name: { type: 'text', required: true } } } } };

let adminId: string;
let orgId: string;
let memId: string;
let memUrn: string;
const admin = (): Context => ({ db, roles: ['ADMIN'], userId: adminId } as Context);
const adminAuth = (): AuthContext => ({ userId: adminId, roles: ['ADMIN'], clientId: `user:${adminId}` });
const updateMemory = (input: Record<string, unknown>) => (resolvers.Mutation as any).updateMemory(null, input, admin());
const createNode = (input: Record<string, unknown>) => (resolvers.Mutation as any).createNode(null, { input }, admin());
const updateNode = (input: Record<string, unknown>) => (resolvers.Mutation as any).updateNode(null, { input }, admin());

beforeEach(async () => {
  await cleanDb(db);
  const org = await db.organization.create({ data: { id: generateId(), name: 'cf-org', urn: 'cf-org' } });
  orgId = org.id;
  const a = await db.user.create({ data: { githubId: 9831, githubUsername: 'cf-admin', roles: ['ADMIN'] } });
  await db.orgMember.create({ data: { organizationId: org.id, userId: a.id, role: 'ADMIN' } });
  adminId = a.id;
  const mem = await resolvers.Mutation.createMemory({}, { orgId, name: 'intel' }, admin());
  memId = mem.id;
  memUrn = mem.urn;
  await updateMemory({ id: memId, schema: competitorSchema });
});

describe('hadron_validate — property-schema conformance audit (#725)', () => {
  it('reports a non-conforming node (missing required field), passes a conforming one', async () => {
    // Conforming (via the enforced write path).
    await createNode({ memoryId: memId, loc: 'ok', name: 'OK', objectType: 'competitor', properties: { name: 'Letta' } });
    // Non-conforming, inserted DIRECTLY (simulates a row written before the schema
    // existed / outside the write seam) — missing required `name`.
    await db.node.create({ data: { id: generateId(), memoryId: memId, loc: 'bad', name: 'Bad', objectType: 'competitor', properties: {} } as any });
    // Undeclared collection, also direct.
    await db.node.create({ data: { id: generateId(), memoryId: memId, loc: 'ghost', name: 'Ghost', objectType: 'gadget', properties: {} } as any });

    const text = await createTestableMcpServer(adminAuth()).callToolText('hadron_validate', { memoryUrn: memUrn });
    expect(text).toContain('[schema]');
    expect(text).toContain('bad');
    expect(text).toContain('ghost');
    // The conforming 'ok' node is never schema-flagged.
    expect(text).not.toMatch(/\[schema\][^\n]*ok\b/);
  });
});

describe('restoreNodeRevision — enforces the current schema (#737)', () => {
  it('blocks restoring a snapshot that no longer conforms after a schema tightening', async () => {
    const n = await createNode({ memoryId: memId, loc: 'c.r', name: 'R', objectType: 'competitor', properties: { name: 'x' } });
    await updateNode({ memoryId: memId, loc: 'c.r', properties: { name: 'y' } }); // snapshots pre-edit {name:'x'}
    const rev = await db.nodeRevision.findFirst({ where: { nodeId: n.id }, orderBy: { revNo: 'desc' } });
    // Tighten: competitor now also requires `stage` — the snapshot lacks it.
    await updateMemory({ id: memId, schema: { objectTypes: { competitor: { fields: { name: { type: 'text', required: true }, stage: { type: 'text', required: true } } } } } });
    await expect((resolvers.Mutation as any).restoreNodeRevision(null, { revisionId: rev!.id }, admin())).rejects.toMatchObject({
      extensions: { code: 'BAD_USER_INPUT' },
    });
  });
});

describe('mergeMemories — enforces the target schema on relocate (#737)', () => {
  it('rejects relocating an undeclared-collection node into a schema-governed target', async () => {
    const src = await resolvers.Mutation.createMemory({}, { orgId, name: 'src' }, admin());
    await db.node.create({ data: { id: generateId(), memoryId: src.id, loc: 'g', name: 'G', objectType: 'gadget', properties: {} } as any });
    await expect(
      (resolvers.Mutation as any).mergeMemories(null, { input: { source: src.id, target: memId } }, admin()),
    ).rejects.toMatchObject({ extensions: { code: 'BAD_USER_INPUT' } });
  });
});
