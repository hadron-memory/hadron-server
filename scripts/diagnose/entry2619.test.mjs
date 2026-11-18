import {test,expect} from 'vitest';
import {spawnSync} from 'node:child_process';
import {mkdtempSync,symlinkSync,writeFileSync,readFileSync,mkdirSync,copyFileSync,rmSync} from 'node:fs';
import {join,dirname} from 'node:path';
import {tmpdir} from 'node:os';
import {fileURLToPath} from 'node:url';
import {workloadValid} from './load.mjs';
const here=dirname(fileURLToPath(import.meta.url));
const shell=(body,dir)=>spawnSync('bash',['-c',`set -euo pipefail; . '${here}/cleanup.sh'; ${body}`],{cwd:dir,encoding:'utf8'});
test('validator and driver execute through a spaced symlink path instead of silently returning zero',()=>{
 const dir=mkdtempSync(join(tmpdir(),'diag-entry-'));try{
  const linked=join(dir,'spaced link');symlinkSync(here,linked,'dir');
  const bad=join(dir,'bad');writeFileSync(bad,'{"kind":"abort"}\n');
  const validator=spawnSync(process.execPath,[join(linked,'validate-samples.mjs'),bad,'1'],{encoding:'utf8'});
  expect(validator.status).not.toBe(0);
  const driver=spawnSync(process.execPath,[join(linked,'load.mjs'),'http://127.0.0.1:1','idle','0'],{env:{...process.env,HADRON_DIAG_KEY:''},encoding:'utf8'});
  expect(driver.status).toBe(2);
 }finally{rmSync(dir,{recursive:true,force:true});}
});
test('sample validation retries a transient incomplete final line without dropping an abort fragment',()=>{
 const dir=mkdtempSync(join(tmpdir(),'diag-copy-'));try{
  writeFileSync(join(dir,'count'),'0');
  const r=shell(`app_exec(){ n=$(cat count); echo $((n+1)) > count; if [ "$n" = 0 ]; then printf '{"kind":"sample","at":1000}\\n{"kind":'; else printf '{"kind":"sample","at":1000}\\n'; fi; }; finish_samples '${join(dir,'out')}' 2 1000`,dir);
  expect(r.status,r.stderr).toBe(0);expect(Number(readFileSync(join(dir,'count'),'utf8'))).toBeGreaterThan(1);
  writeFileSync(join(dir,'count'),'0');
  const abort=shell(`app_exec(){ n=$(cat count); echo $((n+1)) > count; if [ "$n" = 0 ]; then printf '{"kind":"sample","at":1000}\\n{"kind":'; else printf '{"kind":"sample","at":1000}\\n{"kind":"abort"}\\n'; fi; }; finish_samples '${join(dir,'aborted')}' 2 1000`,dir);
  expect(abort.status).not.toBe(0);
 }finally{rmSync(dir,{recursive:true,force:true});}
});
test('real ownership patch applies and patched up writes receipt and passes run marker on launch',()=>{
 const dir=mkdtempSync(join(tmpdir(),'diag-patch-'));try{
  const target=join(dir,'scripts/e2e');mkdirSync(target,{recursive:true});
  copyFileSync(join(here,'../e2e/stack.sh'),join(target,'stack.sh'));
  writeFileSync(join(target,'dns-guard.sh'),'e2e_dns_guard(){ return 0; }\n');
  const applied=spawnSync('git',['apply',join(here,'ownership.patch')],{cwd:dir,encoding:'utf8'});
  expect(applied.status,applied.stderr).toBe(0);
  const bin=join(dir,'bin');mkdirSync(bin);
  writeFileSync(join(bin,'incus'),'#!/bin/sh\nif [ "$1" = launch ]; then printf "%s\\n" "$@" > "$DIAG_LAUNCH_RECORD"; exit 17; fi\nexit 1\n',{mode:0o755});
  const r=spawnSync('bash',[join(target,'stack.sh'),'up','patch','44101','44102'],{cwd:dir,env:{...process.env,PATH:bin+':'+process.env.PATH,E2E_BACKEND:'incus',XDG_STATE_HOME:join(dir,'state'),DIAG_RUN_TOKEN:'synthetic-run',DIAG_LAUNCH_RECORD:join(dir,'launch')},encoding:'utf8'});
  expect(r.status,r.stderr).toBe(17);
  expect(readFileSync(join(dir,'state/hadron-e2e/hadron-e2e-patch/diagnose-owner'),'utf8')).toBe('synthetic-run\n');
  expect(readFileSync(join(dir,'launch'),'utf8')).toContain('user.hadron-diagnose=synthetic-run');
 }finally{rmSync(dir,{recursive:true,force:true});}
});

test('finish requires an end time and positive validator evidence; a zero-exit no-op is rejected',()=>{
 const dir=mkdtempSync(join(tmpdir(),'diag-proof-'));try{
  const body=`app_exec(){ printf '{"kind":"sample","at":1000}\\n'; }; `;
  expect(shell(body+`finish_samples '${join(dir,'missing')}' 2`,dir).status).not.toBe(0);
  expect(shell(body+`node(){ return 0; }; finish_samples '${join(dir,'noop')}' 2 1000`,dir).status).not.toBe(0);
 }finally{rmSync(dir,{recursive:true,force:true});}
});
test('a sample without numeric at and a validator without an end time are rejected',()=>{
 const dir=mkdtempSync(join(tmpdir(),'diag-clock-'));try{
  const f=join(dir,'sample');writeFileSync(f,'{"kind":"sample"}\n');
  expect(spawnSync(process.execPath,[join(here,'validate-samples.mjs'),f,'1000']).status).not.toBe(0);
  writeFileSync(f,'{"kind":"sample","at":1000}\n');
  expect(spawnSync(process.execPath,[join(here,'validate-samples.mjs'),f]).status).not.toBe(0);
 }finally{rmSync(dir,{recursive:true,force:true});}
});
test('closed workloads reject mixed successes and cap refusals or missing closes',()=>{
 const c={ok:5,capRefused:1,other:0,missingSession:0,closeFailed:0,closeOk:5};
 expect(workloadValid('closed',c)).toBe(false);
 expect(workloadValid('churn',c)).toBe(true);
 expect(workloadValid('closed',{...c,capRefused:0,closeOk:4})).toBe(false);
});
test('sample copy replaces a directory symlink without adding files inside its target',()=>{
 const dir=mkdtempSync(join(tmpdir(),'diag-dirlink-'));try{
  const target=join(dir,'target');mkdirSync(target);writeFileSync(join(target,'sentinel'),'KEEP');
  const out=join(dir,'out');symlinkSync(target,out);
  expect(shell(`app_exec(){ printf '{"kind":"sample","at":1000}\\n'; }; copy_samples '${out}'`,dir).status).toBe(0);
  expect(readFileSync(out,'utf8')).toContain('sample');expect(readFileSync(join(target,'sentinel'),'utf8')).toBe('KEEP');
 }finally{rmSync(dir,{recursive:true,force:true});}
});
test('a changed reservation token prevents release from deleting another holder lock',()=>{
 const dir=mkdtempSync(join(tmpdir(),'diag-token-'));try{
  const state=join(dir,'state');
  const r=shell(`incus(){ return 0; }; acquire_stack_reservation '${state}' synthetic; echo foreign > "$DIAG_LOCK/owner"; if reservation_owned; then exit 3; fi; release_stack_reservation; test -d "$DIAG_LOCK"; test "$(cat "$DIAG_LOCK/owner")" = foreign`,dir);
  expect(r.status,r.stderr).toBe(0);
 }finally{rmSync(dir,{recursive:true,force:true});}
});
