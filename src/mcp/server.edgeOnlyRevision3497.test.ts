/** #3497: registered MCP inline writer keeps edge-only current tokens reusable. */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../integrations/db/client.js';
import { cleanDb } from '../test/helpers.js';
import { createTestableMcpServer } from './server.js';
import { resolvers, type Context } from '../api/graphql/schema/resolvers.js';
import { generateId } from '../lib/id.js';
import { createNodeRevision, buildNodeRevisionSnapshot } from '../lib/nodeRevisionSnapshot.js';
import { lockMemoryConfigExclusive } from '../lib/governedRole.js';
import { waitForLockWaitersOfType } from '../test/lockWait.js';
import { holdInTransaction } from '../test/lockHold.js';
import { deadline, waitBlocked } from '../test/lockObserver.js';
vi.mock('../integrations/github/writeNodeToGit.js', () => ({ writeNodeToGit: vi.fn().mockResolvedValue(undefined) }));
// #3558: a spy on the REAL task reader every MCP writer's recovery context carries (server.ts recoveryCtx).
const reader = vi.hoisted(() => ({ calls: 0, override: null as boolean | null }));
vi.mock('./taskReadGate.js', async (orig) => {
  const m = await orig<typeof import('./taskReadGate.js')>();
  return { ...m, mcpReadsTask: (auth: Parameters<typeof m.mcpReadsTask>[0]) => {
    const real = m.mcpReadsTask(auth);
    return async (...a: Parameters<typeof real>) => { reader.calls++; return reader.override ?? real(...a); };
  } };
});
let userId:string,memoryId:string,source:any,a:any,b:any;
const ctx=():Context=>({db,userId,roles:['ADMIN']});
const mcp=()=>createTestableMcpServer({userId,roles:['ADMIN'],clientId:`user:${userId}`});
const urn=(n:any)=>`hrn:node:edges3497-mcp.example:edges:${n.loc}`;
const edges=(n:any)=>[{targetUrn:urn(n),name:'uses'}];
async function state(){const row=await db.node.findUniqueOrThrow({where:{id:source.id}});return{revision:await resolvers.Node.revision(row as never,{},ctx()),count:await db.nodeRevision.count({where:{nodeId:source.id}}),edges:await db.edge.findMany({where:{sourceId:source.id,deletedAt:null},select:{targetId:true,name:true},orderBy:{targetId:'asc'}})};}
beforeEach(async()=>{
 await cleanDb(db);const org=await db.organization.create({data:{name:'MCP edges',urn:'edges3497-mcp.example'}});
 userId=(await db.user.create({data:{handle:'edges3497-mcp-admin',roles:['ADMIN']}})).id;
 await db.orgMember.create({data:{organizationId:org.id,userId,role:'ADMIN'}});
 memoryId=(await db.memory.create({data:{name:'Edges',urn:'edges3497-mcp.example:edges',class:'knowledge',organizationId:org.id}})).id;
 [source,a,b]=await Promise.all(['source','a','b'].map(loc=>(resolvers.Mutation as any).createNode(null,{input:{memoryId,loc,name:loc,content:'original'}},ctx())));
});
describe('#3497 MCP inline edges',()=>{
 it('changed and identical edge-only writes preserve revision/history',async()=>{
  const before=await state(),client=mcp();
  for(const e of [edges(a),edges(a),[]]){
   expect(await client.callToolText('hadron_update_node',{urn:urn(source),edges:e})).toContain('Node updated:');
   expect(await state()).toEqual({...before,edges:e.length?[{targetId:a.id,name:'uses'}]:[]});
  }
 });
 it('identical inline edges alone append no revision',async()=>{
  const client=mcp();expect(await client.callToolText('hadron_create_edge',{sourceUrn:urn(source),targetUrn:urn(a),name:'uses'})).toContain('Edge saved:');
  const before=await state();expect(await client.callToolText('hadron_update_node',{urn:urn(source),edges:edges(a)})).toContain('Node updated:');
  expect(await state()).toEqual(before);
 });
 it('reuses the current token for changed edges; stale token refuses with no writes',async()=>{
  const before=await state(),client=mcp();
  for(const target of [a,b]){
   expect(await client.callToolText('hadron_update_node',{urn:urn(source),expectedRevision:before.revision,edges:edges(target)})).toContain('Node updated:');
   expect(await state()).toEqual({...before,edges:[{targetId:target.id,name:'uses'}]});
  }
  expect(await client.callToolText('hadron_update_node',{urn:urn(source),content:'advance revision'})).toContain('Node updated:');
  const after=await state();expect(after.revision).toBe(before.revision+1);
  expect(await client.callToolText('hadron_update_node',{urn:urn(source),expectedRevision:before.revision,edges:edges(a)})).toMatch(/^\[node_write_conflict\]/);
  expect(await state()).toEqual(after);
 });
 it.each([false,true])('mixed scalar+edges appends exactly one revision (guarded=%s)',async guarded=>{
  const before=await state(),client=mcp();
  expect(await client.callToolText('hadron_update_node',{urn:urn(source),content:'changed',edges:edges(a),...(guarded?{expectedRevision:before.revision}:{})})).toContain('Node updated:');
  const after=await state();expect(after).toEqual({revision:before.revision+1,count:before.count+1,edges:[{targetId:a.id,name:'uses'}]});
  if(guarded){expect(await client.callToolText('hadron_update_node',{urn:urn(source),expectedRevision:before.revision,content:'stale',edges:edges(b)})).toMatch(/^\[node_write_conflict\]/);expect(await state()).toEqual(after);}
 });
 it('standalone MCP create edge remains revision-free',async()=>{
  const before=await state();expect(await mcp().callToolText('hadron_create_edge',{sourceUrn:urn(source),targetUrn:urn(a),name:'uses'})).toContain('Edge saved:');
  expect(await state()).toEqual({...before,edges:[{targetId:a.id,name:'uses'}]});
 });
});

/** #3558 B1 + B2 on the MCP door (cor:dmo:060:04, rulings 0149 + 0198). */
describe('#3558 MCP governed node: edge-only needs no attestation', () => {
 let govMemoryId: string, taskId: string, gov: any, tgt: any, other: any;
 const gurn = (loc: string) => `hrn:node:edges3497-mcp.example:gov:${loc}`;
 const claim = () => ({ task: taskId, revision: 1 });
 const gedges = (t: any) => [{ targetUrn: gurn(t.loc), name: 'uses' }];
 const stamp = (r: any) => ({ k: r.authorshipKind, t: r.authoredByTask, v: r.authoredByRevision, h: r.authoredByHuman, at: r.authoredAt });
 const call = (args: Record<string, unknown>) => mcp().callToolText('hadron_update_node', { urn: gurn('gov'), ...args });
 async function gstate() {
  const row = await db.node.findUniqueOrThrow({ where: { id: gov.id } });
  return { stamp: stamp(row), content: row.content, revSeq: row.revSeq, count: await db.nodeRevision.count({ where: { nodeId: gov.id } }),
   edges: await db.edge.findMany({ where: { sourceId: gov.id, deletedAt: null }, select: { targetId: true, name: true }, orderBy: { targetId: 'asc' } }) };
 }
 beforeEach(async () => {
  reader.calls = 0; reader.override = null;
  const org = await db.organization.findFirstOrThrow({ where: { urn: 'edges3497-mcp.example' } });
  govMemoryId = (await db.memory.create({ data: { name: 'Gov', urn: 'edges3497-mcp.example:gov', class: 'knowledge', organizationId: org.id } })).id;
  taskId = (await db.node.create({ data: { id: generateId(), memoryId: govMemoryId, loc: 'task', name: 'Task', isRunnable: true, content: 'instructions' } })).id;
  const configId = (await db.memoryConfig.create({ data: { id: generateId(), memoryId: govMemoryId } })).id;
  await db.nodeRoleRule.create({ data: { id: generateId(), configId, role: 'guide', authorTaskId: taskId, authorTaskRequired: true } });
  const client = mcp();
  for (const [loc, extra] of [['gov', { role: 'guide', authoredWith: claim() }], ['tgt', {}], ['other', {}]] as const) {
   expect(await client.callToolText('hadron_create_node', { urn: gurn(loc), name: loc, content: 'body', ...extra })).toContain('Node saved:');
  }
  const rows = await db.node.findMany({ where: { memoryId: govMemoryId, loc: { in: ['gov', 'tgt', 'other'] } } });
  gov = rows.find((r) => r.loc === 'gov'); tgt = rows.find((r) => r.loc === 'tgt'); other = rows.find((r) => r.loc === 'other');
  reader.calls = 0;
 });

 it('applies with no claim, keeps the exact stamp, appends no revision and never reads the author task', async () => {
  const before = await gstate();
  expect(before.stamp).toMatchObject({ k: 'TASK', t: taskId, v: 1, h: null });
  expect(before.stamp.at).toBeInstanceOf(Date);
  expect(await call({ edges: gedges(tgt) })).toContain('Node updated:');
  expect(await gstate()).toEqual({ ...before, edges: [{ targetId: tgt.id, name: 'uses' }] });
  expect(await call({ expectedRevision: before.revSeq, edges: gedges(other) })).toContain('Node updated:');
  expect(await gstate()).toEqual({ ...before, edges: [{ targetId: other.id, name: 'uses' }] });
  expect(reader.calls).toBe(0);
 });

 it('mixed content + edges: a missing claim refuses with the existing refusal and changes nothing', async () => {
  const before = await gstate();
  expect(await call({ content: 'changed', edges: gedges(tgt) })).toMatch(/authoring_attestation_missing/);
  expect(await gstate()).toEqual(before);
 });

 it('mixed content + edges: an unreadable author task refuses with the existing refusal and changes nothing', async () => {
  reader.override = false;
  const before = await gstate();
  expect(await call({ content: 'changed', edges: gedges(tgt), authoredWith: claim() })).toMatch(/author_task_broken/i);
  expect(reader.calls).toBeGreaterThan(0);
  expect(await gstate()).toEqual(before);
 });

 it('mixed content + edges: a readable valid claim applies one revision, edges and a re-stamp (positive control)', async () => {
  const before = await gstate();
  expect(await call({ content: 'changed', edges: gedges(tgt), authoredWith: claim() })).toContain('Node updated:');
  const after = await gstate();
  expect(reader.calls).toBeGreaterThan(0);
  expect(after).toMatchObject({ content: 'changed', revSeq: before.revSeq + 1, count: before.count + 1, edges: [{ targetId: tgt.id, name: 'uses' }] });
  expect(after.stamp).toMatchObject({ k: 'TASK', t: taskId, v: 1 });
 });

 describe('#3558 B2: the token is checked on the locked row and never consumed', () => {
  // #4751: the one shared latch (src/test/lockHold.ts): fails fast if the initial lock fails, reports the holder's pid.
  const holdRow = () => holdInTransaction(db, (tx) => tx.$queryRaw`SELECT id FROM nodes WHERE id = ${gov.id} FOR UPDATE`);
  const holdConfig = () => holdInTransaction(db, (tx) => lockMemoryConfigExclusive(tx, govMemoryId));
  /** #4751 (the #4721 LOCAL seat's note): the edge-only writer, identified by its statement and by the pid that blocks it. */
  const writerBlockedBy = (holderPid: number) =>
    waitBlocked(db, deadline(3000), { query: /FROM "?nodes"? WHERE .*FOR UPDATE/s, blockedBy: [holderPid] });

  it('control: waits on the source row, applies, and the same token stays reusable', async () => {
   const before = await gstate();
   const lock = await holdRow();
   let outcome = 'pending';
   const w = call({ expectedRevision: before.revSeq, edges: gedges(tgt) }).then((t) => (outcome = t));
   try {
    await writerBlockedBy(lock.pid);
    expect(outcome).toBe('pending');
   } finally { lock.release(); await lock.done; await w; }
   expect(outcome).toContain('Node updated:');
   expect(await gstate()).toEqual({ ...before, edges: [{ targetId: tgt.id, name: 'uses' }] });
   expect(await call({ expectedRevision: before.revSeq, edges: gedges(other) })).toContain('Node updated:');
   expect(await gstate()).toEqual({ ...before, edges: [{ targetId: other.id, name: 'uses' }] });
  }, 30_000);

  // #3558: on this door the source row is locked TWICE before the token compare: server.ts's own FOR UPDATE and the one in
  // ensureCurrentNodeRevisionInTransaction (the revision snapshot helper). Either lock alone orders the writer, so
  // removing one stays green by design; this pin (and the control and race pins) go red only when BOTH are removed.
  it('a writer that holds only the source row (no address lock) and commits a tracked revision makes the token stale', async () => {
   const before = await gstate();
   // The row-lock-only holder: the real revision allocator under FOR UPDATE, so the address lock cannot be what orders it.
   const lock = await holdInTransaction(db, async (tx) => {
    await tx.$queryRaw`SELECT id FROM nodes WHERE id = ${gov.id} FOR UPDATE`;
    const row = await tx.node.findUniqueOrThrow({ where: { id: gov.id } });
    await createNodeRevision(tx, { id: generateId(), ...buildNodeRevisionSnapshot(row, { userId }, { changes: ['content'] }) });
   });
   let outcome = 'pending';
   const w = call({ expectedRevision: before.revSeq, edges: gedges(tgt) }).then((t) => (outcome = t));
   try {
    await writerBlockedBy(lock.pid);
    expect(outcome).toBe('pending');
   } finally { lock.release(); await lock.done; await w; }
   expect(outcome).toMatch(/^\[node_write_conflict\]/);
   const after = await gstate();
   expect(after.edges).toEqual(before.edges);
   expect(after).toMatchObject({ revSeq: before.revSeq + 1, count: before.count + 1 });
  }, 30_000);

  it('a tracked edit that commits while it waits makes the token stale: conflict, zero edges, no extra revision', async () => {
   const before = await gstate();
   const config = await holdConfig();
   let advance: Promise<unknown> | undefined, edgeOnly: Promise<unknown> | undefined;
   let outcome = 'pending';
   try {
    advance = call({ content: 'advanced', authoredWith: claim() });   // takes the row lock, then waits on the rulebook lock
    await waitForLockWaitersOfType(db, 'advisory', 1, 3000);
    edgeOnly = call({ expectedRevision: before.revSeq, edges: gedges(tgt) }).then((t) => (outcome = t));
    await waitForLockWaitersOfType(db, 'advisory', 2, 3000);   // the edge-only writer is observably queued behind the first
    expect(outcome).toBe('pending');
   } finally { config.release(); await config.done; await advance; await edgeOnly; }
   expect(outcome).toMatch(/^\[node_write_conflict\]/);
   const after = await gstate();
   expect(after.edges).toEqual(before.edges);
   expect(after).toMatchObject({ content: 'advanced', revSeq: before.revSeq + 1, count: before.count + 1 });
  }, 30_000);
 });
});
