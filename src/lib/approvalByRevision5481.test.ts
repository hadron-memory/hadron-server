/**
 * #5481 — approval by revision. A revision is approved only when an approval is recorded AT it: its own history row
 * carries one, or it is the live revision under the node's standing approval. A revision whose text merely equals a
 * text approved earlier is not approved (Holger, 2026-11-28, decision record section 7: "The text is not a factor at
 * all"). This reverses the #1838 rule in hrn:node:hadronmemory.com:specs:cor:dmo:060:04 ("approved when some recorded
 * approval covers its content, whichever revision it was recorded on").
 *
 * Every node here is written through the real resolvers (`updateNode`, `approveNode`), so each history row is what
 * the revision writer makes of it.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../integrations/db/client.js';
import { cleanDb } from '../test/helpers.js';
import { generateId } from './id.js';
import { approvalStateOf, newestApprovedRevisionOf, revisionApprovalOf } from './nodeApproval.js';
import { revisionsExemptFromPruning } from './nodeRevisionSnapshot.js';
import { computeApprovalHash } from './approvalHash.js';
import { plainPinWarnings } from './includes/plainPinWarnings.js';
import { resolvers, type Context } from '../api/graphql/schema/resolvers.js';

vi.mock('../integrations/github/writeNodeToGit.js', () => ({
  writeNodeToGit: vi.fn().mockResolvedValue(undefined),
}));

let admin: { id: string };
let orgId: string;
let memory: { id: string; urn: string };

const as = (): Context => ({ db, userId: admin.id, roles: [] });
const mk = (loc: string, content = 'A') => db.node.create({
  data: { id: generateId(), memoryId: memory.id, loc, name: `Title ${loc}`, abstract: null, content },
});
const approve = (nodeRef: string) => resolvers.Mutation.approveNode(null, { nodeRef }, as());
const edit = (id: string, content: string) => resolvers.Mutation.updateNode(null, { input: { ref: id, content } }, as());
const tag = (id: string, tags: string[]) => resolvers.Mutation.updateNode(null, { input: { ref: id, tags } }, as());
const stateOf = async (nodeId: string, revNo: number) => (await revisionApprovalOf(db, nodeId, revNo)).state;
const newest = async (nodeId: string) => (await newestApprovedRevisionOf(db, nodeId)).found;
const liveRev = async (nodeId: string) => (await db.node.findUniqueOrThrow({ where: { id: nodeId } })).revSeq;
const read = async (loc: string): Promise<string> => {
  const n = await resolvers.Query.node(null, { ref: loc, memoryId: memory.id } as never, as());
  return (await (resolvers as never as { Node: { content: (...a: unknown[]) => Promise<string> } }).Node.content(n, {}, as(), {}));
};

/** The issue's table: rev 1 = A approved, rev 2 = B approved, rev 3 = C, rev 4 = A again; nothing approved after 2. */
async function table(loc: string) {
  const n = await mk(loc, 'A');
  await approve(n.id); // rev 1, A, approved
  await edit(n.id, 'B'); // rev 2
  await approve(n.id); // rev 2, B, approved
  await edit(n.id, 'C'); // rev 3, never approved
  await edit(n.id, 'A'); // rev 4, the text of rev 1 again, never approved
  return n;
}

beforeEach(async () => {
  await cleanDb(db);
  const org = await db.organization.create({ data: { id: generateId(), name: 'By Rev Org', urn: 'byrev.example' } });
  orgId = org.id;
  admin = await db.user.create({ data: { githubId: 548101, githubUsername: 'byrev-admin', handle: 'byrev-admin', roles: [] } });
  await db.orgMember.create({ data: { organizationId: org.id, userId: admin.id, role: 'ADMIN' } });
  memory = await resolvers.Mutation.createMemory(null, { orgRef: org.id, name: 'by-revision' }, as());
});

describe('#5481 the four-revision table: the text is not a factor', () => {
  it('revision 4 repeats the text approved at revision 1 and is NOT approved; revision 2 is the newest approved', async () => {
    const n = await table('t:1');
    expect(await liveRev(n.id)).toBe(4);
    expect(await stateOf(n.id, 4)).toBe('NOT_APPROVED');
    expect(await stateOf(n.id, 3)).toBe('NOT_APPROVED');
    expect(await revisionApprovalOf(db, n.id, 2)).toMatchObject({ state: 'APPROVED', record: { revision: 2, approvedBy: admin.id } });
    expect(await revisionApprovalOf(db, n.id, 1)).toMatchObject({ state: 'APPROVED', record: { revision: 1 } });
    expect(await newest(n.id)).toMatchObject({ revNo: 2, source: 'snapshot', record: { revision: 2 } });
  });

  it('once revision 4 is edited away its history row still reads not approved (no approval was recorded at it)', async () => {
    const n = await table('t:2');
    await edit(n.id, 'D'); // rev 5; rev 4 becomes a history row holding A
    expect(await stateOf(n.id, 4)).toBe('NOT_APPROVED');
    expect(await newest(n.id)).toMatchObject({ revNo: 2 });
  });

  it('approving revision 4 makes it the newest approved; a further unapproved edit keeps it', async () => {
    const n = await table('t:3');
    await approve(n.id); // recorded AT revision 4
    expect(await newest(n.id)).toMatchObject({ revNo: 4, source: 'live', record: { revision: 4 } });
    await edit(n.id, 'E'); // rev 5, unapproved
    expect(await newest(n.id)).toMatchObject({ revNo: 4, source: 'snapshot', record: { revision: 4 } });
    await edit(n.id, 'B'); // rev 6 repeats the text approved at revision 2: still not approved
    expect(await stateOf(n.id, 6)).toBe('NOT_APPROVED');
    expect(await newest(n.id)).toMatchObject({ revNo: 4 });
  });

  it('an approval never reaches back: a revision older than the record with the same text is not approved', async () => {
    const n = await mk('t:4', 'A'); // rev 1, never approved
    await edit(n.id, 'B'); // rev 2
    await edit(n.id, 'A'); // rev 3
    await approve(n.id); // recorded AT revision 3
    expect(await stateOf(n.id, 3)).toBe('APPROVED');
    expect(await stateOf(n.id, 1)).toBe('NOT_APPROVED');
  });

  it('GraphQL NodeRevision.revisionApproval reports the same rule', async () => {
    const n = await table('t:5');
    await edit(n.id, 'D'); // rev 5, so revisions 1..4 are history rows
    const rows = await db.nodeRevision.findMany({ where: { nodeId: n.id }, orderBy: { revNo: 'asc' } });
    const field = (row: (typeof rows)[number]) => resolvers.NodeRevision.revisionApproval(row, {}, as());
    expect(await field(rows[3])).toEqual({ state: 'NOT_APPROVED', approved: false, recordedAtRevision: null, approvedBy: null, approvedByInfo: null, approvedAt: null });
    expect(await field(rows[1])).toMatchObject({ state: 'APPROVED', approved: true, recordedAtRevision: 2, approvedBy: admin.id });
    expect(await field(rows[0])).toMatchObject({ state: 'APPROVED', approved: true, recordedAtRevision: 1 });
  });
});

describe('#5481 an `approved` include resolves to the newest revision an approval was recorded at', () => {
  it('unpinned: revision 2 is served, never the later revision with the earlier-approved text', async () => {
    await table('rule');
    await db.node.create({ data: { id: generateId(), memoryId: memory.id, loc: 'inc', name: 'inc', content: '{{> rule approved}}' } });
    expect(await read('inc')).toBe('B');
  });

  it('a target with a later non-content revision: the approved text is served before and after an unapproved edit, pinned or not', async () => {
    const n = await mk('tagged', 'A');
    await approve(n.id); // rev 1
    await tag(n.id, ['x']); // rev 2: same hashed content
    await db.node.create({ data: { id: generateId(), memoryId: memory.id, loc: 'inc-t', name: 'inc-t', content: '{{> tagged approved}}|{{> tagged rev=1 approved}}|{{> tagged rev=2 approved}}' } });
    expect(await read('inc-t')).toBe('A|A|A');
    await edit(n.id, 'B'); // rev 3, unapproved
    expect(await read('inc-t')).toBe('A|A|A');
    await edit(n.id, 'A'); // rev 4 repeats A, unapproved: not what is served (revision 2 is), and a pin on it is broken
    await db.node.create({ data: { id: generateId(), memoryId: memory.id, loc: 'inc-t4', name: 'inc-t4', content: '{{> tagged rev=4 approved}}' } });
    expect(await read('inc-t')).toBe('A|A|A');
    expect(await read('inc-t4')).toBe('[Include unavailable]');
  });

  it('pinned at the unapproved revision 4: broken; pinned at revision 2: served', async () => {
    await table('rule2');
    await db.node.create({ data: { id: generateId(), memoryId: memory.id, loc: 'inc4', name: 'inc4', content: '{{> rule2 rev=4 approved}}' } });
    await db.node.create({ data: { id: generateId(), memoryId: memory.id, loc: 'inc2', name: 'inc2', content: '{{> rule2 rev=2 approved}}' } });
    expect(await read('inc4')).toBe('[Include unavailable]');
    expect(await read('inc2')).toBe('B');
  });
});

describe('#5481 a write that does not change the hashed content keeps the approval in force (cor:dmo:120:04, unchanged)', () => {
  it('tags after an approval: the approved revision and each later non-content revision read approved by that one record', async () => {
    const n = await mk('m:1', 'A');
    await approve(n.id); // rev 1
    await tag(n.id, ['x']); // rev 2: same hashed content
    await tag(n.id, ['y']); // rev 3: same hashed content, live
    expect((await db.node.findUniqueOrThrow({ where: { id: n.id } })).approvedRevNo).toBe(1);
    expect(approvalStateOf(await db.node.findUniqueOrThrow({ where: { id: n.id } }))).toBe('APPROVED');
    for (const rev of [1, 2, 3]) {
      expect(await revisionApprovalOf(db, n.id, rev), `rev ${rev}`).toMatchObject({ state: 'APPROVED', record: { revision: 1, approvedBy: admin.id } });
    }
    expect(await newest(n.id)).toMatchObject({ revNo: 3, source: 'live', record: { revision: 1 } });
  });

  it('a later content change does not take the approval away from the non-content revisions before it', async () => {
    const n = await mk('m:2', 'A');
    await approve(n.id); // rev 1
    await tag(n.id, ['x']); // rev 2
    await edit(n.id, 'B'); // rev 3, unapproved
    await edit(n.id, 'A'); // rev 4 repeats A, unapproved
    expect(await revisionApprovalOf(db, n.id, 2)).toMatchObject({ state: 'APPROVED', record: { revision: 1 } });
    expect(await stateOf(n.id, 3)).toBe('NOT_APPROVED');
    expect(await stateOf(n.id, 4)).toBe('NOT_APPROVED');
    // The newest revision an approval was in force at; its text is the approved text.
    const found = await newest(n.id);
    expect(found).toMatchObject({ revNo: 2, source: 'snapshot', record: { revision: 1 } });
    expect((await db.nodeRevision.findFirstOrThrow({ where: { nodeId: n.id, revNo: found!.revNo } })).content).toBe('A');
  });

  it('a non-content revision made after the approval ENDED (a content change came first) is not approved', async () => {
    const n = await mk('m:3', 'A');
    await approve(n.id); // rev 1
    await edit(n.id, 'B'); // rev 2: ends the approval
    await tag(n.id, ['x']); // rev 3: non-content, but nothing is in force
    await edit(n.id, 'C'); // rev 4
    expect(await stateOf(n.id, 2)).toBe('NOT_APPROVED');
    expect(await stateOf(n.id, 3)).toBe('NOT_APPROVED');
    expect(await newest(n.id)).toMatchObject({ revNo: 1 });
  });

  it('the approved text coming back and THEN a non-content write: neither revision\'s row carries the old approval', async () => {
    const n = await mk('m:6', 'A');
    await approve(n.id); // rev 1
    await edit(n.id, 'B'); // rev 2: ends the approval
    await edit(n.id, 'A'); // rev 3: the approved text again, nothing in force
    await tag(n.id, ['x']); // rev 4: captures rev 3
    await edit(n.id, 'C'); // rev 5: captures rev 4
    const rows = await db.nodeRevision.findMany({ where: { nodeId: n.id, revNo: { in: [3, 4] } } });
    expect(rows.map((r) => [r.content, r.approvalHash, r.approvedAt, r.approvedRevNo])).toEqual([['A', null, null, null], ['A', null, null, null]]);
    expect(await stateOf(n.id, 3)).toBe('NOT_APPROVED');
    expect(await stateOf(n.id, 4)).toBe('NOT_APPROVED');
    expect(await newest(n.id)).toMatchObject({ revNo: 1 });
  });

  it('a move inside the memory and a role change keep it in force, like tags', async () => {
    const n = await mk('m:4', 'A');
    await approve(n.id); // rev 1
    await resolvers.Mutation.updateNode(null, { input: { ref: n.id, role: 'note' } }, as()); // rev 2
    await resolvers.Mutation.moveNode(null, { sourceRef: n.id, targetUrn: `hrn:node:${memory.urn.replace(/^hrn:mem:/, '')}:moved:m4` }, as()); // rev 3
    const live = await liveRev(n.id);
    expect(live).toBeGreaterThan(1);
    expect(await newest(n.id)).toMatchObject({ revNo: live, source: 'live', record: { revision: 1 } });
    await edit(n.id, 'B');
    expect(await newest(n.id)).toMatchObject({ revNo: live, source: 'snapshot', record: { revision: 1 } });
  });

  it('with the approved revision\'s own row gone, the standing approval still answers for the live revision', async () => {
    const n = await mk('m:5', 'A');
    await approve(n.id); // rev 1
    await tag(n.id, ['x']); // rev 2, live
    await resolvers.Mutation.clearNodeHistory(null, { nodeRef: n.id }, as());
    expect(await db.nodeRevision.count({ where: { nodeId: n.id } })).toBe(0);
    expect(await newest(n.id)).toMatchObject({ revNo: 2, source: 'live', record: { revision: 1 } });
  });
});

describe('#5481 integrity, encryption and capture memory are unchanged', () => {
  it('an approved revision whose stored text no longer hashes to its approval is not approved', async () => {
    const n = await mk('i:1', 'A');
    await approve(n.id);
    await edit(n.id, 'B');
    expect(await stateOf(n.id, 1)).toBe('APPROVED');
    await db.nodeRevision.updateMany({ where: { nodeId: n.id, revNo: 1 }, data: { content: 'tampered' } });
    expect(await stateOf(n.id, 1)).toBe('NOT_APPROVED');
    expect(await newest(n.id)).toBeNull();
  });

  it('a live row altered outside the revision system is not approved by its standing approval', async () => {
    const n = await mk('i:2', 'A');
    await approve(n.id);
    await db.$executeRaw`UPDATE nodes SET content = 'altered' WHERE id = ${n.id}`;
    expect(await stateOf(n.id, 1)).toBe('NOT_APPROVED');
  });

  it('an encrypted memory reads NOT_APPLICABLE and selects nothing', async () => {
    const n = await table('i:3');
    await db.memory.update({ where: { id: memory.id }, data: { isEncrypted: true, vectorIndexEnabled: false } });
    expect(await stateOf(n.id, 2)).toBe('NOT_APPLICABLE');
    expect(await newest(n.id)).toBeNull();
  });

  it('a revision captured in another memory answers NOT_APPROVED to a caller that serves from this one, before any text is charged', async () => {
    const n = await table('i:4');
    const other = await resolvers.Mutation.createMemory(null, { orgRef: orgId, name: 'elsewhere' }, as());
    await db.nodeRevision.updateMany({ where: { nodeId: n.id, revNo: 2 }, data: { memoryId: other.id } });
    const charged: Array<string | null | undefined> = [];
    const meter = { chargeLookup: () => {}, chargeLoaded: (t: string | null | undefined) => { charged.push(t); } };
    const verdict = await revisionApprovalOf(db, n.id, 2, meter, memory.id);
    expect(verdict).toEqual({ state: 'NOT_APPROVED', record: null });
    expect(charged).not.toContain('B');
    // And the newest-approved walk never selects it: revision 1 is the newest one servable from this memory.
    expect(await newest(n.id)).toMatchObject({ revNo: 1 });
  });
});

describe('#5481 a history row is judged by what it carries, and by nothing it cannot carry', () => {
  it('a row that names a revision ABOVE its own as the one its approval was recorded at is not approved', async () => {
    const n = await mk('c:1', 'A');
    await edit(n.id, 'B'); // rev 2; row 1 holds A and carries nothing
    const hash = computeApprovalHash({ title: 'Title c:1', abstract: null, content: 'A' });
    const record = { approvedByInfo: 'test', approvedAt: new Date(), approvalHash: hash };
    await db.nodeRevision.updateMany({ where: { nodeId: n.id, revNo: 1 }, data: { ...record, approvedRevNo: 5 } });
    expect(await stateOf(n.id, 1)).toBe('NOT_APPROVED');
    // control: the same row naming its own revision (or none) is approved, and reports that revision.
    await db.nodeRevision.updateMany({ where: { nodeId: n.id, revNo: 1 }, data: { approvedRevNo: 1 } });
    expect(await revisionApprovalOf(db, n.id, 1)).toMatchObject({ state: 'APPROVED', record: { revision: 1 } });
    await db.nodeRevision.updateMany({ where: { nodeId: n.id, revNo: 1 }, data: { approvedRevNo: null } });
    expect(await revisionApprovalOf(db, n.id, 1)).toMatchObject({ state: 'APPROVED', record: { revision: 1 } });
  });

  it('the row written for a non-content revision names the revision the approval was recorded at, with the original approver and time', async () => {
    const n = await mk('c:2', 'A');
    await approve(n.id); // rev 1
    const approvedAt = (await db.node.findUniqueOrThrow({ where: { id: n.id } })).approvedAt;
    await tag(n.id, ['x']); // rev 2
    await tag(n.id, ['y']); // rev 3
    const rows = await db.nodeRevision.findMany({ where: { nodeId: n.id }, orderBy: { revNo: 'asc' } });
    expect(rows.map((r) => [r.revNo, r.approvedRevNo, r.approvedBy, r.approvedAt?.getTime(), r.approvalHash != null])).toEqual([
      [1, null, admin.id, approvedAt!.getTime(), true],
      [2, 1, admin.id, approvedAt!.getTime(), true],
    ]);
  });

  it('a plain pin is warned as prunable on a revision that only carries an approval forward, not on the one it was recorded at', async () => {
    const n = await mk('pinned', 'A');
    await approve(n.id); // rev 1
    await tag(n.id, ['x']); // rev 2
    await edit(n.id, 'B'); // rev 3; row 2 carries revision 1's approval forward
    const historyReader: Context = { db, userId: admin.id, roles: ['READER'] }; // the advice is for a history reader
    expect(await plainPinWarnings(historyReader, { memoryId: memory.id }, '{{> pinned rev=1}}')).toEqual([]);
    expect(await plainPinWarnings(historyReader, { memoryId: memory.id }, '{{> pinned rev=2}}')).toMatchObject([{ code: 'include.pin.unkept' }]);
    // control: a revision that carries nothing is warned the same way.
    await edit(n.id, 'C'); // rev 4; row 3 holds B and carries nothing
    expect(await plainPinWarnings(historyReader, { memoryId: memory.id }, '{{> pinned rev=3}}')).toMatchObject([{ code: 'include.pin.unkept' }]);
  });
});

describe('#5481 pruning keeps the revision the serve picks', () => {
  it('a prune after the table leaves revision 2 in place and selected', async () => {
    await db.memory.update({ where: { id: memory.id }, data: { maxRevCount: 2 } });
    const n = await table('p:1');
    for (let i = 0; i < 6; i++) await edit(n.id, `more ${i}`);
    const kept = (await db.nodeRevision.findMany({ where: { nodeId: n.id }, select: { revNo: true } })).map((r) => r.revNo);
    expect(kept).toContain(2);
    expect(kept).not.toContain(4); // the unapproved repeat of A is ordinary history
    expect(kept.length).toBeLessThan(8); // ordinary history still prunes
    expect([...await revisionsExemptFromPruning(db, n.id, memory.id)]).toContain(2);
    expect(await newest(n.id)).toMatchObject({ revNo: 2, source: 'snapshot' });
  });

  it('non-content revisions under a standing approval do not pile up: only the record\'s own revision and the newest approved are kept', async () => {
    await db.memory.update({ where: { id: memory.id }, data: { maxRevCount: 2 } });
    const n = await mk('p:2', 'A');
    await approve(n.id); // rev 1
    for (let i = 0; i < 8; i++) await tag(n.id, [`t${i}`]); // revs 2..9, all in force
    await edit(n.id, 'B'); // rev 10, unapproved: rev 9 is the newest approved
    for (let i = 0; i < 4; i++) await edit(n.id, `more ${i}`);
    const kept = (await db.nodeRevision.findMany({ where: { nodeId: n.id }, select: { revNo: true }, orderBy: { revNo: 'asc' } })).map((r) => r.revNo);
    expect(kept).toContain(1); // the revision the approval was recorded at
    expect(kept).toContain(9); // the newest approved revision
    expect(kept.filter((r) => r != null && r > 1 && r < 9)).toEqual([]);
    expect(await newest(n.id)).toMatchObject({ revNo: 9, record: { revision: 1 } });
  });
});
