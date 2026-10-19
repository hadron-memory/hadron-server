/**
 * #2041 — `approved` include settings serve a qualifying revision (cor:dmo:150:02),
 * on top of #2119's `newestApprovedRevisionOf`. RED-FIRST: the approved cases
 * fail on main, where `approved` renders the staged notice.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../../integrations/db/client.js';
import { cleanDb } from '../../test/helpers.js';
import { generateId } from '../id.js';
import { resolvers, type Context } from '../../api/graphql/schema/resolvers.js';
import { computeApprovalHash } from '../approvalHash.js';
import { BROKEN_INCLUDE_NOTICE as N } from './resolveNodeContent.js';

vi.mock('../../integrations/github/writeNodeToGit.js', () => ({
  writeNodeToGit: vi.fn().mockResolvedValue(undefined),
}));

let memoryId: string;
let reader: { id: string };
const ctx = (): Context => ({ db, userId: reader.id, roles: [] });
const read = async (loc: string): Promise<string> => {
  const n = await resolvers.Query.node(null, { ref: loc, memoryId } as never, ctx());
  return (await (resolvers as any).Node.content(n, {}, ctx(), {})) as string;
};

/** A node whose revisions are `texts` (revNo 1..n); the last is live. `approved` lists revNos with a valid approval record. */
async function target(loc: string, texts: string[], approved: number[]) {
  const live = texts.length;
  const approval = (revNo: number) => ({
    approvedBy: reader.id, approvedAt: new Date(), approvalHash: computeApprovalHash({ title: loc, abstract: null, content: texts[revNo - 1] }),
  });
  const liveApproved = approved.includes(live);
  const n = await db.node.create({
    data: {
      id: generateId(), memoryId, loc, name: loc, content: texts[live - 1], revSeq: live,
      ...(liveApproved ? { approvedRevNo: live, ...approval(live) } : {}),
    },
  });
  for (let r = 1; r < live; r++) {
    await db.nodeRevision.create({
      data: {
        id: generateId(), nodeId: n.id, memoryId, revNo: r, loc, name: loc, content: texts[r - 1], tags: [],
        ...(approved.includes(r) ? approval(r) : {}),
      },
    });
  }
  return n;
}
const includer = (content: string) => db.node.create({ data: { id: generateId(), memoryId, loc: 'inc', name: 'inc', content } });

beforeEach(async () => {
  await cleanDb(db);
  const org = await db.organization.create({ data: { id: generateId(), name: 'Ap Org', urn: 'ap.example' } });
  reader = await db.user.create({ data: { githubId: 204201, githubUsername: 'ap-reader', handle: 'ap-reader', roles: [] } });
  await db.orgMember.create({ data: { organizationId: org.id, userId: reader.id, role: 'ADMIN' } });
  const m = await resolvers.Mutation.createMemory(null, { orgId: org.id, name: 'ap' }, ctx());
  memoryId = m.id;
});

describe('`approved` includes (cor:dmo:150:02)', () => {
  it('unpinned: serves the newest approved revision, skipping a newer unapproved edit', async () => {
    await target('t', ['v1', 'v2', 'v3 draft'], [2]);
    await includer('{{> t approved}}');
    expect(await read('inc')).toBe('v2');
  });

  it('unpinned, live revision approved: serves the live text', async () => {
    await target('t', ['v1', 'v2'], [1, 2]);
    await includer('{{> t approved}}');
    expect(await read('inc')).toBe('v2');
  });

  it('rev=N approved: serves N while N was approved, even after a newer revision is approved', async () => {
    await target('t', ['v1', 'v2', 'v3'], [1, 3]);
    await includer('{{> t rev=1 approved}}');
    expect(await read('inc')).toBe('v1');
  });

  it('rev=N approved: N never approved is the notice', async () => {
    await target('t', ['v1', 'v2'], [2]);
    await includer('{{> t rev=1 approved}}');
    expect(await read('inc')).toBe(N);
  });

  it('no revision ever approved is the notice', async () => {
    await target('t', ['v1', 'v2'], []);
    await includer('{{> t approved}}');
    expect(await read('inc')).toBe(N);
  });

  it('approved signed serves as approved (signed is ignored until signing ships)', async () => {
    await target('t', ['v1', 'v2 draft'], [1]);
    await includer('{{> t approved signed}}');
    expect(await read('inc')).toBe('v1');
  });

  it('an approved include of an approved-but-edited-hash target is the notice (altered snapshot is not an approval)', async () => {
    const t = await target('t', ['v1', 'v2 draft'], [1]);
    await db.nodeRevision.updateMany({ where: { nodeId: t.id, revNo: 1 }, data: { content: 'tampered' } });
    await includer('{{> t approved}}');
    expect(await read('inc')).toBe(N);
  });
});
