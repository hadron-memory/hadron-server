/** #3999 HTTP shell: no link reveals metadata and all routes disappear with signing off. */
import { afterEach, describe, expect, it } from 'vitest';
import express from 'express';
import { type Server } from 'node:http';
import { mountSecretChangeCeremonyRoutes } from './secretChangeCeremonyRoutes.js';
let server:Server|undefined;
afterEach(async()=>{if(server)await new Promise<void>(r=>server!.close(()=>r()));server=undefined;});
async function host(on:boolean){const app=express();process.env.PASSKEY_SIGNING_ENABLED=String(on);mountSecretChangeCeremonyRoutes(app);
 server=app.listen(0,'127.0.0.1');await new Promise<void>(r=>server!.once('listening',r));return `http://127.0.0.1:${(server.address() as any).port}`;}
describe('#3999 server ceremony shell',()=>{
 it('is byte identical for every id, no-store and protected from framing',async()=>{
  const base=await host(true),a=await fetch(base+'/secret-changes/real-canary'),b=await fetch(base+'/secret-changes/missing');
  expect(await a.text()).toBe(await b.text());expect(a.headers.get('cache-control')).toBe('no-store');expect(a.headers.get('x-frame-options')).toBe('DENY');
 });
 it('has no page or proof route when signing is off',async()=>{
  const base=await host(false);expect((await fetch(base+'/secret-changes/missing')).status).toBe(404);
  expect((await fetch(base+'/secret-changes/missing/proof/challenge',{method:'POST'})).status).toBe(404);
 });
 it('refuses a missing Origin before opening any proof',async()=>{
  const base=await host(true),r=await fetch(base+'/secret-changes/missing/proof/challenge',{method:'POST'});
  expect(r.status).toBe(403);expect(await r.json()).toEqual({code:'FORBIDDEN'});
 });
});
