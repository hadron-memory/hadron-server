/** #3242: row-local mutation errors must not exhaust healthy siblings. Private DB and local Git only. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import { execFileSync } from 'child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { db } from '../integrations/db/client.js';
import { cleanDb } from '../test/helpers.js';
import { generateId } from '../lib/id.js';

vi.mock('fs', async original => ({ ...(await original<typeof import('fs')>()) }));

const env = vi.hoisted(() => ({ root: '', bare: '', commands: [] as string[][] }));
vi.mock('../config.js', () => ({ get GRAPHS_PATH() { return env.root; } }));
vi.mock('../integrations/github/githubApp.js', async importOriginal => ({
 ...(await importOriginal<typeof import('../integrations/github/githubApp.js')>()),
 getInstallationToken: vi.fn(() => { throw new Error('No provider access in #3156'); }),
}));
vi.mock('../integrations/github/execGit.js', () => ({
 execGit: vi.fn(async (args: string[], options: { cwd?: string; env?: NodeJS.ProcessEnv } = {}) => {
  env.commands.push(args);
  const stdout = execFileSync('git', [
   '-c', 'protocol.allow=never', '-c', 'protocol.file.allow=always',
   '-c', `url.${env.bare}.insteadOf=${SOURCE}`, ...args,
  ], { ...options, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  return { stdout, stderr: '' };
 }),
}));
import * as files from '../integrations/github/writeNodeToGit.js';
import { mirrorMutationMarker } from '../integrations/github/mirrorFileMutation.js';
import { pushMemoryToGit } from '../integrations/github/pushMemoryToGit.js';
import { withMirrorCheckout } from '../integrations/github/gitMirrorCheckout.js';
import { gitMirrorSweepTick } from './sweepGitMirrorObligations.js';
const SOURCE = 'https://github.com/synthetic/isolation3242.git';
const IDENT = { GIT_AUTHOR_NAME: 'test', GIT_AUTHOR_EMAIL: 'test@example.invalid', GIT_COMMITTER_NAME: 'test', GIT_COMMITTER_EMAIL: 'test@example.invalid' };
const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, ...IDENT }, stdio: ['ignore','pipe','pipe'] }).trim();
let memoryId: string;
const tick = (now = new Date()) => gitMirrorSweepTick(db, now);
const old = () => new Date(Date.now()-24*60*60*1000);
const rows = () => db.gitMirrorObligation.findMany({where:{memoryId}});

beforeEach(async () => {
 env.root=mkdtempSync(join(tmpdir(),'dorian-sweep3242-'));
 env.bare=join(env.root,'remote.git'); env.commands=[];
 vi.spyOn(console,'error').mockImplementation(()=>{});
 vi.spyOn(console,'warn').mockImplementation(()=>{});
 vi.spyOn(console,'log').mockImplementation(()=>{});
 await cleanDb(db);
 git(env.root,'init','--bare','-b','main',env.bare);
 const seed=join(env.root,'seed'); mkdirSync(seed);
 git(seed,'init','-b','main'); writeFileSync(join(seed,'seed.txt'),'seed');
 git(seed,'add','-A'); git(seed,'commit','-m','seed'); git(seed,'push',env.bare,'main');
 const org=await db.organization.create({data:{name:'Retry fixture',urn:'isolation3242.test'}});
 const memory=await db.memory.create({data:{organizationId:org.id,name:'Retry',urn:'isolation3242.test:memory',class:'knowledge',source:SOURCE,writeBranch:'main'}});
 memoryId=memory.id;
 const local=join(env.root,org.urn,'memory'); mkdirSync(join(env.root,org.urn));
 execFileSync('git',['-c','protocol.allow=never','-c','protocol.file.allow=always','-c',`url.${env.bare}.insteadOf=${SOURCE}`,'clone',SOURCE,local],{stdio:'ignore'});
});
afterEach(()=>{
 vi.restoreAllMocks();
 const marker=mirrorMutationMarker(localPath());
 if(existsSync(marker)) {
  const backup=readFileSync(marker,'utf8');
  // Only the backup named by this fixture's private checkout is ours.
  if(backup.startsWith(join(tmpdir(),'hadron-mirror-row-')))rmSync(backup,{recursive:true,force:true});
 }
 rmSync(env.root,{recursive:true,force:true});
});


const localPath = () => join(env.root, 'isolation3242.test', 'memory');
async function node(loc: string) {
 return db.node.create({data:{id:generateId(),memoryId,loc,name:loc,content:'fresh '+loc,tags:[]}});
}
async function debt(nodeId: string, kind: 'WRITE'|'REMOVE', removeLoc = '', attempts = 9) {
 return db.gitMirrorObligation.create({data:{memoryId,nodeId,kind,removeLoc,branch:'main',
  state:'FAILED',errorClass:'PUSH_FAILED',attempts,attemptSeq:0n,lastAttemptAt:old()}});
}
function baseline(entries: Record<string,string>) {
 for (const [path, content] of Object.entries(entries)) {
  mkdirSync(join(localPath(), path, '..'), {recursive:true});
  writeFileSync(join(localPath(),path),content);
 }
 git(localPath(),'add','-A'); git(localPath(),'commit','-m','baseline');
 git(localPath(),'push',env.bare,'main');
}
const remote = (path: string) => git(env.bare,'show','main:'+path);

describe('#3242 row-local file operation failures', () => {
 it.each(['write','remove','owner'] as const)('%s failure restores its partial changes and publishes healthy attempt9 sibling', async failure => {
  const healthy = await node('healthy');
  const bad = await node(failure==='write'?'bad':'moved-bad');
  const original = '---\nid: '+bad.id+'\n---\noriginal bad bytes\n';
  baseline({'bad.md':original,'bad/README.md':original,'.bad/edges.yaml':'original edge'});
  await debt(healthy.id,'WRITE');
  await debt(bad.id,failure==='write'?'WRITE':'REMOVE',failure==='write'?'':'bad');
  let calls=0;
  if(failure==='write') {
   const real=files.writeNodeFile;
   vi.spyOn(files,'writeNodeFile').mockImplementation((...args)=>{
    if(args[1].id===bad.id) { calls++; real(...args); throw new Error('synthetic partial write'); }
    return real(...args);
   });
  } else if(failure==='remove') {
   const real=files.removeNodeFile;
   vi.spyOn(files,'removeNodeFile').mockImplementation((...args)=>{
    if(args[2]===bad.id) { calls++; real(...args); throw new Error('synthetic partial removal'); }
    return real(...args);
   });
  } else {
   const real=db.node.findFirst.bind(db.node);
   vi.spyOn(db.node,'findFirst').mockImplementation((...args:Parameters<typeof real>)=>{
    if(args[0]?.where?.loc==='bad') {calls++;throw new Error('synthetic owner read');}
    return real(...args);
   });
  }
  await tick();
  expect(calls).toBe(1);
  expect(await rows()).toEqual([expect.objectContaining({nodeId:bad.id,kind:failure==='write'?'WRITE':'REMOVE',
   attempts:10,state:'EXHAUSTED',errorClass:'TREE_WRITE'})]);
  expect(remote('healthy.md')).toContain('fresh healthy');
  expect(remote('bad.md')).toBe(original.trim());
  expect(remote('bad/README.md')).toBe(original.trim());
  expect(remote('.bad/edges.yaml')).toBe('original edge');
  expect(git(localPath(),'status','--porcelain')).toBe('');
  expect(readFileSync(join(localPath(),'bad.md'),'utf8')).toBe(original);
 });

 it('beforeGit REMOVE owner outage cannot exhaust a healthy REMOVE sibling', async()=>{
  const bad=await node('moved-bad'); const healthy=await node('moved-healthy');
  baseline({'old-bad.md':'---\nid: '+bad.id+'\n---\nbad',
   'old-healthy.md':'---\nid: '+healthy.id+'\n---\nhealthy'});
  await debt(bad.id,'REMOVE','old-bad');
  await debt(healthy.id,'REMOVE','old-healthy');
  const real=db.node.findFirst.bind(db.node);let badReads=0;
  vi.spyOn(db.node,'findFirst').mockImplementation((...args:Parameters<typeof real>)=>{
   if(args[0]?.where?.loc==='old-bad'){badReads++;throw new Error('synthetic readiness read');}
   return real(...args);
  });
  await tick();
    expect(await rows()).toEqual([expect.objectContaining({nodeId:bad.id,kind:'REMOVE',
   attempts:10,state:'EXHAUSTED',errorClass:'TREE_WRITE'})]);
  expect(badReads).toBe(2); // readiness defers to row-local mutation
  expect(remote('old-bad.md')).toContain('bad');
  expect(()=>remote('old-healthy.md')).toThrow();
  expect(existsSync(join(localPath(),'old-healthy.md'))).toBe(false);
  expect(git(localPath(),'status','--porcelain')).toBe('');
 });
 it('REMOVE failures match the exact loc, not every obligation of the same node', async()=>{
  const n=await node('moved');
  baseline({'bad.md':'---\nid: '+n.id+'\n---\nbad','good.md':'---\nid: '+n.id+'\n---\ngood'});
  await debt(n.id,'REMOVE','bad'); await debt(n.id,'REMOVE','good');
  const real=files.removeNodeFile;
  vi.spyOn(files,'removeNodeFile').mockImplementation((...args)=>{
   if(args[1]==='bad')throw new Error('synthetic one-loc failure');
   return real(...args);
  });
  await tick();
  expect(await rows()).toEqual([expect.objectContaining({nodeId:n.id,removeLoc:'bad',attempts:10,errorClass:'TREE_WRITE'})]);
  expect(remote('bad.md')).toContain('bad');
  expect(()=>remote('good.md')).toThrow();
 });

 it('a failed new-file write leaves no partial bytes and an all-failed batch never pushes', async()=>{
  const bad=await node('brand-new');await debt(bad.id,'WRITE');
  vi.spyOn(files,'writeNodeFile').mockImplementation((path,n)=>{
   writeFileSync(join(path,n.loc+'.md'),'partial failed bytes');throw new Error('synthetic write error');
  });
  await tick();
  expect(await rows()).toEqual([expect.objectContaining({nodeId:bad.id,attempts:10,errorClass:'TREE_WRITE'})]);
  expect(existsSync(join(localPath(),'brand-new.md'))).toBe(false);
  expect(git(localPath(),'status','--porcelain')).toBe('');
  expect(env.commands.filter(args=>args[0]==='push')).toEqual([]);
 });

 it('a checkout with an incomplete rollback cannot be published by a later ordinary writer or retry',async()=>{
  const n=await node('healthy');await debt(n.id,'WRITE');const before=await rows();
  writeFileSync(join(localPath(),'partial.md'),'must never publish');
  writeFileSync(mirrorMutationMarker(localPath()),'repair required');
  await tick();
  expect(await rows()).toEqual(before);expect(env.commands).toEqual([]);
  const mutate=vi.fn();
  expect(await withMirrorCheckout({db,memoryId,obligations:[{nodeId:n.id,kind:'WRITE'}],
   commitSubject:'ordinary write',logPrefix:'[3242]'},mutate)).toBe('failed');
  expect(mutate).not.toHaveBeenCalled();expect(env.commands).toEqual([]);
  expect(await pushMemoryToGit(memoryId)).toMatchObject({nodeCount:0,error:expect.stringContaining('needs repair')});
  expect(env.commands).toEqual([]);
  expect(()=>remote('partial.md')).toThrow();
 });

 it('rollback failure blocks publication while retaining healthy sibling debt unchanged',async()=>{
  const healthy=await node('healthy'),bad=await node('bad');
  baseline({'bad.md':'original'});
  const healthyDebt=await debt(healthy.id,'WRITE');await debt(bad.id,'WRITE');
  const realWrite=files.writeNodeFile,realCopy=fs.cpSync;
  vi.spyOn(files,'writeNodeFile').mockImplementation((...args)=>{
   const result=realWrite(...args);
   if(args[1].id===bad.id)throw new Error('synthetic partial mutation');
   return result;
  });
  vi.spyOn(fs,'cpSync').mockImplementation((source,dest,options)=>{
   if(String(dest)===join(localPath(),'bad.md'))throw new Error('synthetic restore failure');
   return realCopy(source,dest,options);
  });
  await tick();
  const after=await rows();
  expect(after.find(r=>r.nodeId===healthy.id)).toEqual(healthyDebt);
  expect(after.find(r=>r.nodeId===bad.id)).toMatchObject({attempts:10,errorClass:'TREE_WRITE',state:'EXHAUSTED'});
  expect(env.commands.filter(args=>args[0]==='push')).toEqual([]);
  const backup=readFileSync(mirrorMutationMarker(localPath()),'utf8');
  expect(readFileSync(join(backup,'0'),'utf8')).toBe('original');
  // This fixture owns the intentionally retained checkpoint.
  rmSync(backup,{recursive:true,force:true});
 });

});
