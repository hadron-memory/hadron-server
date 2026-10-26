/** #2063 R1: structural capture only; no production retention caller is enabled. */
import { readFile } from 'node:fs/promises';
import { beforeEach, describe, expect, expectTypeOf, it, vi } from 'vitest';
import { db } from '../../integrations/db/client.js';
import { cleanDb } from '../../test/helpers.js';
import { computeApprovalHash } from '../approvalHash.js';
import { generateDataKey } from '../crypto.js';
import { encryptNodeFields } from '../nodeCrypto.js';
import { sessionKeyCache } from '../sessionKeyCache.js';
import { recordUrnRename } from '../urnAlias.js';
import { withIncludeHistoryTransaction, includeHistoryClient } from './includeHistoryFence.js';
import { replaceStructuralReferences } from './structuralReferences.js';
import { reliedRevisionsOf } from './reliedRevisions.js';
import { verifyIncludeCoverage } from './verifyIncludeCoverage.js';

let memory: { id: string; urn: string };
let source: { id: string };
let target: { id: string };
const fenced = <T>(work: (tx: Parameters<typeof replaceStructuralReferences>[0]) => Promise<T>) =>
  withIncludeHistoryTransaction(db, context => work(includeHistoryClient(context)));
const capture = (id: string, text: string | null) => fenced(tx => replaceStructuralReferences(tx, id, text));
const relied = (id = target.id, memoryId = memory.id) => fenced(tx => reliedRevisionsOf(tx, id, memoryId));
async function activate() {
  // Test-only activation. R1 deliberately provides NO production activator.
  for (const n of await db.node.findMany({ select: { id: true, content: true } })) await capture(n.id, n.content);
  await db.includeRetentionGeneration.update({ where: { id: 'singleton' }, data: { state: 'ACTIVE', verifiedBindingGeneration: 0 } });
}
beforeEach(async () => {
  await cleanDb(db);
  await db.includeRetentionGeneration.deleteMany();
  const org = await db.organization.create({ data: { name: 'Retention', urn: 'retention2063.example' } });
  memory = await db.memory.create({ data: { organizationId: org.id, name: 'Sources', urn: `${org.urn}:sources`, class: 'knowledge' } });
  source = await db.node.create({ data: { memoryId: memory.id, loc: 'source', name: 'Source' } });
  target = await db.node.create({ data: { memoryId: memory.id, loc: 'target', name: 'Target', content: 'draft', revSeq: 5 } });
  await db.includeRetentionGeneration.create({ data: { id: 'singleton' } });
});

describe('structural references (#2063 R1)', () => {
  it('A: stores every active tag, duplicate settings and unresolved loc/URN addresses', async () => {
    await capture(source.id, '{{> target rev=3}} {{> target approved signed}} {{> missing rev=2}} {{> hrn:node:absent.example:missing:part rev=4}} `{{> literal}}`');
    const rows = await db.includeReference.findMany({ where: { includerId: source.id }, orderBy: { ordinal: 'asc' } });
    expect(rows).toHaveLength(4);
    expect(rows.map(r => [r.ordinal, r.kind, r.reference, r.targetMemoryId, r.targetLoc, r.pinnedRevNo, r.requiresApproved, r.requiresSigned])).toEqual([
      [0, 'loc', 'target', memory.id, 'target', 3, false, false],
      [1, 'loc', 'target', memory.id, 'target', null, true, true],
      [2, 'loc', 'missing', memory.id, 'missing', 2, false, false],
      [3, 'urn', 'hrn:node:absent.example:missing:part', null, null, 4, false, false],
    ]);
    expect(await db.includeSourceCoverage.findUnique({ where: { includerId: source.id } })).toMatchObject({ state: 'COMPLETE_TAGS', referenceCount: 4, parserVersion: 1 });
  });

  it('B: replacement and explicit empty coverage are atomic, including rollback after capture', async () => {
    await capture(source.id, '{{> target rev=3}}');
    const old = await db.includeReference.findMany({ where: { includerId: source.id } });
    const coverage = await db.includeSourceCoverage.findUnique({ where: { includerId: source.id } });
    await expect(fenced(async tx => { await replaceStructuralReferences(tx, source.id, '{{> target rev=4}}'); throw new Error('abort page'); })).rejects.toThrow('abort page');
    expect(await db.includeReference.findMany({ where: { includerId: source.id } })).toEqual(old);
    expect(await db.includeSourceCoverage.findUnique({ where: { includerId: source.id } })).toEqual(coverage);
    await capture(source.id, '{{> target rev=2}}');
    expect(await db.includeReference.findMany({ where: { includerId: source.id }, select: { pinnedRevNo: true } })).toEqual([{ pinnedRevNo: 2 }]);
    await capture(source.id, null);
    expect(await db.includeReference.count({ where: { includerId: source.id } })).toBe(0);
    expect(await db.includeSourceCoverage.findUnique({ where: { includerId: source.id } })).toMatchObject({ state: 'COMPLETE_EMPTY', referenceCount: 0 });
  });

  it('C/E: foreign restorable includers and parent tombstones still count; only numbers escape', async () => {
    const org = await db.organization.create({ data: { name: 'Foreign', urn: 'foreign2063.example' } });
    const foreign = await db.memory.create({ data: { organizationId: org.id, name: 'Hidden', urn: `${org.urn}:hidden`, class: 'knowledge', visibility: 'ORGANIZATION', deletedAt: new Date() } });
    const hidden = await db.node.create({ data: { memoryId: foreign.id, loc: 'hidden', name: 'Hidden', deletedAt: new Date(), content: `{{> hrn:node:${memory.urn}:target rev=3}}` } });
    await activate();
    const result = await relied();
    expectTypeOf(result).toEqualTypeOf<Set<number>>();
    expect(result).toEqual(new Set([3]));
    expect(Object.keys(result)).toEqual([]);
    expect([...result].every(n => typeof n === 'number')).toBe(true);
    await db.node.delete({ where: { id: hidden.id } });
    expect(await relied()).toEqual(new Set());
  });

  it('D: target purge keeps source addresses; includer purge cascades refs and coverage', async () => {
    await capture(source.id, '{{> target rev=3}}');
    await db.node.delete({ where: { id: target.id } });
    expect(await db.includeReference.count({ where: { includerId: source.id } })).toBe(1);
    await db.node.delete({ where: { id: source.id } });
    expect(await db.includeReference.count({ where: { includerId: source.id } })).toBe(0);
    expect(await db.includeSourceCoverage.count({ where: { includerId: source.id } })).toBe(0);
  });

  it('F: pins retain exact numbers regardless of qualification; plain and signed-only add none', async () => {
    await db.node.update({ where: { id: source.id }, data: { content: '{{> target rev=3 approved}} {{> target}} {{> target signed}}' } });
    await activate();
    expect(await relied()).toEqual(new Set([3]));
    expect(await relied(target.id, 'other-capture-memory')).toEqual(new Set());
    await capture(source.id, '{{> target}} {{> target signed}}');
    expect(await relied()).toEqual(new Set());
  });

  it('F: unpinned approved selects the covered non-carrier sibling through the shared predicate', async () => {
    const hash = computeApprovalHash({ title: 'Target', abstract: null, content: 'approved' });
    for (const revNo of [1, 3]) await db.nodeRevision.create({ data: { nodeId: target.id, memoryId: memory.id, loc: 'target', name: 'Target', content: 'approved', tags: [], revNo, ...(revNo === 1 ? { approvedByInfo: 'test', approvedAt: new Date(), approvalHash: hash } : {}) } });
    await db.node.update({ where: { id: source.id }, data: { content: '{{> target approved}} {{> target approved signed}}' } });
    await activate();
    expect(await relied()).toEqual(new Set([3]));
    await db.nodeRevision.deleteMany({ where: { nodeId: target.id, revNo: 3 } });
    expect(await relied()).toEqual(new Set([1]));
  });

  it('F/H: capture uses supplied plaintext even for sealed sources; retention never asks for a key', async () => {
    await db.memory.update({ where: { id: memory.id }, data: { isEncrypted: true } });
    sessionKeyCache.set('retention2063-sealed', memory.id, generateDataKey());
    const sealed = encryptNodeFields({ content: '{{> target rev=3}} {{> target approved}}' }, { id: memory.id, isEncrypted: true });
    await db.node.update({ where: { id: source.id }, data: { content: sealed.content } });
    sessionKeyCache.clear();
    await activate();
    await capture(source.id, '{{> target rev=3}} {{> target approved}}');
    const key = vi.spyOn(sessionKeyCache, 'getByMemoryId').mockImplementation(() => { throw new Error('no key permitted'); });
    try { expect(await relied()).toEqual(new Set([3])); expect(key).not.toHaveBeenCalled(); }
    finally { key.mockRestore(); }
  });

  it('G: absent/non-ACTIVE/dirty/version-mismatched generations fail closed', async () => {
    await activate();
    for (const state of ['PREPARING', 'BACKFILLING', 'VERIFYING', 'BLOCKED'] as const) {
      await db.includeRetentionGeneration.update({ where: { id: 'singleton' }, data: { state } });
      await expect(relied()).rejects.toMatchObject({ code: 'INCLUDE_RETENTION_INACTIVE' });
    }
    await db.includeRetentionGeneration.update({ where: { id: 'singleton' }, data: { state: 'ACTIVE', bindingGeneration: 1 } });
    await expect(relied()).rejects.toMatchObject({ code: 'INCLUDE_RETENTION_INACTIVE' });
    await db.includeRetentionGeneration.update({ where: { id: 'singleton' }, data: { bindingGeneration: 0, parserVersion: 99 } });
    await expect(relied()).rejects.toMatchObject({ code: 'INCLUDE_RETENTION_INACTIVE' });
    await db.includeRetentionGeneration.deleteMany();
    await expect(relied()).rejects.toMatchObject({ code: 'INCLUDE_RETENTION_INACTIVE' });
  });

  it('G: global verifier rejects missing/needs-rewrite/stale coverage', async () => {
    await activate();
    expect(await fenced(verifyIncludeCoverage)).toBe(true);
    await db.includeSourceCoverage.delete({ where: { includerId: source.id } });
    expect(await fenced(verifyIncludeCoverage)).toBe(false);
    await capture(source.id, null);
    await db.includeSourceCoverage.update({ where: { includerId: source.id }, data: { state: 'NEEDS_AUTHORIZED_REWRITE' } });
    expect(await fenced(verifyIncludeCoverage)).toBe(false);
    await capture(source.id, null);
    await db.node.update({ where: { id: source.id }, data: { content: '{{> target rev=2}}' } });
    expect(await fenced(verifyIncludeCoverage)).toBe(false);
  });

  it('URN bindings follow the shared alias resolver, retaining the original reference', async () => {
    const ref = `hrn:node:${memory.urn}:target`;
    await db.$transaction(async tx => {
      await recordUrnRename(tx, { entityType: 'NODE', entityId: target.id, oldUrn: ref.slice(9), newUrn: `${memory.urn}:moved` });
      await tx.node.update({ where: { id: target.id }, data: { loc: 'moved' } });
    });
    await capture(source.id, `{{> ${ref} rev=3}}`);
    expect(await db.includeReference.findFirst({ where: { includerId: source.id } })).toMatchObject({ reference: ref, targetMemoryId: memory.id, targetLoc: 'moved' });
  });

  it('reverse lookup exhausts high fan-in rather than limiting away pins', async () => {
    const text = Array.from({ length: 1001 }, (_, i) => `{{> target rev=${i + 1}}}`).join(' ');
    await db.node.update({ where: { id: source.id }, data: { content: text } });
    await activate();
    expect(await relied()).toEqual(new Set(Array.from({ length: 1001 }, (_, i) => i + 1)));
  });

  it('coverage verifier checks versions, generations, empty proofs and reference counts', async () => {
    await activate();
    for (const delta of [
      { parserVersion: 99 }, { metadataGeneration: 99 }, { sourceRevision: 99 },
      { sourceMemoryId: 'stale' }, { sourceLoc: 'stale' }, { sourceEncrypted: true },
      { referenceCount: 1 }, { state: 'COMPLETE_TAGS' as const },
    ]) {
      await capture(source.id, null);
      await db.includeSourceCoverage.update({ where: { includerId: source.id }, data: delta });
      expect(await fenced(verifyIncludeCoverage)).toBe(false);
    }
    await capture(source.id, '{{> target rev=3}}');
    await db.includeReference.updateMany({ where: { includerId: source.id }, data: { metadataGeneration: 99 } });
    expect(await fenced(verifyIncludeCoverage)).toBe(false);
  });

  it('capture rolls back when a write between reference deletion and coverage fails', async () => {
    await capture(source.id, '{{> target rev=3}}');
    await expect(fenced(async tx => {
      const write = vi.spyOn(tx.includeSourceCoverage, 'upsert').mockRejectedValueOnce(new Error('coverage write failed'));
      try { await replaceStructuralReferences(tx, source.id, '{{> target rev=4}}'); }
      finally { write.mockRestore(); }
    })).rejects.toThrow('coverage write failed');
    expect(await db.includeReference.findMany({ where: { includerId: source.id }, select: { pinnedRevNo: true } })).toEqual([{ pinnedRevNo: 3 }]);
  });

  it('migration applies from a nodes-only schema and rolls back cleanly', async () => {
    const sql = await readFile(new URL('../../../prisma/migrations/20261026040000_include_structural_references/migration.sql', import.meta.url), 'utf8');
    await expect(db.$transaction(async tx => {
      await tx.$executeRawUnsafe('CREATE SCHEMA beckett_migration_2063');
      await tx.$executeRawUnsafe('SET LOCAL search_path TO beckett_migration_2063');
      await tx.$executeRawUnsafe('CREATE TABLE nodes (id TEXT PRIMARY KEY)');
      for (const statement of sql.split(';').filter(s => s.trim())) await tx.$executeRawUnsafe(statement);
      const tables = await tx.$queryRaw<Array<{ name: string }>>`SELECT table_name AS name FROM information_schema.tables WHERE table_schema = 'beckett_migration_2063'`;
      expect(tables.map(t => t.name)).toEqual(expect.arrayContaining(['include_references', 'include_source_coverage', 'include_retention_generation']));
      throw new Error('rollback migration probe');
    })).rejects.toThrow('rollback migration probe');
  });

  it('I: 10k-reference reverse lookup uses the address index', async () => {
    await db.includeReference.createMany({ data: Array.from({ length: 10_000 }, (_, ordinal) => ({ includerId: source.id, ordinal, kind: 'loc' as const, reference: `part:${ordinal}`, targetMemoryId: memory.id, targetLoc: `part:${ordinal}`, metadataGeneration: 1 })) });
    await db.$executeRaw`ANALYZE include_references`;
    const plan = await db.$queryRaw<Array<{ 'QUERY PLAN': unknown }>>`EXPLAIN (FORMAT JSON) SELECT pinned_rev_no, requires_approved FROM include_references WHERE target_memory_id = ${memory.id} AND target_loc = 'part:5321'`;
    expect(JSON.stringify(plan)).toContain('include_references_target_memory_id_target_loc_idx');
  });
});
