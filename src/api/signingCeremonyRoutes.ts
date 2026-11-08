/**
 * #1632 S2b-2 (hrn:node:hadronmemory.com:specs:cor:dmo:130:08, :02, :03) — the server-hosted signing ceremony.
 *
 * Mounted only when `signingSurfacePolicy().signing` is on (#1895); while off nothing is mounted, so every path here
 * is an ordinary 404 with no switch oracle. The logic is `lib/signing/signingCeremony.ts`.
 *
 *   GET  /signing/:id                  the static shell: the same bytes for every id, nothing about any node
 *   GET  /signing/ceremony.js          its script (same-origin, so the CSP needs no inline script)
 *   POST /signing/:id/proof/challenge  opens a SIGN_PROOF ceremony for this browser (the same answer for every id)
 *   POST /signing/:id/proof            a passkey assertion over it: read access + named-signer match, then the content
 *   POST /signing/:id/challenge        reads back the one signing ceremony's bound challenge; mints nothing
 *   POST /signing/:id/complete         the signing assertion; ONE transaction
 *   POST /signing/:id/decline          the proven signer turns the request down
 *
 * The browser is the HttpOnly cookie holder (stored only as its SHA-256), the Origin must be on the
 * SIGNING_CEREMONY_ORIGINS allowlist (an empty list refuses), and no durable session is minted. Every failure a
 * stranger could learn from is one uniform 403 `{"error":"forbidden"}`: nothing says whether a request, a ceremony or
 * a person was missing. After a proof, an ended request and a refused assertion get their own typed answers (the
 * caller is by then a proven, eligible reader of that request).
 */
import { createHash, randomBytes } from 'node:crypto';
import express, { type Express, type Request, type Response } from 'express';
import rateLimit from 'express-rate-limit';
import { db } from '../integrations/db/client.js';
import { passkeyRpId, signingCeremonyOrigins, SigningNotConfiguredError } from '../lib/signing/config.js';
import { SIGNING_CEREMONY_PATH } from '../lib/signing/ceremonyUrl.js';
import { signingSurfacePolicy } from '../lib/signing/surface.js';
import { SigningRefusal } from '../lib/signing/requests.js';
import { ceremonyShell } from './ceremonyShell.js';
import {
  CeremonyRefused, completeSigning, currentSigningChallenge, declineSigning, openProofCeremony, proveForSigning,
  SIGN_TTL_SECONDS,
} from '../lib/signing/signingCeremony.js';

const COOKIE = 'hadron_signing';
/** Requests a minute per client IP, across the ceremony routes. */
export const SIGNING_CEREMONY_RATE_LIMIT_PER_MINUTE = 30;
/** proof/complete attempts per client IP per request id per 15 minutes. */
export const SIGNING_CEREMONY_PER_REQUEST_LIMIT = 30;

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

/** Exact allowlist match on the Origin header; absent or unlisted refuses, and an empty allowlist refuses. */
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

/** The static shell. No request, node or person appears in it: it is byte-identical for every id. */
const SHELL = ceremonyShell({
  title: 'Review and sign', wide: true, scriptSrc: `${SIGNING_CEREMONY_PATH}/ceremony.js`,
  extraCss: 'pre{white-space:pre-wrap;overflow-wrap:anywhere;background:rgba(127,127,127,.12);padding:.75rem;border-radius:.4rem}mark{background:rgba(255,200,0,.3);color:inherit;padding:0 .15rem}.diff-add{background:rgba(0,160,0,.18)}.diff-del{background:rgba(220,0,0,.18)}.bar{position:sticky;bottom:0;background:Canvas;color:CanvasText;border-top:1px solid rgba(127,127,127,.4);margin-top:1rem;padding:.75rem 0 calc(.75rem + env(safe-area-inset-bottom))}.bar p{margin:0 0 .5rem}',
  body: `<h1 id="title" tabindex="-1">Review and sign</h1>
<noscript><p>This page needs JavaScript to ask for your passkey. Turn it on and reload.</p></noscript>
<div id="start"><p>To see what you have been asked to sign, confirm it is you with your passkey. Nothing is shown until you do.</p><button id="go" type="button">Use passkey</button></div>
<div id="view" hidden></div><p id="msg" role="status" aria-live="polite"></p>`,
});

const TOO_MANY_SHELL = ceremonyShell({ title: 'Too many requests', body: '<p>Too many requests. Wait a minute, then reload this page.</p>' });

/**
 * The page's script. It builds every node with textContent, never HTML, so nothing from a node can run. It holds no
 * assertion it did not just get from `navigator.credentials.get`, and it never composes a link.
 */
const SCRIPT = `(()=>{
const b2u=(b)=>btoa(String.fromCharCode(...new Uint8Array(b))).replace(/\\+/g,'-').replace(/\\//g,'_').replace(/=+$/,'');
const u2b=(s)=>{s=s.replace(/-/g,'+').replace(/_/g,'/');const p=atob(s+'==='.slice((s.length+3)%4));return Uint8Array.from(p,(c)=>c.charCodeAt(0)).buffer;};
const id=location.pathname.split('/').filter(Boolean).pop();
const $=(i)=>document.getElementById(i);const msg=$('msg');const view=$('view');const start=$('start');const go=$('go');
const say=(t)=>{msg.textContent=t;};
const post=(p,b)=>fetch('${SIGNING_CEREMONY_PATH}/'+encodeURIComponent(id)+'/'+p,{method:'POST',credentials:'same-origin',headers:{'content-type':'application/json'},body:JSON.stringify(b||{})});
const el=(tag,text,cls)=>{const e=document.createElement(tag);if(text!==undefined)e.textContent=text;if(cls)e.className=cls;return e;};
const assertion=(cred,ceremonyId)=>{const r=cred.response;return{ceremonyId,credentialId:b2u(cred.rawId),authenticatorData:b2u(r.authenticatorData),clientDataJson:b2u(r.clientDataJSON),signature:b2u(r.signature)};};
const focusTitle=()=>{$('title').focus();};
function lines(parent,rows){const pre=el('pre');rows.forEach((l)=>{const s=el('div',(l.kind==='add'?'+ ':l.kind==='del'?'- ':'  ')+l.text,l.kind==='add'?'diff-add':l.kind==='del'?'diff-del':'');pre.appendChild(s);});parent.appendChild(pre);}
function section(t){const s=el('section');s.appendChild(el('h2',t));return s;}
function setTitle(t){$('title').textContent=t;document.title=t;}
const LBL={title:'Title',abstract:'Summary',content:'Text'};
const home=msg.parentNode;
const stamp=(d)=>d.toLocaleString(undefined,{day:'numeric',month:'short',year:'numeric',hour:'numeric',minute:'2-digit',timeZoneName:'short'});
function finish(title,text,v,when){home.appendChild(msg);view.replaceChildren();start.hidden=true;view.hidden=false;
 if(v)view.appendChild(el('p',v.node.title));
 if(when)view.appendChild(el('p',when+' '+stamp(new Date())+' (device time)'));
 view.appendChild(el('p',text));setTitle(title);say('');focusTitle();}
function ended(state,v){const w={COMPLETED:'This request was already signed.',DECLINED:'This request was declined.',EXPIRED:'This request expired.',STALE:'The text changed after this was requested, so this request can no longer be signed.',WITHDRAWN:'The person who asked withdrew this request.'};
 finish('This request has ended',(w[state]||'This request has ended.')+' Ask for a new signature request to sign again.',v);}
function render(out, focusDecline=false){
 view.replaceChildren();start.hidden=true;view.hidden=false;setTitle('Review and sign');
 const v=out.view;
 const sum=el('section');
 sum.appendChild(el('p',v.requester.name+' asks you to sign "'+v.node.title+'".'));
 sum.appendChild(el('p',!v.previous?'No earlier signature.':!v.previous.kept?'Earlier text no longer kept.':(()=>{const ch=['title','abstract','content'].filter((k)=>v.previous.diff[k].some((r)=>r.kind!=='same'));return ch.length?'Changed since revision '+v.previous.revision+': '+ch.map((k)=>LBL[k].toLowerCase()).join(', ')+'.':'No change to the title, summary or text since revision '+v.previous.revision+'.';})()));
 sum.appendChild(el('p','Signing records your approval of exactly this text.'));
 view.appendChild(sum);
 const meta=section('This request');
 meta.appendChild(el('p','Requested by '+v.requester.name+(v.requester.via?' via '+v.requester.via:'')+'.'));
 meta.appendChild(el('p','Expires '+stamp(new Date(v.expiresAt))+'.'));
 view.appendChild(meta);
 const what=section('Exactly what you are signing');
 what.appendChild(el('h3','Document'));what.appendChild(el('p',v.node.urn));what.appendChild(el('p','Revision '+v.revision));
 what.appendChild(el('h3','Title'));what.appendChild(el('p',v.node.title));
 if(v.node.abstract){what.appendChild(el('h3','Summary'));what.appendChild(el('p',v.node.abstract));}
 what.appendChild(el('h3','Text'));
 const pre=el('pre');v.node.contentSegments.forEach((s)=>{if(s.include){const m=el('mark',s.text);m.title='Included text is not covered by this signature';pre.appendChild(m);pre.appendChild(el('span',' [not covered by this signature]'));}else pre.appendChild(document.createTextNode(s.text));});
 what.appendChild(pre);
 what.appendChild(el('p','Each include is shown as its tag, which you do sign. The text it pulls in from elsewhere is not shown here and is not part of what you sign.'));
 view.appendChild(what);
 const chg=section('Changes since the last signed revision');
 if(!v.previous)chg.appendChild(el('p','No earlier signature on this node.'));
 else if(!v.previous.kept)chg.appendChild(el('p','Earlier text no longer kept (revision '+v.previous.revision+').'));
 else{chg.appendChild(el('p','Compared with revision '+v.previous.revision+'.'));['title','abstract','content'].forEach((k)=>{const rows=v.previous.diff[k];if(rows.some((r)=>r.kind!=='same')){chg.appendChild(el('h3',LBL[k]));lines(chg,rows);}});}
 view.appendChild(chg);
 const actions=el('div');
 const bar=el('div',undefined,'bar');const stat=el('div');
 let focusAfterRender=focusTitle;
 if(!out.canSign){actions.appendChild(el('p','You can read this, but you are not allowed to sign it.'));}
 else{
  const sign=el('button','Sign with passkey');sign.type='button';
  const dec=el('button','Decline');dec.type='button';
  let busy=false;
  const lock=(b)=>{busy=b;sign.disabled=b;dec.disabled=b;};
  sign.addEventListener('click',async()=>{
   if(busy)return;lock(true);say('Waiting for your passkey…');
   let sent=false;
   try{
    const c=await post('challenge');if(!c.ok)throw new Error('refused');const o=await c.json();
    const cred=await navigator.credentials.get({publicKey:{challenge:u2b(o.challenge),rpId:o.rpId,userVerification:'required',timeout:120000,allowCredentials:o.allowCredentials.map((x)=>({type:'public-key',id:u2b(x)}))}});
    sent=true;
    const r=await post('complete',assertion(cred,o.ceremonyId));
    if(r.status>=500)throw new Error('uncertain');
    const j=await r.json().catch(()=>null);
    if(j===null)throw new Error('uncertain');
    if(r.ok){finish('Signed','Your signature was recorded. You can close this page.',v,'Signed');return;}
    if(j.error==='SIGNING_REQUEST_ENDED'){ended(j.state,v);return;}
    if(j.error==='ENCRYPTED_MEMORY_NOT_APPLICABLE'){finish('Not signable','This node is in an encrypted memory, which is never signed.');return;}
    if(j.error==='SIGNATURE_NOT_VERIFIED'){say('That did not verify. Nothing was recorded. You can try again.');lock(false);sign.focus();return;}
    say('That did not work and nothing was recorded. Reload this page and start again.');lock(false);sign.focus();
   }catch(e){
    if(sent){say('We could not confirm whether your signature was recorded. Reload this page and check before trying again.');const re=el('button','Reload this page');re.type='button';re.addEventListener('click',()=>location.reload());stat.appendChild(re);re.focus();}
    else{say('That did not work and nothing was recorded. You can try again.');lock(false);sign.focus();}
   }
  });
  dec.addEventListener('click',()=>{
   if(busy)return;
   actions.replaceChildren(el('p','Decline this request? It will be ended and can no longer be signed.'));
   const yes=el('button','Yes, decline');yes.type='button';const no=el('button','Cancel');no.type='button';
   no.addEventListener('click',()=>render(out,true));
   yes.addEventListener('click',async()=>{yes.disabled=true;no.disabled=true;say('');
    try{const r=await post('decline',{ceremonyId:(await (await post('challenge')).json()).ceremonyId});if(r.status>=500)throw new Error('uncertain');
     const j=await r.json().catch(()=>null);
     if(j===null)throw new Error('uncertain');
     if(r.ok){finish('Declined','You declined this request. You can close this page.',v,'Declined');return;}
     if(j.error==='SIGNING_REQUEST_ENDED'){ended(j.state,v);return;}
     say('That did not work and nothing was changed. Reload this page and start again.');yes.disabled=false;no.disabled=false;yes.focus();
    }catch(e){say('We could not confirm whether the request was declined. Reload this page and check.');const re=el('button','Reload this page');re.type='button';re.addEventListener('click',()=>location.reload());stat.appendChild(re);re.focus();}});
   actions.appendChild(yes);actions.appendChild(no);no.focus();
  });
  actions.appendChild(sign);actions.appendChild(dec);
  if(focusDecline)focusAfterRender=()=>dec.focus();
 }
 if(out.canSign){bar.appendChild(stat);stat.appendChild(msg);bar.appendChild(actions);view.appendChild(bar);}else view.appendChild(actions);
 focusAfterRender();say('');
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
 }catch(e){say('That did not work. You may not be able to open this request, or it may no longer be available. Try again.');go.disabled=false;go.focus();}
});
})();`;

/** Mount the signing ceremony when the signing switch is on; the switch is read once, at mount. */
export function mountSigningCeremonyRoutes(app: Express, env: NodeJS.ProcessEnv = process.env): void {
  // X2 (#3698): a GET of the page past the per-minute limit gets a small static HTML answer; the script GET and every POST keep the
  // empty 429 the page script maps to its own message. The page is the same for every id: it names nothing.
  const limited = (req: Request, res: Response) => {
    // Classified by the matched route, not the spelling of the path: Express also serves /signing/CEREMONY.JS and
    // /signing/ceremony.js/ from the script route, and those keep the empty 429.
    if (req.method === 'GET' && req.route?.path === `${SIGNING_CEREMONY_PATH}/:id`) res.status(429).set({ ...PAGE_HEADERS, 'Retry-After': '60' }).type('html').send(TOO_MANY_SHELL);
    else res.status(429).end();
  };
  if (!signingSurfacePolicy(env).signing) return;
  const limiter = rateLimit({
    windowMs: 60_000, limit: SIGNING_CEREMONY_RATE_LIMIT_PER_MINUTE, standardHeaders: false, legacyHeaders: false,
    handler: limited,
  });
  const perRequest = rateLimit({
    windowMs: 15 * 60_000, limit: SIGNING_CEREMONY_PER_REQUEST_LIMIT, standardHeaders: false, legacyHeaders: false,
    keyGenerator: (req) => `signing:${req.ip ?? 'unknown'}:${sha256Hex(String(req.params.id))}`,
    validate: { keyGeneratorIpFallback: false },
    // POST routes only: the empty 429 the page script maps. Never the HTML page.
    handler: (_req, res) => { res.status(429).end(); },
  });
  const body = express.json({ limit: '16kb' });
  const cookieOptions = (req: Request) => ({
    httpOnly: true, sameSite: 'strict' as const, path: SIGNING_CEREMONY_PATH,
    secure: req.secure || req.headers.origin?.startsWith('https://') === true,
  });

  app.get(`${SIGNING_CEREMONY_PATH}/ceremony.js`, limiter, (_req, res) => {
    res.set(PAGE_HEADERS).type('application/javascript').status(200).send(SCRIPT);
  });
  // The shell is the same for every id: a link alone reveals nothing, not even that the request exists.
  app.get(`${SIGNING_CEREMONY_PATH}/:id`, limiter, (_req, res) => {
    res.set(PAGE_HEADERS).type('html').status(200).send(SHELL);
  });

  // Open a proof ceremony for this browser. Reads nothing about the request: the same answer for every id.
  app.post(`${SIGNING_CEREMONY_PATH}/:id/proof/challenge`, limiter, async (req: Request, res: Response) => {
    try {
      const requestId = requestIdOf(req.params.id);
      if (!originAllowed(req) || !requestId) return void refuse(res);
      // The pre-proof nonce only binds the proof ceremony; the proof rotates it (see proveForSigning).
      const existing = cookieValue(req);
      const nonce = existing && /^[A-Za-z0-9_-]{20,64}$/.test(existing) ? existing : randomBytes(32).toString('base64url');
      const { ceremonyId, challenge } = await openProofCeremony(db, { requestId, browserNonceHash: sha256Hex(nonce) });
      res.cookie(COOKIE, nonce, { ...cookieOptions(req), maxAge: SIGN_TTL_SECONDS * 1000 });
      json(res, 200, { ceremonyId, challenge, rpId: passkeyRpId() });
    } catch { refuse(res); }
  });

  app.post(`${SIGNING_CEREMONY_PATH}/:id/proof`, limiter, perRequest, body, async (req: Request, res: Response) => {
    try {
      const parsed = parseAssertion(req);
      if (!parsed) return void refuse(res);
      const result = await proveForSigning(db, { ...parsed, rpId: passkeyRpId(), origins: signingCeremonyOrigins() });
      const { sessionNonce, ...body } = result.outcome === 'open' ? result : { ...result, sessionNonce: undefined };
      // Rotate the browser value at a successful proof: whatever the browser held before proves nothing now.
      if (sessionNonce) res.cookie(COOKIE, sessionNonce, { ...cookieOptions(req), maxAge: SIGN_TTL_SECONDS * 1000 });
      json(res, 200, body);
    } catch { refuse(res); }
  });

  // Read back the one signing ceremony this browser's proof minted. Mints nothing; any problem is the one refusal.
  app.post(`${SIGNING_CEREMONY_PATH}/:id/challenge`, limiter, perRequest, async (req: Request, res: Response) => {
    try {
      const requestId = requestIdOf(req.params.id);
      const nonce = cookieValue(req);
      if (!originAllowed(req) || !requestId || !nonce) return void refuse(res);
      json(res, 200, await currentSigningChallenge(db, { requestId, browserNonceHash: sha256Hex(nonce), rpId: passkeyRpId() }));
    } catch { refuse(res); }
  });

  app.post(`${SIGNING_CEREMONY_PATH}/:id/complete`, limiter, perRequest, body, async (req: Request, res: Response) => {
    try {
      const parsed = parseAssertion(req);
      if (!parsed) return void refuse(res);
      await completeSigning(db, parsed);
      json(res, 200, { ok: true });
    } catch (e) { refusal(res, e); }
  });

  app.post(`${SIGNING_CEREMONY_PATH}/:id/decline`, limiter, perRequest, body, async (req: Request, res: Response) => {
    try {
      const requestId = requestIdOf(req.params.id);
      const nonce = cookieValue(req);
      const ceremonyId = ceremonyIdOf((req.body as Record<string, unknown> | undefined)?.ceremonyId);
      if (!originAllowed(req) || !requestId || !nonce || !ceremonyId) return void refuse(res);
      await declineSigning(db, { requestId, ceremonyId, browserNonceHash: sha256Hex(nonce) });
      json(res, 200, { ok: true });
    } catch (e) { refusal(res, e); }
  });
}

/** The fields every assertion route shares, or null: a malformed body is the same refusal as any other. */
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

/** Map what completion and decline refuse: an ended request and an unverified assertion are typed; the rest is uniform. */
function refusal(res: Response, e: unknown): void {
  if (e instanceof SigningRefusal) {
    if (e.code === 'SIGNING_REQUEST_ENDED') return void json(res, 409, { error: 'SIGNING_REQUEST_ENDED', state: String(e.details.state ?? 'ENDED') });
    if (e.code === 'SIGNATURE_NOT_VERIFIED') return void json(res, 403, { error: 'SIGNATURE_NOT_VERIFIED' });
    if (e.code === 'ENCRYPTED_MEMORY_NOT_APPLICABLE') return void json(res, 409, { error: 'ENCRYPTED_MEMORY_NOT_APPLICABLE' });
  }
  if (e instanceof CeremonyRefused || e instanceof SigningRefusal || e instanceof SigningNotConfiguredError) return void refuse(res);
  refuse(res);
}
