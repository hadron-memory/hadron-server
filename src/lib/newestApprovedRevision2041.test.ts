/**
 * #2041 (cor:dmo:150:05) — newestApprovedRevisionOf: the newest revision the
 * #1838 predicate reads APPROVED; a newer unapproved edit is skipped.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../integrations/db/client.js';
import { cleanDb } from '../test/helpers.js';
import { generateId } from './id.js';
import { endApprovalsOnEncryptedEntry, newestApprovedRevisionForServe, newestApprovedRevisionOf, NEWEST_APPROVED_REVISION_SCAN_BATCHES } from './nodeApproval.js';
import { resolvers, type Context } from '../api/graphql/schema/resolvers.js';

vi.mock('../integrations/github/writeNodeToGit.js', () => ({
  writeNodeToGit: vi.fn().mockResolvedValue(undefined),
}));

let admin: { id: string };
let orgId: string;
let memory: { id: string };

const as = (): Context => ({ db, userId: admin.id, roles: [] });
const mk = (loc: string) => db.node.create({
  data: { id: generateId(), memoryId: memory.id, loc, name: `Title ${loc}`, abstract: `Abstract ${loc}`, content: 'v1' },
});
const approve = (nodeRef: string) => resolvers.Mutation.approveNode(null, { nodeRef }, as());
const edit = (id: string, content: string) => resolvers.Mutation.updateNode(null, { input: { id, content } }, as());
const touchMeta = (id: string, tags: string[]) => resolvers.Mutation.updateNode(null, { input: { id, tags } }, as());

beforeEach(async () => {
  await cleanDb(db);
  const org = await db.organization.create({ data: { id: generateId(), name: 'Newest Org', urn: 'newest.example' } });
  orgId = org.id;
  admin = await db.user.create({ data: { githubId: 204101, githubUsername: 'newest-admin', handle: 'newest-admin', roles: [] } });
  await db.orgMember.create({ data: { organizationId: org.id, userId: admin.id, role: 'ADMIN' } });
  memory = await resolvers.Mutation.createMemory(null, { orgId: org.id, name: 'newest-approved' }, as());
});

describe('newestApprovedRevisionOf (#2041)', () => {
  it('a node never approved, and a missing node, select nothing', async () => {
    const n = await mk('n:1');
    await edit(n.id, 'v2');
    expect(await newestApprovedRevisionOf(db, n.id)).toEqual({ found: null, truncated: false });
    expect(await newestApprovedRevisionOf(db, generateId())).toEqual({ found: null, truncated: false });
  });

  it('a newer unapproved edit is skipped: the approved snapshot is selected', async () => {
    const n = await mk('n:2');
    await approve(n.id); // rev 1
    await edit(n.id, 'v2'); // rev 2, unapproved
    const r = await newestApprovedRevisionOf(db, n.id);
    expect(r.found).toMatchObject({ revNo: 1, source: 'snapshot', record: { revision: 1, approvedBy: admin.id } });
  });

  it('a later approval supersedes an earlier one: the newest approved wins', async () => {
    const n = await mk('n:3');
    await approve(n.id); // 1
    await edit(n.id, 'v2');
    await approve(n.id); // 2
    await edit(n.id, 'v3'); // 3, unapproved
    expect((await newestApprovedRevisionOf(db, n.id)).found).toMatchObject({ revNo: 2, source: 'snapshot' });
  });

  it('the approved live revision is read from the node row', async () => {
    const n = await mk('n:4');
    await edit(n.id, 'v2');
    await approve(n.id);
    const live = await db.node.findUniqueOrThrow({ where: { id: n.id } });
    expect((await newestApprovedRevisionOf(db, n.id)).found).toMatchObject({ revNo: live.revSeq, source: 'live' });
  });

  it('a metadata-only revision after the approval is covered by the earlier record', async () => {
    const n = await mk('n:5');
    await approve(n.id); // rev 1
    await touchMeta(n.id, ['x']); // newer revision, same hashed text
    const live = await db.node.findUniqueOrThrow({ where: { id: n.id } });
    expect((await newestApprovedRevisionOf(db, n.id)).found).toMatchObject({ revNo: live.revSeq, record: { revision: 1 } });
  });

  it('a pruned carrier selects nothing', async () => {
    const n = await mk('n:6');
    await approve(n.id);
    await edit(n.id, 'v2');
    await db.nodeRevision.deleteMany({ where: { nodeId: n.id, revNo: 1 } });
    expect((await newestApprovedRevisionOf(db, n.id)).found).toBeNull();
  });

  it('a hashless approval (ended on encrypted entry) selects nothing', async () => {
    const n = await mk('n:7');
    await approve(n.id);
    await edit(n.id, 'v2');
    expect((await newestApprovedRevisionOf(db, n.id)).found).not.toBeNull();
    await db.$transaction((tx) => endApprovalsOnEncryptedEntry(tx, { nodeIds: [n.id] }));
    expect((await newestApprovedRevisionOf(db, n.id)).found).toBeNull();
  });

  it('an encrypted memory selects nothing', async () => {
    const n = await mk('n:8');
    await approve(n.id);
    await db.memory.update({ where: { id: memory.id }, data: { isEncrypted: true, vectorIndexEnabled: false } });
    expect((await newestApprovedRevisionOf(db, n.id)).found).toBeNull();
  });

  it('a snapshot captured in another memory is never selected', async () => {
    const n = await mk('n:9');
    await approve(n.id); // rev 1
    await edit(n.id, 'v2');
    const other = await resolvers.Mutation.createMemory(null, { orgId, name: 'elsewhere' }, as());
    await db.nodeRevision.updateMany({ where: { nodeId: n.id, revNo: 1 }, data: { memoryId: other.id } });
    expect((await newestApprovedRevisionOf(db, n.id)).found).toBeNull();
  });

  it('a foreign-memory snapshot holding the live number is not read through as the live revision (Baloo P2)', async () => {
    const n = await mk('n:11');
    await approve(n.id); // rev 1, live: approved
    const other = await resolvers.Mutation.createMemory(null, { orgId, name: 'elsewhere-live' }, as());
    const live = await db.node.findUniqueOrThrow({ where: { id: n.id } });
    // A retained snapshot at the live number, captured in another memory, covering the same approved text.
    await db.nodeRevision.create({ data: {
      nodeId: n.id, memoryId: other.id, revNo: live.revSeq, loc: live.loc, name: live.name, abstract: live.abstract, content: live.content,
      approvalHash: live.approvalHash, approvedBy: live.approvedBy, approvedAt: live.approvedAt,
    } });
    expect((await newestApprovedRevisionOf(db, n.id)).found).toBeNull();
    // control: the same row captured in the target's own memory is served, as a snapshot.
    await db.nodeRevision.updateMany({ where: { nodeId: n.id, revNo: live.revSeq }, data: { memoryId: memory.id } });
    expect((await newestApprovedRevisionOf(db, n.id)).found).toMatchObject({ revNo: live.revSeq, source: 'snapshot' });
  });

  it('the cap bounds the walk and reports truncation instead of "never approved"', async () => {
    const n = await mk('n:10');
    await approve(n.id); // rev 1
    await edit(n.id, 'v2');
    await edit(n.id, 'v3');
    expect(await newestApprovedRevisionOf(db, n.id, 1)).toEqual({ found: null, truncated: true, resumeBelow: 3 });
    expect((await newestApprovedRevisionOf(db, n.id, 3)).found).toMatchObject({ revNo: 1 });
  });
});

describe('newestApprovedRevisionForServe (#3801)', () => {
  /** Approved rev 1, then `depth` unapproved revisions above it, seeded directly (retention would prune real edits). */
  const buried = async (loc: string, depth: number) => {
    const n = await mk(loc);
    await approve(n.id); // snapshot/live rev 1
    const live = await db.node.findUniqueOrThrow({ where: { id: n.id } });
    await db.nodeRevision.create({ data: {
      id: generateId(), nodeId: n.id, memoryId: memory.id, loc: n.loc, name: live.name, abstract: live.abstract, content: live.content,
      tags: [], revNo: 1, approvedAt: live.approvedAt, approvedByInfo: live.approvedByInfo, approvedBy: live.approvedBy, approvalHash: live.approvalHash,
    } as never });
    await db.nodeRevision.createMany({ data: Array.from({ length: depth - 2 }, (_, i) => ({
      id: generateId(), nodeId: n.id, memoryId: memory.id, loc: n.loc, name: n.name,
      content: `not approved ${i}`, tags: [], revNo: i + 2,
    })) });
    await db.node.update({ where: { id: n.id }, data: { revSeq: depth, content: 'unapproved head' } });
    return n;
  };

  it('continues past the cap and finds the buried approved revision', async () => {
    const n = await buried('n:11', 6);
    expect((await newestApprovedRevisionOf(db, n.id, 2)).found).toBeNull();
    expect((await newestApprovedRevisionForServe(db, n.id, 2)).found).toMatchObject({ revNo: 1 });
  });

  it('examines exactly cap x BATCHES revisions, then reports truncation', async () => {
    const reach = 2 * NEWEST_APPROVED_REVISION_SCAN_BATCHES;
    const inside = await buried('n:12', reach); // approved rev 1 is the reach-th newest candidate
    expect((await newestApprovedRevisionForServe(db, inside.id, 2)).found).toMatchObject({ revNo: 1 });
    const outside = await buried('n:13', reach + 1); // one deeper
    expect(await newestApprovedRevisionForServe(db, outside.id, 2)).toMatchObject({ found: null, truncated: true });
  }, 60_000);

  it('`below` excludes the live revision and every number at or above it', async () => {
    const n = await mk('n:15');
    await edit(n.id, 'v2');
    await approve(n.id); // approved LIVE revision
    const live = await db.node.findUniqueOrThrow({ where: { id: n.id } });
    expect((await newestApprovedRevisionOf(db, n.id)).found).toMatchObject({ revNo: live.revSeq, source: 'live' });
    expect((await newestApprovedRevisionOf(db, n.id, undefined, undefined, live.revSeq)).found).toBeNull();
  });

  it('a node never approved is not truncated once every revision is examined', async () => {
    const n = await mk('n:14');
    for (let i = 0; i < 5; i++) await edit(n.id, `v${i + 2}`);
    expect(await newestApprovedRevisionForServe(db, n.id, 2)).toMatchObject({ found: null, truncated: false });
  });
});

describe('the unmetered walk pre-filters by approval hash (#3801)', () => {
  const meter = { chargeLookup: () => {}, chargeLoaded: () => {} }; // a metered walk examines every revision by verdict
  const same = async (id: string, cap?: number) => {
    const fast = await newestApprovedRevisionOf(db, id, cap);
    const slow = await newestApprovedRevisionOf(db, id, cap, meter);
    expect(fast).toEqual(slow);
    return fast;
  };

  it('agrees with the per-verdict walk: approved, superseded, edited-after, metadata-only, never approved', async () => {
    const a = await mk('d:1'); await approve(a.id); await edit(a.id, 'x2'); await edit(a.id, 'x3');
    expect((await same(a.id)).found).toMatchObject({ revNo: 1 });
    const b = await mk('d:2'); await approve(b.id); await edit(b.id, 'y2'); await approve(b.id); await edit(b.id, 'y3');
    expect((await same(b.id)).found).toMatchObject({ revNo: 2 });
    const c = await mk('d:3'); await approve(c.id); await touchMeta(c.id, ['t']); await touchMeta(c.id, ['u']);
    expect((await same(c.id)).found).not.toBeNull();
    const d = await mk('d:4'); await edit(d.id, 'z2'); await edit(d.id, 'z3');
    expect((await same(d.id))).toEqual({ found: null, truncated: false });
    expect((await same(a.id, 1))).toEqual(await newestApprovedRevisionOf(db, a.id, 1, meter));
  });

  it('an encrypted memory selects nothing and is not reported truncated, as the per-verdict walk answers', async () => {
    const n = await mk('d:6'); await approve(n.id);
    for (let i = 0; i < 3; i++) await edit(n.id, `e${i}`);
    await db.memory.update({ where: { id: memory.id }, data: { isEncrypted: true, vectorIndexEnabled: false } });
    expect(await same(n.id, 1)).toEqual({ found: null, truncated: false });
  });

  it('the carrier lookup is bounded by the batch, not by the node\'s whole approval history', async () => {
    const n = await mk('d:7'); await approve(n.id);
    await db.nodeRevision.createMany({ data: Array.from({ length: 60 }, (_, i) => ({
      id: generateId(), nodeId: n.id, memoryId: memory.id, loc: n.loc, name: n.name, content: `old ${i}`, tags: [], revNo: 100 + i,
      approvedAt: new Date(), approvedByInfo: 't', approvalHash: `h${i}`.padEnd(64, '0'),
    })) as never });
    await db.node.update({ where: { id: n.id }, data: { revSeq: 400, content: 'changed head' } });
    const spy = vi.spyOn(db.nodeRevision, 'groupBy');
    await newestApprovedRevisionOf(db, n.id, 1);
    const carrierReads = spy.mock.calls.map((c) => c[0] as unknown as { where?: { approvalHash?: { in?: string[] } } }).filter((a) => a?.where?.approvalHash?.in);
    spy.mockRestore();
    for (const a of carrierReads) expect(a.where!.approvalHash!.in!.length).toBeLessThanOrEqual(1);
    expect(carrierReads.length).toBeGreaterThan(0);
  });

  it('repeated matching hashes cost one grouped row, not one fetched row per duplicate', async () => {
    const n = await mk('d:9'); await approve(n.id);
    const live = await db.node.findUniqueOrThrow({ where: { id: n.id } });
    const hash = live.approvalHash!;
    // 120 snapshots carrying the SAME approval hash (as metadata-only revisions after one approval do); live text differs
    await db.nodeRevision.createMany({ data: Array.from({ length: 120 }, (_, i) => ({
      id: generateId(), nodeId: n.id, memoryId: memory.id, loc: n.loc, name: n.name, content: `dup ${i}`, tags: [], revNo: 100 + i,
      approvedAt: new Date(), approvedByInfo: 't', approvalHash: hash,
    })) as never });
    await db.node.update({ where: { id: n.id }, data: { revSeq: 400, content: 'changed head', approvalHash: null } });
    const find = vi.spyOn(db.nodeRevision, 'findMany');
    const group = vi.spyOn(db.nodeRevision, 'groupBy');
    await newestApprovedRevisionOf(db, n.id, 1);
    const unboundedCarrierRead = find.mock.calls.some((c) => (c[0] as { where?: { approvalHash?: unknown } })?.where?.approvalHash != null);
    const grouped = group.mock.calls.length;
    find.mockRestore(); group.mockRestore();
    expect(unboundedCarrierRead).toBe(false);
    expect(grouped).toBeGreaterThan(0);
  });

  it('a metered walk does not read the live text outside its charged verdicts', async () => {
    const n = await mk('d:8'); await edit(n.id, 'm2');
    const spy = vi.spyOn(db.node, 'findUnique');
    await newestApprovedRevisionOf(db, n.id, 1, meter);
    const first = spy.mock.calls[0][0] as { select?: Record<string, boolean> };
    spy.mockRestore();
    expect(first.select).not.toHaveProperty('content');
  });

  it('a revision whose text matches no recorded approval hash costs no verdict query', async () => {
    const n = await mk('d:5'); await approve(n.id);
    for (let i = 0; i < 4; i++) await edit(n.id, `w${i}`);
    const spy = vi.spyOn(db.node, 'findUnique');
    await newestApprovedRevisionOf(db, n.id);
    // the walk's live read, the pre-filter's, and ONE verdict (the approved revision); a per-verdict walk adds one per revision
    expect(spy.mock.calls.length).toBeLessThanOrEqual(3);
    spy.mockRestore();
  });
});
