/** #3156: throwing retry preparation must settle, back off and exhaust. Private DB and local Git only. */
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
import * as obligations from '../integrations/github/mirrorObligations.js';
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
 env.root=mkdtempSync(join(tmpdir(),'beckett-sweep3156-'));
 env.bare=mkdtempSync(join(tmpdir(),'beckett-sweep3156-bare-'));
 env.failOn=null;env.stdoutFor=null;env.tokenFails=false;env.onRetryLock=null;commands=[];errors=[];
 vi.spyOn(console,'error').mockImplementation((...a)=>errors.push(a.map(String).join(' ')));
 vi.spyOn(console,'warn').mockImplementation((...a)=>errors.push(a.map(String).join(' ')));
 vi.spyOn(console,'log').mockImplementation(()=>{});
 await cleanDb(db);await setup();
 env.failOn=(args)=>{commands.push(args);return false;};
});
afterEach(()=>{vi.unstubAllEnvs();vi.restoreAllMocks();rmSync(env.root,{recursive:true,force:true});rmSync(env.bare,{recursive:true,force:true});});


describe('#3156 retry throws', () => {
 it.each(['REMOVE', 'WRITE'] as const)('%s beforeGit throws settle LOCK_FAILED, back off and exhaust across 12 weekly ticks', async kind => {
  const n = await makeNode();
  const initial = await owe(n.id, { kind, removeLoc: kind === 'REMOVE' ? 'old' : '' });
  const hook = kind === 'REMOVE'
   ? vi.spyOn(db.node, 'findFirst').mockRejectedValue(new Error('synthetic liveOwner read outage'))
   : vi.spyOn(db.node, 'findUnique').mockRejectedValue(new Error('synthetic first refresh outage'));
  const sequences = vi.spyOn(obligations, 'tryTakeAttemptSeq');
  const now = Date.now();
  const snapshots = [];
  for (let i = 0; i < 12; i++) {
   await tick(new Date(now + i * 7 * 24 * 60 * 60_000));
   snapshots.push((await rows())[0]);
  }
  expect(snapshots.map(r => r.attempts)).toEqual([2,3,4,5,6,7,8,9,10,10,10,10]);
  expect(snapshots[0].lastAttemptAt.getTime()).toBeGreaterThan(initial.lastAttemptAt.getTime());
  expect(snapshots.slice(0,9).every(r => r.errorClass === 'LOCK_FAILED')).toBe(true);
  expect(snapshots[8]).toMatchObject({ state: 'EXHAUSTED', attempts: 10 });
  expect(snapshots.slice(9)).toEqual([snapshots[8],snapshots[8],snapshots[8]]);
  expect(hook).toHaveBeenCalledTimes(9);
  expect(sequences).toHaveBeenCalledTimes(9); // reuse the taken fence, never allocate in the retry catch
  expect(commands).toEqual([]);
 });

 it('restarts backoff after a throwing hook and retries only at the new exact boundary', async () => {
  const n = await makeNode(); await owe(n.id);
  const hook = vi.spyOn(db.node, 'findFirst').mockRejectedValue(new Error('synthetic liveOwner outage'));
  await db.gitMirrorObligation.updateMany({ where: { memoryId }, data: { kind: 'REMOVE', removeLoc: 'old' } });
  await tick();
  const after = (await rows())[0];
  expect(after).toMatchObject({attempts:2,errorClass:'LOCK_FAILED',state:'FAILED'});
  await tick(new Date(after.lastAttemptAt.getTime() + 10 * 60_000 - 1));
  expect(await rows()).toEqual([after]); expect(hook).toHaveBeenCalledTimes(1);
  await tick(new Date(after.lastAttemptAt.getTime() + 10 * 60_000));
  expect((await rows())[0]).toMatchObject({attempts:3,errorClass:'LOCK_FAILED'});
  expect(hook).toHaveBeenCalledTimes(2);
 });

 it('a throw with a taken retry sequence cannot overwrite a newer row', async () => {
  const n = await makeNode(); await owe(n.id);
  let newer: Awaited<ReturnType<typeof rows>> = [];
  const sequences = vi.spyOn(obligations, 'tryTakeAttemptSeq');
  const result = await withMirrorCheckout({ db, memoryId, obligations: [{ nodeId:n.id,kind:'WRITE' }],
   retry:{now:new Date(),maxAttempts:10}, commitSubject:'stale retry',logPrefix:'[3156]', beforeGit:async()=>{
    await settleMirrorObligations(db,memoryId,[{nodeId:n.id,kind:'WRITE'}],{result:'failed',errorClass:'PUSH_FAILED'},await takeAttemptSeq(db));
    newer = await rows(); throw new Error('synthetic stale hook');
   },
  }, () => { throw new Error('must not mutate'); });
  expect(result).toBe('failed');
  expect(await rows()).toEqual(newer);
  expect(sequences).toHaveBeenCalledTimes(1);
  expect(commands).toEqual([]);
 });

 it('a retry throwing inside the lock before taking a sequence preserves the row and does not invent an attempt', async () => {
  const n = await makeNode(); await owe(n.id); const before = await rows();
  const read = db.memory.findUnique.bind(db.memory); let reads = 0;
  vi.spyOn(db.memory,'findUnique').mockImplementation((...args: Parameters<typeof read>) => {
   if (++reads === 2) throw new Error('synthetic locked configuration outage');
   return read(...args);
  });
  const sequences = vi.spyOn(obligations,'tryTakeAttemptSeq');
  expect(await withMirrorCheckout({db,memoryId,obligations:[{nodeId:n.id,kind:'WRITE'}],retry:{now:new Date(),maxAttempts:10},commitSubject:'pre-sequence',logPrefix:'[3156]'},()=>{})).toBe('failed');
  expect(reads).toBe(2); expect(sequences).not.toHaveBeenCalled(); expect(await rows()).toEqual(before); expect(commands).toEqual([]);
 });

 it('a throwing second WRITE refresh remains TREE_WRITE and increments once', async () => {
  const n=await makeNode(); await owe(n.id);
  const read=db.node.findUnique.bind(db.node); let reads=0;
  vi.spyOn(db.node,'findUnique').mockImplementation((...args: Parameters<typeof read>)=>{
   if (++reads===2) throw new Error('synthetic second refresh outage');
   return read(...args);
  });
  await tick();
  expect(reads).toBe(2); expect((await rows())[0]).toMatchObject({state:'FAILED',attempts:2,errorClass:'TREE_WRITE'});
 });
});
