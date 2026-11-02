import { afterEach, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
vi.mock('fs', async original => ({ ...(await original<typeof import('fs')>()) }));
import { mirrorMutationMarker, mutateMirrorFiles } from './mirrorFileMutation.js';

const roots: string[] = [];
afterEach(() => {
 vi.restoreAllMocks();
 for (const root of roots.splice(0)) fs.rmSync(root,{recursive:true,force:true});
});
function fixture() {
 const root=fs.mkdtempSync(join(tmpdir(),'mirror-rollback3242-'));roots.push(root);
 fs.mkdirSync(join(root,'.git'));
 return root;
}
it('restores existing bytes and legacy directories, removes newly created files, keeps healthy edits',()=>{
 const root=fixture(), path=join(root,'bad.md'), legacy=join(root,'.bad'), fresh=join(root,'new.md');
 fs.writeFileSync(path,'original');fs.mkdirSync(legacy);fs.writeFileSync(join(legacy,'edges.yaml'),'edge');
 fs.writeFileSync(join(root,'healthy.md'),'already written');
 expect(()=>mutateMirrorFiles(root,[path,legacy,fresh],()=>{
  fs.writeFileSync(path,'partial');fs.rmSync(legacy,{recursive:true});fs.writeFileSync(fresh,'partial');
  throw new Error('failed row');
 })).toThrow('failed row');
 expect(fs.readFileSync(path,'utf8')).toBe('original');
 expect(fs.readFileSync(join(legacy,'edges.yaml'),'utf8')).toBe('edge');
 expect(fs.existsSync(fresh)).toBe(false);expect(fs.existsSync(mirrorMutationMarker(root))).toBe(false);
 expect(fs.readFileSync(join(root,'healthy.md'),'utf8')).toBe('already written');
});
it('retains the checkout guard and backup when rollback itself fails',()=>{
 const root=fixture(), path=join(root,'bad.md');fs.writeFileSync(path,'original');
 const real=fs.cpSync;
 vi.spyOn(fs,'cpSync').mockImplementation((source,dest,options)=>{
  if(String(dest)===path)throw new Error('synthetic restore failure');
  return real(source,dest,options);
 });
 expect(()=>mutateMirrorFiles(root,[path],()=>{
  fs.writeFileSync(path,'partial');throw new Error('failed row');
 })).toThrow('synthetic restore failure');
 const backup=fs.readFileSync(mirrorMutationMarker(root),'utf8');
 expect(fs.readFileSync(join(backup,'0'),'utf8')).toBe('original');
 // This test owns the intentionally retained recovery backup.
 fs.rmSync(backup,{recursive:true,force:true});
});
it('successful mutation clears its checkpoint guard',()=>{
 const root=fixture(), path=join(root,'new.md');
 mutateMirrorFiles(root,[path],()=>{fs.writeFileSync(path,'valid');});
 expect(fs.readFileSync(path,'utf8')).toBe('valid');
 expect(fs.existsSync(mirrorMutationMarker(root))).toBe(false);
});
