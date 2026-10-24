/** #1591: approving a node's current revision, its status reads, and the tamper check. */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { GraphQLError } from 'graphql';
import { db } from '../integrations/db/client.js';
import { cleanDb } from '../test/helpers.js';
import { waitForLockWaitersOfType } from '../test/lockWait.js';
import { generateId } from './id.js';
import { computeApprovalHash } from './approvalHash.js';
import type { NodeApprovalState } from './nodeApproval.js';
import {
  buildNodeRevisionSnapshot,
  createNodeRevision,
  revisionStateHashRefreshMarker,
} from './nodeRevisionSnapshot.js';
import { resolvers, type Context } from '../api/graphql/schema/resolvers.js';
import { isCiphertext, parseDataKey } from './crypto.js';
import { sessionKeyCache } from './sessionKeyCache.js';
import { createTestableMcpServer } from '../mcp/server.js';

vi.mock('../integrations/github/writeNodeToGit.js', () => ({
  writeNodeToGit: vi.fn().mockResolvedValue(undefined),
}));

let admin: { id: string; handle: string | null };
let writer: { id: string };
let reader: { id: string };
let outsider: { id: string };
let memory: { id: string; urn: string };

const as = (userId = admin.id): Context => ({ db, userId, roles: [] });
const node = (loc: string, extra: Record<string, unknown> = {}) => db.node.create({
  data: { id: generateId(), memoryId: memory.id, loc, name: `Title ${loc}`, abstract: `Abstract ${loc}`, content: `Body ${loc}`, ...extra },
});
const approve = (nodeRef: string, opts: { revision?: number; userId?: string } = {}) =>
  resolvers.Mutation.approveNode(null, { nodeRef, revision: opts.revision }, as(opts.userId));
const approveAll = (userId = admin.id) =>
  resolvers.Mutation.approveMemoryNodes(null, { memoryRef: memory.id }, as(userId));
const verify = (nodeRef: string, userId = admin.id) => resolvers.Query.verifyNode(null, { nodeRef }, as(userId));
const statusOf = async (id: string) => {
  const row = await db.node.findUniqueOrThrow({ where: { id } });
  return resolvers.Node.approvalStatus(row, {}, as());
};
const edit = (id: string, content: string) =>
  resolvers.Mutation.updateNode(null, { input: { id, content } }, as());
const codeOf = async (p: Promise<unknown>) => {
  try { await p; return 'NO_ERROR'; } catch (e) {
    return e instanceof GraphQLError ? String(e.extensions.code) : (e as Error).message;
  }
};
const hashOf = (n: { name: string; abstract: string | null; content: string | null }) =>
  computeApprovalHash({ title: n.name, abstract: n.abstract, content: n.content });

beforeEach(async () => {
  await cleanDb(db);
  const org = await db.organization.create({ data: { id: generateId(), name: 'Approve Org', urn: 'approve.example' } });
  admin = await db.user.create({ data: { githubId: 159101, githubUsername: 'approve-admin', handle: 'approve-admin', roles: [] } });
  writer = await db.user.create({ data: { githubId: 159102, githubUsername: 'approve-writer', roles: [] } });
  reader = await db.user.create({ data: { githubId: 159103, githubUsername: 'approve-reader', roles: [] } });
  outsider = await db.user.create({ data: { githubId: 159104, githubUsername: 'approve-outsider', roles: [] } });
  await db.orgMember.createMany({ data: [
    { organizationId: org.id, userId: admin.id, role: 'ADMIN' },
    { organizationId: org.id, userId: writer.id, role: 'CONTRIBUTOR' },
    { organizationId: org.id, userId: reader.id, role: 'READER' },
  ] });
  memory = await resolvers.Mutation.createMemory(null, { orgId: org.id, name: 'approvals' }, as());
});

describe('approveNode (#1591)', () => {
  it('records who, when and the approval hash of the current revision, without touching updatedAt', async () => {
    const n = await node('a:1');
    const receipt = await approve(n.id);
    expect(receipt.loc).toBe('a:1');
    expect(receipt.approval).toMatchObject({ revision: 1, approvedBy: admin.id, approvedByInfo: null, hash: hashOf(n) });
    const row = await db.node.findUniqueOrThrow({ where: { id: n.id } });
    expect(row.updatedAt).toEqual(n.updatedAt);
    expect(row.revSeq).toBe(1);
    const status = await statusOf(n.id);
    expect(status.state).toBe('APPROVED');
    expect(status.approval?.revision).toBe(1);
  });

  it('lets any writer approve, the author included, and refuses a reader and an outsider', async () => {
    const authored = await node('a:1', { createdBy: writer.id });
    expect(await codeOf(approve(authored.id, { userId: writer.id }))).toBe('NO_ERROR');
    const other = await node('a:2');
    expect(await codeOf(approve(other.id, { userId: reader.id }))).toBe('FORBIDDEN');
    expect(await codeOf(approve(other.id, { userId: outsider.id }))).toBe('NODE_NOT_FOUND');
    expect((await statusOf(other.id)).state).toBe('NOT_APPROVED');
  });

  it('is idempotent: a second approval keeps the first approver and time', async () => {
    const n = await node('a:1');
    const first = await approve(n.id);
    const second = await approve(n.id, { userId: writer.id });
    expect(second.approval).toEqual(first.approval);
  });

  it('refuses REVISION_MISMATCH when the revision read is no longer current', async () => {
    const n = await node('a:1');
    await edit(n.id, 'changed');
    expect(await codeOf(approve(n.id, { revision: 1 }))).toBe('REVISION_MISMATCH');
    expect((await approve(n.id, { revision: 2 })).approval.revision).toBe(2);
  });

  it('refuses a reserved placeholder', async () => {
    const n = await node('a:1', { isPlaceholder: true, content: null });
    expect(await codeOf(approve(n.id))).toBe('NODE_IS_PLACEHOLDER');
  });

  it('an edit after approval supersedes it, and the approved revision keeps its approval in history', async () => {
    const n = await node('a:1');
    const { approval } = await approve(n.id);
    await edit(n.id, 'changed');
    const status = await statusOf(n.id);
    expect(status.state).toBe('SUPERSEDED');
    expect(status.approval?.revision).toBe(1);
    const history = await db.nodeRevision.findFirstOrThrow({ where: { nodeId: n.id, revNo: 1 } });
    expect(history).toMatchObject({ approvedBy: admin.id, approvalHash: approval.hash });
    expect(history.approvedAt).toEqual(approval.approvedAt);
    // A later edit of the unapproved revision 2 carries no approval into history.
    await edit(n.id, 'changed again');
    const rev2 = await db.nodeRevision.findFirstOrThrow({ where: { nodeId: n.id, revNo: 2 } });
    expect(rev2.approvalHash).toBeNull();
    expect(rev2.approvedAt).toBeNull();
  });

  it('keeps the approval of record on the node when revision history is cleared', async () => {
    const n = await node('a:1');
    await approve(n.id);
    await edit(n.id, 'changed');
    await resolvers.Mutation.clearNodeHistory(null, { nodeRef: n.id }, as());
    expect((await statusOf(n.id)).approval?.revision).toBe(1);
  });
});

describe('approve racing an edit (#1591)', () => {
  /** Hold the node row in a revisioned edit until released, as an in-flight writer would. */
  const holdEdit = async (id: string, content: string) => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    let locked!: () => void;
    const isLocked = new Promise<void>((r) => { locked = r; });
    const done = db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM nodes WHERE id = ${id} FOR UPDATE`;
      const current = await tx.node.findUniqueOrThrow({ where: { id } });
      await createNodeRevision(tx, { id: generateId(), ...buildNodeRevisionSnapshot(current, { userId: admin.id }, { changes: ['content'] }) });
      await tx.node.update({ where: { id }, data: { content, revisionContentHash: revisionStateHashRefreshMarker() } });
      locked();
      await gate;
    }, { timeout: 20_000 });
    await isLocked;
    return { release, done };
  };

  it('an approval of the revision read refuses when an edit commits first', async () => {
    const n = await node('a:1');
    const held = await holdEdit(n.id, 'edited meanwhile');
    const approving = codeOf(approve(n.id, { revision: 1 }));
    await waitForLockWaitersOfType(db, 'transactionid');
    held.release();
    await held.done;
    expect(await approving).toBe('REVISION_MISMATCH');
    expect((await statusOf(n.id)).state).toBe('NOT_APPROVED');
  });

  it('an unguarded approval waits and approves the edited revision with its own hash', async () => {
    const n = await node('a:1');
    const held = await holdEdit(n.id, 'edited meanwhile');
    const approving = approve(n.id);
    await waitForLockWaitersOfType(db, 'transactionid');
    held.release();
    await held.done;
    const { approval } = await approving;
    expect(approval.revision).toBe(2);
    expect(approval.hash).toBe(hashOf({ ...n, content: 'edited meanwhile' }));
    expect((await verify(n.id)).state).toBe('INTACT');
  });
});

describe('the re-read under the lock is pinned to a live row in the gated memory (PR #1592 review)', () => {
  it('refuses NODE_NOT_FOUND, stamping nothing, when a soft delete commits while approve waits on the row', async () => {
    const n = await node('a:1');
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    let locked!: () => void;
    const isLocked = new Promise<void>((r) => { locked = r; });
    const deleting = db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM nodes WHERE id = ${n.id} FOR UPDATE`;
      await tx.node.update({ where: { id: n.id }, data: { deletedAt: new Date() } });
      locked();
      await gate;
    }, { timeout: 20_000 });
    await isLocked;
    // Passes the live-node precheck (the delete is not committed), then waits.
    const approving = codeOf(approve(n.id));
    await waitForLockWaitersOfType(db, 'transactionid');
    release();
    await deleting;
    expect(await approving).toBe('NODE_NOT_FOUND');
    expect(await db.node.findUniqueOrThrow({ where: { id: n.id } })).toMatchObject({ approvedRevNo: null, approvalHash: null });
  });

  it('verifyNode answers NODE_NOT_FOUND, disclosing nothing, when the node moves to an unreadable memory after the gate', async () => {
    const n = await node('a:1');
    const hidden = await db.memory.create({ data: {
      id: generateId(), urn: 'approve.example:hidden', name: 'hidden', class: 'private',
      userId: outsider.id, ownerUserId: outsider.id,
    } });
    // Move the node right after verifyNode's read gate passes: the next thing
    // it does is look up the memory's encryption flag.
    const moveOnce = { done: false };
    const interleaved = new Proxy(db, {
      get(target, prop, receiver) {
        if (prop !== 'memory') return Reflect.get(target, prop, receiver);
        return new Proxy(target.memory, {
          get(m, mp, mr) {
            if (mp !== 'findUniqueOrThrow') return Reflect.get(m, mp, mr);
            return async (args: Parameters<typeof m.findUniqueOrThrow>[0]) => {
              if (!moveOnce.done) {
                moveOnce.done = true;
                await db.node.update({ where: { id: n.id }, data: { memoryId: hidden.id, content: 'private text' } });
              }
              return m.findUniqueOrThrow(args);
            };
          },
        });
      },
    }) as typeof db;
    const code = await codeOf(resolvers.Query.verifyNode(null, { nodeRef: n.id }, { db: interleaved, userId: admin.id, roles: [] }));
    expect(moveOnce.done).toBe(true);
    expect(code).toBe('NODE_NOT_FOUND');
  });
});

describe('approveMemoryNodes (#1591)', () => {
  it('approves every unapproved live node, skips placeholders, and leaves approved ones alone', async () => {
    const a = await node('a:1');
    const b = await node('a:2');
    await node('a:3', { isPlaceholder: true, content: null });
    await node('a:4', { deletedAt: new Date() });
    const first = await approve(a.id, { userId: writer.id });

    // createMemory made the memory's root node, which is live and unapproved too.
    const result = await approveAll();
    expect(result.approvedCount).toBe(2);
    expect(result.approved.map((r: { loc: string }) => r.loc)).toEqual(['a:2', 'approvals']);
    expect(result.alreadyApprovedCount).toBe(1);
    expect(result.skippedPlaceholders).toEqual(['a:3']);
    expect((await statusOf(b.id)).state).toBe('APPROVED');
    expect((await statusOf(a.id)).approval).toEqual(first.approval);

    const again = await approveAll();
    expect(again).toMatchObject({ approvedCount: 0, alreadyApprovedCount: 3 });
  });

  it('refuses a reader as forbidden and an outsider as a missing memory', async () => {
    await node('a:1');
    expect(await codeOf(approveAll(reader.id))).toBe('FORBIDDEN');
    expect(await codeOf(approveAll(outsider.id))).not.toBe('NO_ERROR');
    expect(await db.node.count({ where: { memoryId: memory.id, approvedRevNo: { not: null } } })).toBe(0);
  });
});

describe('verifyNode / verifyMemoryNodes (#1591)', () => {
  it('reports NOT_APPROVED, INTACT and SUPERSEDED for the ordinary lifecycle', async () => {
    const n = await node('a:1');
    expect((await verify(n.id)).state).toBe('NOT_APPROVED');
    await approve(n.id);
    const intact = await verify(n.id);
    expect(intact).toMatchObject({ state: 'INTACT', revision: 1, approvedRevision: 1 });
    expect(intact.actualHash).toBe(intact.expectedHash);
    await edit(n.id, 'a reviewed change');
    expect((await verify(n.id)).state).toBe('SUPERSEDED');
  });

  it('reports TAMPERED for a change made outside the revision system, before and after a reconciling read', async () => {
    const n = await node('a:1');
    await approve(n.id);
    await db.$executeRaw`UPDATE nodes SET content = 'quietly changed' WHERE id = ${n.id}`;
    expect((await verify(n.id)).state).toBe('TAMPERED');

    // The status read reconciles the drift into a new revision by itself, so
    // the changed text never reads as approved. The tamper finding must
    // survive that: the snapshot of the approved revision holds the changed text.
    expect((await statusOf(n.id)).state).toBe('SUPERSEDED');
    expect((await db.node.findUniqueOrThrow({ where: { id: n.id } })).revSeq).toBe(2);
    expect((await verify(n.id)).state).toBe('TAMPERED');
  });

  it('detects a tampered title and abstract, not only content', async () => {
    const t = await node('a:1');
    const ab = await node('a:2');
    await approveAll();
    await db.$executeRaw`UPDATE nodes SET name = 'Renamed' WHERE id = ${t.id}`;
    await db.$executeRaw`UPDATE nodes SET abstract = NULL WHERE id = ${ab.id}`;
    expect((await verify(t.id)).state).toBe('TAMPERED');
    expect((await verify(ab.id)).state).toBe('TAMPERED');
  });

  it('ignores fields outside the hash: tags, role and properties', async () => {
    const n = await node('a:1');
    await approve(n.id);
    await db.$executeRaw`UPDATE nodes SET tags = ARRAY['x'], role = 'spec', properties = '{"k":1}'::jsonb WHERE id = ${n.id}`;
    expect((await verify(n.id)).state).toBe('INTACT');
  });

  it('summarizes a memory, listing every node that is not intact', async () => {
    const ok = await node('a:1');
    const bad = await node('a:2');
    await node('a:3');
    await approve(ok.id);
    await approve(bad.id);
    await db.$executeRaw`UPDATE nodes SET content = 'x' WHERE id = ${bad.id}`;
    const report = await resolvers.Query.verifyMemoryNodes(null, { memoryRef: memory.id }, as());
    // Plus the memory's root node, never approved.
    expect(report).toMatchObject({ checked: 4, intact: 1, tampered: 1, superseded: 0, notApproved: 2 });
    expect(report.problems.map((p) => [p.loc, p.state])).toEqual([
      ['a:2', 'TAMPERED'], ['a:3', 'NOT_APPROVED'], ['approvals', 'NOT_APPROVED'],
    ]);
  });

  it('is read-gated: an outsider gets NODE_NOT_FOUND, a reader may verify', async () => {
    const n = await node('a:1');
    expect(await codeOf(verify(n.id, outsider.id))).toBe('NODE_NOT_FOUND');
    expect((await verify(n.id, reader.id)).state).toBe('NOT_APPROVED');
  });
});

describe('findNodes approvalState filter (#1591)', () => {
  it('selects APPROVED, SUPERSEDED and NOT_APPROVED nodes', async () => {
    const approved = await node('a:1');
    const superseded = await node('a:2');
    await node('a:3');
    await approve(approved.id);
    await approve(superseded.id);
    await edit(superseded.id, 'changed');
    const locsFor = async (approvalState: NodeApprovalState, opts: { query?: string; viaSql?: boolean; limit?: number } = {}) => {
      const res = await resolvers.Query.findNodes(null, {
        ...(opts.query ? { query: opts.query, mode: 'keyword' } : {}),
        ...(opts.limit ? { limit: opts.limit } : {}),
        // A `where` predicate routes the no-query browse through the SQL path.
        filter: {
          memoryIds: [memory.id], approvalState,
          ...(opts.viaSql ? { where: { path: ['k'], eq: 'v' } } : {}),
        },
      }, as());
      // The memory's root node is never approved; leave it out of the comparison.
      return res.hits.map((h: { node: { loc: string } }) => h.node.loc).filter((l: string) => l !== 'approvals').sort();
    };
    expect(await locsFor('APPROVED')).toEqual(['a:1']);
    expect(await locsFor('SUPERSEDED')).toEqual(['a:2']);
    expect(await locsFor('NOT_APPROVED')).toEqual(['a:3']);
    // The keyword path and the SQL browse path apply the same predicate.
    expect(await locsFor('APPROVED', { query: 'Title' })).toEqual(['a:1']);
    await db.node.updateMany({ where: { memoryId: memory.id }, data: { properties: { k: 'v' } } });
    expect(await locsFor('APPROVED', { viaSql: true })).toEqual(['a:1']);
    expect(await locsFor('SUPERSEDED', { viaSql: true })).toEqual(['a:2']);
    expect(await locsFor('NOT_APPROVED', { viaSql: true })).toEqual(['a:3']);
    // The SQL page itself is filtered, not only the hydration after it: one
    // row, loc order, must be the first NOT_APPROVED node (a:3), not a:1.
    expect(await locsFor('NOT_APPROVED', { viaSql: true, limit: 1 })).toEqual(['a:3']);
  });
});

describe('approvals on an encrypted memory (#1591)', () => {
  it('refuses encrypted approval and integrity reads, cached key or not, without writes', async () => {
    const enc = await resolvers.Mutation.createMemory(null, {
      orgId: (await db.memory.findUniqueOrThrow({ where: { id: memory.id } })).organizationId!,
      name: 'approvals-encrypted', memoryClass: 'private',
    }, as());
    const n = await db.node.create({data: {id: generateId(), memoryId: enc.id, loc: 'e:1', name: 'Secret', content: 'Hidden body'}});
    const dataKey = Buffer.alloc(32, 7).toString('base64');
    await resolvers.Mutation.encryptMemory(null, { memoryId: enc.id, dataKey }, as());
    const stored = await db.node.findUniqueOrThrow({where: {id: n.id}});
    expect(isCiphertext(stored.content)).toBe(true);
    try {
      for (const cached of [false, true]) {
        sessionKeyCache.clear();
        if (cached) sessionKeyCache.set('approval-test', enc.id, parseDataKey(dataKey));
        expect(await codeOf(approve(n.id))).toBe('ENCRYPTED_MEMORY_NOT_APPLICABLE');
        expect(await codeOf(resolvers.Mutation.approveMemoryNodes(null, {memoryRef: enc.id}, as()))).toBe('ENCRYPTED_MEMORY_NOT_APPLICABLE');
        expect(await codeOf(verify(n.id))).toBe('ENCRYPTED_MEMORY_NOT_APPLICABLE');
        for (const operation of ['mintMemoryNodes', 'mintSpecCorpus'] as const) {
          for (const dryRun of [false, true]) {
            expect(await codeOf(resolvers.Mutation[operation](null, {memoryRef: enc.id, dryRun}, as()))).toBe('SPEC_CORPUS_ENCRYPTED_UNSUPPORTED');
          }
        }
        expect(await db.node.findUniqueOrThrow({where: {id: n.id}})).toEqual(stored);
        expect(await resolvers.Node.approvalStatus(stored, {}, as())).toEqual({state: 'NOT_APPLICABLE', approval: null});
        expect((await resolvers.Node.mintStatus(stored, {}, as())).minted).toBe(false);
        const mcp = createTestableMcpServer({userId:admin.id,roles:[],clientId:`user:${admin.id}`});
        const text = await mcp.callToolText('hadron_get_node',{urn:`hrn:node:${enc.urn}:e:1`});
        expect(text).toContain('Approval: not applicable (encrypted memory)');
        expect(text).toContain('Minted: not applicable (encrypted memory)');

      }
    } finally { sessionKeyCache.clear(); }
  });

  it('hides retained approval metadata from list and by-id encrypted revision reads with and without a key', async () => {
    memory = await resolvers.Mutation.createMemory(null, {
      orgId: (await db.memory.findUniqueOrThrow({where:{id:memory.id}})).organizationId!,
      name:'encrypted-history',memoryClass:'private',
    }, as());
    const n = await node('history');
    await approve(n.id);
    await edit(n.id, 'changed');
    const retained = await db.nodeRevision.findFirstOrThrow({where:{nodeId:n.id,approvalHash:{not:null}}});
    const dataKey = Buffer.alloc(32,9).toString('base64');
    await resolvers.Mutation.encryptMemory(null,{memoryId:memory.id,dataKey},as());
    try {
      for (const cached of [false,true]) {
        sessionKeyCache.clear();
        if(cached) sessionKeyCache.set('history-key',memory.id,parseDataKey(dataKey));
        const ctx: Context = {...as(),roles:['READER']};
        const list = await resolvers.Query.nodeRevisions(null,{nodeRef:n.id},ctx);
        const single = await resolvers.Query.nodeRevision(null,{revisionId:retained.id},ctx);
        expect(list.some((r:{id:string})=>r.id===retained.id)).toBe(true);
        for(const r of [...list,single]) {
          expect(r).not.toBeNull();
          expect(r!.approvalHash).toBeNull();
          expect(r!.approvedAt).toBeNull();
          expect(r!.approvedBy).toBeNull();
          expect(r!.approvedByInfo).toBeNull();
        }
      }
      // #1838 (cor:dmo:120:04): entering ended the approval: hash cleared, who/when kept.
      const stored = await db.nodeRevision.findUniqueOrThrow({where:{id:retained.id}});
      expect(stored.approvalHash).toBeNull();
      expect(stored.approvedBy).toBe(retained.approvedBy);
      expect(stored.approvedAt).toEqual(retained.approvedAt);
    } finally {sessionKeyCache.clear();}
  });

  it('rechecks encryption after the initial write authorization', async () => {
    const n = await node('race');
    const before = await db.node.findUniqueOrThrow({where:{id:n.id}});
    const transaction = db.$transaction.bind(db);
    const spy = vi.spyOn(db, '$transaction').mockImplementationOnce(async (...args: any[]) => {
      await db.memory.update({where:{id:memory.id},data:{isEncrypted:true,vectorIndexEnabled:false}});
      return (transaction as any)(...args);
    });
    try {
      expect(await codeOf(approve(n.id))).toBe('ENCRYPTED_MEMORY_NOT_APPLICABLE');
      expect(await db.node.findUniqueOrThrow({where:{id:n.id}})).toEqual(before);
    } finally { spy.mockRestore(); }
  });

  it('ignores retained records in encrypted status and both approval filter paths', async () => {
    const n = await node('retained');
    await approve(n.id);
    await db.node.update({where:{id:n.id},data:{mintedAt:new Date(),mintedHash:'retained',mintedRevNo:1,mintedBy:admin.id}});
    await db.node.update({where:{id:n.id},data:{properties:{marker:'yes'}}});
    await db.memory.update({where:{id:memory.id},data:{isEncrypted:true,vectorIndexEnabled:false}});
    const row = await db.node.findUniqueOrThrow({where:{id:n.id}});
    expect(await resolvers.Node.approvalStatus(row, {}, as())).toEqual({state:'NOT_APPLICABLE',approval:null});
    expect((await resolvers.Node.mintStatus(row, {}, as())).hash).toBeNull();
    const mcp = createTestableMcpServer({userId:admin.id,roles:[],clientId:`user:${admin.id}`});
    const text = await mcp.callToolText('hadron_get_node', {urn:`hrn:node:${memory.urn}:retained`});
    expect(text).toContain('Approval: not applicable (encrypted memory)');
    expect(text).toContain('Minted: not applicable (encrypted memory)');

    for (const viaSql of [false,true]) {
      for (const minted of [false,true]) {
        const result = await resolvers.Query.findNodes(null,{filter:{memoryIds:[memory.id],minted,...(viaSql?{where:{path:['marker'],eq:'yes'}}:{})}},as());
        expect(result.hits.some((h:{node:{id:string}})=>h.node.id===n.id)).toBe(!minted);
      }

      for (const state of ['APPROVED','SUPERSEDED','NOT_APPROVED','NOT_APPLICABLE'] as NodeApprovalState[]) {
        const result = await resolvers.Query.findNodes(null, {filter:{memoryIds:[memory.id],approvalState:state,...(viaSql?{where:{path:['marker'],eq:'yes'}}:{})}}, as());
        expect(result.hits.some((h: {node:{id:string}})=>h.node.id===n.id)).toBe(state==='NOT_APPLICABLE');
      }
    }
  });

});

describe('hadron_get_node Approval line (#1591)', () => {
  const getNode = async (loc: string) => {
    const mcp = createTestableMcpServer({ userId: admin.id, roles: [], clientId: `user:${admin.id}` });
    const text = await mcp.callToolText('hadron_get_node', { urn: `hrn:node:${memory.urn}:${loc}` });
    return text.split('\n').find((line) => line.startsWith('Approval:'));
  };

  it('shows not approved, approved, and superseded with the last approval', async () => {
    const n = await node('a:1');
    expect(await getNode('a:1')).toBe('Approval: not approved (r1)');
    const { approval } = await approve(n.id);
    const record = `r1 by hrn:user:approve-admin at ${approval.approvedAt.toISOString()}`;
    expect(await getNode('a:1')).toBe(`Approval: approved ${record}`);
    await edit(n.id, 'changed');
    expect(await getNode('a:1')).toBe(`Approval: not approved (r2; last approved ${record})`);
  });
});

describe('approve authorizes before checking the session key (@copilot, PR #1592)', () => {
  it('refuses a reader of an encrypted memory as FORBIDDEN, key or no key', async () => {
    const n = await node('a:1');
    // Only the gate order matters here, so flag the org memory encrypted
    // directly (encryptMemory is owner-only, and an org memory has none).
    const dataKey = Buffer.alloc(32, 5).toString('base64');
    await db.memory.update({ where: { id: memory.id }, data: { isEncrypted: true, vectorIndexEnabled: false } });
    sessionKeyCache.clear();
    try {
      expect(await codeOf(approve(n.id, { userId: reader.id }))).toBe('FORBIDDEN');
      sessionKeyCache.set('approval-gate-test', memory.id, parseDataKey(dataKey));
      expect(await codeOf(approve(n.id, { userId: reader.id }))).toBe('FORBIDDEN');
    } finally {
      sessionKeyCache.clear();
    }
  });
});

describe('status reads on a list page (#1596)', () => {
  const APPROVAL_COLUMNS = ['approvedRevNo', 'approvedBy', 'approvedByInfo', 'approvedAt', 'approvalHash'];
  const MINT_COLUMNS = ['mintedAt', 'mintedBy', 'mintedByInfo', 'mintedRevNo', 'mintedHash'];
  /** A parent selected the way a slim list projection would: everything but `columns`. */
  const slimParent = async (id: string, columns: string[]) => {
    const row: Record<string, unknown> = { ...(await db.node.findUniqueOrThrow({ where: { id } })) };
    for (const c of columns) delete row[c];
    return row as Awaited<ReturnType<typeof db.node.findUniqueOrThrow>>;
  };
  const selects = (spy: { mock: { calls: unknown[][] } }, column: string) =>
    spy.mock.calls.filter(([a]) => Object.keys((a as { select?: object })?.select ?? {}).includes(column)).length;

  it('loads the approval columns of a whole page in one query, not one per node', async () => {
    const nodes = await Promise.all(['l:1', 'l:2', 'l:3', 'l:4', 'l:5'].map((loc) => node(loc)));
    await approve(nodes[0].id);
    await approve(nodes[3].id);
    const parents = await Promise.all(nodes.map((n) => slimParent(n.id, APPROVAL_COLUMNS)));
    const findMany = vi.spyOn(db.node, 'findMany');
    const findUnique = vi.spyOn(db.node, 'findUnique');
    try {
      const ctx = as();
      const states = await Promise.all(parents.map((p) => resolvers.Node.approvalStatus(p, {}, ctx)));
      expect(states.map((s) => s.state)).toEqual(['APPROVED', 'NOT_APPROVED', 'NOT_APPROVED', 'APPROVED', 'NOT_APPROVED']);
      expect(states[3].approval?.revision).toBe(1);
      expect(selects(findMany, 'approvedRevNo')).toBe(1);
      expect(selects(findUnique, 'approvedRevNo')).toBe(0);
    } finally {
      findMany.mockRestore();
      findUnique.mockRestore();
    }
  });

  it('skips the revision reconcile for a node with no approval, and still runs it for an approved one', async () => {
    const unapproved = await node('r:1');
    const approved = await node('r:2');
    await approve(approved.id);
    const reconciles = vi.spyOn(db, '$transaction');
    try {
      expect((await statusOf(unapproved.id)).state).toBe('NOT_APPROVED');
      expect(reconciles).not.toHaveBeenCalled();
      expect((await statusOf(approved.id)).state).toBe('APPROVED');
      expect(reconciles).toHaveBeenCalled();
    } finally {
      reconciles.mockRestore();
    }
  });

  it('still reads SUPERSEDED for an approved node changed outside the revision system', async () => {
    const n = await node('r:1');
    await approve(n.id);
    // A raw writer: the stored row moves on without a revision.
    await db.node.update({ where: { id: n.id }, data: { content: 'raw write' } });
    const parent = await slimParent(n.id, APPROVAL_COLUMNS);
    expect((await resolvers.Node.approvalStatus(parent, {}, as())).state).toBe('SUPERSEDED');
  });

  it('loads the mint columns of a whole page in one query', async () => {
    const nodes = await Promise.all(['m:1', 'm:2', 'm:3'].map((loc) => node(loc)));
    await db.node.update({
      where: { id: nodes[1].id },
      data: { mintedAt: new Date(), mintedBy: admin.id, mintedRevNo: 1, mintedHash: 'h' },
    });
    const parents = await Promise.all(nodes.map((n) => slimParent(n.id, MINT_COLUMNS)));
    const findMany = vi.spyOn(db.node, 'findMany');
    const findUnique = vi.spyOn(db.node, 'findUnique');
    try {
      const ctx = as();
      const statuses = await Promise.all(parents.map((p) => resolvers.Node.mintStatus(p, {}, ctx)));
      expect(statuses.map((s) => s.minted)).toEqual([false, true, false]);
      expect(statuses[1]).toMatchObject({ revision: 1, hash: 'h' });
      expect(selects(findMany, 'mintedAt')).toBe(1);
      expect(selects(findUnique, 'mintedAt')).toBe(0);
    } finally {
      findMany.mockRestore();
      findUnique.mockRestore();
    }
  });

  it('pins the fallback to the parent memory: a node moved after the page was read discloses no record', async () => {
    const n = await node('p:1');
    await approve(n.id);
    await db.node.update({
      where: { id: n.id },
      data: { mintedAt: new Date(), mintedBy: admin.id, mintedRevNo: 1, mintedHash: 'h' },
    });
    const approvalParent = await slimParent(n.id, APPROVAL_COLUMNS);
    const mintParent = await slimParent(n.id, MINT_COLUMNS);
    const elsewhere = await db.memory.create({
      data: { id: generateId(), urn: 'approve.example:elsewhere', name: 'elsewhere', class: 'private', userId: outsider.id, ownerUserId: outsider.id },
    });
    await db.node.update({ where: { id: n.id }, data: { memoryId: elsewhere.id } });
    const ctx = as();
    const status = await resolvers.Node.approvalStatus(approvalParent, {}, ctx);
    expect(status).toEqual({ state: 'NOT_APPROVED', approval: null });
    expect((await resolvers.Node.mintStatus(mintParent, {}, ctx)).minted).toBe(false);
  });

  it('opens a new batch in a later tick instead of joining a flushed one', async () => {
    const n = await node('t:1');
    const parent = await slimParent(n.id, APPROVAL_COLUMNS);
    const findMany = vi.spyOn(db.node, 'findMany');
    // A joiner of an already-flushed batch would never settle: fail fast instead.
    const settled = <T>(p: Promise<T>) => Promise.race([
      p, new Promise<never>((_, reject) => setTimeout(() => reject(new Error('batch never settled')), 2000)),
    ]);
    try {
      const ctx = as();
      expect((await settled(resolvers.Node.approvalStatus(parent, {}, ctx))).state).toBe('NOT_APPROVED');
      await approve(n.id);
      // Same request, later tick: a fresh query sees the approval made meanwhile.
      expect((await settled(resolvers.Node.approvalStatus(parent, {}, ctx))).state).toBe('APPROVED');
      expect(selects(findMany, 'approvedRevNo')).toBe(2);
    } finally {
      findMany.mockRestore();
    }
  });

  it('applies each waiter its own memory pin when two parents share an id in one batch', async () => {
    const n = await node('d:1');
    await approve(n.id);
    const parent = await slimParent(n.id, APPROVAL_COLUMNS);
    const findMany = vi.spyOn(db.node, 'findMany');
    try {
      const ctx = as();
      const [own, foreign] = await Promise.all([
        resolvers.Node.approvalStatus(parent, {}, ctx),
        resolvers.Node.approvalStatus({ ...parent, memoryId: generateId() }, {}, ctx),
      ]);
      expect(own.state).toBe('APPROVED');
      expect(foreign).toEqual({ state: 'NOT_APPROVED', approval: null });
      expect(selects(findMany, 'approvedRevNo')).toBe(1);
    } finally {
      findMany.mockRestore();
    }
  });

  it('rejects every waiter of a batch when its query fails, rather than hanging', async () => {
    const nodes = await Promise.all(['f:1', 'f:2'].map((loc) => node(loc)));
    const parents = await Promise.all(nodes.map((n) => slimParent(n.id, MINT_COLUMNS)));
    const findMany = vi.spyOn(db.node, 'findMany').mockRejectedValueOnce(new Error('db down'));
    try {
      const ctx = as();
      const outcomes = await Promise.allSettled(parents.map((p) => resolvers.Node.mintStatus(p, {}, ctx)));
      expect(outcomes.map((o) => o.status)).toEqual(['rejected', 'rejected']);
    } finally {
      findMany.mockRestore();
    }
  });
});
