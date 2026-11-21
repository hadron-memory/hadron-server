/** #3999 HTTP shell: no link reveals metadata and all routes disappear with signing off. */
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as ceremony from '../lib/secrets/changeCeremony.js';
import express from 'express';
import { type Server } from 'node:http';
import { mountSecretChangeCeremonyRoutes } from './secretChangeCeremonyRoutes.js';
let server:Server|undefined;
afterEach(async()=>{vi.restoreAllMocks();vi.unstubAllEnvs();if(server)await new Promise<void>(r=>server!.close(()=>r()));server=undefined;});
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
 it('returns a correlated internal fault for a database failure without logging staged data',async()=>{
  vi.stubEnv('SIGNING_CEREMONY_ORIGINS','http://localhost:4000');
  vi.spyOn(ceremony,'openSecretProof').mockRejectedValue(new Error('database-staged-ciphertext-canary'));
  const log=vi.spyOn(console,'error').mockImplementation(()=>{});
  const base=await host(true),r=await fetch(base+'/secret-changes/request/proof/challenge',{method:'POST',headers:{origin:'http://localhost:4000'}});
  expect(r.status).toBe(500);const out=await r.json() as {requestId:string};expect(out).toMatchObject({code:'INTERNAL_SERVER_ERROR',error:'Internal server error.',requestId:expect.any(String)});
  expect(log).toHaveBeenCalledTimes(1);expect(log.mock.calls[0][1]).toMatchObject({requestId:out.requestId,site:'secret-change-ceremony'});
  expect(JSON.stringify(log.mock.calls)).not.toContain('database-staged-ciphertext-canary');expect(JSON.stringify(out)).not.toContain('canary');
 });
 it('refuses a missing Origin before opening any proof',async()=>{
  const base=await host(true),r=await fetch(base+'/secret-changes/missing/proof/challenge',{method:'POST'});
  expect(r.status).toBe(403);expect(await r.json()).toEqual({code:'FORBIDDEN'});
 });
});

/** Execute served JS with a tiny synthetic DOM, not a browser or a stack. No WebAuthn/provider calls. */
async function pageModel(over: Record<string,unknown> = {}, opts: { cancelled?:boolean; completeCode?:string; ended?:string } = {}) {
 const { runInNewContext } = await import('node:vm');
 const { vi } = await import('vitest');
 class Element {
  children:Element[]=[];hidden=false;disabled=false;textContent='';onclick?:()=>Promise<void>;focused=false;
  constructor(public tagName:string){Object.defineProperty(this,'innerHTML',{set(){throw new Error('unsafe HTML');}});}
  append(...nodes:Element[]){this.children.push(...nodes);}
  replaceChildren(...nodes:Element[]){this.children=[...nodes];}
  focus(){this.focused=true;}
 }
 const elements=Object.fromEntries(['status','review','start','title'].map(id=>[id,new Element(id)]));elements.review.hidden=true;
 const summary={app:'hrn:app:example.test:demo',secret:'hrn:secret:example.test:app:demo:token',operation:'SET_PROTECTED',change:'Turn protection on',sizeBytes:1024,requester:'opaque-user-id',expiresAt:'2030-01-02T03:04:05Z',unexpectedValue:'never-render-canary',...over};
 const fetchModel=vi.fn(async(url:string)=>({ok:!(url.endsWith('/complete')&&opts.completeCode),json:async()=>url.endsWith('/proof/challenge')?{challenge:'AA',rpId:'localhost',ceremonyId:'proof'}:url.endsWith('/proof')?(opts.ended?{outcome:'ended',state:opts.ended}:{outcome:'change',summary,challenge:'AA',rpId:'localhost',ceremonyId:'complete'}):(opts.completeCode?{code:opts.completeCode}:{ok:true})}));
 const credentials=vi.fn(async()=>{if(opts.cancelled)throw Object.assign(new Error('user cancelled'),{name:'NotAllowedError'});return{rawId:new ArrayBuffer(1),response:{authenticatorData:new ArrayBuffer(1),clientDataJSON:new ArrayBuffer(1),signature:new ArrayBuffer(1)}};});
 const base=await host(true),script=await(await fetch(base+'/secret-changes/ceremony.js')).text();
 runInNewContext(script,{document:{getElementById:(id:string)=>elements[id],createElement:(tag:string)=>new Element(tag)},location:{pathname:'/secret-changes/request'},navigator:{credentials:{get:credentials}},fetch:fetchModel,Uint8Array,ArrayBuffer,Date,Intl,btoa:(s:string)=>Buffer.from(s,'binary').toString('base64'),atob:(s:string)=>Buffer.from(s,'base64').toString('binary')});
 return{elements,summary,fetchModel,credentials};
}
describe('#3999 readable approval model (Node VM; no browser)',()=>{
 it('renders fixed human labels with Change first, local expiry/zone, and no raw requester, enum or extra value',async()=>{
  const {elements,summary}=await pageModel();expect(elements.review.hidden).toBe(true);await elements.start.onclick!();
  const dl=elements.review.children[0];const labels=dl.children.filter((_,i)=>i%2===0).map(n=>n.textContent);
  expect(labels).toEqual(['Change','Secret','App','Value size','Request expires']);
  const values=dl.children.filter((_,i)=>i%2===1).map(n=>n.textContent);expect(values[0]).toBe('Turn protection on');
  expect(values[3]).toBe(new Intl.NumberFormat().format(1024)+' bytes');expect(values[4]).not.toBe(summary.expiresAt);expect(values[4]).toContain(Intl.DateTimeFormat().resolvedOptions().timeZone);
  const text=JSON.stringify(dl);expect(text).not.toContain('opaque-user-id');expect(text).not.toContain('SET_PROTECTED');expect(text).not.toContain('never-render-canary');
 });
 it('renders the proposed inspectable metadata as plain text for a store',async()=>{
  const metadata={type:'bearer',urlPrefix:'https://example.test/<script>unsafe</script>'};
  const {elements}=await pageModel({operation:'STORE',change:'Update secret metadata',sizeBytes:null,metadata});await elements.start.onclick!();
  const rows=elements.review.children[0].children;const i=rows.findIndex(n=>n.textContent==='New metadata');expect(i).toBeGreaterThan(-1);expect(rows[i+1].textContent).toBe(JSON.stringify(metadata));
 });
 it('a dismissed proof prompt is a retryable cancellation, not an unavailable request',async()=>{
  const {elements}=await pageModel({}, {cancelled:true});await elements.start.onclick!();
  expect(elements.status.textContent).toMatch(/prompt.*closed|cancelled/i);expect(elements.status.textContent).not.toMatch(/unavailable/);expect(elements.start.disabled).toBe(false);expect(elements.review.hidden).toBe(true);
 });
 it('uses a readable ended-state message and never exposes the raw state value',async()=>{
  const {elements}=await pageModel({}, {ended:'withdrawn'});await elements.start.onclick!();expect(elements.status.textContent).toBe('This request was withdrawn. Open a new request if you still need the change.');
 });
 it.each(['SECRET_CHANGE_REQUEST_STALE','SECRET_CHANGE_REQUEST_EXPIRED'])('a terminal %s response disables approval',async completeCode=>{
  const {elements}=await pageModel({}, {completeCode});await elements.start.onclick!();const approve=elements.review.children.find(n=>n.tagName==='button')!;await approve.onclick!();expect(approve.disabled).toBe(true);expect(elements.status.textContent).toMatch(/new change request/i);
 });
 it('warns that delete is irreversible, then names the completed change and next step',async()=>{
  const {elements}=await pageModel({operation:'DELETE',change:'Delete this secret',sizeBytes:null});await elements.start.onclick!();expect(elements.review.children.some(n=>/cannot be undone/.test(n.textContent))).toBe(true);
  const approve=elements.review.children.find(n=>n.tagName==='button')!;await approve.onclick!();expect(elements.status.textContent).toMatch(/deleted/i);expect(elements.status.textContent).toMatch(/Next:/);
 });
});
