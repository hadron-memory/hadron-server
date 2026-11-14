/** #3999; cor:sec:070:02. Static server page; proof before metadata, two own-passkey assertions, never a value. */
import { createHash, randomBytes } from 'node:crypto';
import express, { type Express, type Request } from 'express';
import rateLimit from 'express-rate-limit';
import { GraphQLError } from 'graphql';
import { db } from '../integrations/db/client.js';
import { ceremonyShell } from './ceremonyShell.js';
import { signingSurfacePolicy } from '../lib/signing/surface.js';
import { passkeyRpId, signingCeremonyOrigins } from '../lib/signing/config.js';
import { SECRET_CHANGE_PATH as PATH } from '../lib/secrets/changeRequests.js';
import { openSecretProof, proveSecretChange, completeSecretChange } from '../lib/secrets/changeCeremony.js';
const COOKIE='hadron_secret_change';
const hash=(s:string)=>createHash('sha256').update(s).digest('hex');
const HEADERS={ 'Cache-Control':'no-store','Referrer-Policy':'same-origin','X-Content-Type-Options':'nosniff','X-Frame-Options':'DENY',
 'Content-Security-Policy':"default-src 'none'; script-src 'self'; style-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'" };
const SHELL=ceremonyShell({title:'Review a secret change',scriptSrc:`${PATH}/ceremony.js`,body:'<h1 id="title" tabindex="-1">Review a secret change</h1><p>Confirm it is you with your passkey to see your request. This page never shows the secret value.</p><noscript>This page needs JavaScript to use your passkey.</noscript><button id="start">Use passkey</button><div id="review" hidden></div><p id="status" role="status" aria-live="polite"></p>'});
const SCRIPT=`(()=>{
const $=id=>document.getElementById(id),status=$('status'),review=$('review'),start=$('start');
const id=location.pathname.split('/').filter(Boolean).pop();
const b64=b=>btoa(String.fromCharCode(...new Uint8Array(b))).replace(/\\+/g,'-').replace(/\\//g,'_').replace(/=+$/,'');
const bytes=s=>Uint8Array.from(atob(s.replace(/-/g,'+').replace(/_/g,'/')),c=>c.charCodeAt(0));
const post=async(p,body)=>{const r=await fetch('${PATH}/'+encodeURIComponent(id)+'/'+p,{method:'POST',credentials:'same-origin',headers:{'content-type':'application/json'},body:JSON.stringify(body||{})});const out=await r.json();if(!r.ok)throw new Error(({PASSKEY_COOLING_OFF:'This passkey is still in its cooling-off period.',SECRET_CHANGE_REQUEST_STALE:'The secret changed. Open a new change request.',SECRET_CHANGE_REQUEST_EXPIRED:'This request expired. Open a new change request.'})[out.code]||'The change could not be approved.');return out;};
const assert=async opt=>{const c=await navigator.credentials.get({publicKey:{challenge:bytes(opt.challenge),rpId:opt.rpId,userVerification:'required',timeout:120000}});return{ceremonyId:opt.ceremonyId,credentialId:b64(c.rawId),authenticatorData:b64(c.response.authenticatorData),clientDataJson:b64(c.response.clientDataJSON),signature:b64(c.response.signature)};};
start.onclick=async()=>{start.disabled=true;status.textContent='';try{const p=await post('proof/challenge');const out=await post('proof',await assert(p));if(out.outcome==='ended'){status.textContent='This request has ended ('+out.state+').';return;}start.hidden=true;review.hidden=false;review.replaceChildren();const dl=document.createElement('dl');for(const [k,v] of Object.entries(out.summary)){const dt=document.createElement('dt'),dd=document.createElement('dd');dt.textContent=k;dd.textContent=v===null?'Not applicable':String(v);dl.append(dt,dd);}review.append(dl);const note=document.createElement('p');note.textContent='Approve only the change you requested. A store uses the value you supplied; it is never shown here.';review.append(note);const approve=document.createElement('button');approve.textContent='Approve with my passkey';review.append(approve);approve.focus();approve.onclick=async()=>{approve.disabled=true;try{await post('complete',await assert(out));review.replaceChildren();status.textContent='Your change was completed.';$('title').focus();}catch(e){status.textContent=e.message;approve.disabled=false;}};}catch(e){status.textContent='The request is unavailable, or the passkey proof did not succeed.';start.disabled=false;}};
})();`;
function nonce(req:Request){return(req.headers.cookie??'').split(';').map(s=>s.trim()).find(s=>s.startsWith(COOKIE+'='))?.slice(COOKIE.length+1)??null;}
function decode(v:unknown){if(typeof v!=='string'||!v.length||v.length>8192||!/^[A-Za-z0-9_-]+$/.test(v))throw new Error('invalid');return Buffer.from(v,'base64url');}
/** Mount only with signing enabled; off means no route, not a different refusal surface. */
export function mountSecretChangeCeremonyRoutes(app:Express){
 if(!signingSurfacePolicy().signing)return;
 const limiter=rateLimit({windowMs:60_000,limit:60,standardHeaders:false,legacyHeaders:false});
 const limited=rateLimit({windowMs:900_000,limit:30,standardHeaders:false,legacyHeaders:false});
 const body=express.json({limit:'16kb'});
 app.get(`${PATH}/ceremony.js`,limiter,(_,res)=>{res.set(HEADERS).type('application/javascript').send(SCRIPT);});
 app.get(`${PATH}/:id`,limiter,(_,res)=>{res.set(HEADERS).type('html').send(SHELL);});
 for(const operation of ['proof/challenge','proof','complete'])app.post(`${PATH}/:id/${operation}`,limiter,limited,body,async(req,res)=>{
  res.set(HEADERS);
  try{
   if(typeof req.headers.origin!=='string'||!signingCeremonyOrigins().includes(req.headers.origin))throw new Error('origin');
   const id=req.params.id;if(typeof id!=='string'||!/^[A-Za-z0-9_-]{1,64}$/.test(id))throw new Error('id');
   const cookieOptions={httpOnly:true,sameSite:'strict' as const,path:PATH,secure:req.secure||req.headers.origin.startsWith('https://'),maxAge:600_000};
   if(operation==='proof/challenge'){
    const old=nonce(req),n=old&&/^[A-Za-z0-9_-]{20,64}$/.test(old)?old:randomBytes(32).toString('base64url');
    const out=await openSecretProof(db,{requestId:id,browserNonceHash:hash(n)});res.cookie(COOKIE,n,cookieOptions);res.json({...out,rpId:passkeyRpId()});return;
   }
   const n=nonce(req);if(!n||!/^[A-Za-z0-9_-]{20,64}$/.test(n))throw new Error('cookie');
   const b=req.body;if(!b||typeof b.ceremonyId!=='string'||!/^[A-Za-z0-9_-]{20,64}$/.test(b.ceremonyId))throw new Error('body');
   const a={requestId:id,ceremonyId:b.ceremonyId,browserNonceHash:hash(n),credentialId:decode(b.credentialId),assertion:{authenticatorData:decode(b.authenticatorData),clientDataJson:decode(b.clientDataJson),signature:decode(b.signature)}};
   if(operation==='proof'){
    const result=await proveSecretChange(db,a);const {nonce:newNonce,...out}=result.outcome==='change'?result:{...result,nonce:undefined};
    if(newNonce)res.cookie(COOKIE,newNonce,cookieOptions);res.json(out);return;
   }
   await completeSecretChange(db,a);res.json({ok:true});
  }catch(e){const code=e instanceof GraphQLError&&['SECRET_CHANGE_REQUEST_EXPIRED','SECRET_CHANGE_REQUEST_STALE','PASSKEY_COOLING_OFF'].includes(String(e.extensions.code))?e.extensions.code:'FORBIDDEN';res.status(403).json({code});}
 });
}
