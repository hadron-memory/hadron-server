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
import { openSecretProof, proveSecretChange, completeSecretChange, declineSecretChange, SecretCeremonyRefused } from '../lib/secrets/changeCeremony.js';
import { respondInternalFault } from '../lib/internalFault.js';
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
const messages={PASSKEY_COOLING_OFF:'This passkey is still in its cooling-off period.',SECRET_CHANGE_REQUEST_STALE:'The secret changed. Open a new change request.',SECRET_CHANGE_REQUEST_EXPIRED:'This request expired. Open a new change request.'};
const terminal=e=>e.code==='SECRET_CHANGE_REQUEST_STALE'||e.code==='SECRET_CHANGE_REQUEST_EXPIRED';
const cancelled=e=>e.name==='NotAllowedError'||e.name==='AbortError';
const errorText=e=>cancelled(e)?'The passkey step was cancelled or did not complete. Try again when you are ready.':messages[e.code]||'The change could not be approved. Try again or open a new request.';
const post=async(p,body)=>{
 const r=await fetch('${PATH}/'+encodeURIComponent(id)+'/'+p,{method:'POST',credentials:'same-origin',headers:{'content-type':'application/json'},body:JSON.stringify(body||{})});
 const out=await r.json();if(!r.ok){const e=new Error('Secret change refused');e.code=out.code;throw e;}return out;
};
const assert=async opt=>{
 const c=await navigator.credentials.get({publicKey:{challenge:bytes(opt.challenge),rpId:opt.rpId,userVerification:'required',timeout:120000}});
 if(!c)throw Object.assign(new Error('Prompt closed'),{name:'NotAllowedError'});
 return{ceremonyId:opt.ceremonyId,credentialId:b64(c.rawId),authenticatorData:b64(c.response.authenticatorData),clientDataJson:b64(c.response.clientDataJSON),signature:b64(c.response.signature)};
};
const endedText=state=>({completed:'This change was already completed.',withdrawn:'This request was withdrawn. Open a new request if you still need the change.',expired:'This request expired. Open a new change request.',stale:'The secret changed. Open a new change request.',declined:'This request was declined. Open a new request if you still need the change.'})[state]||'This request is no longer available. Open a new change request.';
const completionText=s=>({DELETE:'The secret was deleted.',SET_PROTECTED:'Protection is now on.',CLEAR_PROTECTED:'Protection is now off.'})[s.operation]||'Completed: '+s.change+'.';
start.onclick=async()=>{
 start.disabled=true;status.textContent='';
 try{
  const p=await post('proof/challenge');const out=await post('proof',await assert(p));
  if(out.outcome==='ended'){status.textContent=endedText(out.state);return;}
  start.hidden=true;review.hidden=false;review.replaceChildren();
  const dl=document.createElement('dl');
  const row=(label,value)=>{const dt=document.createElement('dt'),dd=document.createElement('dd');dt.textContent=label;dd.textContent=String(value);dl.append(dt,dd);};
  row('Change',out.summary.change);row('Secret',out.summary.secret);row('App',out.summary.app);
  if(out.summary.metadata!==undefined)row('New metadata',Object.entries(out.summary.metadata).map(([k,v])=>k+': '+(v!==null&&typeof v==='object'?JSON.stringify(v):String(v))).join('; ')||'(none)');
  if(out.summary.sizeBytes!==null)row('Value size',new Intl.NumberFormat().format(out.summary.sizeBytes)+' bytes');
  const expiry=new Date(out.summary.expiresAt);
  row('Request expires',new Intl.DateTimeFormat(undefined,{dateStyle:'medium',timeStyle:'long'}).format(expiry)+' ('+Intl.DateTimeFormat().resolvedOptions().timeZone+')');
  review.append(dl);
  const note=document.createElement('p');note.textContent='Approve only the change you requested. A store uses the value you supplied; it is never shown here.';review.append(note);
  if(out.summary.operation==='DELETE'){const warning=document.createElement('p');warning.textContent='Deleting this secret removes its versions and cannot be undone.';review.append(warning);}
  const approve=document.createElement('button');approve.textContent='Approve with my passkey';review.append(approve);approve.focus();
  const decline=document.createElement('button');decline.textContent='Decline this request';review.append(decline);
  approve.onclick=async()=>{
   approve.disabled=true;decline.disabled=true;
   try{await post('complete',await assert(out));review.replaceChildren();status.textContent=completionText(out.summary)+' Next: return to where you requested the change.';$('title').focus();}
   catch(e){status.textContent=errorText(e);approve.disabled=terminal(e);decline.disabled=terminal(e);}
  };
  decline.onclick=async()=>{
   approve.disabled=true;decline.disabled=true;
   try{await post('decline',await assert({...out.decline,rpId:out.rpId}));review.replaceChildren();status.textContent='This request was declined. Nothing was changed. Open a new request if you still need the change.';$('title').focus();}
   catch(e){status.textContent=errorText(e);approve.disabled=terminal(e);decline.disabled=terminal(e);}
  };
 }catch(e){status.textContent=cancelled(e)?errorText(e):'The request is unavailable, or the passkey proof did not succeed.';start.disabled=false;}
};
})();`;
function nonce(req:Request){return(req.headers.cookie??'').split(';').map(s=>s.trim()).find(s=>s.startsWith(COOKIE+'='))?.slice(COOKIE.length+1)??null;}
function decode(v:unknown){if(typeof v!=='string'||!v.length||v.length>8192||!/^[A-Za-z0-9_-]+$/.test(v))throw new SecretCeremonyRefused();return Buffer.from(v,'base64url');}
/** Mount only with signing enabled; off means no route, not a different refusal surface. */
export function mountSecretChangeCeremonyRoutes(app:Express){
 if(!signingSurfacePolicy().signing)return;
 const limiter=rateLimit({windowMs:60_000,limit:60,standardHeaders:false,legacyHeaders:false});
 const limited=rateLimit({windowMs:900_000,limit:30,standardHeaders:false,legacyHeaders:false});
 const body=express.json({limit:'16kb'});
 app.get(`${PATH}/ceremony.js`,limiter,(_,res)=>{res.set(HEADERS).type('application/javascript').send(SCRIPT);});
 app.get(`${PATH}/:id`,limiter,(_,res)=>{res.set(HEADERS).type('html').send(SHELL);});
 for(const operation of ['proof/challenge','proof','complete','decline'])app.post(`${PATH}/:id/${operation}`,limiter,limited,body,async(req,res)=>{
  res.set(HEADERS);
  try{
   if(typeof req.headers.origin!=='string'||!signingCeremonyOrigins().includes(req.headers.origin))throw new SecretCeremonyRefused();
   const id=req.params.id;if(typeof id!=='string'||!/^[A-Za-z0-9_-]{1,64}$/.test(id))throw new SecretCeremonyRefused();
   const cookieOptions={httpOnly:true,sameSite:'strict' as const,path:PATH,secure:req.secure||req.headers.origin.startsWith('https://'),maxAge:600_000};
   if(operation==='proof/challenge'){
    const old=nonce(req),n=old&&/^[A-Za-z0-9_-]{20,64}$/.test(old)?old:randomBytes(32).toString('base64url');
    const out=await openSecretProof(db,{requestId:id,browserNonceHash:hash(n)});res.cookie(COOKIE,n,cookieOptions);res.json({...out,rpId:passkeyRpId()});return;
   }
   const n=nonce(req);if(!n||!/^[A-Za-z0-9_-]{20,64}$/.test(n))throw new SecretCeremonyRefused();
   const b=req.body;if(!b||typeof b.ceremonyId!=='string'||!/^[A-Za-z0-9_-]{20,64}$/.test(b.ceremonyId))throw new SecretCeremonyRefused();
   const a={requestId:id,ceremonyId:b.ceremonyId,browserNonceHash:hash(n),credentialId:decode(b.credentialId),assertion:{authenticatorData:decode(b.authenticatorData),clientDataJson:decode(b.clientDataJson),signature:decode(b.signature)}};
   if(operation==='proof'){
    const result=await proveSecretChange(db,a);const {nonce:newNonce,...out}=result.outcome==='change'?result:{...result,nonce:undefined};
    if(newNonce)res.cookie(COOKIE,newNonce,cookieOptions);res.json(out);return;
   }
   if(operation==='decline'){await declineSecretChange(db,a);res.json({ok:true});return;}
   await completeSecretChange(db,a);res.json({ok:true});
  }catch(e){
   if(e instanceof SecretCeremonyRefused){res.status(403).json({code:'FORBIDDEN'});return;}
   if(e instanceof GraphQLError && ['SECRET_CHANGE_REQUEST_EXPIRED','SECRET_CHANGE_REQUEST_STALE','PASSKEY_COOLING_OFF','FORBIDDEN','UNAUTHENTICATED'].includes(String(e.extensions.code))){res.status(403).json({code:e.extensions.code});return;}
   // Crypto and database exceptions may contain staged bytes. Correlate the fault without logging their payloads.
   respondInternalFault(res,'secret-change-ceremony',new Error('Secret change operation failed.'));
  }
 });
}
