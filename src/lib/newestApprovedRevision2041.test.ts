/**
 * #2041 (cor:dmo:150:05) — newestApprovedRevisionOf: the newest revision the
 * #1838 predicate reads APPROVED; a newer unapproved edit is skipped.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../integrations/db/client.js';
import { cleanDb } from '../test/helpers.js';
import { generateId } from './id.js';
import { endApprovalsOnEncryptedEntry, newestApprovedRevisionOf } from './nodeApproval.js';
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
    expect(await newestApprovedRevisionOf(db, n.id, 1)).toEqual({ found: null, truncated: true });
    expect((await newestApprovedRevisionOf(db, n.id, 3)).found).toMatchObject({ revNo: 1 });
  });
});
