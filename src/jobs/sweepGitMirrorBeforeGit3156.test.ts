/** #3156: throwing retry preparation must settle, back off and exhaust. Private DB and local Git only. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { db } from '../integrations/db/client.js';
import { cleanDb } from '../test/helpers.js';
import { generateId } from '../lib/id.js';

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
import { withMirrorCheckout } from '../integrations/github/gitMirrorCheckout.js';
import * as obligations from '../integrations/github/mirrorObligations.js';
import { settleMirrorObligations, takeAttemptSeq } from '../integrations/github/mirrorObligations.js';
import { gitMirrorSweepTick } from './sweepGitMirrorObligations.js';
const SOURCE = 'https://github.com/synthetic/retry3156.git';
const IDENT = { GIT_AUTHOR_NAME: 'test', GIT_AUTHOR_EMAIL: 'test@example.invalid', GIT_COMMITTER_NAME: 'test', GIT_COMMITTER_EMAIL: 'test@example.invalid' };
const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, ...IDENT }, stdio: ['ignore','pipe','pipe'] }).trim();
let memoryId: string;
const tick = (now = new Date()) => gitMirrorSweepTick(db, now);
const old = () => new Date(Date.now()-24*60*60*1000);
const makeNode = () => db.node.create({data:{id:generateId(),memoryId,loc:'topic',name:'Topic',content:'current content',tags:[]}});
const owe = (nodeId: string, extra: {kind?:'WRITE'|'REMOVE';removeLoc?:string} = {}) => db.gitMirrorObligation.create({data:{memoryId,nodeId,kind:'WRITE',removeLoc:'',state:'FAILED',errorClass:'PUSH_FAILED',attempts:1,attemptSeq:0n,lastAttemptAt:old(),...extra}});
const rows = () => db.gitMirrorObligation.findMany({where:{memoryId}});

beforeEach(async () => {
 env.root=mkdtempSync(join(tmpdir(),'beckett-sweep3156-'));
 env.bare=join(env.root,'remote.git'); env.commands=[];
 vi.spyOn(console,'error').mockImplementation(()=>{});
 vi.spyOn(console,'warn').mockImplementation(()=>{});
 vi.spyOn(console,'log').mockImplementation(()=>{});
 await cleanDb(db);
 git(env.root,'init','--bare','-b','main',env.bare);
 const seed=join(env.root,'seed'); mkdirSync(seed);
 git(seed,'init','-b','main'); writeFileSync(join(seed,'seed.txt'),'seed');
 git(seed,'add','-A'); git(seed,'commit','-m','seed'); git(seed,'push',env.bare,'main');
 const org=await db.organization.create({data:{name:'Retry fixture',urn:'retry3156.test'}});
 const memory=await db.memory.create({data:{organizationId:org.id,name:'Retry',urn:'retry3156.test:memory',class:'knowledge',source:SOURCE}});
 memoryId=memory.id;
 const local=join(env.root,org.urn,'memory'); mkdirSync(join(env.root,org.urn));
 execFileSync('git',['-c','protocol.allow=never','-c','protocol.file.allow=always','-c',`url.${env.bare}.insteadOf=${SOURCE}`,'clone',SOURCE,local],{stdio:'ignore'});
});
afterEach(()=>{vi.restoreAllMocks();rmSync(env.root,{recursive:true,force:true});});

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
  expect(env.commands).toEqual([]);
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
  expect(env.commands).toEqual([]);
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
  expect(reads).toBe(2); expect(sequences.mock.calls.length).toBe(0); expect(await rows()).toEqual(before); expect(env.commands).toEqual([]);
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
