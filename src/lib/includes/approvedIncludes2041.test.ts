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
import { createTestableMcpServer } from '../../mcp/server.js';
import * as nodeApproval from '../nodeApproval.js';

// Wrapped (not replaced) so a drift test can mutate the carrier right after the selector returns.
vi.mock('../nodeApproval.js', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../nodeApproval.js')>();
  return { ...orig, newestApprovedRevisionOf: vi.fn(orig.newestApprovedRevisionOf) };
});

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

  it('an approved target with empty (null) content serves the empty text, not the notice (pinned and unpinned)', async () => {
    const hash = computeApprovalHash({ title: 'e', abstract: null, content: null });
    await db.node.create({ data: { id: generateId(), memoryId, loc: 'e', name: 'e', content: null, revSeq: 1, approvedRevNo: 1, approvedBy: reader.id, approvedAt: new Date(), approvalHash: hash } });
    await includer('[{{> e approved}}][{{> e rev=1 approved}}]');
    expect(await read('inc')).toBe('[][]');
  });

  it('R50: after the newest approved revision is deliberately deleted, a fresh resolution serves the next approved one; none left is the notice', async () => {
    const t = await target('t', ['v1', 'v2', 'v3 draft'], [1, 2]);
    await includer('{{> t approved}}');
    expect(await read('inc')).toBe('v2');
    await db.nodeRevision.deleteMany({ where: { nodeId: t.id, revNo: 2 } });
    expect(await read('inc')).toBe('v1');
    await db.nodeRevision.deleteMany({ where: { nodeId: t.id, revNo: 1 } });
    expect(await read('inc')).toBe(N);
  });

  it('a snapshot captured in another memory is never served (foreign carrier)', async () => {
    const t = await target('t', ['v1', 'v2 draft'], [1]);
    const other = await db.memory.create({ data: { name: 'Elsewhere', urn: 'ap.example:elsewhere', organizationId: (await db.memory.findUniqueOrThrow({ where: { id: memoryId } })).organizationId, class: 'knowledge', visibility: 'ORGANIZATION' } });
    await db.nodeRevision.updateMany({ where: { nodeId: t.id, revNo: 1 }, data: { memoryId: other.id } });
    await includer('{{> t approved}} {{> t rev=1 approved}}');
    expect(await read('inc')).toBe(`${N} ${N}`);
  });

  it('a hashless approval record is not an approval (hashless carrier)', async () => {
    const t = await target('t', ['v1', 'v2 draft'], [1]);
    await db.nodeRevision.updateMany({ where: { nodeId: t.id, revNo: 1 }, data: { approvalHash: null } });
    await includer('{{> t approved}}');
    expect(await read('inc')).toBe(N);
  });

  it('an unreadable target is the same notice even when it is approved (access negative)', async () => {
    const org = await db.organization.create({ data: { id: generateId(), name: 'Ap Other', urn: 'apother.example' } });
    const fm = await db.memory.create({ data: { name: 'Foreign', urn: 'apother.example:foreign', organizationId: org.id, class: 'knowledge', visibility: 'ORGANIZATION' } });
    const hash = computeApprovalHash({ title: 'secret', abstract: null, content: 'FOREIGN_APPROVED' });
    await db.node.create({ data: { id: generateId(), memoryId: fm.id, loc: 'secret', name: 'secret', content: 'FOREIGN_APPROVED', revSeq: 1, approvedRevNo: 1, approvedBy: reader.id, approvedAt: new Date(), approvalHash: hash } });
    await includer(`{{> hrn:node:${fm.urn}:secret approved}}`);
    expect(await read('inc')).toBe(N);
  });

  it('an encrypted target renders the notice (approval does not apply inside an encrypted memory)', async () => {
    const { sessionKeyCache } = await import('../sessionKeyCache.js');
    const { generateDataKey } = await import('../crypto.js');
    const { encryptNodeFields } = await import('../nodeCrypto.js');
    const org = await db.organization.findFirstOrThrow({ where: { urn: 'ap.example' } });
    const enc = await db.memory.create({ data: { name: 'sealed', urn: 'ap.example:sealed', organizationId: org.id, class: 'knowledge', visibility: 'ORGANIZATION', isEncrypted: true } });
    sessionKeyCache.set('ap-session', enc.id, generateDataKey());
    const sealed = encryptNodeFields({ content: 'SEALED_APPROVED' }, { id: enc.id, isEncrypted: true });
    await db.node.create({ data: { id: generateId(), memoryId: enc.id, loc: 'vault', name: 'vault', content: sealed.content, revSeq: 1, approvedRevNo: 1, approvedBy: reader.id, approvedAt: new Date(), approvalHash: computeApprovalHash({ title: 'vault', abstract: null, content: 'SEALED_APPROVED' }) } });
    await includer(`{{> hrn:node:${enc.urn}:vault approved}}`);
    try {
      expect(await read('inc')).toBe(N);
    } finally {
      sessionKeyCache.clear();
    }
  });

  describe('selector-to-retrieval drift (the served text is the text that qualified)', () => {
    const afterSelector = (mutate: () => Promise<unknown>) => {
      const orig = vi.mocked(nodeApproval.newestApprovedRevisionOf).getMockImplementation()!;
      vi.mocked(nodeApproval.newestApprovedRevisionOf).mockImplementationOnce(async (...a) => {
        const r = await orig(...a);
        await mutate();
        return r;
      });
    };

    it('a selected snapshot whose text is changed after selection is never served', async () => {
      const t = await target('t', ['v1', 'v2', 'v3 draft'], [2]);
      await includer('{{> t approved}}');
      afterSelector(() => db.nodeRevision.updateMany({ where: { nodeId: t.id, revNo: 2 }, data: { content: 'UNAPPROVED_SWAP' } }));
      const out = await read('inc');
      expect(out).not.toContain('UNAPPROVED_SWAP');
      expect(out).toBe(N);
    });

    it('a selected snapshot replaced by an unapproved one is never served', async () => {
      const t = await target('t', ['v1', 'v2', 'v3 draft'], [2]);
      await includer('{{> t approved}}');
      afterSelector(async () => {
        await db.nodeRevision.deleteMany({ where: { nodeId: t.id, revNo: 2 } });
        await db.nodeRevision.create({ data: { id: generateId(), nodeId: t.id, memoryId, revNo: 2, loc: 't', name: 't', content: 'REPLACED_UNAPPROVED', tags: [] } });
      });
      const out = await read('inc');
      expect(out).not.toContain('REPLACED_UNAPPROVED');
      expect(out).toBe(N);
    });

    it('a selected snapshot deleted after selection renders the notice, not another revision', async () => {
      const t = await target('t', ['v1', 'v2', 'v3 draft'], [1, 2]);
      await includer('{{> t approved}}');
      afterSelector(() => db.nodeRevision.deleteMany({ where: { nodeId: t.id, revNo: 2 } }));
      expect(await read('inc')).toBe(N);
    });
  });

  describe('transports: MCP and nodeExport(full:false) serve the same qualified text', () => {
    it('hadron_get_node and nodeExport full:false', async () => {
      await target('t', ['v1', 'v2 draft'], [1]);
      const inc = await includer('x {{> t approved}} y');
      const mcp = createTestableMcpServer({ userId: reader.id, roles: [], clientId: `user:${reader.id}` });
      const text = await mcp.callToolText('hadron_get_node', { urn: `hrn:node:${(await db.memory.findUniqueOrThrow({ where: { id: memoryId } })).urn}:inc` });
      expect(text).toContain('x v1 y');
      const exp = await resolvers.Query.nodeExport({}, { id: inc.id, full: false }, ctx());
      expect(exp.data).toContain('x v1 y');
      expect(exp.data).not.toContain('v2 draft');
    });
  });
});
