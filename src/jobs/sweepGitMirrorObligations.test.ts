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

import * as nodeLoader from '../integrations/github/nodeWrittenSubscriber.js';
import * as mirrorDebt from '../integrations/github/mirrorObligations.js';
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

/** #3444 diagnostic sink: one JSON line, stderr (console is mocked per test). */
type DiagnosticSink = (record: Record<string, unknown>) => void;
const stderrSink: DiagnosticSink = record => { process.stderr.write(`[#3444 diagnostic] ${JSON.stringify(record)}\n`); };
type DiagnosticContext = { labels: Record<string, string>; counters: () => Record<string, unknown>; startedAt: number };
const DIAGNOSTIC_CAP = 16;
const clip = (value: unknown) => String(value).slice(0, 80);
const scalar = (value: unknown) => typeof value === 'number' || typeof value === 'boolean' ? value : clip(value);
/**
 * #3444 (Refs only; the flake stays UNCONFIRMED): run one post-tick read, and only if it throws, emit one bounded,
 * whitelisted record of the memory's obligation rows before rethrowing the ORIGINAL error object unchanged.
 * A passing read costs nothing: no query, no counters call, no output. Bounds per the CHECKED gate: `take: 16` with a
 * scalar `select` (never materialize then slice), at most 16 rows and 16 command categories (argv[0] only) with cap
 * markers, every string at most 80 characters, node ids mapped to fixture labels or `other`. A capture or sink
 * failure is swallowed after a note naming its class only; it never replaces the original error.
 */
async function readOrDiagnose<T>(read: () => Promise<T>, ctx: DiagnosticContext, emit: DiagnosticSink = stderrSink): Promise<T> {
 try {
  return await read();
 } catch (original) {
  try {
   let record: Record<string, unknown>;
   try {
    const found = await db.gitMirrorObligation.findMany({
     where: { memoryId }, orderBy: { lastAttemptAt: 'asc' }, take: DIAGNOSTIC_CAP,
     select: { nodeId: true, kind: true, state: true, errorClass: true, attempts: true, attemptSeq: true, lastAttemptAt: true },
    });
    record = {
     diagnostic: 'post_tick_read_failed',
     elapsedMs: Date.now() - ctx.startedAt,
     counters: Object.fromEntries(Object.entries(ctx.counters()).slice(0, DIAGNOSTIC_CAP).map(([k, v]) => [clip(k), scalar(v)])),
     rows: found.map(row => ({
      node: clip(ctx.labels[row.nodeId] ?? 'other'), kind: clip(row.kind), state: clip(row.state),
      errorClass: clip(row.errorClass), attempts: row.attempts, attemptSeq: clip(row.attemptSeq), lastAttemptAt: clip(row.lastAttemptAt.toISOString()),
     })),
     rowCapReached: found.length >= DIAGNOSTIC_CAP,
     commandCategories: commands.slice(0, DIAGNOSTIC_CAP).map(argv => clip(argv[0])),
     commandCount: commands.length,
     commandCapReached: commands.length > DIAGNOSTIC_CAP,
    };
   } catch (captureFailure) {
    record = { diagnostic: 'capture_failed', class: clip((captureFailure as { constructor?: { name?: string } })?.constructor?.name ?? 'unknown') };
   }
   emit(record);
  } catch {
   // The sink itself failed; the original error still wins.
  }
  throw original;
 }
}
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
 await acquired;const waiting=retryQueued();const running=tick().then(()=>null,error=>error);
 try {await expectQueued(waiting,running);} finally {release();await holder;}
 const error=await running;if(error) throw error;
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
 const n=await makeNode();await owe(n.id,{branch:'hadron-updates',state:'EXHAUSTED',attempts:10});rejectPushes();
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
 await acquired;const waiting=retryQueued();const running=tick().then(()=>null,e=>e);
 try {await expectQueued(waiting,running);} finally {release();await holder;}
 const e=await running;if(e)throw e;
 expect(await rows()).toEqual(before);expect(commands).toEqual([]);
});
it('skips overlapping local runs and processes the held first run once',async()=>{
 const n=await makeNode();await owe(n.id);let release!:()=>void;let entered!:()=>void;
 const acquired=new Promise<void>(r=>entered=r);const hold=new Promise<void>(r=>release=r);
 const holder=withMirrorCheckoutLock(memoryId,async()=>{entered();await hold;});await acquired;
 const waiting=retryQueued();const first=tick().then(()=>null,e=>e);
 try {await expectQueued(waiting,first);expect(await tick()).toBe(0);expect(commands).toEqual([]);} finally {release();await holder;}
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
 await acquired;const waiting=retryQueued();const running=tick().then(()=>null,e=>e);
 try {await expectQueued(waiting,running);} finally {release();await holder;}
 const e=await running;if(e)throw e;
 expect(await rows()).toEqual([]);expect(remoteFile()).toContain('changed while sweep waited');
});
it('redacts a raw Git push rejection from both stored rows and every log',async()=>{
 const n=await makeNode();await owe(n.id);
 env.failOn=args=>{commands.push(args);if(args[0]==='push')throw new Error(`synthetic Git failure https://x-access-token:${TOKEN}@github.com/acme/repo.git`);return false;};
 await tick();expect(commands.some(a=>a[0]==='push')).toBe(true);
 expect((await rows())[0]).toMatchObject({state:'FAILED',errorClass:'PUSH_FAILED',attempts:2});
 expect(JSON.stringify(await rows(),(_,v)=>typeof v==='bigint'?v.toString():v)).not.toContain(TOKEN);
 expect(errors.join('\n')).not.toContain(TOKEN);
});
const sequenceValue = () => db.$queryRaw<Array<{value:string;is_called:boolean}>>`SELECT last_value::text AS value,is_called FROM git_mirror_attempt_seq`;
it('leaves a templated branch debt visible and unchanged without taking an attempt sequence',async()=>{
 const n=await makeNode();await owe(n.id);await db.memory.update({where:{id:memoryId},data:{writeBranch:'clients/{client}'}});
 const before=await rows(),seq=await sequenceValue();await tick();
 expect(await rows()).toEqual(before);expect(await sequenceValue()).toEqual(seq);expect(commands).toEqual([]);
 expect((await validateMemoryNodes(db,memoryId)).findings.some(f=>f.kind==='GIT_MIRROR_FAILED'&&f.nodeId===n.id)).toBe(true);
});
it('rechecks a branch template introduced while the retry waited, before taking any sequence',async()=>{
 const n=await makeNode();await owe(n.id);const before=await rows(),seq=await sequenceValue();let release!:()=>void;let entered!:()=>void;
 const acquired=new Promise<void>(r=>entered=r);const hold=new Promise<void>(r=>release=r);
 const holder=withMirrorCheckoutLock(memoryId,async()=>{entered();await hold;await db.memory.update({where:{id:memoryId},data:{writeBranch:'clients/{client}'}});});
 await acquired;const waiting=retryQueued();const running=tick().then(()=>null,e=>e);
 try {await expectQueued(waiting,running);} finally {release();await holder;}
 const e=await running;if(e)throw e;
 expect(await rows()).toEqual(before);expect(await sequenceValue()).toEqual(seq);expect(commands).toEqual([]);
});

describe('#3056 shared row budget', () => {
  it('defaults to 200 selected rows and leaves the 201st unchanged', async () => {
    vi.stubEnv('GIT_MIRROR_SWEEP_MAX_ROWS', undefined);
    const before = [];
    for (let i = 0; i < 201; i++) {
      before.push(await owe(`missing-${String(i).padStart(3, '0')}`));
    }
    await tick();
    expect(await rows()).toEqual([before[200]]);
    expect(commands).toEqual([]);
    await tick();
    expect(await rows()).toEqual([]);
  }, 30_000);

  it('leaves cut-off rows byte-identical and continues them on the next run', async () => {
    vi.stubEnv('GIT_MIRROR_SWEEP_MAX_ROWS', '2');
    const nodes = await Promise.all(['one', 'two', 'three'].map(loc => makeNode(loc)));
    for (let i = 0; i < nodes.length; i++) {
      await owe(nodes[i].id, { lastAttemptAt: new Date(old().getTime() + i * 1000) });
    }
    const untouched = await db.gitMirrorObligation.findFirstOrThrow({ where: { nodeId: nodes[2].id } });

    await tick();
    expect(await rows()).toEqual([untouched]);
    expect(commands.filter(args => args[0] === 'push')).toHaveLength(1); // #3042 batches the two funded rows on one branch
    commands = [];
    await tick();
    expect(await rows()).toEqual([]);
    expect(commands.filter(args => args[0] === 'push')).toHaveLength(1);
  });

  it('shares its budget across memories, not separately for each memory', async () => {
    vi.stubEnv('GIT_MIRROR_SWEEP_MAX_ROWS', '2');
    const first = await makeNode('first');
    await owe(first.id, { lastAttemptAt: new Date(old().getTime() - 1000) });
    const org = await db.organization.findUniqueOrThrow({ where: { urn: 'mirror430-org' } });
    const other = await db.memory.create({ data: {
      name: 'other', urn: 'mirror430-org:other', organizationId: org.id, class: 'knowledge', source: SOURCE,
    } });
    mkdirSync(join(env.root, org.urn, 'other', '.git'), { recursive: true });
    for (const nodeId of ['missing-one', 'missing-two']) {
      await db.gitMirrorObligation.create({ data: {
        memoryId: other.id, nodeId, kind: 'WRITE', removeLoc: '', state: 'FAILED', errorClass: 'PUSH_FAILED',
        attempts: 1, attemptSeq: await takeAttemptSeq(db), lastAttemptAt: old(),
      } });
    }
    await tick();
    expect(await rows()).toEqual([]);
    const remaining = await db.gitMirrorObligation.findMany({ where: { memoryId: other.id } });
    expect(remaining).toHaveLength(1);
    expect(remaining[0]).toMatchObject({ nodeId: 'missing-two', attempts: 1 });
    await tick();
    expect(await db.gitMirrorObligation.findMany()).toEqual([]);
  });

  it('does not let rows still in backoff consume a due row slot', async () => {
    vi.stubEnv('GIT_MIRROR_SWEEP_MAX_ROWS', '1');
    const now = new Date();
    const late = await makeNode('late');
    const due = await makeNode('due');
    // The oldest attempt is not the oldest due time: attempts=9 has six-hour backoff.
    await owe(late.id, { attempts: 9, lastAttemptAt: new Date(now.getTime() - 60 * 60_000) });
    await owe(due.id, { lastAttemptAt: new Date(now.getTime() - 10 * 60_000) });
    const before = await db.gitMirrorObligation.findFirstOrThrow({ where: { nodeId: late.id } });
    await tick(now);
    expect(await rows()).toEqual([before]);
    expect(remoteFile('due')).toContain('current content');
    expect(commands.filter(args => args[0] === 'push')).toHaveLength(1);
  });

  it('selects the oldest due row rather than the oldest attempted row', async () => {
    vi.stubEnv('GIT_MIRROR_SWEEP_MAX_ROWS', '1');
    const now = new Date();
    const olderAttempt = await makeNode('older-attempt');
    const olderDue = await makeNode('older-due');
    await owe(olderAttempt.id, { attempts: 9, lastAttemptAt: new Date(now.getTime() - 7 * 60 * 60_000) });
    await owe(olderDue.id, { lastAttemptAt: new Date(now.getTime() - 2 * 60 * 60_000) });
    const before = await db.gitMirrorObligation.findFirstOrThrow({ where: { nodeId: olderAttempt.id } });
    await tick(now);
    expect(await rows()).toEqual([before]);
    expect(remoteFile('older-due')).toContain('current content');
  });

  it('does not reserve another memory\'s budget for a row still in backoff', async () => {
    vi.stubEnv('GIT_MIRROR_SWEEP_MAX_ROWS', '2');
    const now = new Date();
    const due = await makeNode('due');
    const late = await makeNode('late');
    await owe(due.id);
    await owe(late.id, { attempts: 9, lastAttemptAt: new Date(now.getTime() - 60 * 60_000) });
    const untouched = await db.gitMirrorObligation.findFirstOrThrow({ where: { nodeId: late.id } });
    const org = await db.organization.findUniqueOrThrow({ where: { urn: 'mirror430-org' } });
    const other = await db.memory.create({ data: {
      name: 'next', urn: 'mirror430-org:next', organizationId: org.id, class: 'knowledge', source: SOURCE,
    } });
    mkdirSync(join(env.root, org.urn, 'next', '.git'), { recursive: true });
    await db.gitMirrorObligation.create({ data: {
      memoryId: other.id, nodeId: 'missing-next', kind: 'WRITE', removeLoc: '', state: 'FAILED',
      errorClass: 'PUSH_FAILED', attempts: 1, attemptSeq: await takeAttemptSeq(db),
      lastAttemptAt: new Date(now.getTime() - 2 * 60 * 60_000),
    } });
    await tick(now);
    expect(await rows()).toEqual([untouched]);
    expect(await db.gitMirrorObligation.findMany({ where: { memoryId: other.id } })).toEqual([]);
  });
});


describe('#3151 second-refresh settlement', () => {
 it('a throwing second refresh settles its own TREE_WRITE attempt and lets the next due row proceed', async () => {
  const startedAt=Date.now(); // #3444: the one baseline clock read the diagnostic's elapsedMs needs
  const first=await makeNode('refresh-fails'), next=await makeNode('next'), later=await makeNode('later');
  const firstDebt=await owe(first.id,{lastAttemptAt:new Date(old().getTime()-1000)});
  const nextDebt=await owe(next.id);
  const untouched=await owe(later.id,{lastAttemptAt:new Date(Date.now()+7*24*60*60_000)});
  const seqs=vi.spyOn(mirrorDebt,'tryTakeAttemptSeq');
  const load=nodeLoader.loadNodeForGit;
  let firstReads=0, nextReads=0;
  let nextAtEntry: typeof nextDebt | undefined;
  vi.spyOn(nodeLoader,'loadNodeForGit').mockImplementation(async (...args) => {
   if(args[1].nodeId===first.id && ++firstReads===2) throw new Error('synthetic second-refresh failure');
   if(args[1].nodeId===next.id && ++nextReads===1) {
    // The first row's failure must not consume, clear or restamp the next row.
    nextAtEntry=await db.gitMirrorObligation.findFirstOrThrow({where:{memoryId,nodeId:next.id}});
   }
   return load(...args);
  });
  await tick();
  const failed=await readOrDiagnose(()=>db.gitMirrorObligation.findFirstOrThrow({where:{memoryId,nodeId:first.id}}),{
   labels:{[first.id]:'first',[next.id]:'next',[later.id]:'later'}, startedAt,
   counters:()=>({firstReads,nextReads,nextAtEntry:nextAtEntry!==undefined,attemptSeqCalls:seqs.mock.calls.length}),
  });
  expect(firstReads).toBe(2);
  expect(failed).toMatchObject({state:'FAILED',errorClass:'TREE_WRITE',attempts:2});
  expect(failed.lastAttemptAt.getTime()).toBeGreaterThan(firstDebt.lastAttemptAt.getTime());
  expect(seqs.mock.calls.length).toBe(1); // one checkout/fence for the admitted branch group
  expect(failed.attemptSeq).toBe(await seqs.mock.results[0].value);
  expect(nextAtEntry).toEqual(nextDebt);
  expect(nextReads).toBe(1); // readiness short-circuits at first work; healthy payload loads after Git preparation
  expect(await db.gitMirrorObligation.findFirst({where:{memoryId,nodeId:next.id}})).toBeNull();
  expect(remoteFile('next')).toContain('current content');
  expect(commands.filter(a=>a[0]==='push')).toHaveLength(1);
  expect(await db.gitMirrorObligation.findFirstOrThrow({where:{memoryId,nodeId:later.id}})).toEqual(untouched);
  expect(()=>remoteFile('refresh-fails')).toThrow();
 });
});

describe('#3444 failure-only diagnostics', () => {
 const ROW_KEYS = ['node', 'kind', 'state', 'errorClass', 'attempts', 'attemptSeq', 'lastAttemptAt'];
 const RECORD_KEYS = ['diagnostic', 'elapsedMs', 'counters', 'rows', 'rowCapReached', 'commandCategories', 'commandCount', 'commandCapReached'];
 const missing = (nodeId: string) => db.gitMirrorObligation.findFirstOrThrow({ where: { memoryId, nodeId } });
 async function failingRead(nodeId: string) {
  let original: unknown;
  const read = () => missing(nodeId).catch(error => { original = error; throw error; });
  return { read, original: () => original };
 }

 it('rethrows the exact original P2025 object and emits only whitelisted, labelled scalars', async () => {
  const first = await makeNode('first'), other = await makeNode('other-node');
  await owe(first.id); await owe(other.id);
  commands.push(['push', 'https://x-access-token:secret@github.com/acme/repo.git', '/tmp/path']);
  const emitted: Record<string, unknown>[] = [];
  const { read, original } = await failingRead('no-such-node');
  let thrown: unknown;
  try { await readOrDiagnose(read, { labels: { [first.id]: 'first' }, counters: () => ({ firstReads: 2, nextAtEntry: true }), startedAt: Date.now() }, r => emitted.push(r)); }
  catch (error) { thrown = error; }
  expect(thrown).toBe(original());
  expect(thrown).toMatchObject({ code: 'P2025' });
  expect(emitted).toHaveLength(1);
  const record = emitted[0];
  expect(Object.keys(record).sort()).toEqual([...RECORD_KEYS].sort());
  const rowsOut = record.rows as Record<string, unknown>[];
  expect(rowsOut).toHaveLength(2);
  for (const row of rowsOut) {
   expect(Object.keys(row).sort()).toEqual([...ROW_KEYS].sort());
   for (const value of Object.values(row)) expect(typeof value === 'number' || (typeof value === 'string' && value.length <= 80)).toBe(true);
  }
  expect(rowsOut.map(r => r.node).sort()).toEqual(['first', 'other']);
  expect(record.commandCategories).toEqual(['push']);
  expect(record).toMatchObject({ diagnostic: 'post_tick_read_failed', rowCapReached: false, commandCount: 1, commandCapReached: false, counters: { firstReads: 2, nextAtEntry: true } });
  const text = JSON.stringify(record);
  for (const secret of [first.id, other.id, memoryId, 'secret', 'github.com', '/tmp', 'No record was found']) expect(text).not.toContain(secret);
 });

 it('caps the bounded query at 16 rows before materializing, and caps command categories at 16', async () => {
  for (let i = 0; i < 20; i++) await owe((await makeNode(`n${i}`)).id);
  for (let i = 0; i < 20; i++) commands.push([`cmd${i}`, '--arg']);
  const findMany = vi.spyOn(db.gitMirrorObligation, 'findMany');
  const emitted: Record<string, unknown>[] = [];
  const { read } = await failingRead('no-such-node');
  await expect(readOrDiagnose(read, { labels: {}, counters: () => ({}), startedAt: Date.now() }, r => emitted.push(r))).rejects.toMatchObject({ code: 'P2025' });
  expect(findMany).toHaveBeenCalledTimes(1);
  const args = findMany.mock.calls[0][0] as { take?: number; select?: Record<string, boolean> };
  expect(args.take).toBe(16);
  expect(Object.keys(args.select ?? {}).sort()).toEqual(['attemptSeq', 'attempts', 'errorClass', 'kind', 'lastAttemptAt', 'nodeId', 'state']);
  expect(emitted[0]).toMatchObject({ rowCapReached: true, commandCount: 20, commandCapReached: true });
  expect(emitted[0].rows).toHaveLength(16);
  expect(emitted[0].commandCategories).toHaveLength(16);
 });

 it('clips every emitted string scalar to 80 characters, counters included', async () => {
  vi.spyOn(db.gitMirrorObligation, 'findMany').mockResolvedValueOnce([{ nodeId: 'raw-node-id', kind: 'WRITE', state: 'FAILED', errorClass: 'E'.repeat(200), attempts: 3, attemptSeq: 7n, lastAttemptAt: new Date(0) }] as never);
  const emitted: Record<string, unknown>[] = [];
  const { read } = await failingRead('no-such-node');
  commands.push(['C'.repeat(200)]);
  await expect(readOrDiagnose(read, { labels: {}, counters: () => ({ note: 'N'.repeat(200), n: 4 }), startedAt: Date.now() }, r => emitted.push(r))).rejects.toMatchObject({ code: 'P2025' });
  const record = emitted[0] as { rows: Record<string, unknown>[]; commandCategories: string[]; counters: Record<string, unknown> };
  expect(record.rows[0]).toMatchObject({ node: 'other', attempts: 3, attemptSeq: '7', lastAttemptAt: new Date(0).toISOString() });
  expect((record.rows[0].errorClass as string).length).toBe(80);
  expect(record.commandCategories[0].length).toBe(80);
  expect((record.counters.note as string).length).toBe(80);
  expect(record.counters.n).toBe(4);
  expect(JSON.stringify(record)).not.toContain('raw-node-id');
 });

 it('rethrows the original even when the capture itself throws, noting only the capture failure class', async () => {
  vi.spyOn(db.gitMirrorObligation, 'findMany').mockRejectedValue(new TypeError('capture exploded with detail'));
  const emitted: Record<string, unknown>[] = [];
  const { read, original } = await failingRead('no-such-node');
  let thrown: unknown;
  try { await readOrDiagnose(read, { labels: {}, counters: () => ({}), startedAt: Date.now() }, r => emitted.push(r)); }
  catch (error) { thrown = error; }
  expect(thrown).toBe(original());
  expect(emitted).toEqual([{ diagnostic: 'capture_failed', class: 'TypeError' }]);
 });

 it('rethrows the original even when the sink throws', async () => {
  const { read, original } = await failingRead('no-such-node');
  let thrown: unknown;
  try { await readOrDiagnose(read, { labels: {}, counters: () => ({}), startedAt: Date.now() }, () => { throw new Error('sink down'); }); }
  catch (error) { thrown = error; }
  expect(thrown).toBe(original());
 });

 it('a passing read emits nothing and runs no extra query', async () => {
  const n = await makeNode('present'); const debt = await owe(n.id);
  const findMany = vi.spyOn(db.gitMirrorObligation, 'findMany');
  const counters = vi.fn(() => ({}));
  const emit = vi.fn();
  await expect(readOrDiagnose(() => missing(n.id), { labels: {}, counters, startedAt: Date.now() }, emit)).resolves.toEqual(debt);
  expect(emit).not.toHaveBeenCalled();
  expect(findMany).not.toHaveBeenCalled();
  expect(counters).not.toHaveBeenCalled();
 });
});
