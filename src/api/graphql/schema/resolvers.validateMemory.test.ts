/**
 * #819 — `validateMemory`, the GraphQL twin of `hadron_validate`.
 *
 * Two things the issue asked to settle, both pinned here:
 *   - a large memory is BOUNDED (findings capped) but `totalFindings` still
 *     reports the true count, so a CI gate is never fooled by truncation;
 *   - the encrypted-memory carve-out is reported as a SKIPPED CHECK, not
 *     silently omitted — "a clean bill of health that quietly skipped a check
 *     is worse than no report".
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { db } from '../../../integrations/db/client.js';
import { cleanDb, createDbNode } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { computeContentHash } from '../../../lib/contentHash.js';
import { resolvers, type Context } from './resolvers.js';
import { validateMemoryNodes } from '../../../lib/memoryValidation.js';

vi.mock('../../../integrations/github/writeNodeToGit.js', () => ({
  writeNodeToGit: vi.fn().mockResolvedValue(undefined),
}));

const Q = resolvers.Query as any;

const ctx = (userId?: string, roles: Context['roles'] = ['READER']): Context =>
  ({ db, userId, roles });

let org: { id: string; urn: string };
let member: { id: string };
let stranger: { id: string };
let mem: { id: string; urn: string };

beforeEach(async () => {
  await cleanDb(db);
  org = await db.organization.create({ data: { id: generateId(), name: 'vm', urn: `vm-${generateId()}` } });
  member = await db.user.create({ data: { id: generateId(), githubId: 52101, githubUsername: 'vm-member' } });
  stranger = await db.user.create({ data: { id: generateId(), githubId: 52102, githubUsername: 'vm-stranger' } });
  await db.orgMember.create({ data: { id: generateId(), organizationId: org.id, userId: member.id, role: 'READER' } });
  mem = await db.memory.create({
    data: {
      id: generateId(), organizationId: org.id, urn: `${org.urn}:mem`,
      name: 'vm mem', class: 'knowledge', visibility: 'ORGANIZATION',
    },
  });
});

const validate = (memoryRef = mem.id, limit?: number, c: Context = ctx(member.id)) =>
  Q.validateMemory(null, { memoryRef, limit }, c);

describe('validateMemory — a healthy memory (#819)', () => {
  it('reports ok with zero findings and nothing skipped', async () => {
    await createDbNode(db, { loc: 'a', memoryId: mem.id, name: 'A', content: 'body' });
    const r = await validate();
    expect(r.ok).toBe(true);
    expect(r.totalFindings).toBe(0);
    expect(r.findings).toEqual([]);
    expect(r.skippedChecks).toEqual([]);
    expect(r.nodesChecked).toBe(1);
    expect(r.truncated).toBe(false);
  });
});

describe('validateMemory — the five checks (#819)', () => {
  it('SPARSE: a node with no description, content, or abstract', async () => {
    await createDbNode(db, { loc: 'empty', memoryId: mem.id, name: 'Empty' });
    const r = await validate();
    expect(r.findings.map((f: { kind: string }) => f.kind)).toContain('SPARSE');
    expect(r.ok).toBe(false);
  });

  it('SPARSE does NOT fire on a node carrying only an abstract (spec 031 FR-011)', async () => {
    const n = await createDbNode(db, { loc: 'abs', memoryId: mem.id, name: 'Abs' });
    await db.node.update({ where: { id: n.id }, data: { abstract: 'just an abstract' } });
    const r = await validate();
    expect(r.findings.map((f: { kind: string }) => f.kind)).not.toContain('SPARSE');
  });

  // #2516 (cor:api:020:03, Holger 2026-10-27): every object node is exempt —
  // objects are data-only by design. The exemption keys on objectType alone.
  it('SPARSE does NOT fire on a data-only object node (#2516)', async () => {
    const n = await createDbNode(db, { loc: 'obj', memoryId: mem.id, name: 'Obj' });
    await db.node.update({ where: { id: n.id }, data: { objectType: 'contact', properties: { email: 'a@b.c' } } });
    const r = await validate();
    expect(r.findings.map((f: { kind: string }) => f.kind)).not.toContain('SPARSE');
  });

  it('SPARSE still fires on a name-only node with no objectType (#2516)', async () => {
    await createDbNode(db, { loc: 'plain', memoryId: mem.id, name: 'Plain' });
    const n = await createDbNode(db, { loc: 'obj', memoryId: mem.id, name: 'Obj' });
    await db.node.update({ where: { id: n.id }, data: { objectType: 'contact' } });
    const r = await validate();
    const sparse = r.findings.filter((f: { kind: string }) => f.kind === 'SPARSE');
    expect(sparse.map((f: { nodeLoc: string }) => f.nodeLoc)).toEqual(['plain']);
  });

  it('a legacy blank objectType is no collection, so the node is still SPARSE (#2516, #725)', async () => {
    const n = await createDbNode(db, { loc: 'blank', memoryId: mem.id, name: 'Blank' });
    await db.node.update({ where: { id: n.id }, data: { objectType: '  ' } });
    const r = await validate();
    expect(r.findings.map((f: { kind: string }) => f.kind)).toContain('SPARSE');
  });

  it('an object node that also carries content is not SPARSE (#2516)', async () => {
    const n = await createDbNode(db, { loc: 'objc', memoryId: mem.id, name: 'ObjC', content: 'body' });
    await db.node.update({ where: { id: n.id }, data: { objectType: 'contact', description: 'd' } });
    const r = await validate();
    expect(r.findings.map((f: { kind: string }) => f.kind)).not.toContain('SPARSE');
  });

  it('a soft-deleted node produces NO findings and is not counted (#884)', async () => {
    // The prod case that motivated #884: a tombstone carrying a stale
    // embeddingFailedAt and a stale abstract from before its deletion. Its
    // findings are unactionable — no read surface resolves it,
    // retryFailedEmbeddings and the embed worker both skip it — so it must
    // not pollute the audit or any CI gate on the count.
    await createDbNode(db, { loc: 'live', memoryId: mem.id, name: 'Live', content: 'x' });
    const dead = await createDbNode(db, { loc: 'dead', memoryId: mem.id, name: 'Dead' });
    await db.node.update({
      where: { id: dead.id },
      data: {
        deletedAt: new Date(),
        // EMBED_FAILED and STALE_ABSTRACT would both fire on this row if it
        // were scanned:
        embeddingFailedAt: new Date(),
        embeddingError: 'EMBEDDING_REQUEST_FAILED: fetch failed',
        abstract: 'stale abstract',
        content: 'body since rewritten',
        abstractOriginHash: 'deadbeef',
      },
    });
    const r = await validate();
    expect(r.totalFindings).toBe(0);
    expect(r.findings).toEqual([]);
    expect(r.nodesChecked).toBe(1); // the live node only
    expect(r.ok).toBe(true);
  });

  it('BROKEN_REF: an edge whose target is a soft-deleted tombstone', async () => {
    // A hard-deleted target is impossible — Edge.target is FK-enforced with
    // onDelete: Cascade, so deleting the node takes the edge with it. The
    // reachable dangling-edge state is a target that was SOFT deleted.
    const a = await createDbNode(db, { loc: 'a', memoryId: mem.id, name: 'A', content: 'x' });
    const b = await createDbNode(db, { loc: 'b', memoryId: mem.id, name: 'B', content: 'y' });
    await db.edge.create({
      data: { id: generateId(), memoryId: mem.id, sourceId: a.id, targetId: b.id, name: 'rel', loc: 'a:rel:b' },
    });
    await db.node.update({ where: { id: b.id }, data: { deletedAt: new Date() } });
    const r = await validate();
    const broken = r.findings.filter((f: { kind: string }) => f.kind === 'BROKEN_REF');
    expect(broken.length).toBe(1);
    expect(broken[0].nodeId).toBe(a.id);
  });

  it('BROKEN_REF does NOT fire on a legitimate CROSS-MEMORY edge', async () => {
    // Cross-memory edges are a supported feature (#755 gates writing them,
    // #781 gates reading them back). The pre-#819 check compared targets
    // against THIS memory's node ids only, so every one of them was reported
    // as broken — the audit would have been unusable for CI on any memory
    // that links out.
    const other = await db.memory.create({
      data: {
        id: generateId(), organizationId: org.id, urn: `${org.urn}:other`,
        name: 'other', class: 'knowledge', visibility: 'ORGANIZATION',
      },
    });
    const a = await createDbNode(db, { loc: 'a', memoryId: mem.id, name: 'A', content: 'x' });
    const far = await createDbNode(db, { loc: 'far', memoryId: other.id, name: 'Far', content: 'y' });
    await db.edge.create({
      data: { id: generateId(), memoryId: mem.id, sourceId: a.id, targetId: far.id, name: 'rel', loc: 'a:rel:far' },
    });
    const r = await validate();
    expect(r.findings.map((f: { kind: string }) => f.kind)).not.toContain('BROKEN_REF');
    expect(r.ok).toBe(true);
  });

  it('STALE_ABSTRACT: abstractOriginHash no longer matches the content', async () => {
    const n = await createDbNode(db, { loc: 'stale', memoryId: mem.id, name: 'S', content: 'NEW BODY' });
    await db.node.update({
      where: { id: n.id },
      data: { abstract: 'old summary', abstractOriginHash: computeContentHash('OLD BODY') },
    });
    const r = await validate();
    expect(r.findings.map((f: { kind: string }) => f.kind)).toContain('STALE_ABSTRACT');
  });

  it('STALE_ABSTRACT reports rows with NO origin hash (#1128)', async () => {
    // EXPECTATION INVERTED by #1128. The GraphQL validator shares
    // isAbstractUnverified with the MCP surfaces, so this moves with them —
    // which is the point of extracting the predicate: three copies of a rule
    // stay in step only until someone edits one.
    //
    // A never-fingerprinted abstract is precisely what an audit should report.
    const n = await createDbNode(db, { loc: 'legacy', memoryId: mem.id, name: 'L', content: 'BODY' });
    await db.node.update({
      where: { id: n.id },
      data: { abstract: 'summary', abstractOriginHash: null },
    });
    const r = await validate();
    expect(r.findings.map((f: { kind: string }) => f.kind)).toContain('STALE_ABSTRACT');
  });

  it('EMBED_FAILED: surfaces the failure reason', async () => {
    const n = await createDbNode(db, { loc: 'ef', memoryId: mem.id, name: 'E', content: 'x' });
    await db.node.update({
      where: { id: n.id },
      data: { embeddingFailedAt: new Date(), embeddingError: 'provider 429' },
    });
    const r = await validate();
    const ef = r.findings.find((f: { kind: string }) => f.kind === 'EMBED_FAILED');
    expect(ef?.detail).toBe('provider 429');
  });

  it('EMBED_FAILED renders "unknown" for a blank error rather than an empty reason', async () => {
    const n = await createDbNode(db, { loc: 'ef2', memoryId: mem.id, name: 'E2', content: 'x' });
    await db.node.update({
      where: { id: n.id },
      data: { embeddingFailedAt: new Date(), embeddingError: '   ' },
    });
    const r = await validate();
    expect(r.findings.find((f: { kind: string }) => f.kind === 'EMBED_FAILED')?.detail).toBe('unknown');
  });
});

describe('validateMemory — the encrypted carve-out is SAID, not silent (#819)', () => {
  it('reports STALE_ABSTRACT as a skipped check, and ok is FALSE despite no findings', async () => {
    await db.memory.update({ where: { id: mem.id }, data: { isEncrypted: true } });
    await createDbNode(db, { loc: 'a', memoryId: mem.id, name: 'A', content: 'body' });
    const r = await validate();
    expect(r.totalFindings).toBe(0);
    expect(r.skippedChecks.map((c: { check: string }) => c.check)).toEqual(['STALE_ABSTRACT']);
    expect(r.skippedChecks[0].reason).toMatch(/encrypted/i);
    // The point: zero findings is NOT a clean bill of health when a check
    // could not run.
    expect(r.ok).toBe(false);
  });

  it('does not emit false STALE_ABSTRACT findings on ciphertext', async () => {
    const n = await createDbNode(db, { loc: 'enc', memoryId: mem.id, name: 'E', content: 'CIPHERTEXT' });
    await db.node.update({
      where: { id: n.id },
      data: { abstract: 'summary', abstractOriginHash: computeContentHash('PLAINTEXT') },
    });
    await db.memory.update({ where: { id: mem.id }, data: { isEncrypted: true } });
    const r = await validate();
    // Without the skip this would be a false positive on EVERY node.
    expect(r.findings.map((f: { kind: string }) => f.kind)).not.toContain('STALE_ABSTRACT');
  });
});

describe('validateMemory — bounded, but honest about it (#819)', () => {
  beforeEach(async () => {
    for (let i = 0; i < 12; i++) {
      await createDbNode(db, { loc: `sparse-${i}`, memoryId: mem.id, name: `S${i}` });
    }
  });

  it('caps findings at limit while totalFindings reports the TRUE count', async () => {
    const r = await validate(mem.id, 5);
    expect(r.findings.length).toBe(5);
    // A CI gate reads this, so truncation must never make a memory look healthy.
    expect(r.totalFindings).toBe(12);
    expect(r.truncated).toBe(true);
    expect(r.ok).toBe(false);
  });

  it('is not truncated when everything fits', async () => {
    const r = await validate(mem.id, 100);
    expect(r.findings.length).toBe(12);
    expect(r.truncated).toBe(false);
  });

  it('limit 0 returns the count only — the cheap "is it healthy" probe', async () => {
    const r = await validate(mem.id, 0);
    expect(r.findings).toEqual([]);
    expect(r.totalFindings).toBe(12);
    expect(r.truncated).toBe(true);
  });

  it('scans every node regardless of the findings cap', async () => {
    const r = await validate(mem.id, 1);
    expect(r.nodesChecked).toBe(12);
  });
});

describe('validateMemory — shape and access (#819)', () => {
  it('each finding carries a node ref the caller can act on', async () => {
    const n = await createDbNode(db, { loc: 'deep:thing', memoryId: mem.id, name: 'D' });
    const r = await validate();
    const f = r.findings[0];
    expect(f.nodeId).toBe(n.id);
    expect(f.nodeLoc).toBe('deep:thing');
    expect(f.nodeUrn).toContain('deep:thing');
  });

  it('accepts a memory URN as well as a PK (cor:api:140)', async () => {
    await createDbNode(db, { loc: 'a', memoryId: mem.id, name: 'A', content: 'x' });
    const r = await validate(mem.urn);
    expect(r.memoryId).toBe(mem.id);
  });

  // #1316: "indistinguishably" is now literal. This used to throw NOT_FOUND
  // "Memory not found" while a real miss threw MEMORY_NOT_FOUND from ref
  // resolution — two different answers, i.e. an existence oracle.
  it('a non-member is refused, indistinguishably from a miss', async () => {
    const missing = generateId();
    await expect(validate(mem.id, undefined, ctx(stranger.id))).rejects.toThrow(`MEMORY_NOT_FOUND: ${mem.id}`);
    await expect(validate(missing, undefined, ctx(stranger.id))).rejects.toThrow(`MEMORY_NOT_FOUND: ${missing}`);
  });

  it('an anonymous caller is refused', async () => {
    await expect(validate(mem.id, undefined, ctx())).rejects.toThrow(`MEMORY_NOT_FOUND: ${mem.id}`);
  });

  // PR #859 review (Codex P1). This query returns node ids, locs, counts and
  // operational error details — NODE-level data. The record-level gate keeps
  // an org-member fast path that admits app/system-class memories which
  // getAccessibleMemoryIds deliberately excludes from node access, so gating
  // on it let an ordinary org member enumerate App-internal nodes.
  it('an org member cannot validate an APP-SCOPED memory of their own org', async () => {
    const app = await db.app.create({
      data: { id: generateId(), organizationId: org.id, urn: `${org.urn}:app`, name: 'App' },
    });
    const appMem = await db.memory.create({
      data: {
        id: generateId(), organizationId: org.id, urn: `${org.urn}:app-internal`,
        name: 'App Internal', class: 'knowledge', visibility: 'ORGANIZATION', appId: app.id,
      },
    });
    await createDbNode(db, { loc: 'internal:secret', memoryId: appMem.id, name: 'S' });
    // The member CAN open the memory record (Query.memory admits them)…
    expect(await Q.memory(null, { ref: appMem.id }, ctx(member.id))).not.toBeNull();
    // …but must NOT be able to enumerate its nodes through the validator.
    await expect(validate(appMem.id, undefined, ctx(member.id))).rejects.toThrow(`MEMORY_NOT_FOUND: ${appMem.id}`);
  });

  it('an org member CAN validate an ordinary org memory (no over-tightening)', async () => {
    await createDbNode(db, { loc: 'a', memoryId: mem.id, name: 'A', content: 'x' });
    expect((await validate(mem.id, undefined, ctx(member.id))).nodesChecked).toBe(1);
  });
});

describe('validateMemory — findings are capped at the SOURCE (#859 review)', () => {
  it('never retains more than the cap, while still counting the rest', async () => {
    for (let i = 0; i < 12; i++) {
      await createDbNode(db, { loc: `s-${i}`, memoryId: mem.id, name: `S${i}` });
    }
    // The cap is pushed into validateMemoryNodes, so the big array is never
    // built in the first place.
    const report = await validateMemoryNodes(db, mem.id, 3);
    expect(report.findings.length).toBe(3);
    expect(report.totalFindings).toBe(12);
  });

  it('BROKEN_REF ignores a soft-deleted EDGE row', async () => {
    const a = await createDbNode(db, { loc: 'ea', memoryId: mem.id, name: 'A', content: 'x' });
    const b = await createDbNode(db, { loc: 'eb', memoryId: mem.id, name: 'B', content: 'y' });
    const edge = await db.edge.create({
      data: { id: generateId(), memoryId: mem.id, sourceId: a.id, targetId: b.id, name: 'rel', loc: 'ea:rel:eb' },
    });
    // Both the edge AND its target are gone — every normal edge surface
    // excludes a soft-deleted edge, so this is not a broken reference.
    await db.edge.update({ where: { id: edge.id }, data: { deletedAt: new Date() } });
    await db.node.update({ where: { id: b.id }, data: { deletedAt: new Date() } });
    const r = await validate();
    expect(r.findings.map((f: { kind: string }) => f.kind)).not.toContain('BROKEN_REF');
  });
});
