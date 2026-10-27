import {test, expect} from 'vitest';
import {spawnSync, spawn} from 'node:child_process';
import {mkdtempSync, writeFileSync, readFileSync, symlinkSync, existsSync, readdirSync, rmSync, mkdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join, dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
const here=dirname(fileURLToPath(import.meta.url));
const shell=(body,dir,env={})=>spawnSync('bash',['-c',`set -euo pipefail; . '${here}/cleanup.sh'; ${body}`],{cwd:dir,env:{...process.env,...env},encoding:'utf8'});
const scratch=()=>mkdtempSync(join(tmpdir(),'dorian-diag2619-'));
const response=(status,sid=null)=>({status,headers:{get:()=>sid},text:async()=>''});
// Exercise the actual driver CLI against local HTTP; no server/provider/private stack is touched.
import {createServer} from 'node:http';
async function driver(status,sid,workload='closed') {
 const server=createServer((_q,r)=>{if(sid)r.setHeader('mcp-session-id',sid);r.writeHead(status);r.end('{}');});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 try {
  return await new Promise((resolve,reject)=>{
   const p=spawn(process.execPath,[join(here,'load.mjs'),`http://127.0.0.1:${server.address().port}`,workload,'0.01'],{env:{...process.env,HADRON_DIAG_KEY:'synthetic'}});
   let stdout='';let stderr='';p.stdout.on('data',b=>stdout+=b);p.stderr.on('data',b=>stderr+=b);p.on('error',reject);p.on('close',code=>resolve({code,stdout,stderr}));
  });
 } finally {await new Promise(r=>server.close(r));}
}
test.each([401,500,429])('closed CLI rejects unsuccessful initialize status %s',async status=>{
 expect((await driver(status,null)).code).not.toBe(0);
});
test('CLI rejects a successful initialize with no session id',async()=>{
 const result=await driver(200,null);expect(result.code).not.toBe(0);
 const counts=JSON.parse(result.stdout);expect(counts.closeFailed).toBe(1);expect(counts.missingSession).toBe(1);
});
test('closed CLI with a usable id and successful DELETE remains valid',async()=>{expect((await driver(200,'synthetic-session')).code).toBe(0);});
test('churn cannot pass with only cap refusals and zero successful sessions',async()=>{expect((await driver(429,null,'churn')).code).not.toBe(0);});
test('idle is a valid no-initialize control',async()=>{expect((await driver(200,null,'idle')).code).toBe(0);});
test('sample copy never follows predictable partial or destination symlinks',()=>{
 const dir=scratch();try{
  const target=join(dir,'sentinel');writeFileSync(target,'KEEP');const out=join(dir,'samples');
  symlinkSync(target,out+'.partial');symlinkSync(target,out);
  const r=shell(`app_exec(){ printf '%s\\n' '{"kind":"sample","at":1000}'; }; copy_samples '${out}'`,dir);
  expect(r.status).toBe(0);expect(readFileSync(target,'utf8')).toBe('KEEP');expect(readFileSync(out,'utf8')).toContain('sample');
  expect(readdirSync(dir).filter(n=>n.startsWith('.diagnose-copy-'))).toEqual([]);
 }finally{rmSync(dir,{recursive:true,force:true});}
});
test.each(['abort','stale','empty'])('idle-tail %s cannot produce a successful finish',kind=>{
 const dir=scratch();try{
  const lines=kind==='abort'?'{"kind":"sample","at":1000}\n{"kind":"abort","why":"rss"}':kind==='stale'?'{"kind":"sample","at":100}':'{"kind":"config"}';
  writeFileSync(join(dir,'source'),lines+'\n');
  const r=shell(`app_exec(){ cat source; }; finish_samples '${join(dir,'out')}' 2 1000`,dir);
  expect(r.status).not.toBe(0);if (existsSync(join(dir,'out'))) expect(readFileSync(join(dir,'out'),'utf8')).not.toContain('pg_activity');
 }finally{rmSync(dir,{recursive:true,force:true});}
});
test('fresh completed sample control passes the success path',()=>{
 const dir=scratch();try{const r=shell(`app_exec(){ printf '%s\\n' '{"kind":"sample","at":1000}'; }; finish_samples '${join(dir,'out')}' 2 1000`,dir);expect(r.status).toBe(0);}finally{rmSync(dir,{recursive:true,force:true});}
});
test('failed Incus inspection refuses rather than claiming absence',()=>{
 const dir=scratch();try{writeFileSync(join(dir,'incus'),'#!/bin/sh\nexit 7\n',{mode:0o755});expect(shell(`refuse_existing_stack '${join(dir,'state')}' synthetic`,dir,{PATH:dir+':'+process.env.PATH}).status).not.toBe(0);}finally{rmSync(dir,{recursive:true,force:true});}
});
test('atomic same-name reservation refuses a concurrent holder without releasing its lock',async()=>{
 const dir=scratch();try{
  writeFileSync(join(dir,'incus'),'#!/bin/sh\nexit 0\n',{mode:0o755});const env={PATH:dir+':'+process.env.PATH};const state=join(dir,'state');
  // A separate shell really holds the reservation while B attempts the same name.
  const a=spawn('bash',['-c',`set -e; . '${here}/cleanup.sh'; acquire_stack_reservation '${state}' synthetic; echo held; read -r done; release_stack_reservation`],{cwd:dir,env:{...process.env,...env},stdio:['pipe','pipe','pipe']});
  const ready=await new Promise(resolve=>{a.stdout.once('data',()=>resolve(true));a.once('exit',()=>resolve(false));});
  expect(ready).toBe(true);
  try{expect(shell(`acquire_stack_reservation '${state}' synthetic`,dir,env).status).not.toBe(0);expect(existsSync(state+'.diagnose-lock')).toBe(true);}finally{a.stdin.end('done\n');await new Promise(r=>a.once('close',r));}
  expect(existsSync(state+'.diagnose-lock')).toBe(false);
 }finally{rmSync(dir,{recursive:true,force:true});}
});
test('teardown ownership needs both state receipt and live instance marker',()=>{
 const dir=scratch();try{
  const state=join(dir,'state');mkdirSync(state);const lock=state+'.diagnose-lock';mkdirSync(lock);writeFileSync(join(lock,'owner'),'mine');writeFileSync(join(state,'backend'),'incus\n');writeFileSync(join(state,'diagnose-owner'),'mine\n');
  writeFileSync(join(dir,'incus'),'#!/bin/sh\nif [ "$1" = list ]; then echo synthetic; else echo somebody-else; fi\n',{mode:0o755});
  const check=()=>shell(`DIAG_STATE='${state}'; DIAG_LOCK='${lock}'; DIAG_PROJECT=synthetic; DIAG_RUN_TOKEN=mine; stack_owned`,dir,{PATH:dir+':'+process.env.PATH}).status;
  expect(check()).not.toBe(0);
  writeFileSync(join(dir,'incus'),'#!/bin/sh\nif [ "$1" = list ]; then echo synthetic; else echo mine; fi\n',{mode:0o755});
  expect(check()).toBe(0);
  writeFileSync(join(dir,'incus'),'#!/bin/sh\nexit 0\n',{mode:0o755});
  expect(check()).not.toBe(0);
 }finally{rmSync(dir,{recursive:true,force:true});}
});
