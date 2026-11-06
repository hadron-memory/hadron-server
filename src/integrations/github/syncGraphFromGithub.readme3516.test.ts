/** #3516: report a refused README-child source without changing its identity or edges. */
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { join, dirname } from 'node:path';
import { mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { db } from '../db/client.js';
import { cleanDb, createDbOrgAndGraph, makeTmpDir } from '../../test/helpers.js';
import { syncGraphFromGithub, type MemoryWithOrg } from './syncGraphFromGithub.js';
import { loadGraphFromFs } from '../localFs/loadGraphFromFs.js';
import { acquireLockSet } from '../../lib/nodeSubtreeLock.js';
import { moveNodeSubtree } from '../../lib/nodeSubtreeMove.js';
import { waitForLockWaitersOfType } from '../../test/lockWait.js';
import { execGit } from './execGit.js';
import { deriveEdgeLoc } from '../../lib/edgeLoc.js';
vi.mock('child_process', () => ({ execFile: vi.fn((...args: unknown[]) => {
  (args.at(-1) as Function)(null, { stdout: (args[1] as string[]).includes('rev-list') ? '0\n' : '', stderr: '' });
}) }));
vi.mock('./githubApp.js', () => ({ getInstallationToken: vi.fn(async () => 'fake'), toHttpsUrl: vi.fn((source: string) => source) }));
let graphsPath: string, cleanup: () => void, graph: MemoryWithOrg;
vi.mock('../../config.js', async original => ({ ...await original<typeof import('../../config.js')>(), get GRAPHS_PATH() { return graphsPath; } }));
const root = () => join(graphsPath, 'test-org', 'readme-memory');
const file = (path: string, id: string, content: string, targets: Array<{targetId: string; name: string}> = []) => {
  const at = join(root(),path);mkdirSync(dirname(at),{recursive:true});
  writeFileSync(at, `---\nid: ${id}\nname: ${path}\nnodes: ${JSON.stringify(targets.map(t=>({id:t.targetId,rel:t.name})))}\n---\n\n${content}\n`);
};
async function resetDb() {
  await cleanDb(db);
  const {org,graph:created}=await createDbOrgAndGraph(db,{orgName:'test-org',graphName:'readme-memory'});
  await db.organization.update({where:{id:org.id},data:{githubInstallationId:12345}});
  graph=await db.memory.update({where:{id:created.id},data:{urn:'test-org:readme-memory',source:'git@github.com:test/repo.git',readBranch:'main'},include:{organization:true}});
}
beforeEach(async () => { ({dir:graphsPath,cleanup}=makeTmpDir()); await resetDb(); });
afterEach(()=>{cleanup();vi.restoreAllMocks()});
async function fixture() {
  const make=(loc:string)=>db.node.create({data:{memoryId:graph.id,loc,name:loc,content:'stored '+loc,ownerRepo:'test/repo'}});
  const [parent,child,a,b,third,deleted]=await Promise.all(['p','p:README','a','b','third','deleted'].map(make));
  const stored=await db.edge.create({data:{memoryId:graph.id,sourceId:child.id,targetId:a.id,name:'stored',loc:deriveEdgeLoc(child.loc,'stored',a.loc)}});
  for(const n of [a,b])file(n.loc+'.md',n.id,n.content!);
  file('p.md',parent.id,'edited parent',[{targetId:a.id,name:'E1'}]);
  file('p/README.md',child.id,'unapplied child',[{targetId:b.id,name:'E2'}]);
  file('third.md',third.id,'third',[{targetId:child.id,name:'E3'}]);
  return {parent,child,a,b,third,deleted,stored};
}
it.each([false,true])('keeps separate parent/child sources and stable incoming edges (reverse=%s)',async reverse=>{
  const f=await fixture();
  const load=await import('../localFs/loadGraphFromFs.js');
  const original=load.loadGraphFromFs;
  vi.spyOn(load,'loadGraphFromFs').mockImplementation(async(...args)=>{
    const result=await original(...args);if(reverse)result.graph.nodes.reverse();return result;
  });
  const beforeChild=await db.node.findUniqueOrThrow({where:{id:f.child.id}});
  const hashes=['p.md','p/README.md'].map(p=>readFileSync(join(root(),p),'utf8'));
  for(let attempt=0;attempt<2;attempt++) {
    expect((await syncGraphFromGithub(graph)).error).toBeUndefined();
    expect(await db.node.findUniqueOrThrow({where:{id:f.child.id}})).toEqual(beforeChild);
    expect(await db.node.findUniqueOrThrow({where:{id:f.parent.id}})).toMatchObject({loc:'p',content:'edited parent'});
    expect(await db.edge.findUniqueOrThrow({where:{id:f.stored.id}})).toEqual(f.stored);
    expect(await db.edge.count({where:{memoryId:graph.id,sourceId:f.parent.id,targetId:f.a.id,name:'E1'}})).toBe(1);
    expect(await db.edge.count({where:{memoryId:graph.id,name:'E2'}})).toBe(0);
    expect(await db.pendingEdge.count({where:{name:{in:['E2','E3']}}})).toBe(0);
    expect(await db.edge.findFirstOrThrow({where:{memoryId:graph.id,name:'E3'}})).toMatchObject({sourceId:f.third.id,targetId:f.child.id,loc:deriveEdgeLoc('third','E3','p:README')});
    const report=JSON.parse((await db.memory.findUniqueOrThrow({where:{id:graph.id}})).lastSyncReport!);
    expect(report).toMatchObject({version:1,outcome:'partial',entries:[{kind:'held_move',loc:'p',fromLoc:'p:README',code:'MOVE_HELD'}]});
    expect(await db.node.findUnique({where:{id:f.deleted.id}})).toBeNull();
    expect(['p.md','p/README.md'].map(p=>readFileSync(join(root(),p),'utf8'))).toEqual(hashes);
  }
});
it('does not admit the refused child bytes into the parent include overlay or validation',async()=>{
  const f=await fixture();file('p/README.md',f.child.id,'{{> invalid bogus}}');
  const result=await syncGraphFromGithub(graph);expect(result.error).toBeUndefined();
  expect(result.skippedInvalidIncludes??[]).toEqual([]);
  expect(await db.node.findUniqueOrThrow({where:{id:f.parent.id}})).toMatchObject({content:'edited parent'});
});

const collisionEntry = {kind:'held_move',loc:'p',fromLoc:'p:README',code:'MOVE_HELD'};
const report = async () => JSON.parse((await db.memory.findUniqueOrThrow({where:{id:graph.id}})).lastSyncReport ?? 'null');
it('reports once after an existing parking retry and clears normally when the collision is gone',async()=>{
  const f=await fixture();
  const x=await db.node.create({data:{memoryId:graph.id,loc:'x',name:'x',ownerRepo:'test/repo'}});
  const y=await db.node.create({data:{memoryId:graph.id,loc:'y',name:'y',ownerRepo:'test/repo'}});
  file('y.md',x.id,'move x'); file('x.md',y.id,'{{> broken invalid}}');
  writeFileSync(join(root(),'evil--> x.md'),'---\nname: invalid path, no id\n---\n');
  const transaction=db.$transaction.bind(db), retried: string[]=[];
  vi.spyOn(db,'$transaction').mockImplementation(((body:any,options:any)=>transaction(async(tx:any)=>{
    try {return await body(tx);} catch(error) {retried.push((error as Error).constructor.name);throw error;}
  },options)) as typeof db.$transaction);
  expect((await syncGraphFromGithub(graph)).error).toBeUndefined();
  expect(retried).toContain('GitSyncUnsettledParking');
  expect((await report()).entries.filter((entry: unknown)=>JSON.stringify(entry)===JSON.stringify(collisionEntry))).toHaveLength(1);
  file('p/README.md',f.child.id,'still refused after edit');
  expect((await syncGraphFromGithub(graph)).error).toBeUndefined();
  expect((await report()).entries.filter((entry: {fromLoc?: string})=>entry.fromLoc==='p:README')).toEqual([collisionEntry]);
  // A normal path is a different, unambiguous source. No new file encoding.
  rmSync(join(root(),'p/README.md'));
  mkdirSync(join(root(),'p','README','.node'),{recursive:true});
  writeFileSync(join(root(),'p','README','.node','node.yaml'),`id: ${f.child.id}\nname: child\n`);
  writeFileSync(join(root(),'p','README','.node','topic.md'),'accepted after collision clears');
  rmSync(join(root(),'x.md'));rmSync(join(root(),'y.md'));rmSync(join(root(),'evil--> x.md'));
  expect((await syncGraphFromGithub(graph)).error).toBeUndefined();
  expect(await db.node.findUniqueOrThrow({where:{id:f.child.id}})).toMatchObject({loc:'p:README',content:'accepted after collision clears'});
  expect(await report()).toBeNull();
});
it('rolls back graph and partial report when completion fails after classification',async()=>{
  const f=await fixture();const before=await db.node.findUniqueOrThrow({where:{id:f.parent.id}});
  const transaction=db.$transaction.bind(db);let failed=false;
  vi.spyOn(db,'$transaction').mockImplementation(((body: any,options: any)=>transaction(async(tx: any)=>{
    const update=tx.memory.update.bind(tx.memory);
    tx.memory.update=async(args: any)=>{
      if(args.data.lastSyncReport && !failed){failed=true;throw new Error('fixture completion failure');}
      return update(args);
    };
    return body(tx);
  },options)) as typeof db.$transaction);
  expect((await syncGraphFromGithub(graph)).error).toContain('fixture completion failure');
  expect(await db.node.findUniqueOrThrow({where:{id:f.parent.id}})).toEqual(before);
  expect(await db.node.findUnique({where:{id:f.deleted.id}})).not.toBeNull();
  expect(await db.edge.count({where:{memoryId:graph.id,name:{in:['E1','E2','E3']}}})).toBe(0);
  expect(await report()).toMatchObject({outcome:'failed',entries:[]});
});
it('keeps a parsed governance-refused parent present while reporting only the child collision separately',async()=>{
  const f=await fixture();
  file('p.md',f.parent.id,'refused parent');
  const text=readFileSync(join(root(),'p.md'),'utf8').replace('name: p.md','name: p.md\nrole: decision');writeFileSync(join(root(),'p.md'),text);
  expect((await syncGraphFromGithub(graph)).error).toBeUndefined();
  expect(await db.node.findUniqueOrThrow({where:{id:f.parent.id}})).toEqual(f.parent);
  expect((await report()).entries).toEqual(expect.arrayContaining([collisionEntry,{kind:'protected',loc:'p',code:'PROTECTED_DECISION'}]));
  expect(await db.edge.findUniqueOrThrow({where:{id:f.stored.id}})).toEqual(f.stored);
});
it.each(['absent-parent','idless-child','foreign-child','deleted-child','deleted-parent','wrong-child-loc','duplicate-child','duplicate-parent','duplicate-invalid-child','ordinary-source','wrong-parent-resolution'].flatMap(shape=>[false,true].map(reverse=>({shape,reverse}))))('keeps baseline for $shape (reverse=$reverse, no guessed pair)',async({shape,reverse})=>{
  const load=await import('../localFs/loadGraphFromFs.js');const original=load.loadGraphFromFs;
  const run=async(disable:boolean)=>{
    rmSync(root(),{recursive:true,force:true}); await resetDb();const f=await fixture();
    if(shape==='absent-parent')rmSync(join(root(),'p.md'));
    if(shape==='idless-child')writeFileSync(join(root(),'p/README.md'),readFileSync(join(root(),'p/README.md'),'utf8').replace(`id: ${f.child.id}\n`,''));
    if(shape==='foreign-child'){
      const other=await db.memory.create({data:{urn:'test-org:other',name:'other',organizationId:graph.organizationId!,class:'knowledge'}});
      const foreign=await db.node.create({data:{memoryId:other.id,loc:'p:README',name:'foreign'}});
      file('p/README.md',foreign.id,'foreign copied source');
      // Keep no foreign incident edge from making cleanup a different case.
    }
    if(shape==='deleted-child')await db.node.update({where:{id:f.child.id},data:{deletedAt:new Date('2026-01-01')}});
    if(shape==='deleted-parent')await db.node.update({where:{id:f.parent.id},data:{deletedAt:new Date('2026-01-01')}});
    if(shape==='wrong-parent-resolution'){
      rmSync(join(root(),'b.md')); // One claim: exercise resolution, not the duplicate-id gate.
      file('p.md',f.b.id,'a different row moving to P');
    }
    if(shape==='wrong-child-loc')await db.node.update({where:{id:f.child.id},data:{loc:'q'}});
    if(shape==='duplicate-child')file('z.md',f.child.id,'duplicate child');
    if(shape==='duplicate-parent')file('z.md',f.parent.id,'duplicate parent');
    if(shape==='duplicate-invalid-child')file('evil--> x.md',f.child.id,'duplicate unusable-path claim');
    if(shape==='ordinary-source'){rmSync(join(root(),'p/README.md'));file('.hadron/p.md',f.child.id,'ordinary duplicate loc');}
    const spy=vi.spyOn(load,'loadGraphFromFs').mockImplementation(async(...args)=>{
      const result=await original(...args);if(reverse)result.graph.nodes.reverse();return disable?{...result,sources:[]}:result;
    });
    const result=await syncGraphFromGithub(graph);spy.mockRestore();
    const nodes=await db.node.findMany({where:{memoryId:graph.id},select:{loc:true,content:true,deletedAt:true},orderBy:{loc:'asc'}});
    const edges=await db.edge.findMany({where:{memoryId:graph.id},select:{name:true,source:{select:{loc:true}},target:{select:{loc:true}}},orderBy:{loc:'asc'}});
    const value=await report();if(value)delete value.recordedAt;
    return {failed:!!result.error,nodes,edges,report:value};
  };
  expect(await run(false)).toEqual(await run(true));
});
it.each(['p.md','p/README.md'])('keeps unreadable %s atomic and leaves child stored edges untouched',async path=>{
  const f=await fixture();writeFileSync(join(root(),path),'---\nname: [broken\n---\n');
  expect((await syncGraphFromGithub(graph)).error).toContain('nothing was written');
  expect(await db.node.findUniqueOrThrow({where:{id:f.parent.id}})).toEqual(f.parent);
  expect(await db.node.findUniqueOrThrow({where:{id:f.child.id}})).toEqual(f.child);
  expect(await db.edge.findUniqueOrThrow({where:{id:f.stored.id}})).toEqual(f.stored);
});
it('refuses encrypted sync before checkout',async()=>{
  await fixture();await db.memory.update({where:{id:graph.id},data:{isEncrypted:true}});
  const childProcess=await import('child_process');const git=vi.mocked(childProcess.execFile);git.mockClear();
  expect((await syncGraphFromGithub(graph)).errorCode).toBe('ENCRYPTED_GIT_SYNC_UNAVAILABLE');
  expect(git).not.toHaveBeenCalled();
});

it('recognizes an id-less parent source under the existing loc fallback',async()=>{
  const f=await fixture();
  writeFileSync(join(root(),'p.md'),readFileSync(join(root(),'p.md'),'utf8').replace(`id: ${f.parent.id}\n`,''));
  expect((await syncGraphFromGithub(graph)).error).toBeUndefined();
  expect((await report()).entries).toEqual([collisionEntry]);
  expect(await db.node.findUniqueOrThrow({where:{id:f.parent.id}})).toMatchObject({content:'edited parent'});
  expect(await db.node.findUniqueOrThrow({where:{id:f.child.id}})).toEqual(f.child);
});
it('rechecks encryption after checkout before classifying or writing a pair',async()=>{
  const f=await fixture();const load=await import('../localFs/loadGraphFromFs.js');const original=load.loadGraphFromFs;
  vi.spyOn(load,'loadGraphFromFs').mockImplementation(async(...args)=>{
    const result=await original(...args);await db.memory.update({where:{id:graph.id},data:{isEncrypted:true}});return result;
  });
  expect((await syncGraphFromGithub(graph)).error).toContain('encrypted memory');
  expect(await db.node.findUniqueOrThrow({where:{id:f.parent.id}})).toEqual(f.parent);
  expect(await db.node.findUniqueOrThrow({where:{id:f.child.id}})).toEqual(f.child);
});
it('takes the complete candidate set before resolving a concurrently moved child',async()=>{
  const f=await fixture();
  // No incident edges: their existing endpoint locks must not mask the new keys.
  await db.edge.deleteMany({where:{memoryId:graph.id}});
  file('p.md',f.parent.id,'edited parent');file('p/README.md',f.child.id,'unapplied child');file('third.md',f.third.id,'third');
  let held!:()=>void,release!:()=>void;
  const ready=new Promise<void>(r=>{held=r});const gate=new Promise<void>(r=>{release=r});
  const moving=db.$transaction(async tx=>{
    await acquireLockSet(tx,[{memoryId:graph.id,loc:'p'},{memoryId:graph.id,loc:'p:README'}]);
    held();await gate;
    return moveNodeSubtree(tx,{source:f.child,destLoc:'q',editor:{info:'readme3516-controlled-move'}});
  },{timeout:15_000});
  await ready;
  const syncing=syncGraphFromGithub(graph);
  try {await waitForLockWaitersOfType(db,'advisory',1,2_000);}
  finally {release();await moving;}
  expect((await syncing).error).toBeUndefined();
  // Revalidation sees Q and uses the baseline move path, never invents P:README.
  expect((await report())?.entries??[]).not.toContainEqual(collisionEntry);
  expect(await db.node.findUniqueOrThrow({where:{id:f.child.id}})).toMatchObject({loc:'q'});
},15_000);

it('retains canonical root import alongside a separate legal parent/child pair',async()=>{
  await fixture();
  const rootRow=await db.node.create({data:{memoryId:graph.id,loc:'readme-memory',name:'Root',content:'root old',ownerRepo:'test/repo'}});
  file('README.md',rootRow.id,'root edited');
  expect((await syncGraphFromGithub(graph)).error).toBeUndefined();
  expect(await db.node.findUniqueOrThrow({where:{id:rootRow.id}})).toMatchObject({loc:'readme-memory',content:'root edited'});
  expect((await report()).entries).toEqual([collisionEntry]);
});

it('excludes refused child content from include-cycle checks on accepted sources',async()=>{
  const f=await fixture();
  file('p/README.md',f.child.id,'{{> a}}');file('a.md',f.a.id,'{{> p}}');
  expect((await syncGraphFromGithub(graph)).skippedInvalidIncludes??[]).toEqual([]);
  expect(await db.node.findUniqueOrThrow({where:{id:f.a.id}})).toMatchObject({content:'{{> p}}'});
  expect((await report()).entries).toEqual([collisionEntry]);
});

it.each(['p','p:README'])('waits on exact candidate key %s independently',async key=>{
  const f=await fixture();await db.edge.deleteMany({where:{memoryId:graph.id}});
  file('p.md',f.parent.id,'edited parent');file('p/README.md',f.child.id,'child');file('third.md',f.third.id,'third');
  let held!:()=>void,release!:()=>void;
  const ready=new Promise<void>(r=>{held=r});const gate=new Promise<void>(r=>{release=r});
  // Barrier owns exactly one key and takes no later locks: no artificial inversion.
  const barrier=db.$transaction(async tx=>{await acquireLockSet(tx,[{memoryId:graph.id,loc:key}]);held();await gate;},{timeout:15_000});
  await ready;const syncing=syncGraphFromGithub(graph);
  try {await waitForLockWaitersOfType(db,'advisory',1,2_000);}
  finally {release();await barrier;}
  expect((await syncing).error).toBeUndefined();expect((await report()).entries).toEqual([collisionEntry]);
},15_000);

it('rebuilds prelocks for a candidate arriving after the governed-row scan',async()=>{
  const f=await fixture();await db.node.delete({where:{id:f.child.id}});
  file('p.md',f.parent.id,'refused parent');
  writeFileSync(join(root(),'p.md'),readFileSync(join(root(),'p.md'),'utf8').replace('name: p.md','name: p.md\nrole: decision'));
  const transaction=db.$transaction.bind(db);let inserted=false;const retried:string[]=[];
  vi.spyOn(db,'$transaction').mockImplementation(((body:any,options:any)=>transaction(async(tx:any)=>{
    const query=tx.$queryRaw.bind(tx);
    const observedQuery=async(...args:any[])=>{
      const result=await query(...args);const sql=Array.from(args[0] as string[]).join('');
      if(!inserted && sql.includes('SELECT "id" FROM "nodes" WHERE "memory_id"')){
        inserted=true;await db.node.create({data:{id:f.child.id,memoryId:graph.id,loc:'p:README',name:'late child',content:'late stored child',ownerRepo:'test/repo'}});
      }
      return result;
    };
    const observed=new Proxy(tx,{get(target,key){return key==='$queryRaw'?observedQuery:Reflect.get(target,key);}});
    try{return await body(observed);}catch(error){retried.push((error as Error).constructor.name);throw error;}
  },options)) as typeof db.$transaction);
  expect((await syncGraphFromGithub(graph)).error).toBeUndefined();
  expect(inserted).toBe(true);expect(retried).toContain('EdgeEndpointPreflightStale');
  expect((await report()).entries.filter((entry:{fromLoc?:string})=>entry.fromLoc==='p:README')).toEqual([collisionEntry]);
  expect(await db.node.findUniqueOrThrow({where:{id:f.child.id}})).toMatchObject({loc:'p:README',content:'late stored child'});
});

it('preserves the existing canonical-root duplicate-source refusal before any import',async()=>{
  const f=await fixture();rmSync(join(root(),'p/README.md'));
  const parent=await db.node.create({data:{memoryId:graph.id,loc:'readme-memory',name:'Root',content:'old root',ownerRepo:'test/repo'}});
  const child=await db.node.create({data:{memoryId:graph.id,loc:'readme-memory:README',name:'Root child',content:'stored root child',ownerRepo:'test/repo'}});
  const stored=await db.edge.create({data:{memoryId:graph.id,sourceId:child.id,targetId:f.a.id,name:'root-stored',loc:deriveEdgeLoc(child.loc,'root-stored',f.a.loc)}});
  file('README.md',parent.id,'edited canonical root');
  file('readme-memory/README.md',child.id,'refused root child',[{targetId:f.b.id,name:'root-E2'}]);
  file('third.md',f.third.id,'third',[{targetId:child.id,name:'root-E3'}]);
  expect((await syncGraphFromGithub(graph)).error).toContain('Git root README slug is occupied');
  expect(await db.node.findUniqueOrThrow({where:{id:parent.id}})).toEqual(parent);
  expect(await db.node.findUniqueOrThrow({where:{id:child.id}})).toEqual(child);
  expect(await db.edge.findUniqueOrThrow({where:{id:stored.id}})).toEqual(stored);
  expect(await db.edge.count({where:{memoryId:graph.id,name:{in:['root-E2','root-E3','E1']}}})).toBe(0);
  expect((await report()).outcome).toBe('failed');
});

it.each(['idless','foreign'].flatMap(parentKind=>[false,true].map(reverse=>({parentKind,reverse}))))('does not recognize an ambiguous $parentKind parent with another claimant (reverse=$reverse)',async({parentKind,reverse})=>{
  const f=await fixture();
  if(parentKind==='idless')writeFileSync(join(root(),'p.md'),readFileSync(join(root(),'p.md'),'utf8').replace(`id: ${f.parent.id}\n`,''));
  else{
    const other=await db.memory.create({data:{urn:'test-org:foreign-parent',name:'other',organizationId:graph.organizationId!,class:'knowledge'}});
    const foreign=await db.node.create({data:{memoryId:other.id,loc:'parent',name:'foreign parent'}});
    file('p.md',foreign.id,'edited parent',[{targetId:f.a.id,name:'E1'}]);
  }
  file('z.md',f.parent.id,'move the original parent to Z');
  const load=await import('../localFs/loadGraphFromFs.js');const original=load.loadGraphFromFs;
  vi.spyOn(load,'loadGraphFromFs').mockImplementation(async(...args)=>{const value=await original(...args);if(reverse)value.graph.nodes.reverse();return value;});
  const result=await syncGraphFromGithub(graph);
  if(result.error){
    // Frozen head fails closed: do not describe this as a committed bad edge.
    expect(await db.node.findUniqueOrThrow({where:{id:f.parent.id}})).toEqual(f.parent);
    expect(await db.edge.count({where:{memoryId:graph.id,name:'E1'}})).toBe(0);
  }
  expect(result.error).toBeUndefined();
  const e1=await db.edge.findFirst({where:{memoryId:graph.id,name:'E1'},include:{source:true}});
  if(e1)expect(e1.source.loc).toBe('p');
  expect((await report())?.entries??[]).not.toContainEqual(collisionEntry);
});
it('does not let a refused child role suppress its independently admitted parent edges',async()=>{
  const f=await fixture();
  writeFileSync(join(root(),'p/README.md'),readFileSync(join(root(),'p/README.md'),'utf8').replace('name: p/README.md','name: p/README.md\nrole: decision'));
  expect((await syncGraphFromGithub(graph)).error).toBeUndefined();
  expect(await db.edge.count({where:{memoryId:graph.id,name:'E1',sourceId:f.parent.id,targetId:f.a.id}})).toBe(1);
  expect(await db.edge.count({where:{memoryId:graph.id,name:'E2'}})).toBe(0);
  expect((await report()).entries).toEqual([collisionEntry]);
  expect(await db.node.findUniqueOrThrow({where:{id:f.child.id}})).toEqual(f.child);
});
