import assert from 'node:assert/strict';
import {test,after} from 'node:test';
import {startSpike} from './preview.mjs';
const keys=['PASSKEY_SPIKE_CEREMONY_EXPIRY_SECONDS','PASSKEY_SPIKE_BROWSER_TIMEOUT_MS'];
const originalEnv=keys.map(key=>process.env[key]);
after(()=>keys.forEach((key,i)=>originalEnv[i]===undefined?delete process.env[key]:process.env[key]=originalEnv[i]));
for(const key of keys) delete process.env[key];
async function post(s,path,body={},cookie='') {
 const r=await fetch(s.url+path,{method:'POST',headers:{'Content-Type':'application/json',Cookie:cookie},body:JSON.stringify(body)});
 return {body:await r.json(),cookie:r.headers.get('set-cookie')?.split(';')[0],status:r.status};
}
test('generous defaults and registration hint',async()=>{
 const s=await startSpike(); try {
 const c=await (await fetch(s.url+'config')).json();
 assert.equal(c.ceremonyExpirySeconds,600);
 assert.equal(c.browserTimeoutMs,300000);
 assert.equal((await post(s,'registration/options')).body.options.timeout,300000);
 }finally{await s.close();}
});
test('explicit overrides beat env',async()=>{
 process.env.PASSKEY_SPIKE_CEREMONY_EXPIRY_SECONDS='700';
 process.env.PASSKEY_SPIKE_BROWSER_TIMEOUT_MS='400000';
 const s=await startSpike({ceremonyExpirySeconds:120,browserTimeoutMs:60000});
 try{
 const c=await (await fetch(s.url+'config')).json();
 assert.equal(c.ceremonyExpirySeconds,120);
 assert.equal(c.browserTimeoutMs,60000);
 assert.equal((await post(s,'registration/options')).body.options.timeout,60000);
 }
 finally{await s.close();for(const key of keys)delete process.env[key];}
});
test('server ceremony survives old deadline, consumes failure, expires inside session',async()=>{
 const s=await startSpike({sessionTtlSeconds:1800,ceremonyExpirySeconds:120});
 const realNow=Date.now;const now=realNow();
 try{
 Date.now=()=>now;
 const first=await post(s,'registration/options');
 const second=await post(s,'registration/options',{},first.cookie);
 Date.now=()=>now+61000;
 const attempted=await post(s,'registration/verify',{id:first.body.id,response:{}},first.cookie);
 assert.equal(attempted.body.code,'VERIFICATION_REFUSED','unused ceremony must reach mandatory verifier after old deadline');
 assert.equal((await post(s,'registration/verify',{id:first.body.id,response:{}},first.cookie)).body.code,'CEREMONY_SPENT');
 Date.now=()=>now+120001;
 assert.equal((await post(s,'registration/verify',{id:second.body.id,response:{}},first.cookie)).body.code,'CEREMONY_SPENT');
 Date.now=()=>now+62000;
 assert.equal((await post(s,'registration/verify',{id:second.body.id,response:{}},first.cookie)).body.code,'CEREMONY_SPENT','expired ceremony stays consumed even if clock reverses');
 }finally{Date.now=realNow;await s.close();}
});
test('invalid configuration refuses startup',async()=>{
 for(const [key,values]of Object.entries({ceremonyExpirySeconds:[0,29,3601,NaN,Infinity,30.5],browserTimeoutMs:[0,19999,900001,NaN,Infinity,20000.5]}))
 for(const value of values) {
 let s;try{s=await startSpike({[key]:value});assert.fail('invalid '+key+' accepted');}catch(e){assert.match(e.message,new RegExp('Invalid '+key));}finally{await s?.close();}
 }
});
test('environment settings and explicit range endpoints',async()=>{
 const saved=keys.map(k=>process.env[k]);
 try{
 process.env.PASSKEY_SPIKE_CEREMONY_EXPIRY_SECONDS='900';
 process.env.PASSKEY_SPIKE_BROWSER_TIMEOUT_MS='420000';
 const s=await startSpike();try{
 const c=await (await fetch(s.url+'config')).json();assert.equal(c.ceremonyExpirySeconds,900);assert.equal(c.browserTimeoutMs,420000);
 assert.equal((await post(s,'registration/options')).body.options.timeout,420000);
 }finally{await s.close();}
 for(const key of keys)for(const value of ['', 'nope','Infinity','1.5']){
 process.env[key]=value;await assert.rejects(startSpike(),/Invalid/);
 process.env[key]=key===keys[0]?'900':'420000';
 }
 for(const [ceremonyExpirySeconds,browserTimeoutMs]of [[30,20000],[3600,900000]]){
 const s=await startSpike({ceremonyExpirySeconds,browserTimeoutMs});try{
 const c=await (await fetch(s.url+'config')).json();assert.equal(c.ceremonyExpirySeconds,ceremonyExpirySeconds);assert.equal(c.browserTimeoutMs,browserTimeoutMs);
 }finally{await s.close();}
 }
 }finally{keys.forEach((k,i)=>saved[i]===undefined?delete process.env[k]:process.env[k]=saved[i]);}
});
test('session bounds an otherwise unexpired ceremony',async()=>{
 const s=await startSpike({sessionTtlSeconds:30,ceremonyExpirySeconds:600});
 const realNow=Date.now;const now=realNow();
 try{
 Date.now=()=>now;const o=await post(s,'registration/options');
 Date.now=()=>now+30000;
 assert.equal((await post(s,'registration/verify',{id:o.body.id,response:{}},o.cookie)).body.code,'SESSION_REQUIRED');
 }finally{Date.now=realNow;await s.close();}
});
