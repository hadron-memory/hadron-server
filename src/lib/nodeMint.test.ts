/** #1591: per-node minting, its status reads, the backfill, and permanence switched off. */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { GraphQLError } from 'graphql';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { db } from '../integrations/db/client.js';
import { cleanDb } from '../test/helpers.js';
import { generateId } from './id.js';
import { resolvers, type Context } from '../api/graphql/schema/resolvers.js';
import { createTestableMcpServer } from '../mcp/server.js';
import { isMintedSpecPermanenceEnforced } from './mintedSpecPermanence.js';

vi.mock('../integrations/github/writeNodeToGit.js', () => ({
  writeNodeToGit: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../integrations/github/mirrorNodeMove.js', () => ({
  mirrorNodeMoveToGit: vi.fn().mockResolvedValue(undefined),
}));

let admin: { id: string };
let writer: { id: string };
let reader: { id: string };
let org: { id: string; urn: string };
let memory: { id: string; urn: string };

type Finding = { kind: string; loc: string };
const as = (userId = admin.id): Context => ({ db, userId, roles: [] });
const spec = (loc: string, extra: Record<string, unknown> = {}) => db.node.create({
  data: { id: generateId(), memoryId: memory.id, loc, name: loc, content: `Body of ${loc}.`, role: 'spec', nodeType: 'info', tags: ['spec'], ...extra },
});
const mint = (dryRun = false, userId = admin.id, memoryRef = memory.id) =>
  resolvers.Mutation.mintMemoryNodes(null, { memoryRef, dryRun }, as(userId));
const approveAll = (userId = admin.id) =>
  resolvers.Mutation.approveMemoryNodes(null, { memoryRef: memory.id }, as(userId));
const codeOf = async (p: Promise<unknown>) => {
  try { await p; return 'NO_ERROR'; } catch (e) {
    return e instanceof GraphQLError ? String(e.extensions.code) : (e as Error).message;
  }
};
const rowOf = (id: string) => db.node.findUniqueOrThrow({ where: { id } });
const mintStatusOf = async (id: string) => resolvers.Node.mintStatus(await rowOf(id), {}, as());

beforeEach(async () => {
  await cleanDb(db);
  org = await db.organization.create({ data: { id: generateId(), name: 'Mint Org', urn: 'mint1591.example' } });
  admin = await db.user.create({ data: { githubId: 159201, githubUsername: 'mint-admin', handle: 'mint-admin', roles: [] } });
  writer = await db.user.create({ data: { githubId: 159202, githubUsername: 'mint-writer', roles: [] } });
  reader = await db.user.create({ data: { githubId: 159203, githubUsername: 'mint-reader', roles: [] } });
  await db.orgMember.createMany({ data: [
    { organizationId: org.id, userId: admin.id, role: 'ADMIN' },
    { organizationId: org.id, userId: writer.id, role: 'CONTRIBUTOR' },
    { organizationId: org.id, userId: reader.id, role: 'READER' },
  ] });
  memory = await resolvers.Mutation.createMemory(null, { orgId: org.id, name: 'specs' }, as());
});

describe('mintMemoryNodes (#1591)', () => {
  it('blocks every unapproved node, then mints them all with their revision and approval hash', async () => {
    const a = await spec('pas:010');
    const b = await spec('pas:010:01');
    const dry = await mint(true);
    expect(dry.blockers.filter((f: Finding) => f.kind === 'NOT_APPROVED').map((f: Finding) => f.loc).sort())
      .toEqual(['pas:010', 'pas:010:01', 'specs'].sort());
    expect(await codeOf(mint())).toBe('SPEC_CORPUS_MINT_BLOCKED');

    await approveAll();
    const done = await mint();
    expect(done).toMatchObject({ minted: true, mintedCount: 3, blockers: [] });
    expect(done.mintLocs).toEqual(['pas:010', 'pas:010:01', 'specs']);
    for (const id of [a.id, b.id]) {
      const row = await rowOf(id);
      expect(row).toMatchObject({ mintedBy: admin.id, mintedByInfo: null, mintedRevNo: row.revSeq, mintedHash: row.approvalHash });
      expect(row.mintedAt).toBeInstanceOf(Date);
    }
    expect(await mintStatusOf(a.id)).toMatchObject({ minted: true, mintedBy: admin.id, revision: 1 });
    expect(await resolvers.Memory.corpusState({ id: memory.id }, {}, as())).toBe('MINTED');
  });

  it('reports and mints only nodes in scope: an unchanged earlier mint is never re-checked', async () => {
    await approveAll();
    await mint();
    // A minted node edited since (no longer approved) and with a lint error
    // (nodeType not info) blocks nothing.
    const old = await db.node.findFirstOrThrow({ where: { memoryId: memory.id, loc: 'specs' } });
    await db.node.update({ where: { id: old.id }, data: { revSeq: { increment: 1 } } });
    await spec('pas:020', { nodeType: 'parent', mintedAt: new Date(), mintedByInfo: 'test', mintedRevNo: 1, mintedHash: 'h' });
    const added = await spec('pas:030');
    const dry = await mint(true);
    expect(dry.mintLocs).toEqual(['pas:030']);
    expect(dry.blockers.map((f: Finding) => [f.kind, f.loc])).toEqual([['NOT_APPROVED', 'pas:030']]);
    await approveAll();
    expect(await mint()).toMatchObject({ mintedCount: 1, mintLocs: ['pas:030'] });
    expect((await rowOf(added.id)).mintedAt).not.toBeNull();
  });

  it('refuses an approval that an edit superseded before the mint', async () => {
    const n = await spec('pas:010');
    await approveAll();
    await resolvers.Mutation.updateSpecNode(null, { input: { memoryId: memory.id, loc: 'pas:010', content: 'Changed.' } } as never, as());
    const dry = await mint(true);
    expect(dry.blockers).toEqual([expect.objectContaining({ kind: 'NOT_APPROVED', loc: 'pas:010' })]);
    expect((await rowOf(n.id)).mintedAt).toBeNull();
  });

  it('lets any writer mint (ruling 2a) and refuses a reader', async () => {
    await approveAll();
    expect(await codeOf(mint(false, reader.id))).not.toBe('NO_ERROR');
    expect(await mint(false, writer.id)).toMatchObject({ minted: true });
  });

  it('mintSpecCorpus is the same operation', async () => {
    await approveAll();
    expect(await resolvers.Mutation.mintSpecCorpus(null, { memoryRef: memory.id }, as()))
      .toMatchObject({ minted: true, mintedCount: 1 });
  });
});

describe('mint certifies the text it stamps (Atilla, PR #1593)', () => {
  it('refuses TAMPERED when approved text changed outside the revision system; re-approving clears it', async () => {
    const n = await spec('pas:010');
    await approveAll();
    // A direct write: the revision number and the approval both stay put.
    await db.$executeRaw`UPDATE nodes SET content = 'Quietly changed.' WHERE id = ${n.id}`;
    expect((await rowOf(n.id)).approvedRevNo).toBe((await rowOf(n.id)).revSeq);

    const dry = await mint(true);
    expect(dry.blockers).toEqual([expect.objectContaining({ kind: 'TAMPERED', loc: 'pas:010' })]);
    expect(await codeOf(mint())).toBe('SPEC_CORPUS_MINT_BLOCKED');
    expect((await rowOf(n.id)).mintedAt).toBeNull();
    const report = await resolvers.Query.verifyMemoryNodes(null, { memoryRef: memory.id }, as());
    expect(report.problems.map((p: { loc: string; state: string }) => [p.loc, p.state])).toContainEqual(['pas:010', 'TAMPERED']);

    // Approve reconciles the drift into a new revision first, so re-approving
    // approves the changed text, and the mint then stamps exactly that.
    const again = await approveAll();
    expect(again.approved.map((r: { loc: string }) => r.loc)).toEqual(['pas:010']);
    const done = await mint();
    expect(done).toMatchObject({ minted: true, mintLocs: ['pas:010', 'specs'] });
    const row = await rowOf(n.id);
    expect(row.mintedRevNo).toBe(2);
    expect(row.mintedHash).toBe(row.approvalHash);
  });
});

describe('approveMemoryNodes covers the mint scope (#1612)', () => {
  it('skips a minted node unchanged since its minted revision, approves unminted ones', async () => {
    const minted = await spec('pas:010', { mintedAt: new Date(), mintedByInfo: 'test', mintedRevNo: 1, mintedHash: 'h' });
    await spec('pas:020');
    const result = await approveAll();
    expect(result.approved.map((r: { loc: string }) => r.loc).sort()).toEqual(['pas:020', 'specs']);
    expect((await rowOf(minted.id)).approvedRevNo).toBeNull();
  });
});

describe('re-mint (#1612, cor:dmo:120:06)', () => {
  const edit = (loc: string, patch: Record<string, unknown>) =>
    resolvers.Mutation.updateSpecNode(null, { input: { memoryId: memory.id, loc, ...patch } } as never, as(writer.id));

  it('puts a content-edited minted node back in scope, blocks it until approved, then re-stamps and keeps the first mint', async () => {
    const n = await spec('pas:010');
    await approveAll();
    await mint(false, admin.id);
    const first = await rowOf(n.id);

    await edit('pas:010', { content: 'Changed.' });
    const dry = await mint(true);
    expect(dry.mintLocs).toEqual([]);
    expect(dry.remintLocs).toEqual(['pas:010']);
    expect(dry.blockers).toEqual([expect.objectContaining({ kind: 'NOT_APPROVED', loc: 'pas:010' })]);
    expect(await codeOf(mint(false, writer.id))).toBe('SPEC_CORPUS_MINT_BLOCKED');

    const approved = await approveAll(writer.id);
    expect(approved.approved.map((r: { loc: string }) => r.loc)).toEqual(['pas:010']);
    const done = await mint(false, writer.id);
    expect(done).toMatchObject({ minted: true, mintedCount: 1, remintedCount: 1, mintLocs: [], remintLocs: ['pas:010'], blockers: [] });

    const row = await rowOf(n.id);
    expect(row.mintedRevNo).toBe(2);
    expect(row.mintedHash).toBe(row.approvalHash);
    expect(row.mintedHash).not.toBe(first.mintedHash);
    expect(row.mintedAt).toEqual(first.mintedAt);
    expect(row.mintedBy).toBe(admin.id);
    expect(await mintStatusOf(n.id)).toMatchObject({ minted: true, mintedBy: admin.id, revision: 2 });
    // Settled: a second mint has nothing in scope.
    expect(await mint(true)).toMatchObject({ remintLocs: [], mintLocs: [], blockers: [] });
  });

  it('keeps new and re-minted nodes apart in one report', async () => {
    await spec('pas:010');
    await approveAll();
    await mint();
    await edit('pas:010', { content: 'Changed.' });
    await spec('pas:020');
    await approveAll();
    expect(await mint()).toMatchObject({ mintedCount: 2, remintedCount: 1, mintLocs: ['pas:020'], remintLocs: ['pas:010'] });
  });

  it('leaves a minted node out of scope after a tags-only edit', async () => {
    const n = await spec('pas:010');
    await approveAll();
    await mint();
    const before = await rowOf(n.id);
    await edit('pas:010', { tags: ['spec', 'extra'] });
    expect((await rowOf(n.id)).contentRevSeq).toBe(before.contentRevSeq);
    expect(await mint(true)).toMatchObject({ mintLocs: [], remintLocs: [], blockers: [] });
    expect((await approveAll()).approved).toEqual([]);
  });

  it('puts a minted node with no recorded minted revision in scope (R197, option A)', async () => {
    const n = await spec('pas:010', { mintedAt: new Date('2026-05-01T00:00:00.000Z'), mintedByInfo: 'backfill' });
    const dry = await mint(true);
    expect(dry.remintLocs).toEqual(['pas:010']);
    expect(dry.blockers).toContainEqual(expect.objectContaining({ kind: 'NOT_APPROVED', loc: 'pas:010' }));
    await approveAll();
    await mint();
    const row = await rowOf(n.id);
    expect(row).toMatchObject({ mintedRevNo: row.revSeq, mintedHash: row.approvalHash, mintedByInfo: 'backfill', mintedBy: null });
    expect(row.mintedAt!.toISOString()).toBe('2026-05-01T00:00:00.000Z');
  });
});

describe('mint status reads (#1591)', () => {
  it('filters findNodes by minted on the Prisma and SQL paths', async () => {
    await spec('pas:010', { mintedAt: new Date(), mintedByInfo: 'test', properties: { k: 'v' } });
    await spec('pas:020', { properties: { k: 'v' } });
    const locs = async (minted: boolean, viaSql: boolean) => {
      const res = await resolvers.Query.findNodes(null, {
        filter: { memoryIds: [memory.id], minted, ...(viaSql ? { where: { path: ['k'], eq: 'v' } } : {}) },
        ...(viaSql ? { limit: 1 } : {}),
      }, as());
      return res.hits.map((h: { node: { loc: string } }) => h.node.loc).filter((l: string) => l !== 'specs').sort();
    };
    expect(await locs(true, false)).toEqual(['pas:010']);
    expect(await locs(false, false)).toEqual(['pas:020']);
    // limit 1 in loc order: the SQL page itself must skip the minted pas:010.
    expect(await locs(false, true)).toEqual(['pas:020']);
    expect(await locs(true, true)).toEqual(['pas:010']);
  });

  it('shows the mint line in hadron_get_node', async () => {
    const getLine = async (loc: string) => {
      const mcp = createTestableMcpServer({ userId: admin.id, roles: [], clientId: `user:${admin.id}` });
      const text = await mcp.callToolText('hadron_get_node', { urn: `hrn:node:${memory.urn}:${loc}` });
      return text.split('\n').find((line) => line.startsWith('Minted:'));
    };
    await spec('pas:010');
    expect(await getLine('pas:010')).toBe('Minted: no');
    await approveAll();
    await mint();
    const at = (await db.node.findFirstOrThrow({ where: { memoryId: memory.id, loc: 'pas:010' } })).mintedAt!.toISOString();
    expect(await getLine('pas:010')).toBe(`Minted: r1 at ${at} by hrn:user:mint-admin`);
    const backfilled = new Date('2026-05-01T00:00:00.000Z');
    await spec('pas:020', { mintedAt: backfilled, mintedByInfo: 'backfill' });
    expect(await getLine('pas:020')).toBe(`Minted: at ${backfilled.toISOString()} (backfilled)`);
  });
});

describe('minted-spec permanence is off (#1591 ruling)', () => {
  it('lets a minted spec be deleted, even in a corpus stamped by the old flow', async () => {
    expect(isMintedSpecPermanenceEnforced()).toBe(false);
    const n = await spec('pas:010');
    await approveAll();
    await mint();
    expect((await db.memory.findUniqueOrThrow({ where: { id: memory.id } })).corpusMintedAt).not.toBeNull();
    // Permanence is off, but the generic delete still follows the governed-node
    // rule: the spec role is cleared first (the kind's update door), then the
    // node deletes as an ordinary one.
    await db.node.update({ where: { id: n.id }, data: { role: null } });
    await resolvers.Mutation.deleteNode(null, { nodeRef: n.id }, as());
    expect((await rowOf(n.id)).deletedAt).not.toBeNull();
  });
});

describe('the #1591 backfill migration', () => {
  /** The migration's UPDATE statements, run against seeded rows. */
  const backfill = async () => {
    const sql = readFileSync(
      fileURLToPath(new URL('../../prisma/migrations/20261001030000_node_minting/migration.sql', import.meta.url)),
      'utf8',
    );
    const statements = sql.split(';').map((s) => s.replace(/--[^\n]*\n/g, '').trim()).filter((s) => s.startsWith('UPDATE'));
    expect(statements).toHaveLength(2);
    for (const statement of statements) await db.$executeRawUnsafe(statement);
  };

  it('mints a never-draft memory at creation, a stamped corpus at its mint, and leaves an unminted draft alone', async () => {
    const created = new Date('2026-01-01T00:00:00.000Z');
    const stampedAt = new Date('2026-06-01T00:00:00.000Z');
    const plain = await spec('pas:010', { createdAt: created });
    const stamped = await db.memory.create({ data: {
      id: generateId(), organizationId: org.id, urn: `${org.urn}:stamped`, name: 'stamped', class: 'knowledge', visibility: 'ORGANIZATION',
      corpusMintedAt: stampedAt, corpusMintedBy: admin.id,
    } });
    const early = await db.node.create({ data: { id: generateId(), memoryId: stamped.id, loc: 'a', name: 'a', createdAt: created } });
    const late = await db.node.create({ data: { id: generateId(), memoryId: stamped.id, loc: 'b', name: 'b', createdAt: new Date('2026-07-01T00:00:00.000Z') } });
    const byClient = await db.memory.create({ data: {
      id: generateId(), organizationId: org.id, urn: `${org.urn}:by-client`, name: 'by-client', class: 'knowledge', visibility: 'ORGANIZATION',
      corpusMintedAt: stampedAt, corpusMintedBy: 'github:someone',
    } });
    const clientNode = await db.node.create({ data: { id: generateId(), memoryId: byClient.id, loc: 'a', name: 'a' } });
    const draft = await db.memory.create({ data: {
      id: generateId(), organizationId: org.id, urn: `${org.urn}:draft`, name: 'draft', class: 'knowledge', visibility: 'ORGANIZATION', corpusDraft: true,
    } });
    const drafted = await db.node.create({ data: { id: generateId(), memoryId: draft.id, loc: 'a', name: 'a' } });

    await backfill();

    expect(await rowOf(plain.id)).toMatchObject({ mintedAt: created, mintedByInfo: 'backfill', mintedBy: null, mintedRevNo: null, mintedHash: null });
    expect(await rowOf(early.id)).toMatchObject({ mintedAt: stampedAt, mintedBy: admin.id, mintedByInfo: null });
    // Added after the corpus was minted: permanent from its creation.
    expect((await rowOf(late.id)).mintedAt).toEqual(new Date('2026-07-01T00:00:00.000Z'));
    expect(await rowOf(clientNode.id)).toMatchObject({ mintedBy: null, mintedByInfo: 'github:someone' });
    expect((await rowOf(drafted.id)).mintedAt).toBeNull();
    // Status reads the backfilled record as minted, with no revision.
    expect(await mintStatusOf(plain.id)).toMatchObject({ minted: true, revision: null, hash: null, mintedByInfo: 'backfill' });
  });
});
