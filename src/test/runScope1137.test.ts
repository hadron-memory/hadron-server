import { afterEach, describe, expect, it, vi } from 'vitest';
import { computeRunScope, stampTestRunIdentity, testRunScope, testRunToken, testRunId, runToken, isOwnedRunDead, parseWorkerDbName, workerDbName, runTemplateDbName, isLocalDbHost } from './dbWorkers.js';
const old = { id: process.env.HADRON_TEST_RUN_ID, scope: process.env.HADRON_TEST_RUN_SCOPE };
const bootA = '01234567-89ab-cdef-0123-456789abcdef', bootB = '01234567-89ab-cdef-0123-456789abcdee';
const scope = 'l'+'a'.repeat(20), foreign = 'l'+'b'.repeat(20);
afterEach(() => {
  vi.restoreAllMocks();
  if (old.id === undefined) delete process.env.HADRON_TEST_RUN_ID; else process.env.HADRON_TEST_RUN_ID=old.id;
  if (old.scope === undefined) delete process.env.HADRON_TEST_RUN_SCOPE; else process.env.HADRON_TEST_RUN_SCOPE=old.scope;
});
describe('#1137 verified run scope', () => {
  it('depends on boot and PID namespace dev/inode, not just a pid', () => {
    const get = (boot=bootA, dev=4n, ino=8n) => computeRunScope('linux',()=>boot,()=>({dev,ino}));
    expect(get()).toMatch(/^l[0-9a-f]{20}$/);
    expect(new Set([get(),get(bootB),get(bootA,5n),get(bootA,4n,9n)]).size).toBe(4);
    expect(get()).toBe(get());
  });
  it('refuses unverifiable Linux with the serial remedy, never a pid-only fallback', () => {
    expect(()=>computeRunScope('linux',()=>{throw new Error('EACCES');})).toThrow(/HADRON_TEST_PARALLEL=0/);
    expect(()=>computeRunScope('linux',()=>bootA,()=>{throw new Error('EACCES');})).toThrow(/HADRON_TEST_PARALLEL=0/);
    expect(()=>computeRunScope('linux',()=>'',()=>({dev:4n,ino:8n}))).toThrow(/refuses/);
  });
  it('keeps native non-Linux support in an explicit machine/platform scope', () => {
    const noProc = ()=>{throw new Error('must not read proc');};
    const darwin=computeRunScope('darwin',noProc,noProc,()=> 'local-host');
    expect(darwin).toMatch(/^n[0-9a-f]{20}$/);
    expect(darwin).not.toBe(computeRunScope('freebsd',noProc,noProc,()=> 'local-host'));
    expect(darwin).not.toBe(computeRunScope('darwin',noProc,noProc,()=> 'other-host'));
  });
  it('overwrites both inherited shell variables; pid remains bare and workers compose separately', () => {
    process.env.HADRON_TEST_RUN_ID='99'; process.env.HADRON_TEST_RUN_SCOPE=foreign;
    stampTestRunIdentity();
    expect(testRunId()).toBe(String(process.pid));
    expect(testRunScope()).toBe(computeRunScope());
    expect(testRunToken()).toBe(`${testRunScope()}_p${process.pid}`);
  });
  it.each([undefined,'','pid1','l../bad','l'+'a'.repeat(19)])('refuses an unset/malformed worker scope: %s', value=>{
    if(value===undefined) delete process.env.HADRON_TEST_RUN_SCOPE; else process.env.HADRON_TEST_RUN_SCOPE=value;
    expect(()=>workerDbName(1,'b','1')).toThrow(/HADRON_TEST_RUN_SCOPE/);
  });
  it('never probes foreign/prior-boot/unknown/legacy PIDs, even if absent locally', () => {
    process.env.HADRON_TEST_RUN_SCOPE=scope;
    const kill=vi.spyOn(process,'kill').mockImplementation(()=>{throw Object.assign(new Error(),{code:'ESRCH'});});
    for(const s of [foreign,null,'u'+'a'.repeat(20)]) expect(isOwnedRunDead(s,'99')).toBe(false);
    expect(kill).not.toHaveBeenCalled();
    expect(isOwnedRunDead(scope,'99')).toBe(true);
  });
  it.each(['EPERM','EIO',undefined])('preserves same-scope PID reuse or unverifiable liveness (%s)', code=>{
    process.env.HADRON_TEST_RUN_SCOPE=scope;
    vi.spyOn(process,'kill').mockImplementation(()=>{throw Object.assign(new Error(),{code});});
    expect(isOwnedRunDead(scope,'99')).toBe(false);
  });
  it('preserves a live same-scope run before its first DB connection (PID reuse too)',()=>{
    process.env.HADRON_TEST_RUN_SCOPE=scope;
    vi.spyOn(process,'kill').mockReturnValue(true);
    expect(isOwnedRunDead(scope,'99')).toBe(false);
  });
  it('parses full tokens exactly and old parsers ignore new names; keeps legacy ownership unknown',()=>{
    process.env.HADRON_TEST_RUN_SCOPE=scope;
    const name=workerDbName(1,'ha.ron','99');
    expect(parseWorkerDbName(name,'ha.ron')).toEqual({datname:name,runId:'99',scope,runToken:runToken('99'),poolId:'1'});
    expect(/^r([0-9]+)_([0-9]+|tpl)$/.test(name.slice('ha.ron_'.length))).toBe(false);
    for(const legacy of ['b_1','b_r99_1','b_r99_tpl']) expect(parseWorkerDbName(legacy,'b')?.runToken).toBeNull();
    for(const invalid of [name+'x',name.replace('ha.ron','haXron'),'ha.ron_s0123456789abcdef','ha.ron_s0123456789abcdef_build']) expect(parseWorkerDbName(invalid,'ha.ron')).toBeNull();
    expect(parseWorkerDbName(runTemplateDbName('99','b'),'b')?.poolId).toBe('tpl');
  });
  it('admits loopback and Unix-socket endpoints without assuming namespace locality',()=>{
    expect(isLocalDbHost('postgresql://u@127.0.0.1/b')).toBe(true);
    expect(isLocalDbHost('postgresql:///b?host=/shared/socket')).toBe(true);
    expect(isLocalDbHost('postgresql://u@remote/b')).toBe(false);
  });
});
