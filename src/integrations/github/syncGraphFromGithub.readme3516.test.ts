/** #3516: report a refused README-child source without changing its identity or edges. */
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { join, dirname } from 'node:path';
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { db } from '../db/client.js';
import { cleanDb, createDbOrgAndGraph, makeTmpDir } from '../../test/helpers.js';
import { syncGraphFromGithub, type MemoryWithOrg } from './syncGraphFromGithub.js';
import { loadGraphFromFs } from '../localFs/loadGraphFromFs.js';
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
beforeEach(async () => {
  ({dir:graphsPath,cleanup}=makeTmpDir());await cleanDb(db);
  const {org,graph:created}=await createDbOrgAndGraph(db,{orgName:'test-org',graphName:'readme-memory'});
  await db.organization.update({where:{id:org.id},data:{githubInstallationId:12345}});
  graph=await db.memory.update({where:{id:created.id},data:{urn:'test-org:readme-memory',source:'git@github.com:test/repo.git',readBranch:'main'},include:{organization:true}});
});
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
