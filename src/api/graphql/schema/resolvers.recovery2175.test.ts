/** #2175: explicit writer-only recovery, preserving ordinary read and single-node restore semantics. */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { resolvers, type Context } from './resolvers.js';

vi.mock('../../../integrations/github/writeNodeToGit.js', () => ({ writeNodeToGit: vi.fn() }));
const Q = resolvers.Query as unknown as Record<string, (p: unknown, a: any, c: Context) => Promise<any>>;
const M = resolvers.Mutation as unknown as Record<string, (p: unknown, a: any, c: Context) => Promise<any>>;
let memoryId: string, writerId: string, readerId: string;
const ctx = (userId = writerId): Context => ({ db, userId, roles: [] });
const node = (loc: string, extra: Record<string, unknown> = {}) => db.node.create({ data: {
  id: generateId(), memoryId, loc, name: loc, content: 'raw {{missing}}', deletedAt: new Date('2026-01-01'), ...extra,
} });
beforeEach(async () => {
  await cleanDb(db);
  const org = await db.organization.create({ data: { name: 'Recovery', urn: 'recovery2175.example' } });
  writerId = (await db.user.create({ data: { handle: 'recovery-writer' } })).id;
  readerId = (await db.user.create({ data: { handle: 'recovery-reader' } })).id;
  await db.orgMember.createMany({ data: [
    { organizationId: org.id, userId: writerId, role: 'CONTRIBUTOR' },
    { organizationId: org.id, userId: readerId, role: 'READER' },
  ] });
  memoryId = (await db.memory.create({ data: { organizationId: org.id, class: 'knowledge', name: 'Recovery', urn: 'recovery2175.example:corpus' } })).id;
});

describe('explicit recovery reads', () => {
  it('returns an old retained tombstone without compiling its stored body; normal node read remains null', async () => {
    const n = await node('a');
    expect(await Q.node({}, { ref: n.id }, ctx())).toBeNull();
    const recovered = await Q.recoveryNode({}, { nodeRef: n.id }, ctx());
    expect(recovered).toMatchObject({ id: n.id, deletedAt: n.deletedAt });
    // Content is a selection-time resolver so encrypted metadata inspection needs no plaintext key.
    const R = resolvers.RecoveryNode as unknown as Record<string, (...a: any[]) => Promise<unknown>>;
    expect(await R.content(recovered, {}, ctx())).toBe('raw {{missing}}');
    expect(recovered.urn).toBe('hrn:node:recovery2175.example:corpus:a');
  });
  it('conceals deleted content from a reader and treats live nodes as absent on the recovery point read', async () => {
    const n = await node('a');
    expect(await Q.recoveryNode({}, { nodeRef: n.id }, ctx(readerId))).toBeNull();
    await db.node.update({ where: { id: n.id }, data: { deletedAt: null } });
    expect(await Q.recoveryNode({}, { nodeRef: n.id }, ctx())).toBeNull();
  });
  it('defaults omitted and null pages to20, with exact total and continuation', async () => {
    for (let i = 0; i < 23; i++) await node(`n${String(i).padStart(2, '0')}`);
    await node('live', { deletedAt: null });
    for (const args of [{ memoryRef: memoryId }, { memoryRef: memoryId, limit: null }]) {
      const p = await Q.recoveryNodes({}, args, ctx());
      expect(p.total).toBe(23); expect(p.items).toHaveLength(20);
    }
    const tail = await Q.recoveryNodes({}, { memoryRef: memoryId, offset: 20 }, ctx());
    expect(tail.total).toBe(23); expect(tail.items).toHaveLength(3);
  });
  it('refuses a reader-only listing rather than exposing its count', async () => {
    await node('a');
    await expect(Q.recoveryNodes({}, { memoryRef: memoryId }, ctx(readerId))).rejects.toThrow();
  });
  it('never opens a tombstone inside a deleted memory', async () => {
    const n = await node('a');
    await db.memory.update({ where: { id: memoryId }, data: { deletedAt: new Date() } });
    expect(await Q.recoveryNode({}, { nodeRef: n.id }, ctx())).toBeNull();
  });
});

describe('single-node restore', () => {
  it('clears only deletion state, retains body/history, and repeats without modifying a live node', async () => {
    const n = await node('a');
    const before = await db.nodeRevision.count({ where: { nodeId: n.id } });
    const out = await M.restoreNode({}, { nodeRef: n.id }, ctx());
    expect(out).toMatchObject({ id: n.id, content: n.content, deletedAt: null, deletedBy: null });
    const first = await db.node.findUniqueOrThrow({ where: { id: n.id } });
    await M.restoreNode({}, { nodeRef: n.id }, ctx());
    expect(await db.node.findUniqueOrThrow({ where: { id: n.id } })).toEqual(first);
    expect(await db.nodeRevision.count({ where: { nodeId: n.id } })).toBe(before);
  });
  it('requires the parent to be restored first', async () => {
    const parent = await node('a'), child = await node('a:b');
    await expect(M.restoreNode({}, { nodeRef: child.id }, ctx())).rejects.toMatchObject({ extensions: { code: 'NODE_PARENT_DELETED' } });
    await M.restoreNode({}, { nodeRef: parent.id }, ctx());
    expect((await M.restoreNode({}, { nodeRef: child.id }, ctx())).deletedAt).toBeNull();
  });
  it.each([{ role: 'review' }, { role: 'spec.rule' }, { isRunnable: true }])('refuses governed tombstone %j without writing', async (signal) => {
    const n = await node('g', signal);
    await expect(M.restoreNode({}, { nodeRef: n.id }, ctx())).rejects.toMatchObject({ extensions: { code: 'ROLE_GOVERNED' } });
    expect((await db.node.findUniqueOrThrow({ where: { id: n.id } })).deletedAt).toEqual(n.deletedAt);
  });
  it('does not grant recovery to a run acting on behalf of a writer', async () => {
    const n = await node('a');
    await expect(M.restoreNode({}, { nodeRef: n.id }, { ...ctx(), clientId: 'run:synthetic' })).rejects.toThrow();
  });
});
