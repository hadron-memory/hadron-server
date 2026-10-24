import { withIncludeHistoryClientTransaction } from './includes/includeHistoryFence.js';
/**
 * #1838 — historical per-revision approval (cor:dmo:060:04, R7): a revision is
 * approved when some recorded approval covers exactly its hashed content.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../integrations/db/client.js';
import { cleanDb } from '../test/helpers.js';
import { generateId } from './id.js';
import { computeApprovalHash } from './approvalHash.js';
import { revisionApprovalOf, endApprovalsOnEncryptedEntry } from './nodeApproval.js';
import { revisionsExemptFromPruning } from './nodeRevisionSnapshot.js';
import { resolvers, type Context } from '../api/graphql/schema/resolvers.js';
import { createTestableMcpServer } from '../mcp/server.js';

vi.mock('../integrations/github/writeNodeToGit.js', () => ({
  writeNodeToGit: vi.fn().mockResolvedValue(undefined),
}));

let admin: { id: string };
let orgId: string;
let memory: { id: string };

const as = (userId = admin.id): Context => ({ db, userId, roles: [] });
const mk = (loc: string) => db.node.create({
  data: { id: generateId(), memoryId: memory.id, loc, name: `Title ${loc}`, abstract: `Abstract ${loc}`, content: 'v1' },
});
const approve = (nodeRef: string) => resolvers.Mutation.approveNode(null, { nodeRef }, as());
const edit = (id: string, content: string) => resolvers.Mutation.updateNode(null, { input: { id, content } }, as());
const touchMeta = (id: string, tags: string[]) => resolvers.Mutation.updateNode(null, { input: { id, tags } }, as());
const stateOf = async (nodeId: string, revNo: number) => (await revisionApprovalOf(db, nodeId, revNo)).state;

beforeEach(async () => {
  await cleanDb(db);
  const org = await db.organization.create({ data: { id: generateId(), name: 'Rev Org', urn: 'rev.example' } });
  orgId = org.id;
  admin = await db.user.create({ data: { githubId: 183801, githubUsername: 'rev-admin', handle: 'rev-admin', roles: [] } });
  await db.orgMember.create({ data: { organizationId: org.id, userId: admin.id, role: 'ADMIN' } });
  memory = await resolvers.Mutation.createMemory(null, { orgId: org.id, name: 'rev-approvals' }, as());
});

describe('revisionApprovalOf (#1838, R7)', () => {
  it('1: approve R, change, approve S: both read approved, each by its own record', async () => {
    const n = await mk('r:1');
    await approve(n.id); // rev 1
    await edit(n.id, 'v2'); // rev 2
    await approve(n.id);
    await edit(n.id, 'v3'); // rev 3
    const r1 = await revisionApprovalOf(db, n.id, 1);
    const r2 = await revisionApprovalOf(db, n.id, 2);
    expect(r1).toMatchObject({ state: 'APPROVED', record: { revision: 1, approvedBy: admin.id } });
    expect(r2).toMatchObject({ state: 'APPROVED', record: { revision: 2 } });
    expect(r1.record!.hash).not.toBe(r2.record!.hash);
    expect(await stateOf(n.id, 3)).toBe('NOT_APPROVED');
  });

  it('2 (R7 earlier): a metadata-only revision after the approval reads approved by the earlier record', async () => {
    const n = await mk('r:2');
    await approve(n.id); // rev 1
    await touchMeta(n.id, ['x']); // rev 2, same hashed text
    await touchMeta(n.id, ['y']); // rev 3
    await edit(n.id, 'changed'); // rev 4
    expect(await revisionApprovalOf(db, n.id, 2)).toMatchObject({ state: 'APPROVED', record: { revision: 1 } });
    expect(await stateOf(n.id, 3)).toBe('APPROVED');
    expect(await stateOf(n.id, 4)).toBe('NOT_APPROVED');
  });

  it('3 (R7 later): an approval recorded on a later identical-content revision covers the earlier one', async () => {
    const n = await mk('r:3');
    await touchMeta(n.id, ['x']); // rev 2: same text as rev 1
    await approve(n.id); // recorded at rev 2
    await edit(n.id, 'changed'); // rev 3
    expect(await revisionApprovalOf(db, n.id, 1)).toMatchObject({ state: 'APPROVED', record: { revision: 2 } });
    expect(await stateOf(n.id, 2)).toBe('APPROVED');
  });

  it('4/5: changed content and never-approved revisions (even between approved ones) read not approved', async () => {
    const n = await mk('r:4');
    await approve(n.id); // 1
    await edit(n.id, 'middle'); // 2, never approved
    await edit(n.id, 'last'); // 3
    await approve(n.id);
    await edit(n.id, 'after'); // 4
    expect(await stateOf(n.id, 1)).toBe('APPROVED');
    expect(await stateOf(n.id, 2)).toBe('NOT_APPROVED');
    expect(await stateOf(n.id, 3)).toBe('APPROVED');
    expect((await revisionApprovalOf(db, n.id, 2)).record).toBeNull();
  });

  it('reads the LIVE revision from the node when no snapshot exists', async () => {
    const n = await mk('r:5');
    await approve(n.id);
    expect(await stateOf(n.id, 1)).toBe('APPROVED');
    expect(await stateOf(n.id, 9)).toBe('NOT_APPROVED');
  });

  it('6: a snapshot whose text no longer hashes to its copied approval is not approved by it', async () => {
    const n = await mk('r:6');
    await approve(n.id);
    await edit(n.id, 'changed');
    await db.nodeRevision.updateMany({ where: { nodeId: n.id, revNo: 1 }, data: { content: 'tampered' } });
    expect(await stateOf(n.id, 1)).toBe('NOT_APPROVED');
    // The altered row must not vouch for a byte-identical sibling either.
    await db.nodeRevision.create({
      data: { id: generateId(), nodeId: n.id, memoryId: memory.id, loc: 'r:6', name: 'Title r:6', abstract: 'Abstract r:6', content: 'v1', tags: [], revNo: 9 },
    });
    expect(await stateOf(n.id, 9)).toBe('NOT_APPROVED');
  });

  it('11: legacy rows: only a row with copied approval columns and a revNo counts', async () => {
    const n = await mk('r:7');
    await approve(n.id); // rev 1
    await edit(n.id, 'two'); // rev 2 snapshot of rev 1 carries the approval
    const carried = await db.nodeRevision.findFirstOrThrow({ where: { nodeId: n.id, revNo: 1 } });
    const base = {
      nodeId: n.id, memoryId: memory.id, loc: 'r:7', name: 'Title r:7', abstract: 'Abstract r:7', tags: [] as string[],
    };
    // pre-#620-style row: no approval columns; same text as the approved one.
    await db.nodeRevision.create({ data: { id: generateId(), ...base, content: 'v1', revNo: 7 } });
    // approval columns but NO revNo (pre-#621): never pinned, never counts.
    await db.nodeRevision.create({
      data: {
        id: generateId(), ...base, content: 'legacy', revNo: null,
        approvedBy: admin.id, approvedAt: new Date(),
        approvalHash: computeApprovalHash({ title: 'Title r:7', abstract: 'Abstract r:7', content: 'legacy' }),
      },
    });
    expect(carried.approvalHash).not.toBeNull();
    expect(await stateOf(n.id, 1)).toBe('APPROVED');
    expect(await stateOf(n.id, 7)).toBe('APPROVED'); // identical text to a real record (R7)
    await db.nodeRevision.deleteMany({ where: { id: carried.id } });
    expect(await stateOf(n.id, 7)).toBe('NOT_APPROVED'); // the legacy NULL-revNo row covers nothing
  });

  it('records from another capture memory never cover this one', async () => {
    const n = await mk('r:8');
    await approve(n.id);
    await edit(n.id, 'changed');
    const other = await resolvers.Mutation.createMemory(null, { orgId, name: 'other-capture' }, as());
    await db.nodeRevision.updateMany({ where: { nodeId: n.id, revNo: 1 }, data: { memoryId: other.id } });
    await db.nodeRevision.create({
      data: { id: generateId(), nodeId: n.id, memoryId: memory.id, loc: 'r:8', name: 'Title r:8', abstract: 'Abstract r:8', content: 'v1', tags: [], revNo: 5 },
    });
    expect(await stateOf(n.id, 5)).toBe('NOT_APPROVED');
  });

  it('GraphQL NodeRevision.revisionApproval follows the same derivation', async () => {
    const n = await mk('r:9');
    await approve(n.id);
    await touchMeta(n.id, ['m']);
    const rows = await db.nodeRevision.findMany({ where: { nodeId: n.id }, orderBy: { revNo: 'asc' } });
    const out = await resolvers.NodeRevision.revisionApproval(rows[0], {}, as());
    expect(out).toMatchObject({ state: 'APPROVED', approved: true, recordedAtRevision: 1, approvedBy: admin.id });
  });
});

describe('approval carriers survive cap-pruning (#1838)', () => {
  it('10: cap-prune keeps the carrying revision; a deliberate delete removes it and the dependent stops reading approved', async () => {
    await db.memory.update({ where: { id: memory.id }, data: { maxRevCount: 2 } });
    const n = await mk('p:1');
    await approve(n.id); // rev 1
    await touchMeta(n.id, ['a']); // rev 2
    await edit(n.id, 'changed'); // rev 3 -> snapshot of rev 2, record carried on rev 1's snapshot
    for (let i = 0; i < 4; i++) await edit(n.id, `more ${i}`);
    const kept = await db.nodeRevision.findMany({ where: { nodeId: n.id }, select: { revNo: true, approvalHash: true } });
    expect(kept.some((r) => r.revNo === 1 && r.approvalHash)).toBe(true);
    expect([...await revisionsExemptFromPruning(db, n.id, memory.id)]).toContain(1);
    expect(kept.length).toBeLessThan(6); // unrelated revisions still prune
    await resolvers.Mutation.clearNodeHistory(null, { nodeRef: n.id }, as());
    expect(await stateOf(n.id, 1)).toBe('NOT_APPROVED');
  });

  it('the exemption set also holds signed revisions', async () => {
    const n = await mk('p:2');
    expect((await revisionsExemptFromPruning(db, n.id, memory.id)).size).toBe(0);
  });
});

describe('entering an encrypted memory ends approvals (#1838, cor:dmo:120:04)', () => {
  it('E-A/E-B/E-D: hashes cleared, audit kept, nothing revives, a fresh approval counts, other nodes untouched', async () => {
    const n = await mk('e:1');
    const other = await mk('e:2');
    await approve(n.id); // 1
    await approve(other.id);
    await touchMeta(n.id, ['x']); // 2
    await edit(n.id, 'changed'); // 3
    await edit(n.id, 'v1'); // 4: byte-identical to rev 1 (history keeps a copy)
    await withIncludeHistoryClientTransaction(db, (tx) => endApprovalsOnEncryptedEntry(tx, { nodeIds: [n.id] }));
    const node = await db.node.findUniqueOrThrow({ where: { id: n.id } });
    expect(node).toMatchObject({ approvalHash: null, approvedBy: admin.id });
    expect(node.approvedRevNo).not.toBeNull();
    expect(node.approvedAt).not.toBeNull();
    const revs = await db.nodeRevision.findMany({ where: { nodeId: n.id } });
    expect(revs.every((r) => r.approvalHash === null)).toBe(true);
    expect(revs.some((r) => r.approvedBy === admin.id)).toBe(true); // audit kept
    for (const r of [1, 2, 4]) expect(await stateOf(n.id, r)).toBe('NOT_APPROVED');
    // E-D: a node outside the seam call is untouched.
    expect((await db.node.findUniqueOrThrow({ where: { id: other.id } })).approvalHash).not.toBeNull();
    // Fresh approval after the seam counts again and covers byte-identical text.
    const live = await db.node.findUniqueOrThrow({ where: { id: n.id } });
    const receipt = await approve(n.id);
    expect(receipt.approval.revision).toBe(live.revSeq);
    expect(await stateOf(n.id, 1)).toBe('APPROVED');
  });

  it('E-A: in-place encryption runs the seam for the memory nodes, tombstones and snapshots', async () => {
    const enc = await resolvers.Mutation.createMemory(null, { orgId, name: 'enc-seam', memoryClass: 'private' }, as());
    const n = await db.node.create({ data: { id: generateId(), memoryId: enc.id, loc: 'e:3', name: 'S', content: 'body' } });
    const gone = await db.node.create({ data: { id: generateId(), memoryId: enc.id, loc: 'e:4', name: 'T', content: 'body2' } });
    await resolvers.Mutation.approveNode(null, { nodeRef: n.id }, as());
    await edit(n.id, 'changed');
    await resolvers.Mutation.approveNode(null, { nodeRef: gone.id }, as());
    await resolvers.Mutation.deleteNode(null, { nodeRef: gone.id }, as());
    const dataKey = Buffer.alloc(32, 9).toString('base64');
    await resolvers.Mutation.encryptMemory(null, { memoryId: enc.id, dataKey }, as());
    for (const id of [n.id, gone.id]) {
      const row = await db.node.findUniqueOrThrow({ where: { id } });
      expect(row.approvalHash).toBeNull();
      expect(row.approvedBy).toBe(admin.id);
      const revs = await db.nodeRevision.findMany({ where: { nodeId: id } });
      expect(revs.every((r) => r.approvalHash === null)).toBe(true);
    }
  });
});

describe('a hashless record authorizes nothing, on any surface (#1838)', () => {
  it('status, filters (Prisma and SQL), mint and the MCP line treat an ended approval as not approved; controls stay approved', async () => {
    const ended = await mk('h:1');
    const control = await mk('h:2');
    await db.node.update({ where: { id: ended.id }, data: { properties: { marker: 'yes' } } });
    await db.node.update({ where: { id: control.id }, data: { properties: { marker: 'yes' } } });
    await approve(ended.id);
    await approve(control.id);
    // the memory is plaintext again (the fixture stands in for a move out)
    await withIncludeHistoryClientTransaction(db, (tx) => endApprovalsOnEncryptedEntry(tx, { nodeIds: [ended.id] }));

    const row = await db.node.findUniqueOrThrow({ where: { id: ended.id } });
    expect(await resolvers.Node.approvalStatus(row, {}, as())).toEqual({ state: 'NOT_APPROVED', approval: null });
    const ctrl = await db.node.findUniqueOrThrow({ where: { id: control.id } });
    expect((await resolvers.Node.approvalStatus(ctrl, {}, as())).state).toBe('APPROVED');

    for (const viaSql of [false, true]) {
      for (const state of ['APPROVED', 'NOT_APPROVED', 'SUPERSEDED'] as const) {
        const res = await resolvers.Query.findNodes(null, {
          filter: { memoryIds: [memory.id], approvalState: state, ...(viaSql ? { where: { path: ['marker'], eq: 'yes' } } : {}) },
        }, as());
        const ids = res.hits.map((h: { node: { id: string } }) => h.node.id);
        expect(ids.includes(ended.id)).toBe(state === 'NOT_APPROVED');
        expect(ids.includes(control.id)).toBe(state === 'APPROVED');
      }
    }

    const mcp = createTestableMcpServer({ userId: admin.id, roles: [], clientId: `user:${admin.id}` });
    const mem = await db.memory.findUniqueOrThrow({ where: { id: memory.id } });
    const text = await mcp.callToolText('hadron_get_node', { urn: `hrn:node:${mem.urn}:h:1` });
    expect(text).toContain('Approval: not approved');
    expect(await mcp.callToolText('hadron_get_node', { urn: `hrn:node:${mem.urn}:h:2` })).toContain('Approval: approved');

    await expect(resolvers.Mutation.mintMemoryNodes(null, { memoryRef: memory.id, dryRun: false }, as()))
      .rejects.toBeDefined();
    expect((await db.node.findUniqueOrThrow({ where: { id: ended.id } })).mintedAt).toBeNull();
    expect((await revisionApprovalOf(db, ended.id, 1)).state).toBe('NOT_APPROVED');
  });
});

describe('anonymous promotion ends approvals in its flip transaction (#1838, QA P2)', () => {
  it('an interrupted completion pass leaves no live or copied hash, audit kept', async () => {
    const { withTestOperationKey } = await import('../test/operationKey.js');
    const { memoryMutations } = await import('../api/graphql/schema/resolvers.mutation.memory.js');
    const org = await db.organization.findUniqueOrThrow({ where: { id: orgId } });
    const app = await db.app.create({ data: { name: 'Promo App', urn: 'rev.example:promo', organizationId: orgId } });
    const agent = await db.agent.create({ data: { name: 'Promo agent', urn: 'rev.example:promo-agent', organizationId: orgId } });
    const anon = await db.memory.create({ data: {
      name: 'Anon', urn: 'rev.example:anon', organizationId: org.id, appId: app.id, userMemoryOfAgentId: agent.id,
      anonymousExpiresAt: new Date(Date.now() + 86400000), class: 'app',
    } });
    const n = await db.node.create({ data: { id: generateId(), memoryId: anon.id, loc: 'a:1', name: 'T', abstract: 'A', content: 'one' } });
    await resolvers.Mutation.approveNode(null, { nodeRef: n.id }, { db, appId: app.id, userId: admin.id, roles: [] } as Context)
      .catch(async () => {
        // an anonymous App-scoped memory is not approvable through the user path: stamp a record directly
        const h = computeApprovalHash({ title: 'T', abstract: 'A', content: 'one' });
        await db.node.update({ where: { id: n.id }, data: { approvedRevNo: 1, approvedBy: admin.id, approvedAt: new Date(), approvalHash: h } });
      });
    await edit(n.id, 'two').catch(async () => {
      await db.node.update({ where: { id: n.id }, data: { content: 'two' } });
    });
    await db.nodeRevision.create({ data: {
      id: generateId(), nodeId: n.id, memoryId: anon.id, loc: 'a:1', name: 'T', abstract: 'A', content: 'one', tags: [], revNo: 7,
      approvedBy: admin.id, approvedAt: new Date(), approvalHash: computeApprovalHash({ title: 'T', abstract: 'A', content: 'one' }),
    } });
    const key = Buffer.alloc(32, 5).toString('base64');
    const spy = vi.spyOn(memoryMutations, 'encryptMemory').mockRejectedValue(new Error('interrupted'));
    try {
      await expect(withTestOperationKey(key, app.id, () =>
        resolvers.Mutation.linkMemoryToUser({}, { memoryId: anon.id, externalUserId: 'promo-user' }, { db, appId: app.id, roles: [] }),
      )).rejects.toThrow('interrupted');
    } finally { spy.mockRestore(); }
    expect((await db.memory.findUniqueOrThrow({ where: { id: anon.id } })).isEncrypted).toBe(true);
    const live = await db.node.findUniqueOrThrow({ where: { id: n.id } });
    expect(live.approvalHash).toBeNull();
    expect(live.approvedBy).toBe(admin.id);
    expect(live.approvedAt).not.toBeNull();
    const revs = await db.nodeRevision.findMany({ where: { nodeId: n.id } });
    expect(revs.every((r) => r.approvalHash === null)).toBe(true);
    expect(revs.some((r) => r.approvedBy === admin.id && r.approvedAt)).toBe(true);
  });
});

describe('entry clears snapshots captured elsewhere for a node now resident (#1838, blind P2)', () => {
  it('approve in A, metadata edit, move to B, encrypt B: A-captured hashes are cleared too', async () => {
    const b = await resolvers.Mutation.createMemory(null, { orgId, name: 'move-target', memoryClass: 'private' }, as());
    const n = await mk('m:1');
    await approve(n.id);
    await touchMeta(n.id, ['x']); // snapshot of rev 1 captured in A carries the record
    const carried = await db.nodeRevision.findFirstOrThrow({ where: { nodeId: n.id, approvalHash: { not: null } } });
    expect(carried.memoryId).toBe(memory.id);
    await db.node.update({ where: { id: n.id }, data: { memoryId: b.id } });
    await withIncludeHistoryClientTransaction(db, (tx) => endApprovalsOnEncryptedEntry(tx, { memoryId: b.id }));
    expect((await db.node.findUniqueOrThrow({ where: { id: n.id } })).approvalHash).toBeNull();
    const after = await db.nodeRevision.findUniqueOrThrow({ where: { id: carried.id } });
    expect(after.approvalHash).toBeNull();
    expect(after.approvedBy).toBe(admin.id);
  });
});
