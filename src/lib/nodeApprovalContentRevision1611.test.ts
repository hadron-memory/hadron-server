/**
 * #1611 (cor:dmo:120:04/01/05) — an approval stays valid until the hashed
 * content (title, abstract, content under approval-hash v1) changes.
 * Metadata-only revisions keep it; the approved revision stays the revision
 * the approval was recorded at; a change outside the write path is TAMPERED.
 */
import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../integrations/db/client.js';
import { cleanDb } from '../test/helpers.js';
import { generateId } from './id.js';
import type { NodeApprovalState } from './nodeApproval.js';
import { resolvers, type Context } from '../api/graphql/schema/resolvers.js';
import { createTestableMcpServer } from '../mcp/server.js';
import { specCorpusMintMutations } from '../api/graphql/schema/resolvers.specCorpus.js';

vi.mock('../integrations/github/writeNodeToGit.js', () => ({
  writeNodeToGit: vi.fn().mockResolvedValue(undefined),
}));

let admin: { id: string };
let memory: { id: string; urn: string };

const as = (): Context => ({ db, userId: admin.id, roles: [] });
const node = (loc: string, extra: Record<string, unknown> = {}) => db.node.create({
  data: { id: generateId(), memoryId: memory.id, loc, name: `Title ${loc}`, abstract: `Abstract ${loc}`, content: `Body ${loc}`, ...extra },
});
const approve = (nodeRef: string) => resolvers.Mutation.approveNode(null, { nodeRef }, as());
const verify = (nodeRef: string) => resolvers.Query.verifyNode(null, { nodeRef }, as());
const update = (id: string, input: Record<string, unknown>) =>
  resolvers.Mutation.updateNode(null, { input: { id, ...input } }, as());
const statusOf = async (id: string) => {
  const row = await db.node.findUniqueOrThrow({ where: { id } });
  return resolvers.Node.approvalStatus(row, {}, as());
};
const rowOf = (id: string) => db.node.findUniqueOrThrow({ where: { id } });
const filterLocs = async (approvalState: NodeApprovalState) => {
  const res = await resolvers.Query.findNodes(null, { filter: { memoryIds: [memory.id], approvalState } }, as());
  return res.hits.map((h: { node: { loc: string } }) => h.node.loc).filter((l: string) => l !== 'approvals').sort();
};

beforeEach(async () => {
  await cleanDb(db);
  const org = await db.organization.create({ data: { id: generateId(), name: 'Rev Org', urn: 'rev1611.example' } });
  admin = await db.user.create({ data: { githubId: 161101, githubUsername: 'rev-admin', handle: 'rev-admin', roles: [] } });
  await db.orgMember.create({ data: { organizationId: org.id, userId: admin.id, role: 'ADMIN' } });
  memory = await resolvers.Mutation.createMemory(null, { orgId: org.id, name: 'approvals' }, as());
});

/** An approved node, then one revisioned write; returns the node id. */
async function approvedThen(input: Record<string, unknown>, extra: Record<string, unknown> = {}) {
  const n = await node('a:1', extra);
  await approve(n.id);
  await update(n.id, input);
  return n.id;
}

describe('metadata-only revisions keep an approval (cor:dmo:120:04)', () => {
  const cases: Array<[string, Record<string, unknown>]> = [
    ['tags', { tags: ['t1', 't2'] }],
    ['properties', { properties: { k: 'v' } }],
    ['role', { role: 'note' }],
    ['description', { description: 'a new description' }],
    ['alias', { alias: 'an-alias' }],
  ];
  for (const [label, input] of cases) {
    it(`a ${label}-only revision leaves status, filters, verify and mint agreeing on APPROVED`, async () => {
      const id = await approvedThen(input);
      const row = await rowOf(id);
      expect(row.revSeq).toBe(2); // the write really was a new revision
      const status = await statusOf(id);
      expect(status.state).toBe('APPROVED');
      expect(status.approval?.revision).toBe(1); // approvedRevision stays where it was recorded
      expect(row.approvedRevNo).toBe(1);
      expect((await verify(id)).state).toBe('INTACT');
      expect(await filterLocs('APPROVED')).toEqual(['a:1']);
      expect(await filterLocs('SUPERSEDED')).toEqual([]);
      const dry = await specCorpusMintMutations.mintMemoryNodes(null, { memoryRef: memory.id, dryRun: true }, as());
      expect(dry.blockers.filter((b: { kind: string; loc: string }) => b.loc === 'a:1' && (b.kind === 'NOT_APPROVED' || b.kind === 'TAMPERED'))).toEqual([]);
    });
  }

  it('approving again after a metadata-only revision returns the existing approval, unmoved', async () => {
    const id = await approvedThen({ tags: ['x'] });
    const before = await rowOf(id);
    const receipt = await approve(id);
    expect(receipt.approval.revision).toBe(1);
    const after = await rowOf(id);
    expect(after.approvedRevNo).toBe(1);
    expect(after.approvedAt).toEqual(before.approvedAt);
  });

  it('moveNode keeps the approval', async () => {
    const n = await node('a:1');
    await approve(n.id);
    await resolvers.Mutation.moveNode(null, { sourceRef: n.id, targetUrn: `hrn:node:${memory.urn}:b:1` }, as());
    expect((await rowOf(n.id)).revSeq).toBeGreaterThan(1);
    expect((await statusOf(n.id)).state).toBe('APPROVED');
    expect((await verify(n.id)).state).toBe('INTACT');
  });

  it('a real mint after metadata-only housekeeping succeeds and certifies the unchanged text', async () => {
    const n = await node('a:1');
    await resolvers.Mutation.approveMemoryNodes(null, { memoryRef: memory.id }, as());
    await update(n.id, { tags: ['x'] });
    const done = await specCorpusMintMutations.mintMemoryNodes(null, { memoryRef: memory.id, dryRun: false }, as());
    expect(done.minted).toBe(true);
    const row = await rowOf(n.id);
    expect(row.mintedAt).not.toBeNull();
    expect(row.approvedRevNo).toBe(1);
    expect(row.mintedHash).toBe(row.approvalHash);
  });
});

describe('hashed-field changes supersede (cor:dmo:120:01, 120:04)', () => {
  const superseding: Array<[string, Record<string, unknown>]> = [
    ['content', { content: 'Body a:1 edited' }],
    ['title', { name: 'Another title' }],
    ['abstract', { abstract: 'Another abstract' }],
    ['a trailing space', { content: 'Body a:1 ' }],
    ['a tab', { content: 'Body a:1\t' }],
    ['case', { content: 'body a:1' }],
    ['a trailing newline', { content: 'Body a:1\n' }],
  ];
  for (const [label, input] of superseding) {
    it(`${label} supersedes the approval`, async () => {
      const id = await approvedThen(input);
      expect((await statusOf(id)).state).toBe('SUPERSEDED');
      expect((await verify(id)).state).toBe('SUPERSEDED');
      expect(await filterLocs('SUPERSEDED')).toEqual(['a:1']);
      expect(await filterLocs('APPROVED')).toEqual([]);
    });
  }

  it('a line-ending-only rewrite (CRLF, lone CR) keeps the approval', async () => {
    const n = await node('a:1', { content: 'line one\nline two\n' });
    await approve(n.id);
    await update(n.id, { content: 'line one\r\nline two\r\n' });
    expect((await statusOf(n.id)).state).toBe('APPROVED');
    await update(n.id, { content: 'line one\rline two\r' });
    expect((await statusOf(n.id)).state).toBe('APPROVED');
    expect((await verify(n.id)).state).toBe('INTACT');
  });

  it('keeps missing and empty abstract distinct', async () => {
    const n = await node('a:1', { abstract: null });
    await approve(n.id);
    await db.node.update({ where: { id: n.id }, data: { abstract: '' } }); // a raw write is not a supported change
    expect((await verify(n.id)).state).toBe('TAMPERED');
  });

  it('a content edit after a metadata-only revision supersedes', async () => {
    const id = await approvedThen({ tags: ['x'] });
    await update(id, { content: 'Body a:1 edited' });
    expect((await statusOf(id)).state).toBe('SUPERSEDED');
  });
});

describe('restore (cor:dmo:060:04, 120:04)', () => {
  it('restoring different older text supersedes; a superseded approval is never recreated by a restore', async () => {
    const n = await node('a:1');
    await approve(n.id);
    await update(n.id, { content: 'changed' });
    const original = await db.nodeRevision.findFirstOrThrow({ where: { nodeId: n.id, revNo: 1 } });
    await update(n.id, { content: 'changed again' });
    await resolvers.Mutation.restoreNodeRevision(null, { revisionId: original.id }, as());
    expect((await rowOf(n.id)).content).toBe('Body a:1');
    expect((await statusOf(n.id)).state).toBe('SUPERSEDED');
  });

  it('restoring a metadata-only older revision keeps the approval', async () => {
    const n = await node('a:1');
    await approve(n.id);
    await update(n.id, { tags: ['x'] });
    await update(n.id, { tags: ['y'] });
    const older = await db.nodeRevision.findFirstOrThrow({ where: { nodeId: n.id, revNo: 1 } });
    await resolvers.Mutation.restoreNodeRevision(null, { revisionId: older.id }, as());
    expect((await statusOf(n.id)).state).toBe('APPROVED');
  });
});

describe('searchReplaceInNodes is a content writer (cor:dmo:120:04)', () => {
  it('a replace that changes content supersedes; one that matches nothing keeps the approval', async () => {
    const n = await node('a:1', { content: 'alpha beta' });
    await approve(n.id);
    await resolvers.Mutation.searchReplaceInNodes(null, {
      input: { nodeIds: [n.id], fields: ['content'], oldText: 'nomatch', newText: 'x', dryRun: false },
    }, as());
    expect((await statusOf(n.id)).state).toBe('APPROVED');
    await resolvers.Mutation.searchReplaceInNodes(null, {
      input: { nodeIds: [n.id], fields: ['content'], oldText: 'beta', newText: 'gamma', dryRun: false },
    }, as());
    expect((await rowOf(n.id)).content).toBe('alpha gamma');
    expect((await statusOf(n.id)).state).toBe('SUPERSEDED');
  });
});

describe('tampering stays TAMPERED, never relabeled (cor:dmo:120:05)', () => {
  it('a raw content change after metadata revisions reports TAMPERED and never APPROVED', async () => {
    const id = await approvedThen({ tags: ['x'] });
    await db.node.update({ where: { id }, data: { content: 'sneaked in' } });
    expect((await verify(id)).state).toBe('TAMPERED');
    expect((await statusOf(id)).state).not.toBe('APPROVED');
    expect(await filterLocs('APPROVED')).toEqual([]);
    const dry = await specCorpusMintMutations.mintMemoryNodes(null, { memoryRef: memory.id, dryRun: true }, as());
    expect(dry.blockers.some((b: { kind: string; loc: string }) => b.kind === 'TAMPERED' && b.loc === 'a:1')).toBe(true);
  });

  it('a raw content change on a node whose current revision is approved reports TAMPERED', async () => {
    const n = await node('a:1');
    await approve(n.id);
    await db.node.update({ where: { id: n.id }, data: { content: 'sneaked in' } });
    expect((await verify(n.id)).state).toBe('TAMPERED');
    expect((await statusOf(n.id)).state).not.toBe('APPROVED');
  });

  it('a raw write does not move the content-change boundary; a supported write does', async () => {
    const n = await node('a:1');
    const boundary = async () => (await db.$queryRaw<Array<{ c: number; r: number }>>`
      SELECT content_rev_seq AS c, rev_seq AS r FROM nodes WHERE id = ${n.id}`)[0]!;
    const start = (await boundary()).c;
    await db.node.update({ where: { id: n.id }, data: { name: 'raw rename' } });
    expect((await boundary()).c).toBe(start);
    await update(n.id, { content: 'supported' });
    const after = await boundary();
    expect(after.c).toBe(after.r);
  });
});

describe('other supported writers move the boundary exactly when the hashed text changes', () => {
  it('hadron_update_node: a tags-only update keeps the approval, a content update supersedes', async () => {
    const mcp = createTestableMcpServer({ userId: admin.id, roles: [], clientId: `user:${admin.id}` });
    const n = await node('a:1');
    await approve(n.id);
    await mcp.callToolText('hadron_update_node', { urn: `hrn:node:${memory.urn}:a:1`, tags: ['via-mcp'] });
    expect((await rowOf(n.id)).revSeq).toBeGreaterThan(1);
    expect((await statusOf(n.id)).state).toBe('APPROVED');
    await mcp.callToolText('hadron_update_node', { urn: `hrn:node:${memory.urn}:a:1`, content: 'changed over MCP' });
    expect((await statusOf(n.id)).state).toBe('SUPERSEDED');
  });

  it('a raw metadata edit reconciled by a read keeps the approval; a raw text edit reconciled by a read stays TAMPERED', async () => {
    const meta = await node('a:1');
    const text = await node('a:2');
    await approve(meta.id);
    await approve(text.id);
    await db.node.update({ where: { id: meta.id }, data: { tags: ['raw'] } });
    await db.node.update({ where: { id: text.id }, data: { content: 'raw rewrite' } });
    // Reading the status reconciles each drifted node into a new revision.
    expect((await statusOf(meta.id)).state).toBe('APPROVED');
    expect((await statusOf(text.id)).state).toBe('SUPERSEDED');
    expect((await verify(meta.id)).state).toBe('INTACT');
    expect((await verify(text.id)).state).toBe('TAMPERED');
    // A later supported edit of the tampered node does not launder it.
    await update(text.id, { content: 'a human edit' });
    expect((await verify(text.id)).state).toBe('TAMPERED');
  });
});

describe('legacy rows: the migration backfill is conservative (#1611)', () => {
  it('an approved node past its approval stays SUPERSEDED, a current approval stays APPROVED, a tampered one stays TAMPERED', async () => {
    const sql = readFileSync(new URL('../../prisma/migrations/20261016090000_node_content_revision_boundary/migration.sql', import.meta.url), 'utf8');
    const backfill = /UPDATE "nodes"[\s\S]*?;/.exec(sql)![0];
    const past = await node('l:1');
    const current = await node('l:2');
    const tampered = await node('l:3');
    for (const n of [past, current, tampered]) await approve(n.id);
    // Legacy state: revisions moved on with no boundary column to say why.
    await db.$executeRaw`UPDATE nodes SET rev_seq = 3, content_rev_seq = 1 WHERE id = ${past.id}`;
    await db.node.update({ where: { id: tampered.id }, data: { content: 'legacy raw edit' } });
    await db.$executeRawUnsafe(backfill);
    expect((await rowOf(past.id)).contentRevSeq).toBe(3);
    expect((await statusOf(past.id)).state).toBe('SUPERSEDED');
    expect((await statusOf(current.id)).state).toBe('APPROVED');
    expect((await verify(tampered.id)).state).toBe('TAMPERED');
  });
});
