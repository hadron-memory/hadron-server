/** #430 retry sweep: real Git, private bare remotes only. Red-first consumer pins. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'child_process';
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { db } from '../integrations/db/client.js';
import { cleanDb } from '../test/helpers.js';
import { generateId } from '../lib/id.js';

const env = vi.hoisted(() => ({
  tokenFails: false, root: '', bare: '', failOn: null as null | ((args: string[]) => boolean),
  stdoutFor: null as null | ((args: string[]) => string | null),
}));
const TOKEN = 'tok-430-secret';
vi.mock('../integrations/github/githubApp.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../integrations/github/githubApp.js')>()),
  getInstallationToken: vi.fn(async () => { if (env.tokenFails) throw new Error(`https://x-access-token:${TOKEN}@github.com/acme/repo.git`); return TOKEN; }),
}));
vi.mock('../config.js', () => ({ get GRAPHS_PATH() { return env.root; } }));
vi.mock('../integrations/github/execGit.js', () => ({
  execGit: vi.fn(async (args: string[], options: { cwd?: string; env?: NodeJS.ProcessEnv } = {}) => {
    if (env.failOn?.(args)) throw new Error('Git command failed. Check the repository and branch, then retry.');
    const forged = env.stdoutFor?.(args);
    if (forged != null) return { stdout: forged, stderr: '' };
    try {
      const stdout = execFileSync('git', [
        '-c', 'protocol.allow=never', '-c', 'protocol.file.allow=always',
        '-c', `url.${env.bare}.insteadOf=${SOURCE}`,
        '-c', `url.${env.bare}.insteadOf=${SOURCE.replace('https://github.com/', `https://x-access-token:${TOKEN}@github.com/`)}`,
        ...args,
      ], { ...options, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
      return { stdout, stderr: '' };
    } catch {
      throw new Error('Git command failed. Check the repository and branch, then retry.');
    }
  }),
}));

import { withMirrorCheckout } from '../integrations/github/gitMirrorCheckout.js';
import { writeNodeToGit } from '../integrations/github/writeNodeToGit.js';
import { settleMirrorObligations, takeAttemptSeq, type MirrorObligationRef } from '../integrations/github/mirrorObligations.js';

const SOURCE = 'https://github.com/acme/repo.git';
const IDENT = { GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };
const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, ...IDENT } }).trim();

let memoryId: string;
let local: string;
let errors: string[];

/** Seed the bare remote: `main` (HEAD) and optionally `develop` one commit ahead of it. */
function seedRemote(opts: { develop?: boolean; empty?: boolean } = {}) {
  git(env.bare, 'init', '--bare', '-b', 'main');
  if (opts.empty) return;
  const seed = mkdtempSync(join(tmpdir(), 'hadron-seed-'));
  git(seed, 'init', '-b', 'main');
  writeFileSync(join(seed, 'seed.txt'), 'seed');
  git(seed, 'add', '-A'); git(seed, 'commit', '-m', 'seed');
  if (opts.develop) {
    git(seed, 'checkout', '-b', 'develop');
    writeFileSync(join(seed, 'dev.txt'), 'dev');
    git(seed, 'add', '-A'); git(seed, 'commit', '-m', 'dev');
    git(seed, 'checkout', 'main');
  }
  git(seed, 'push', env.bare, '--all');
  rmSync(seed, { recursive: true, force: true });
}

async function setup(opts: { develop?: boolean; empty?: boolean; readBranch?: string; token?: boolean } = {}) {
  seedRemote(opts);
  const org = await db.organization.create({ data: { id: generateId(), name: 'o', urn: 'mirror430-org', ...(opts.token ? { githubInstallationId: 4242 } : {}) } });
  const memory = await db.memory.create({
    data: {
      id: generateId(), organizationId: org.id, name: 'mem', urn: 'mirror430-org:mem',
      class: 'knowledge', source: SOURCE, readBranch: opts.readBranch ?? null,
    },
  });
  memoryId = memory.id;
  local = join(env.root, org.urn, 'mem');
  mkdirSync(join(env.root, org.urn), { recursive: true });
  // The clone's origin is the github URL, rewritten to the bare repo by insteadOf.
  execFileSync('git', ['-c', 'protocol.file.allow=always', '-c', `url.${env.bare}.insteadOf=${SOURCE}`,
    'clone', ...(opts.readBranch ? ['--branch', opts.readBranch] : []), SOURCE, local], { stdio: 'ignore' });
}

import { nodeFilePath } from '../integrations/github/nodeFrontmatter.js';
import { withMirrorCheckoutLock } from '../integrations/github/mirrorCheckoutLock.js';
import { validateMemoryNodes } from '../lib/memoryValidation.js';
import { existsSync } from 'fs';

const tick = async (now = new Date()) => (await import('./sweepGitMirrorObligations.js')).gitMirrorSweepTick(db, now);
const old = () => new Date(Date.now()-24*60*60*1000);
const makeNode = (loc='topic') => db.node.create({data:{id:generateId(),memoryId,loc,name:loc,content:'current content',tags:[]}});
const owe = async (nodeId:string,extra:Record<string,unknown>={}) => db.gitMirrorObligation.create({data:{memoryId,nodeId,kind:'WRITE',removeLoc:'',state:'FAILED',errorClass:'PUSH_FAILED',attempts:1,attemptSeq:await takeAttemptSeq(db),lastAttemptAt:old(),...extra} as any});
const rows = () => db.gitMirrorObligation.findMany({where:{memoryId}});
const remoteFile = (loc='topic') => git(env.bare,'show',`refs/heads/hadron-updates:${loc}.md`);
const rejectPushes = () => {const hook=join(env.bare,'hooks','pre-receive');writeFileSync(hook,'#!/bin/sh\nexit 1\n');chmodSync(hook,0o755);};
let commands:string[][];

beforeEach(async()=>{
 env.root=mkdtempSync(join(tmpdir(),'dorian-sweep430-'));
 env.bare=mkdtempSync(join(tmpdir(),'dorian-sweep430-bare-'));
 env.failOn=null;env.stdoutFor=null;env.tokenFails=false;commands=[];errors=[];
 vi.spyOn(console,'error').mockImplementation((...a)=>errors.push(a.map(String).join(' ')));
 vi.spyOn(console,'warn').mockImplementation((...a)=>errors.push(a.map(String).join(' ')));
 vi.spyOn(console,'log').mockImplementation(()=>{});
 await cleanDb(db);await setup();
 env.failOn=(args)=>{commands.push(args);return false;};
});
afterEach(()=>{vi.restoreAllMocks();rmSync(env.root,{recursive:true,force:true});rmSync(env.bare,{recursive:true,force:true});});

it('retries an existing failed WRITE and clears it only after the current file is pushed',async()=>{
 const n=await makeNode();await owe(n.id);
 await tick();expect(await rows()).toEqual([]);expect(remoteFile()).toContain('current content');
 expect(commands.some(a=>a[0]==='push')).toBe(true);
});
it('loads current content, not the snapshot from the failed write',async()=>{
 const n=await makeNode();await owe(n.id);await db.node.update({where:{id:n.id},data:{content:'new content after failure'}});
 await tick();expect(remoteFile()).toContain('new content after failure');expect(await rows()).toEqual([]);
});
it('keeps REMOVE while an unowned file remains, then clears after verified absence',async()=>{
 const n=await makeNode('new');const p=nodeFilePath(local,'old','mirror430-org:mem');
 writeFileSync(p,'---\nid: somebody-else\n---\nold');
 await owe(n.id,{kind:'REMOVE',removeLoc:'old'});
 await tick();expect(await rows()).toHaveLength(1);expect(existsSync(p)).toBe(true);
 // The publisher verified a remaining path, so it must not report success merely because removeNodeFile did nothing.
 writeFileSync(p,`---\nid: ${n.id}\n---\nold`);
 await db.gitMirrorObligation.updateMany({where:{memoryId},data:{lastAttemptAt:old()}});
 await tick();expect(await rows()).toEqual([]);expect(existsSync(p)).toBe(false);
 expect(()=>remoteFile('old')).toThrow();
});
it('clears a REMOVE whose loc a live node now owns without any Git command',async()=>{
 const moved=await makeNode('new');const owner=await makeNode('old');
 const p=nodeFilePath(local,'old','mirror430-org:mem');writeFileSync(p,`---\nid: ${moved.id}\n---\nold`);
 await owe(moved.id,{kind:'REMOVE',removeLoc:'old'});
 await tick();expect(await rows()).toEqual([]);expect(existsSync(p)).toBe(true);expect(commands).toEqual([]);expect(owner.id).not.toBe(moved.id);
});
it('re-reads under the held lock and never revives a newer writer success',async()=>{
 const n=await makeNode();await owe(n.id);let release!:()=>void;let entered!:()=>void;
 const acquired=new Promise<void>(r=>entered=r);const hold=new Promise<void>(r=>release=r);
 const holder=withMirrorCheckoutLock(memoryId,async()=>{entered();await hold;await settleMirrorObligations(db,memoryId,[{nodeId:n.id,kind:'WRITE'}],{result:'cleared'},await takeAttemptSeq(db));});
 await acquired;const running=tick().then(()=>null,error=>error);await new Promise(r=>setTimeout(r,60));release();await holder;const error=await running;if(error) throw error;
 expect(await rows()).toEqual([]);expect(commands).toEqual([]);
});
it('honors the derived backoff and retries at its exact boundary',async()=>{
 const n=await makeNode();const at=new Date();await owe(n.id,{lastAttemptAt:at,attempts:2});
 await tick(new Date(at.getTime()+10*60_000-1));expect(commands).toEqual([]);expect((await rows())[0].attempts).toBe(2);
 await tick(new Date(at.getTime()+10*60_000));expect(await rows()).toEqual([]);expect(commands.some(a=>a[0]==='push')).toBe(true);
});
it('exhausts the tenth failed attempt, exposes the cap in validate, and never retries it again',async()=>{
 const n=await makeNode();await owe(n.id,{attempts:9});rejectPushes();
 await tick();expect((await rows())[0]).toMatchObject({state:'EXHAUSTED',attempts:10,errorClass:'PUSH_FAILED'});
 const f=(await validateMemoryNodes(db,memoryId)).findings.find(f=>f.kind==='GIT_MIRROR_FAILED');
 expect(f?.detail).toContain('retries stopped after 10 attempts');commands=[];
 await tick(new Date(Date.now()+7*24*60*60_000));expect(commands).toEqual([]);expect((await rows())[0].attempts).toBe(10);
});
it('ordinary writer failure after EXHAUSTED stays outside the sweep cap, while ordinary success clears',async()=>{
 const n=await makeNode();await owe(n.id,{state:'EXHAUSTED',attempts:10});rejectPushes();
 await writeNodeToGit({...n,outgoingEdges:[]},'',null,memoryId);
 expect((await rows())[0]).toMatchObject({state:'FAILED',attempts:11});commands=[];
 await tick(new Date(Date.now()+7*24*60*60_000));expect(commands).toEqual([]);
 rmSync(join(env.bare,'hooks','pre-receive'));
 await writeNodeToGit({...n,outgoingEdges:[]},'',null,memoryId);expect(await rows()).toEqual([]);
});
it('does not burn a NOT_CLONED attempt until a clone exists',async()=>{
 const n=await makeNode();await owe(n.id,{state:'NOT_CLONED',errorClass:'NOT_CLONED'});rmSync(join(local,'.git'),{recursive:true});
 const before=await rows();await tick();expect(await rows()).toEqual(before);expect(commands).toEqual([]);
});
it.each(['encrypted','no-source','no-org','invalid-source'])('leaves %s memory rows and Git untouched',async mode=>{
 const n=await makeNode();await owe(n.id);
 const owner=mode==='no-org'?await db.user.create({data:{githubId:430999,githubUsername:'sweep-owner'}}):null;
 await db.memory.update({where:{id:memoryId},data:mode==='encrypted'?{isEncrypted:true}:mode==='no-source'?{source:null}:mode==='no-org'?{organizationId:null,ownerUserId:owner!.id}:{source:'https://attacker.invalid/repo'}});
 const before=await rows();await tick();expect(await rows()).toEqual(before);expect(commands).toEqual([]);
});
it('never logs or stores a token-bearing Git provider error',async()=>{
 const n=await makeNode();await owe(n.id);await db.organization.updateMany({where:{urn:'mirror430-org'},data:{githubInstallationId:4242}});env.tokenFails=true;
 await tick();expect((await rows())[0]).toMatchObject({state:'FAILED',errorClass:'TOKEN_UNAVAILABLE',attempts:2});
 expect(JSON.stringify(await rows(),(_,v)=>typeof v==='bigint'?v.toString():v)).not.toContain(TOKEN);expect(errors.join('\n')).not.toContain(TOKEN);
});
it('clears a missing or soft-deleted WRITE without Git or republishing a tombstone',async()=>{
 const n=await makeNode();await owe(n.id);const path=nodeFilePath(local,n.loc,'mirror430-org:mem');writeFileSync(path,'pre-existing tombstone file');
 await db.node.update({where:{id:n.id},data:{deletedAt:new Date()}});await owe('hard-missing');
 await tick();expect(await rows()).toEqual([]);expect(commands).toEqual([]);expect(readFileSync(path,'utf8')).toBe('pre-existing tombstone file');
});
it('a late cap-reaching settle cannot turn a newer row into EXHAUSTED',async()=>{
 const n=await makeNode();await owe(n.id,{attempts:9});const stale=await takeAttemptSeq(db);const newer=await takeAttemptSeq(db);
 await settleMirrorObligations(db,memoryId,[{nodeId:n.id,kind:'WRITE'}],{result:'failed',errorClass:'BRANCH_SETUP'},newer);
 const before=await rows();
 await settleMirrorObligations(db,memoryId,[{nodeId:n.id,kind:'WRITE'}],{result:'failed',errorClass:'PUSH_FAILED'},stale,10);
 expect(await rows()).toEqual(before);expect((await rows())[0].state).toBe('FAILED');
});
it('rechecks encryption after waiting for the checkout lock and leaves the row untouched',async()=>{
 const n=await makeNode();await owe(n.id);const before=await rows();let release!:()=>void;let entered!:()=>void;
 const acquired=new Promise<void>(r=>entered=r);const hold=new Promise<void>(r=>release=r);
 const holder=withMirrorCheckoutLock(memoryId,async()=>{entered();await hold;await db.memory.update({where:{id:memoryId},data:{isEncrypted:true}});});
 await acquired;const running=tick().then(()=>null,e=>e);await new Promise(r=>setTimeout(r,60));release();await holder;const e=await running;if(e)throw e;
 expect(await rows()).toEqual(before);expect(commands).toEqual([]);
});
it('skips overlapping local runs and processes the held first run once',async()=>{
 const n=await makeNode();await owe(n.id);let release!:()=>void;let entered!:()=>void;
 const acquired=new Promise<void>(r=>entered=r);const hold=new Promise<void>(r=>release=r);
 const holder=withMirrorCheckoutLock(memoryId,async()=>{entered();await hold;});await acquired;
 const first=tick().then(()=>null,e=>e);await new Promise(r=>setTimeout(r,50));
 try {expect(await tick()).toBe(0);expect(commands).toEqual([]);} finally {release();await holder;}
 const e=await first;if(e)throw e;expect(await rows()).toEqual([]);expect(commands.filter(a=>a[0]==='push')).toHaveLength(1);
});
it('handles at most20 eligible memories, oldest due first, without a startup pass',async()=>{
 const org=await db.organization.findUniqueOrThrow({where:{urn:'mirror430-org'}});
 const ids:string[]=[];
 for(let i=0;i<21;i++){
  const m=await db.memory.create({data:{name:`m${i}`,urn:`mirror430-org:m${i}`,organizationId:org.id,class:'knowledge',source:SOURCE}});ids.push(m.id);
  mkdirSync(join(env.root,org.urn,`m${i}`,'.git'),{recursive:true});
  await db.gitMirrorObligation.create({data:{memoryId:m.id,nodeId:`missing${i}`,kind:'WRITE',removeLoc:'',state:'FAILED',errorClass:'PUSH_FAILED',attempts:1,attemptSeq:await takeAttemptSeq(db),lastAttemptAt:new Date(old().getTime()-i*60_000)}});
 }
 expect(await tick()).toBe(20);
 const left=await db.gitMirrorObligation.findMany();expect(left).toHaveLength(1);expect(left[0].memoryId).toBe(ids[0]);expect(commands).toEqual([]);
});
it('starts only on the interval and honors both disable modes',async()=>{
 const {startGitMirrorObligationSweepLoop:start}=await import('./sweepGitMirrorObligations.js');
 expect(start(db)).toBeNull();vi.stubEnv('NODE_ENV','production');vi.stubEnv('DISABLE_GIT_MIRROR_SWEEP','true');expect(start(db)).toBeNull();
 vi.stubEnv('DISABLE_GIT_MIRROR_SWEEP','false');vi.useFakeTimers();const query=vi.fn().mockResolvedValue([]);const timer=start({$queryRaw:query} as any,10_000);
 try {expect(query).not.toHaveBeenCalled();await vi.advanceTimersByTimeAsync(9999);expect(query).not.toHaveBeenCalled();await vi.advanceTimersByTimeAsync(1);expect(query).toHaveBeenCalledTimes(1);}
 finally {if(timer)clearInterval(timer);vi.useRealTimers();vi.unstubAllEnvs();}
});
it('loads node content only after a waiting retry acquires its memory lock',async()=>{
 const n=await makeNode();await owe(n.id);let release!:()=>void;let entered!:()=>void;
 const acquired=new Promise<void>(r=>entered=r);const hold=new Promise<void>(r=>release=r);
 const holder=withMirrorCheckoutLock(memoryId,async()=>{entered();await hold;await db.node.update({where:{id:n.id},data:{content:'changed while sweep waited'}});});
 await acquired;const running=tick().then(()=>null,e=>e);await new Promise(r=>setTimeout(r,60));release();await holder;const e=await running;if(e)throw e;
 expect(await rows()).toEqual([]);expect(remoteFile()).toContain('changed while sweep waited');
});
