// Real run.sh, synthetic boundary adapters. No real Git worktree, container or database is created.
import {test,expect} from 'vitest';
import {spawn,spawnSync} from 'node:child_process';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,existsSync,rmSync} from 'node:fs';
import {join,dirname} from 'node:path';
import {tmpdir} from 'node:os';
import {fileURLToPath} from 'node:url';
const here=dirname(fileURLToPath(import.meta.url));
function fixture(mode) {
 const dir=mkdtempSync(join(tmpdir(),'dorian-run2619-')); const bin=join(dir,'bin');mkdirSync(bin);
 const put=(name,body)=>writeFileSync(join(bin,name),'#!/bin/bash\nset -eu\n'+body,{mode:0o755});
 put('git',`if [ "\${1:-}" = -C ]; then shift 2; fi
case "$1" in
 rev-parse) echo "$FIXTURE";;
 worktree) if [ "$2" = add ]; then mkdir -p "$4/scripts/e2e"; cp "$FIXTURE/stack.sh" "$4/scripts/e2e/stack.sh"; printf '      GRAPHS_PATH: /private\n' > "$4/scripts/e2e/compose.yaml"; fi;;
 apply|add) :;;
 *) exit 8;;
esac\n`);
 put('node',`if [[ "\${1:-}" = */load.mjs ]]; then
 if [ "$MODE" = held ]; then touch "$FIXTURE/ready"; for i in {1..200}; do [ -e "$FIXTURE/release" ] && exit 0; sleep .02; done; exit 9; fi
 exit 0
fi
exec '${process.execPath}' "$@"\n`);
 put('incus',`case "$1" in
 list) [ "$MODE" != list-failure ] || exit 7; [ ! -e "$FIXTURE/instance" ] || echo hadron-e2e-fixture;;
 config) cat "$FIXTURE/instance";;
 exec)
  case "$*" in
   *memory.max*) echo 6442450944;;
   *diagnose-samples.jsonl*) printf '{"kind":"sample","at":%s}\\n' "$(date +%s%3N)"; if [ "$MODE" = abort ]; then echo '{"kind":"abort","why":"rss"}'; fi;;
   *credentials.json*) echo synthetic-private-key;;
   *pg_stat_activity*) echo 2;;
   *health*) while [ "$1" != app ]; do shift; done; shift; NODE_OPTIONS="--import $FIXTURE/health.mjs" "$@";;
  esac;;
 *) exit 8;;
esac\n`);
 writeFileSync(join(dir,'stack.sh'),`#!/bin/bash
set -eu
state="$XDG_STATE_HOME/hadron-e2e/hadron-e2e-fixture"
case "$1" in
 up) mkdir "$state"; echo incus > "$state/backend";
     if [ "$MODE" = failed-up ]; then echo foreign > "$state/diagnose-owner"; echo KEEP > "$state/sentinel"; exit 23; fi
     printf '%s\\n' "$DIAG_RUN_TOKEN" > "$state/diagnose-owner"; printf '%s\\n' "$DIAG_RUN_TOKEN" > "$FIXTURE/instance";;
 down) echo down >> "$FIXTURE/down"; rm -rf "$state"; rm "$FIXTURE/instance";;
 logs) echo private-log;;
esac\n`,{mode:0o755});
 writeFileSync(join(dir,'health.mjs'),"globalThis.fetch=async()=>{if(process.env.MODE==='dead')throw new Error('synthetic');return {ok:process.env.MODE!=='unhealthy'};};\n");
 const env={...process.env,FIXTURE:dir,MODE:mode,PATH:bin+':'+process.env.PATH,TMPDIR:dir,XDG_STATE_HOME:join(dir,'state'),DIAG_OUT:join(dir,'samples'),DIAG_IDLE_S:'0.01',E2E_BACKEND:'incus'};
 const args=[join(here,'run.sh'),'fixture','41001','41002','idle','1'];
 return {dir,env,args,run:()=>spawnSync('bash',args,{env,encoding:'utf8',timeout:10_000}),clean:()=>rmSync(dir,{recursive:true,force:true})};
}
test.each(['abort','dead','unhealthy'])('real runner refuses %s during idle tail and tears down its stack',mode=>{
 const f=fixture(mode);try{const r=f.run();expect(r.status,r.stderr).not.toBe(0);expect(readFileSync(join(f.dir,'down'),'utf8')).toBe('down\n');}finally{f.clean();}
});
test('real runner success requires fresh samples and releases its reservation',()=>{
 const f=fixture('success');try{const r=f.run();expect(r.status,r.stderr).toBe(0);expect(readFileSync(join(f.dir,'samples'),'utf8')).toContain('pg_activity');expect(existsSync(join(f.dir,'state/hadron-e2e/hadron-e2e-fixture.diagnose-lock'))).toBe(false);}finally{f.clean();}
});
test('failed up without this run receipt never tears down existing state',()=>{
 const f=fixture('failed-up');try{const r=f.run();expect(r.status).toBe(23);expect(existsSync(join(f.dir,'down'))).toBe(false);expect(r.stderr).toContain('inspect private state:');expect(readFileSync(join(f.dir,'state/hadron-e2e/hadron-e2e-fixture/sentinel'),'utf8')).toBe('KEEP\n');}finally{f.clean();}
});
test('failed inspection refuses before up or teardown',()=>{
 const f=fixture('list-failure');try{expect(f.run().status).toBe(2);expect(existsSync(join(f.dir,'instance'))).toBe(false);expect(existsSync(join(f.dir,'down'))).toBe(false);}finally{f.clean();}
});
test('two actual same-name runners: second refuses while first retains stack ownership',async()=>{
 const f=fixture('held');const a=spawn('bash',f.args,{env:f.env,stdio:'ignore'});const done=new Promise(r=>a.once('close',r));
 try{
  for(let i=0;i<200&&!existsSync(join(f.dir,'ready'));i++) await new Promise(r=>setTimeout(r,20));
  expect(existsSync(join(f.dir,'ready'))).toBe(true);
  expect(f.run().status).toBe(2);expect(existsSync(join(f.dir,'down'))).toBe(false);expect(existsSync(join(f.dir,'instance'))).toBe(true);
  writeFileSync(join(f.dir,'release'),'go');expect(await done).toBe(0);expect(readFileSync(join(f.dir,'down'),'utf8')).toBe('down\n');
 }finally{writeFileSync(join(f.dir,'release'),'go');await done;f.clean();}
});

test('invalid name is refused before reservation paths or backend inspection',()=>{
 const f=fixture('success');try{
  const args=[...f.args];args[1]='../escape';
  const r=spawnSync('bash',args,{env:f.env,encoding:'utf8'});
  expect(r.status).toBe(2);expect(existsSync(join(f.dir,'state'))).toBe(false);
 }finally{f.clean();}
});
