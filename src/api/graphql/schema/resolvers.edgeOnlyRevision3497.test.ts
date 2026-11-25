/** #3497 / cor:dmo:060:04 / rulings0149+0198: edges are not node revision state. */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { resolvers, type Context } from './resolvers.js';
import { generateId } from '../../../lib/id.js';
import { createNodeRevision, buildNodeRevisionSnapshot } from '../../../lib/nodeRevisionSnapshot.js';
import { lockMemoryConfigExclusive } from '../../../lib/governedRole.js';
import { waitForLockWaitersOfType } from '../../../test/lockWait.js';
import { holdInTransaction } from '../../../test/lockHold.js';
import { deadline, waitBlocked } from '../../../test/lockObserver.js';
vi.mock('../../../integrations/github/writeNodeToGit.js', () => ({ writeNodeToGit: vi.fn().mockResolvedValue(undefined) }));
const M = resolvers.Mutation as any;
let userId: string, memoryId: string, source: any, a: any, b: any;
const ctx = (): Context => ({ db, userId, roles: ['ADMIN'] });
const edges = (target: any) => [{ targetRef: target.id, name: 'uses' }];
const update = (input: Record<string, unknown>) => M.updateNode(null, { input: { ref: source.id, ...input } }, ctx());
async function state() {
 const row = await db.node.findUniqueOrThrow({ where: { id: source.id } });
 return { revision: await resolvers.Node.revision(row as never, {}, ctx()), count: await db.nodeRevision.count({ where: { nodeId: source.id } }),
  edges: await db.edge.findMany({where:{sourceId:source.id,deletedAt:null},select:{targetId:true,name:true},orderBy:{targetId:'asc'}}) };
}
beforeEach(async () => {
 await cleanDb(db);
 const org=await db.organization.create({data:{name:'Edge revision',urn:'edges3497.example'}});
 userId=(await db.user.create({data:{handle:'edges3497-admin',roles:['ADMIN']}})).id;
 await db.orgMember.create({data:{organizationId:org.id,userId,role:'ADMIN'}});
 memoryId=(await db.memory.create({data:{name:'Edges',urn:'edges3497.example:edges',class:'knowledge',organizationId:org.id}})).id;
 [source,a,b]=await Promise.all(['source','a','b'].map(loc=>M.createNode(null,{input:{memoryRef: memoryId,loc,name:loc,content:'original'}},ctx())));
});
describe('#3497 GraphQL inline edges', () => {
 it('changed and identical edge-only writes preserve the exposed revision and history', async () => {
  const before=await state();
  await update({edges:edges(a)});
  expect(await state()).toEqual({...before,edges:[{targetId:a.id,name:'uses'}]});
  await update({edges:edges(a)});
  expect(await state()).toEqual({...before,edges:[{targetId:a.id,name:'uses'}]});
  await update({edges:[]});
  expect(await state()).toEqual(before);
 });
 it('identical inline edges alone append no revision',async()=>{
  await M.createEdge(null,{sourceRef:source.id,targetRef:a.id,name:'uses'},ctx());
  const before=await state();await update({edges:edges(a)});expect(await state()).toEqual(before);
 });
 it('current token is reusable for changed edge sets, stale token writes nothing', async () => {
  const before=await state(); const token=before.revision;
  await update({expectedRevision:token,edges:edges(a)});
  expect(await state()).toEqual({...before,edges:[{targetId:a.id,name:'uses'}]});
  await update({expectedRevision:token,edges:edges(b)});
  expect(await state()).toEqual({...before,edges:[{targetId:b.id,name:'uses'}]});
  await update({content:'advance revision'}); const after=await state();
  expect(after.revision).toBe(token+1);
  await expect(update({expectedRevision:token,edges:edges(a)})).rejects.toMatchObject({extensions:{code:'NODE_WRITE_CONFLICT'}});
  expect(await state()).toEqual(after);
 });
 it.each([false,true])('mixed scalar+edges appends exactly one revision (guarded=%s)',async guarded=>{
  const before=await state();
  await update({content:'changed',edges:edges(a),...(guarded?{expectedRevision:before.revision}:{})});
  const after=await state();expect(after).toEqual({revision:before.revision+1,count:before.count+1,edges:[{targetId:a.id,name:'uses'}]});
  if(guarded){await expect(update({expectedRevision:before.revision,content:'stale',edges:edges(b)})).rejects.toMatchObject({extensions:{code:'NODE_WRITE_CONFLICT'}});expect(await state()).toEqual(after);}
 });
 it('guarded ownerRepo-only change still consumes the token',async()=>{
  const before=await state();await update({expectedRevision:before.revision,ownerRepo:'example/repo'});
  expect(await state()).toEqual({...before,revision:before.revision+1,count:before.count+1});
  await expect(update({expectedRevision:before.revision,ownerRepo:'example/other'})).rejects.toMatchObject({extensions:{code:'NODE_WRITE_CONFLICT'}});
 });
 it('standalone create/update/delete edges remain revision-free',async()=>{
  const before=await state();
  const e=await M.createEdge(null,{sourceRef:source.id,targetRef:a.id,name:'uses'},ctx());
  expect(await state()).toEqual({...before,edges:[{targetId:a.id,name:'uses'}]});
  await M.updateEdge(null,{edgeRef:e.id,name:'needs'},ctx());
  expect(await state()).toEqual({...before,edges:[{targetId:a.id,name:'needs'}]});
  await M.deleteEdge(null,{edgeRef:e.id},ctx());expect(await state()).toEqual(before);
 });
});

/**
 * #3558 B1 + B2 (cor:dmo:060:04, rulings 0149 + 0198): the edge-only exception on a GOVERNED node and under a
 * concurrent writer. An edge-only write is not an authored change: it needs no claim, keeps the stamp, reads
 * no author task; and its token is checked on the locked row, never consumed.
 */
describe('#3558 governed node: edge-only needs no attestation', () => {
 let govMemoryId: string, taskId: string, gov: any, tgt: any, other: any;
 const reader = vi.fn(async (..._a: unknown[]) => true);
 const gctx = (): Context => ({ db, userId, roles: ['ADMIN'], readsAuthorTask: reader as never });
 const claim = () => ({ task: taskId, revision: 1 });
 const gupdate = (input: Record<string, unknown>) => M.updateNode(null, { input: { ref: gov.id, ...input } }, gctx());
 const stamp = (r: any) => ({ k: r.authorshipKind, t: r.authoredByTask, v: r.authoredByRevision, h: r.authoredByHuman, at: r.authoredAt });
 async function gstate() {
  const row = await db.node.findUniqueOrThrow({ where: { id: gov.id } });
  return { stamp: stamp(row), content: row.content, revSeq: row.revSeq, count: await db.nodeRevision.count({ where: { nodeId: gov.id } }),
   edges: await db.edge.findMany({ where: { sourceId: gov.id, deletedAt: null }, select: { targetId: true, name: true }, orderBy: { targetId: 'asc' } }) };
 }
 beforeEach(async () => {
  reader.mockClear(); reader.mockImplementation(async () => true);
  const org = await db.organization.findFirstOrThrow({ where: { urn: 'edges3497.example' } });
  govMemoryId = (await db.memory.create({ data: { name: 'Gov', urn: 'edges3497.example:gov', class: 'knowledge', organizationId: org.id } })).id;
  taskId = (await db.node.create({ data: { id: generateId(), memoryId: govMemoryId, loc: 'task', name: 'Task', isRunnable: true, content: 'instructions' } })).id;
  const configId = (await db.memoryConfig.create({ data: { id: generateId(), memoryId: govMemoryId } })).id;
  await db.nodeRoleRule.create({ data: { id: generateId(), configId, role: 'guide', authorTaskId: taskId, authorTaskRequired: true } });
  const mk = (loc: string, extra: Record<string, unknown> = {}) => M.createNode(null, { input: { memoryRef: govMemoryId, loc, name: loc, content: 'body', ...extra } }, gctx());
  gov = await mk('gov', { role: 'guide', authoredWith: claim() });
  [tgt, other] = await Promise.all([mk('tgt'), mk('other')]);
  reader.mockClear();
 });
 const gedges = (t: any) => [{ targetRef: t.id, name: 'uses' }];

 it('applies with no claim, keeps the exact stamp, appends no revision and never reads the author task', async () => {
  const before = await gstate();
  expect(before.stamp).toMatchObject({ k: 'TASK', t: taskId, v: 1, h: null });
  expect(before.stamp.at).toBeInstanceOf(Date);
  await gupdate({ edges: gedges(tgt) });
  expect(await gstate()).toEqual({ ...before, edges: [{ targetId: tgt.id, name: 'uses' }] });
  await gupdate({ expectedRevision: before.revSeq, edges: gedges(other) });
  expect(await gstate()).toEqual({ ...before, edges: [{ targetId: other.id, name: 'uses' }] });
  expect(reader).not.toHaveBeenCalled();
 });

 it('mixed content + edges: a missing claim refuses with the existing refusal and changes nothing', async () => {
  const before = await gstate();
  await expect(gupdate({ content: 'changed', edges: gedges(tgt) })).rejects.toMatchObject({ extensions: { code: 'AUTHORING_ATTESTATION_MISSING', role: 'guide' } });
  expect(await gstate()).toEqual(before);
 });

 it('mixed content + edges: an unreadable author task refuses with the existing refusal and changes nothing', async () => {
  reader.mockImplementation(async () => false);
  const before = await gstate();
  await expect(gupdate({ content: 'changed', edges: gedges(tgt), authoredWith: claim() })).rejects.toMatchObject({ extensions: { code: 'AUTHOR_TASK_BROKEN', role: 'guide' } });
  expect(reader).toHaveBeenCalled();
  expect(await gstate()).toEqual(before);
 });

 it('mixed content + edges: a readable valid claim applies one revision, edges and a re-stamp (positive control)', async () => {
  const before = await gstate();
  await gupdate({ content: 'changed', edges: gedges(tgt), authoredWith: claim() });
  const after = await gstate();
  expect(reader).toHaveBeenCalled();
  expect(after).toMatchObject({ content: 'changed', revSeq: before.revSeq + 1, count: before.count + 1, edges: [{ targetId: tgt.id, name: 'uses' }] });
  expect(after.stamp).toMatchObject({ k: 'TASK', t: taskId, v: 1 });
 });

 describe('#3558 B2: the token is checked on the locked row and never consumed', () => {
  // #4751: one shared latch (src/test/lockHold.ts). It fails fast if the initial lock fails, and it reports the holder's pid.
  const holdRow = () => holdInTransaction(db, (tx) => tx.$queryRaw`SELECT id FROM nodes WHERE id = ${gov.id} FOR UPDATE`);
  const holdConfig = () => holdInTransaction(db, (tx) => lockMemoryConfigExclusive(tx, govMemoryId));
  /** #4751 (the #4721 LOCAL seat's note): the edge-only writer, identified by its statement and by the pid that blocks it. */
  const writerBlockedBy = (holderPid: number) =>
    waitBlocked(db, deadline(3000), { query: /FROM "?nodes"? WHERE .*FOR UPDATE/s, blockedBy: [holderPid] });
  type Outcome = 'pending' | 'ok' | unknown;

  it('control: waits on the source row, applies, and the same token stays reusable', async () => {
   const before = await gstate();
   const lock = await holdRow();
   let outcome: Outcome = 'pending';
   const w = gupdate({ expectedRevision: before.revSeq, edges: gedges(tgt) }).then(() => (outcome = 'ok'), (e: unknown) => (outcome = e));
   try {
    await writerBlockedBy(lock.pid);
    expect(outcome).toBe('pending');
   } finally { lock.release(); await lock.done; await w; }
   expect(outcome).toBe('ok');
   expect(await gstate()).toEqual({ ...before, edges: [{ targetId: tgt.id, name: 'uses' }] });
   await gupdate({ expectedRevision: before.revSeq, edges: gedges(other) });
   expect(await gstate()).toEqual({ ...before, edges: [{ targetId: other.id, name: 'uses' }] });
  }, 30_000);

  it('a writer that holds only the source row (no address lock) and commits a tracked revision makes the token stale', async () => {
   const before = await gstate();
   // The row-lock-only holder: the real revision allocator under FOR UPDATE, so the address lock cannot be what orders it.
   const lock = await holdInTransaction(db, async (tx) => {
    await tx.$queryRaw`SELECT id FROM nodes WHERE id = ${gov.id} FOR UPDATE`;
    const row = await tx.node.findUniqueOrThrow({ where: { id: gov.id } });
    await createNodeRevision(tx, { id: generateId(), ...buildNodeRevisionSnapshot(row, { userId }, { changes: ['content'] }) });
   });
   let outcome: Outcome = 'pending';
   const w = gupdate({ expectedRevision: before.revSeq, edges: gedges(tgt) }).then(() => (outcome = 'ok'), (e: unknown) => (outcome = e));
   try {
    await writerBlockedBy(lock.pid);
    expect(outcome).toBe('pending');
   } finally { lock.release(); await lock.done; await w; }
   expect(outcome).toMatchObject({ extensions: { code: 'NODE_WRITE_CONFLICT' } });
   const after = await gstate();
   expect(after.edges).toEqual(before.edges);
   expect(after).toMatchObject({ revSeq: before.revSeq + 1, count: before.count + 1 });
  }, 30_000);

  it('a tracked edit that commits while it waits makes the token stale: conflict, zero edges, no extra revision', async () => {
   const before = await gstate();
   const config = await holdConfig();
   let advance: Promise<unknown> | undefined, edgeOnly: Promise<unknown> | undefined;
   let outcome: Outcome = 'pending';
   try {
    advance = gupdate({ content: 'advanced', authoredWith: claim() });   // takes the row lock, then waits on the rulebook lock
    await waitForLockWaitersOfType(db, 'advisory', 1, 3000);
    edgeOnly = gupdate({ expectedRevision: before.revSeq, edges: gedges(tgt) }).then(() => (outcome = 'ok'), (e: unknown) => (outcome = e));
    await waitForLockWaitersOfType(db, 'advisory', 2, 3000);   // the edge-only writer is observably queued behind the first (the per-loc lock it holds)
    expect(outcome).toBe('pending');
   } finally { config.release(); await config.done; await advance; await edgeOnly; }
   expect(outcome).toMatchObject({ extensions: { code: 'NODE_WRITE_CONFLICT' } });
   const after = await gstate();
   expect(after.edges).toEqual(before.edges);
   expect(after).toMatchObject({ content: 'advanced', revSeq: before.revSeq + 1, count: before.count + 1 });
  }, 30_000);
 });
});
