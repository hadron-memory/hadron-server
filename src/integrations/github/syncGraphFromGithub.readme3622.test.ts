/** #3622: pin the parent FILE-id duplicate guard against the baseline oracle (test-only follow-up to #3516/#3614). */
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { join, dirname } from 'node:path';
import { mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { db } from '../db/client.js';
import { cleanDb, createDbOrgAndGraph, makeTmpDir } from '../../test/helpers.js';
import { syncGraphFromGithub, type MemoryWithOrg } from './syncGraphFromGithub.js';
import { acquireLockSet } from '../../lib/nodeSubtreeLock.js';
import { moveNodeSubtree } from '../../lib/nodeSubtreeMove.js';
import { waitForLockWaitersOfType } from '../../test/lockWait.js';
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
const report = async () => JSON.parse((await db.memory.findUniqueOrThrow({where:{id:graph.id}})).lastSyncReport ?? 'null');
// The stored-parent ROW-id census cannot mask this: the parent file's id U matches no stored
// row (unknown) or a row of another memory (foreign), yet a second file claims U as well, so
// only `idOccurrences.get(parentFile.id) !== 1` keeps the pair unrecognized (baseline).
it.each(['unknown','foreign'].flatMap(kind=>[false,true].map(reverse=>({kind,reverse}))))('keeps baseline for a $kind parent file id claimed by two files (reverse=$reverse)',async({kind,reverse})=>{
  const load=await import('../localFs/loadGraphFromFs.js');const original=load.loadGraphFromFs;
  const run=async(disable:boolean)=>{
    rmSync(root(),{recursive:true,force:true}); await resetDb();const f=await fixture();
    let dup='aaaaaaaaaaaa7aaa8aaaaaaaaaaaaaaa';
    if(kind==='foreign'){
      const other=await db.memory.create({data:{urn:'test-org:foreign-parent',name:'other',organizationId:graph.organizationId!,class:'knowledge'}});
      dup=(await db.node.create({data:{memoryId:other.id,loc:'parent',name:'foreign parent'}})).id;
    }
    file('p.md',dup,'edited parent',[{targetId:f.a.id,name:'E1'}]);
    file('z.md',dup,'second claimant of the same id');
    const spy=vi.spyOn(load,'loadGraphFromFs').mockImplementation(async(...args)=>{
      const result=await original(...args);if(reverse)result.graph.nodes.reverse();return disable?{...result,sources:[]}:result;
    });
    const result=await syncGraphFromGithub(graph).finally(()=>spy.mockRestore());
    const nodes=await db.node.findMany({where:{memoryId:graph.id},select:{loc:true,content:true,deletedAt:true},orderBy:{loc:'asc'}});
    const edges=await db.edge.findMany({where:{memoryId:graph.id},select:{name:true,source:{select:{loc:true}},target:{select:{loc:true}}},orderBy:{loc:'asc'}});
    const value=await report();if(value)delete value.recordedAt;
    return {failed:!!result.error,nodes,edges,report:value};
  };
  expect(await run(false)).toEqual(await run(true));
});
