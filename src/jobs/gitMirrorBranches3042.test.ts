/** #3042 branch-aware retry: real local bare Git, no provider/network access. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'child_process';
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { db } from '../integrations/db/client.js';
import { cleanDb } from '../test/helpers.js';
import { generateId } from '../lib/id.js';

const env = vi.hoisted(() => ({
  onRetryLock: null as null | (() => void),
  tokenFails: false, root: '', bare: '', failOn: null as null | ((args: string[]) => boolean),
  stdoutFor: null as null | ((args: string[]) => string | null),
}));
const TOKEN = 'tok-430-secret';
vi.mock('../integrations/github/githubApp.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../integrations/github/githubApp.js')>()),
  getInstallationToken: vi.fn(async () => { if (env.tokenFails) throw new Error(`https://x-access-token:${TOKEN}@github.com/acme/repo.git`); return TOKEN; }),
}));
vi.mock('../config.js', () => ({ get GRAPHS_PATH() { return env.root; } }));
// Observe queue arrival without replacing the real PostgreSQL lock. A sleep alone can release the holder
// before a cold dynamic import reaches the sweep, making an apparent interleave vacuous.
vi.mock('../integrations/github/mirrorCheckoutLock.js', async importOriginal => {
 const real = await importOriginal<typeof import('../integrations/github/mirrorCheckoutLock.js')>();
 return {...real, withMirrorCheckoutLock: <T>(id: string, work: () => Promise<T>, opts?: {fenceEncryption?: boolean}) => {
  if (opts?.fenceEncryption) env.onRetryLock?.();
  return real.withMirrorCheckoutLock(id, work, opts);
 }};
});
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
const retryQueued = () => new Promise<void>(resolve => { env.onRetryLock = resolve; });
const expectQueued = (waiting: Promise<void>, running: Promise<unknown>) => Promise.race([
 waiting, running.then(error => { throw error ?? new Error('sweep finished before requesting the checkout lock'); }),
]);


beforeEach(async()=>{
 env.root=mkdtempSync(join(tmpdir(),'dorian-sweep430-'));
 env.bare=mkdtempSync(join(tmpdir(),'dorian-sweep430-bare-'));
 env.failOn=null;env.stdoutFor=null;env.tokenFails=false;env.onRetryLock=null;commands=[];errors=[];
 vi.spyOn(console,'error').mockImplementation((...a)=>errors.push(a.map(String).join(' ')));
 vi.spyOn(console,'warn').mockImplementation((...a)=>errors.push(a.map(String).join(' ')));
 vi.spyOn(console,'log').mockImplementation(()=>{});
 await cleanDb(db);await setup();
 env.failOn=(args)=>{commands.push(args);return false;};
});
afterEach(()=>{vi.unstubAllEnvs();vi.restoreAllMocks();rmSync(env.root,{recursive:true,force:true});rmSync(env.bare,{recursive:true,force:true});});


const ref = (nodeId: string, branch: string, removeLoc?: string) => ({ nodeId, branch, kind: removeLoc === undefined ? 'WRITE' : 'REMOVE', ...(removeLoc === undefined ? {} : { removeLoc }) }) as MirrorObligationRef;
const fail = async (nodeId: string, branch: string, seq?: bigint) => settleMirrorObligations(db,memoryId,[ref(nodeId,branch)],{result:'failed',errorClass:'PUSH_FAILED'},seq ?? await takeAttemptSeq(db));
const age = () => db.gitMirrorObligation.updateMany({where:{memoryId},data:{lastAttemptAt:old()}});
const on = (branch: string, loc='topic') => git(env.bare,'show',`refs/heads/${branch}:${loc}.md`);
const rekey = (nodeId: string, from: string, to: string, seq: bigint, result: 'failed'|'cleared'='failed', cap=10) =>
 (settleMirrorObligations as any)(db,memoryId,[ref(nodeId,from)], result==='cleared'?{result}:{result,errorClass:'PUSH_FAILED'},seq,cap,{targetBranch:to});

it('records two client branches independently and fences A success away from B',async()=>{
 const n=await makeNode();await fail(n.id,'client/A',10n);await fail(n.id,'client/B',20n);
 expect(await rows()).toHaveLength(2);
 await settleMirrorObligations(db,memoryId,[ref(n.id,'client/A')],{result:'cleared'},30n);
 expect(await rows()).toEqual([expect.objectContaining({branch:'client/B',attemptSeq:20n})]);
});
it('captures the actual ordinary writer branch on push failure',async()=>{
 const n=await makeNode();await db.memory.update({where:{id:memoryId},data:{writeBranch:'client/{client}'}});rejectPushes();
 await writeNodeToGit({...n,outgoingEdges:[]},'','A',memoryId);
 expect(await rows()).toEqual([expect.objectContaining({branch:'client/A',errorClass:'PUSH_FAILED'})]);
});
it('sweep retries only recorded A and never invents an unknown branch',async()=>{
 const n=await makeNode();await db.memory.update({where:{id:memoryId},data:{writeBranch:'client/{client}'}});await fail(n.id,'client/A');await age();
 await tick();expect(await rows()).toEqual([]);expect(on('client/A')).toContain('current content');
 expect(git(env.bare,'for-each-ref','--format=%(refname)','refs/heads')).toBe('refs/heads/client/A\nrefs/heads/main');
});
it('A success and B failure preserve separate attempts then B succeeds',async()=>{
 const n=await makeNode();await db.memory.update({where:{id:memoryId},data:{writeBranch:'client/{client}'}});await fail(n.id,'client/A');await fail(n.id,'client/B');await age();
 env.failOn=a=>{commands.push(a);return a[0]==='push'&&a.some(v=>v.includes('refs/heads/client/B:'));};
 await tick();expect(await rows()).toEqual([expect.objectContaining({branch:'client/B',attempts:2})]);expect(on('client/A')).toContain('current content');
 env.failOn=a=>{commands.push(a);return false;};await age();await tick();expect(await rows()).toEqual([]);expect(on('client/B')).toContain('current content');
});
it('legacy templated and tombstoned legacy rows remain visible with zero Git',async()=>{
 const n=await makeNode();await owe(n.id);await db.memory.update({where:{id:memoryId},data:{writeBranch:'client/{client}'}});await db.node.update({where:{id:n.id},data:{deletedAt:new Date()}});
 const before=await rows();await tick();expect(await rows()).toEqual(before);expect(commands).toEqual([]);
 expect((await validateMemoryNodes(db,memoryId)).findings.some(f=>f.kind==='GIT_MIRROR_FAILED')).toBe(true);
});
it('templated config drift retains debt without sequence or attempt',async()=>{
 const n=await makeNode();await fail(n.id,'client/A');await age();await db.memory.update({where:{id:memoryId},data:{writeBranch:'different/{client}'}});
 const before=await rows();const seq=await takeAttemptSeq(db);await tick();expect(await takeAttemptSeq(db)).toBe(seq+1n);expect(await rows()).toEqual(before);expect(commands).toEqual([]);
});
it.each(['fixed-before','client/A',''])('fixed config retries old branch %s on current branch',async branch=>{
 const n=await makeNode();await fail(n.id,branch);await age();await db.memory.update({where:{id:memoryId},data:{writeBranch:'fixed-now'}});
 await tick();expect(await rows()).toEqual([]);expect(on('fixed-now')).toContain('current content');
});
it('invalid ordinary final branch runs no Git, logs no branch and clears no debt',async()=>{
 const n=await makeNode();await fail(n.id,'safe');const before=await rows();await db.memory.update({where:{id:memoryId},data:{writeBranch:'{client}'}});
 await writeNodeToGit({...n,outgoingEdges:[]},'','-synthetic-secret',memoryId);
 expect(await rows()).toEqual(before);expect(commands).toEqual([]);expect(errors.join(' ')).not.toContain('-synthetic-secret');
});
it('invalid recorded branch is retained without Git, sequence or raw text',async()=>{
 const n=await makeNode();await fail(n.id,'-synthetic-secret');await age();await db.memory.update({where:{id:memoryId},data:{writeBranch:'{client}'}});
 const before=await rows(),seq=await takeAttemptSeq(db);await tick();expect(await takeAttemptSeq(db)).toBe(seq+1n);expect(await rows()).toEqual(before);expect(commands).toEqual([]);expect(errors.join(' ')).not.toContain('-synthetic-secret');
});
it('missing WRITE clears only its attempted branch while legacy template debt remains',async()=>{
 await db.memory.update({where:{id:memoryId},data:{writeBranch:'client/{client}'}});await fail('missing','client/A');await fail('missing','client/B');await fail('missing','');await age();
 await tick();expect(await rows()).toEqual([expect.objectContaining({branch:''})]);expect(commands).toEqual([]);
});
it('recreates a recorded remote branch deleted since failure',async()=>{
 const n=await makeNode();await fail(n.id,'client/A');await age();await db.memory.update({where:{id:memoryId},data:{writeBranch:'client/{client}'}});
 await tick();git(env.bare,'update-ref','-d','refs/heads/client/A');await fail(n.id,'client/A');await age();await tick();expect(on('client/A')).toContain('current content');expect(await rows()).toEqual([]);
});
it.each(['failed','cleared'] as const)('stale A %s cannot touch newer A or B',async result=>{
 const n=await makeNode();await fail(n.id,'A',20n);await fail(n.id,'B',21n);const before=await rows();
 await rekey(n.id,'A','B',10n,result);expect(await rows()).toEqual(before);
});
it('re-key collision merges attempts with cap and removes only captured old debt',async()=>{
 const n=await makeNode();await fail(n.id,'old',10n);await fail(n.id,'new',11n);
 await db.gitMirrorObligation.updateMany({where:{memoryId,branch:'old'} as any,data:{attempts:8}});await db.gitMirrorObligation.updateMany({where:{memoryId,branch:'new'} as any,data:{attempts:9}});
 await rekey(n.id,'old','new',20n);expect(await rows()).toEqual([expect.objectContaining({branch:'new',attempts:10,state:'EXHAUSTED',attemptSeq:20n})]);
});
it.each(['failed','cleared'] as const)('re-key %s leaves newer destination byte-identical',async result=>{
 const n=await makeNode();await fail(n.id,'old',10n);await fail(n.id,'new',30n);const newer=(await rows()).find((r:any)=>r.branch==='new');
 await rekey(n.id,'old','new',20n,result);expect(await rows()).toEqual([newer]);
});
it('re-key success removes old and older destination',async()=>{
 const n=await makeNode();await fail(n.id,'old',10n);await fail(n.id,'new',11n);await rekey(n.id,'old','new',20n,'cleared');expect(await rows()).toEqual([]);
});
it('a missing captured source cannot recreate destination debt',async()=>{
 const n=await makeNode();await rekey(n.id,'missing','new',20n);expect(await rows()).toEqual([]);
});
it('failed fixed-branch retry moves captured debt to the actual attempted branch',async()=>{
 const n=await makeNode();await fail(n.id,'old');await age();await db.memory.update({where:{id:memoryId},data:{writeBranch:'new'}});rejectPushes();
 await tick();expect(await rows()).toEqual([expect.objectContaining({branch:'new',attempts:2,errorClass:'PUSH_FAILED'})]);
});
