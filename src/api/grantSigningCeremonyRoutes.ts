/**
 * #3649 slice C (hrn:node:hadronmemory.com:specs:cor:acl:140:07, :04) — the server-hosted grant signing ceremony.
 *
 * Mounted only when `signingSurfacePolicy().signing` is on, exactly as node signing's (#1895): while off every path here is
 * an ordinary 404. The logic is `lib/signing/grantCeremony.ts`.
 *
 *   GET  /grant-signing/:id                  the static shell: the same bytes for every id
 *   GET  /grant-signing/ceremony.js          its script (same-origin; it builds the page from text nodes only)
 *   POST /grant-signing/:id/proof/challenge  opens a GRANT_SIGN_PROOF ceremony for this browser (the same answer for every id)
 *   POST /grant-signing/:id/proof            a passkey assertion: the prover must be able to ISSUE the grant; then the terms
 *   POST /grant-signing/:id/challenge        reads back the one GRANT_SIGN ceremony's bound challenge; mints nothing
 *   POST /grant-signing/:id/complete         the signing assertion; ONE transaction: record, request completed, grant ACTIVE
 *   POST /grant-signing/:id/decline          the proven issuer turns the request down
 *
 * The browser is the HttpOnly cookie `hadron_grant_signing`, scoped to this path: a node ceremony never sees it, so a node
 * proof never rotates or retires a grant ceremony (and the reverse). Origin allowlist, rate limits and the one uniform 403
 * are node signing's. After a proof, an ended request and the completion's own refusals get typed answers (the caller is by
 * then a proven issuer of that grant).
 */
import { createHash, randomBytes } from 'node:crypto';
import express, { type Express, type Request, type Response } from 'express';
import rateLimit from 'express-rate-limit';
import { db } from '../integrations/db/client.js';
import { passkeyRpId, signingCeremonyOrigins, SigningNotConfiguredError } from '../lib/signing/config.js';
import { GRANT_SIGNING_CEREMONY_PATH } from '../lib/signing/ceremonyUrl.js';
import { signingSurfacePolicy } from '../lib/signing/surface.js';
import { GrantSigningRefusal } from '../lib/signing/grantRequests.js';
import { ceremonyShell } from './ceremonyShell.js';
import {
  CeremonyRefused, completeGrantSigning, currentGrantSigningChallenge, declineGrantSigning, GRANT_SIGN_TTL_SECONDS,
  openGrantProofCeremony, proveForGrantSigning,
} from '../lib/signing/grantCeremony.js';
import { SIGNING_CEREMONY_PER_REQUEST_LIMIT, SIGNING_CEREMONY_RATE_LIMIT_PER_MINUTE } from './signingCeremonyRoutes.js';

const PATH = GRANT_SIGNING_CEREMONY_PATH;
const COOKIE = 'hadron_grant_signing';

const sha256Hex = (b: Uint8Array | string) => createHash('sha256').update(b).digest('hex');
const refuse = (res: Response) => res.status(403).type('application/json').set('Cache-Control', 'no-store').send('{"error":"forbidden"}');
const json = (res: Response, status: number, body: unknown) => res.status(status).type('application/json').set('Cache-Control', 'no-store').send(JSON.stringify(body));

const requestIdOf = (v: unknown) => (typeof v === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(v) ? v : null);
const ceremonyIdOf = (v: unknown) => (typeof v === 'string' && /^[A-Za-z0-9_-]{20,64}$/.test(v) ? v : null);
const b64 = (v: unknown, max = 4096): Buffer | null => {
  if (typeof v !== 'string' || v.length === 0 || v.length > max || !/^[A-Za-z0-9_-]+$/.test(v)) return null;
  return Buffer.from(v, 'base64url');
};

function cookieValue(req: Request): string | null {
  for (const part of (req.headers.cookie ?? '').split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === COOKIE) return v.join('=') || null;
  }
  return null;
}

function originAllowed(req: Request): boolean {
  const origin = req.headers.origin;
  return typeof origin === 'string' && signingCeremonyOrigins().includes(origin);
}

const PAGE_HEADERS: Record<string, string> = {
  'Cache-Control': 'no-store',
  'Referrer-Policy': 'same-origin',
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Content-Security-Policy': "default-src 'none'; script-src 'self'; style-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
};

/** The static shell. No request, grant or person appears in it: it is byte-identical for every id. */
const SHELL = ceremonyShell({
  title: 'Review and sign a grant', wide: true, scriptSrc: `${PATH}/ceremony.js`,
  extraCss: 'blockquote{white-space:pre-wrap;overflow-wrap:anywhere;background:rgba(127,127,127,.12);padding:.75rem;border-radius:.4rem;margin:0 0 1rem}dt{font-weight:600}dd{margin:0 0 .5rem;overflow-wrap:anywhere}.bar{position:sticky;bottom:0;background:Canvas;color:CanvasText;border-top:1px solid rgba(127,127,127,.4);margin-top:1rem;padding:.75rem 0 calc(.75rem + env(safe-area-inset-bottom))}.bar p{margin:0 0 .5rem}',
  body: `<h1 id="title" tabindex="-1">Review and sign a grant</h1>
<noscript><p>This page needs JavaScript to ask for your passkey. Turn it on and reload.</p></noscript>
<div id="start"><p>To see the grant you have been asked to sign, confirm it is you with your passkey. Nothing is shown until you do.</p><button id="go" type="button">Use passkey</button></div>
<div id="view" hidden></div><p id="msg" role="status" aria-live="polite"></p>`,
});

const TOO_MANY_SHELL = ceremonyShell({ title: 'Too many requests', body: '<p>Too many requests. Wait a minute, then reload this page.</p>' });

/**
 * The page's script. Every element is built with createElement and textContent, never HTML: the requester's reason and every
 * name are shown as text, so nothing in them can run. It never composes a link.
 */
const SCRIPT = `(()=>{
const b2u=(b)=>btoa(String.fromCharCode(...new Uint8Array(b))).replace(/\\+/g,'-').replace(/\\//g,'_').replace(/=+$/,'');
const u2b=(s)=>{s=s.replace(/-/g,'+').replace(/_/g,'/');const p=atob(s+'==='.slice((s.length+3)%4));return Uint8Array.from(p,(c)=>c.charCodeAt(0)).buffer;};
const id=location.pathname.split('/').filter(Boolean).pop();
const $=(i)=>document.getElementById(i);const msg=$('msg');const view=$('view');const start=$('start');const go=$('go');
const say=(t)=>{msg.textContent=t;};
const post=(p,b)=>fetch('${PATH}/'+encodeURIComponent(id)+'/'+p,{method:'POST',credentials:'same-origin',headers:{'content-type':'application/json'},body:JSON.stringify(b||{})});
const el=(tag,text,cls)=>{const e=document.createElement(tag);if(text!==undefined)e.textContent=text;if(cls)e.className=cls;return e;};
const assertion=(cred,ceremonyId)=>{const r=cred.response;return{ceremonyId,credentialId:b2u(cred.rawId),authenticatorData:b2u(r.authenticatorData),clientDataJson:b2u(r.clientDataJSON),signature:b2u(r.signature)};};
const focusTitle=()=>{$('title').focus();};
function setTitle(t){$('title').textContent=t;document.title=t;}
const home=msg.parentNode;
const stamp=(d)=>d.toLocaleString(undefined,{day:'numeric',month:'short',year:'numeric',hour:'numeric',minute:'2-digit',timeZoneName:'short'});
function finish(title,text){home.appendChild(msg);view.replaceChildren();start.hidden=true;view.hidden=false;view.appendChild(el('p',text));setTitle(title);say('');focusTitle();}
function ended(state){const w={COMPLETED:'This grant was already signed.',DECLINED:'This request was declined.',EXPIRED:'This request, or the grant itself, has expired.',STALE:'The grant changed or ended after this was requested, so this request can no longer be signed.',WITHDRAWN:'The person who asked withdrew this request.'};
 finish('This request has ended',(w[state]||'This request has ended.')+' Ask for a new signature request to sign again.');}
function row(dl,k,v){dl.appendChild(el('dt',k));dl.appendChild(el('dd',v));}
function render(out){
 view.replaceChildren();start.hidden=true;view.hidden=false;setTitle('Review and sign a grant');
 const v=out.view;
 const what=el('section');what.appendChild(el('h2','What this grant allows'));
 what.appendChild(el('p',v.summary===null?'You cannot read everything this grant refers to, so it is not shown and you cannot sign it.':v.summary));
 const dl=el('dl');
 row(dl,'Held by',(v.holder.name||'(unnamed)')+' ('+v.holder.kind+')');
 row(dl,'App',v.app.urn);
 row(dl,'Starts',v.startsAt?stamp(new Date(v.startsAt)):'When signed');
 row(dl,'Ends',v.expiresAt?stamp(new Date(v.expiresAt)):'No end date');
 row(dl,'Uses',v.maxUses===null?'No limit':String(v.maxUses));
 what.appendChild(dl);view.appendChild(what);
 const why=el('section');why.appendChild(el('h2','The requester\\'s reason'));
 why.appendChild(el('p','In their own words. Hadron did not write or check this text.'));
 why.appendChild(el('blockquote',v.requesterReason));view.appendChild(why);
 const meta=el('section');meta.appendChild(el('h2','This request'));
 meta.appendChild(el('p','Requested by '+v.requester.name+(v.requester.via?' via '+v.requester.via:'')+'.'));
 meta.appendChild(el('p','Expires '+stamp(new Date(v.requestExpiresAt))+'.'));
 meta.appendChild(el('p','Signing makes this grant active, and makes you its issuer.'));
 view.appendChild(meta);
 const actions=el('div');const bar=el('div',undefined,'bar');const stat=el('div');
 if(!out.canSign){actions.appendChild(el('p','You cannot sign this grant.'));view.appendChild(actions);focusTitle();say('');return;}
 const sign=el('button','Sign with passkey');sign.type='button';
 const dec=el('button','Decline');dec.type='button';
 let busy=false;const lock=(b)=>{busy=b;sign.disabled=b;dec.disabled=b;};
 const answer=(j)=>{
  if(j.error==='SIGNING_REQUEST_ENDED'){ended(j.state);return true;}
  if(j.error==='SIGNER_NOT_ELIGIBLE'){finish('Not signed','You can no longer issue this grant, so nothing was recorded.');return true;}
  if(j.error==='PASSKEY_COOLING_OFF'){finish('Not signed yet','This passkey was added recently and is still in its waiting period. Nothing was recorded. Sign again once the waiting period ends.');return true;}
  return false;};
 sign.addEventListener('click',async()=>{
  if(busy)return;lock(true);say('Waiting for your passkey…');let sent=false;
  try{
   const c=await post('challenge');if(!c.ok)throw new Error('refused');const o=await c.json();
   const cred=await navigator.credentials.get({publicKey:{challenge:u2b(o.challenge),rpId:o.rpId,userVerification:'required',timeout:120000,allowCredentials:o.allowCredentials.map((x)=>({type:'public-key',id:u2b(x)}))}});
   sent=true;
   const r=await post('complete',assertion(cred,o.ceremonyId));
   if(r.status>=500)throw new Error('uncertain');
   const j=await r.json().catch(()=>null);if(j===null)throw new Error('uncertain');
   if(r.ok){finish('Signed','Your signature was recorded and the grant is now active. You can close this page.');return;}
   if(answer(j))return;
   if(j.error==='SIGNATURE_NOT_VERIFIED'){say('That did not verify. Nothing was recorded. You can try again.');lock(false);sign.focus();return;}
   say('That did not work and nothing was recorded. Reload this page and start again.');lock(false);sign.focus();
  }catch(e){
   if(sent){say('We could not confirm whether your signature was recorded. Reload this page and check before trying again.');const re=el('button','Reload this page');re.type='button';re.addEventListener('click',()=>location.reload());stat.appendChild(re);re.focus();}
   else{say('That did not work and nothing was recorded. You can try again.');lock(false);sign.focus();}
  }
 });
 dec.addEventListener('click',()=>{
  if(busy)return;
  actions.replaceChildren(el('p','Decline this request? It will be ended and can no longer be signed. The grant stays inactive.'));
  const yes=el('button','Yes, decline');yes.type='button';const no=el('button','Cancel');no.type='button';
  no.addEventListener('click',()=>render(out));
  yes.addEventListener('click',async()=>{yes.disabled=true;no.disabled=true;say('');
   try{const r=await post('decline',{ceremonyId:(await (await post('challenge')).json()).ceremonyId});if(r.status>=500)throw new Error('uncertain');
    const j=await r.json().catch(()=>null);if(j===null)throw new Error('uncertain');
    if(r.ok){finish('Declined','You declined this request. You can close this page.');return;}
    if(answer(j))return;
    say('That did not work and nothing was changed. Reload this page and start again.');yes.disabled=false;no.disabled=false;yes.focus();
   }catch(e){say('We could not confirm whether the request was declined. Reload this page and check.');const re=el('button','Reload this page');re.type='button';re.addEventListener('click',()=>location.reload());stat.appendChild(re);re.focus();}});
  actions.appendChild(yes);actions.appendChild(no);no.focus();
 });
 actions.appendChild(sign);actions.appendChild(dec);
 bar.appendChild(stat);stat.appendChild(msg);bar.appendChild(actions);view.appendChild(bar);
 focusTitle();say('');
}
go.addEventListener('click',async()=>{
 go.disabled=true;say('');
 if(!(navigator.credentials&&navigator.credentials.get&&window.PublicKeyCredential)){say('This browser cannot use a passkey here. Open this page in a current browser that supports passkeys.');go.disabled=false;return;}
 try{
  const o=await post('proof/challenge');if(!o.ok)throw new Error('refused');const opt=await o.json();
  const cred=await navigator.credentials.get({publicKey:{challenge:u2b(opt.challenge),rpId:opt.rpId,userVerification:'required',timeout:120000}});
  const r=await post('proof',assertion(cred,opt.ceremonyId));
  if(!r.ok)throw new Error('refused');
  const out=await r.json();
  if(out.outcome==='ended')ended(out.state);else render(out);
 }catch(e){say('That did not work. You may not be able to sign this grant, or the request may no longer be available. Try again.');go.disabled=false;go.focus();}
});
})();`;

/** Mount the grant signing ceremony when the signing switch is on; the switch is read once, at mount. */
export function mountGrantSigningCeremonyRoutes(app: Express, env: NodeJS.ProcessEnv = process.env): void {
  if (!signingSurfacePolicy(env).signing) return;
  const limited = (req: Request, res: Response) => {
    if (req.method === 'GET' && req.route?.path === `${PATH}/:id`) res.status(429).set({ ...PAGE_HEADERS, 'Retry-After': '60' }).type('html').send(TOO_MANY_SHELL);
    else res.status(429).end();
  };
  const limiter = rateLimit({
    windowMs: 60_000, limit: SIGNING_CEREMONY_RATE_LIMIT_PER_MINUTE, standardHeaders: false, legacyHeaders: false, handler: limited,
  });
  const perRequest = rateLimit({
    windowMs: 15 * 60_000, limit: SIGNING_CEREMONY_PER_REQUEST_LIMIT, standardHeaders: false, legacyHeaders: false,
    keyGenerator: (req) => `grant-signing:${req.ip ?? 'unknown'}:${sha256Hex(String(req.params.id))}`,
    validate: { keyGeneratorIpFallback: false },
    handler: (_req, res) => { res.status(429).end(); },
  });
  const body = express.json({ limit: '16kb' });
  const cookieOptions = (req: Request) => ({
    httpOnly: true, sameSite: 'strict' as const, path: PATH,
    secure: req.secure || req.headers.origin?.startsWith('https://') === true,
  });

  app.get(`${PATH}/ceremony.js`, limiter, (_req, res) => {
    res.set(PAGE_HEADERS).type('application/javascript').status(200).send(SCRIPT);
  });
  app.get(`${PATH}/:id`, limiter, (_req, res) => {
    res.set(PAGE_HEADERS).type('html').status(200).send(SHELL);
  });

  app.post(`${PATH}/:id/proof/challenge`, limiter, async (req: Request, res: Response) => {
    try {
      const requestId = requestIdOf(req.params.id);
      if (!originAllowed(req) || !requestId) return void refuse(res);
      const existing = cookieValue(req);
      const nonce = existing && /^[A-Za-z0-9_-]{20,64}$/.test(existing) ? existing : randomBytes(32).toString('base64url');
      const { ceremonyId, challenge } = await openGrantProofCeremony(db, { requestId, browserNonceHash: sha256Hex(nonce) });
      res.cookie(COOKIE, nonce, { ...cookieOptions(req), maxAge: GRANT_SIGN_TTL_SECONDS * 1000 });
      json(res, 200, { ceremonyId, challenge, rpId: passkeyRpId() });
    } catch { refuse(res); }
  });

  app.post(`${PATH}/:id/proof`, limiter, perRequest, body, async (req: Request, res: Response) => {
    try {
      const parsed = parseAssertion(req);
      if (!parsed) return void refuse(res);
      const result = await proveForGrantSigning(db, { ...parsed, rpId: passkeyRpId(), origins: signingCeremonyOrigins() });
      const { sessionNonce, ...out } = result.outcome === 'open' ? result : { ...result, sessionNonce: undefined };
      if (sessionNonce) res.cookie(COOKIE, sessionNonce, { ...cookieOptions(req), maxAge: GRANT_SIGN_TTL_SECONDS * 1000 });
      json(res, 200, out);
    } catch { refuse(res); }
  });

  app.post(`${PATH}/:id/challenge`, limiter, perRequest, async (req: Request, res: Response) => {
    try {
      const requestId = requestIdOf(req.params.id);
      const nonce = cookieValue(req);
      if (!originAllowed(req) || !requestId || !nonce) return void refuse(res);
      json(res, 200, await currentGrantSigningChallenge(db, { requestId, browserNonceHash: sha256Hex(nonce), rpId: passkeyRpId() }));
    } catch { refuse(res); }
  });

  app.post(`${PATH}/:id/complete`, limiter, perRequest, body, async (req: Request, res: Response) => {
    try {
      const parsed = parseAssertion(req);
      if (!parsed) return void refuse(res);
      await completeGrantSigning(db, parsed);
      json(res, 200, { ok: true });
    } catch (e) { refusal(res, e); }
  });

  app.post(`${PATH}/:id/decline`, limiter, perRequest, body, async (req: Request, res: Response) => {
    try {
      const requestId = requestIdOf(req.params.id);
      const nonce = cookieValue(req);
      const ceremonyId = ceremonyIdOf((req.body as Record<string, unknown> | undefined)?.ceremonyId);
      if (!originAllowed(req) || !requestId || !nonce || !ceremonyId) return void refuse(res);
      await declineGrantSigning(db, { requestId, ceremonyId, browserNonceHash: sha256Hex(nonce) });
      json(res, 200, { ok: true });
    } catch (e) { refusal(res, e); }
  });
}

function parseAssertion(req: Request) {
  const requestId = requestIdOf(req.params.id);
  const nonce = cookieValue(req);
  const b = (req.body ?? {}) as Record<string, unknown>;
  const ceremonyId = ceremonyIdOf(b.ceremonyId);
  const credentialId = b64(b.credentialId, 512);
  const authenticatorData = b64(b.authenticatorData);
  const clientDataJson = b64(b.clientDataJson);
  const signature = b64(b.signature);
  if (!originAllowed(req) || !requestId || !nonce || !ceremonyId || !credentialId || !authenticatorData || !clientDataJson || !signature) return null;
  return { requestId, ceremonyId, browserNonceHash: sha256Hex(nonce), credentialId, assertion: { authenticatorData, clientDataJson, signature } };
}

/** The completion's own refusals are typed; a ceremony problem, and anything unexpected, is the uniform 403. */
function refusal(res: Response, e: unknown): void {
  if (e instanceof GrantSigningRefusal) {
    if (e.code === 'SIGNING_REQUEST_ENDED') return void json(res, 409, { error: 'SIGNING_REQUEST_ENDED', state: String(e.details.state ?? 'ENDED') });
    if (e.code === 'SIGNATURE_NOT_VERIFIED') return void json(res, 403, { error: 'SIGNATURE_NOT_VERIFIED' });
    if (e.code === 'SIGNER_NOT_ELIGIBLE') return void json(res, 403, { error: 'SIGNER_NOT_ELIGIBLE' });
    if (e.code === 'PASSKEY_COOLING_OFF') return void json(res, 409, { error: 'PASSKEY_COOLING_OFF' });
  }
  if (e instanceof CeremonyRefused || e instanceof GrantSigningRefusal || e instanceof SigningNotConfiguredError) return void refuse(res);
  refuse(res);
}
