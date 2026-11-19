/**
 * #3998 (S3 of #3991, hrn:node:hadronmemory.com:specs:cor:sec:060) — the server-hosted passkey page where a PERSON who holds a
 * secret read client reveals the value. Never an API token: the value goes to this browser alone, `Cache-Control: no-store`.
 * Mounted only through `signingSurfacePolicy().signing`, as the grant signing ceremony is; while off every path is a plain 404.
 *
 *   GET  /secret-reveal/:clientId            the static shell: the same bytes for every id
 *   GET  /secret-reveal/ceremony.js          its script (builds the page from text nodes only)
 *   POST /secret-reveal/:clientId/challenge  opens a SECRET_REVEAL ceremony for this browser (the same answer for every id)
 *   POST /secret-reveal/:clientId/reveal     a passkey assertion; ONE read: the use commits, then the value is returned once
 *
 * The browser is the HttpOnly cookie `hadron_secret_reveal`, scoped to this path. Origin allowlist and rate limits are signing's.
 */
import { createHash, randomBytes } from 'node:crypto';
import express, { type Express, type Request, type Response } from 'express';
import rateLimit from 'express-rate-limit';
import { GraphQLError } from 'graphql';
import { db } from '../integrations/db/client.js';
import { passkeyRpId, signingCeremonyOrigins } from '../lib/signing/config.js';
import { SECRET_REVEAL_PATH } from '../lib/signing/ceremonyUrl.js';
import { signingSurfacePolicy } from '../lib/signing/surface.js';
import { CeremonyRefused } from '../lib/signing/signingCeremony.js';
import { openSecretRevealCeremony, revealForPasskeyPerson, SECRET_REVEAL_TTL_SECONDS } from '../lib/secrets/personReveal.js';
import { SECRET_READ_CLIENT_NOT_FOUND } from '../lib/secrets/readClientReveal.js';
import { ceremonyShell } from './ceremonyShell.js';
import { SIGNING_CEREMONY_PER_REQUEST_LIMIT, SIGNING_CEREMONY_RATE_LIMIT_PER_MINUTE } from './signingCeremonyRoutes.js';

const PATH = SECRET_REVEAL_PATH;
const COOKIE = 'hadron_secret_reveal';

const sha256Hex = (b: string) => createHash('sha256').update(b).digest('hex');
const refuse = (res: Response) => res.status(403).type('application/json').set('Cache-Control', 'no-store').send('{"error":"forbidden"}');
const json = (res: Response, status: number, body: unknown) => res.status(status).type('application/json').set('Cache-Control', 'no-store').send(JSON.stringify(body));
const idOf = (v: unknown) => (typeof v === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(v) ? v : null);
const ceremonyIdOf = (v: unknown) => (typeof v === 'string' && /^[A-Za-z0-9_-]{20,64}$/.test(v) ? v : null);
const b64 = (v: unknown, max = 4096): Buffer | null => (typeof v !== 'string' || v.length === 0 || v.length > max || !/^[A-Za-z0-9_-]+$/.test(v) ? null : Buffer.from(v, 'base64url'));

function cookieValue(req: Request): string | null {
  for (const part of (req.headers.cookie ?? '').split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === COOKIE) return v.join('=') || null;
  }
  return null;
}
const originAllowed = (req: Request) => typeof req.headers.origin === 'string' && signingCeremonyOrigins().includes(req.headers.origin);

const PAGE_HEADERS: Record<string, string> = {
  'Cache-Control': 'no-store',
  'Referrer-Policy': 'same-origin',
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Content-Security-Policy': "default-src 'none'; script-src 'self'; style-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
};

/** The static shell. No client, secret or person appears in it: it is byte-identical for every id. */
const SHELL = ceremonyShell({
  title: 'Reveal a secret', scriptSrc: `${PATH}/ceremony.js`,
  extraCss: 'pre{white-space:pre-wrap;overflow-wrap:anywhere;background:rgba(127,127,127,.12);padding:.75rem;border-radius:.4rem}',
  body: `<h1 id="title" tabindex="-1">Reveal a secret</h1>
<noscript><p>This page needs JavaScript to ask for your passkey. Turn it on and reload.</p></noscript>
<div id="start"><p>Revealing counts as one use of the permission you were given. Confirm it is you with your passkey to read the value once.</p><button id="go" type="button">Reveal with passkey</button></div>
<div id="view" hidden></div><p id="msg" role="status" aria-live="polite"></p>`,
});
const TOO_MANY_SHELL = ceremonyShell({ title: 'Too many requests', body: '<p>Too many requests. Wait a minute, then reload this page.</p>' });

/** The page's script: every element is built with createElement and textContent, so the value can never run as markup. */
const SCRIPT = `(()=>{
const b2u=(b)=>btoa(String.fromCharCode(...new Uint8Array(b))).replace(/\\+/g,'-').replace(/\\//g,'_').replace(/=+$/,'');
const u2b=(s)=>{s=s.replace(/-/g,'+').replace(/_/g,'/');const p=atob(s+'==='.slice((s.length+3)%4));return Uint8Array.from(p,(c)=>c.charCodeAt(0)).buffer;};
const id=location.pathname.split('/').filter(Boolean).pop();
const $=(i)=>document.getElementById(i);const msg=$('msg');const view=$('view');const start=$('start');const go=$('go');
const say=(t)=>{msg.textContent=t;};
const post=(p,b)=>fetch('${PATH}/'+encodeURIComponent(id)+'/'+p,{method:'POST',credentials:'same-origin',headers:{'content-type':'application/json'},body:JSON.stringify(b||{})});
const el=(tag,text)=>{const e=document.createElement(tag);if(text!==undefined)e.textContent=text;return e;};
const W={SECRET_READ_CLIENT_PENDING:'This permission has not been signed yet.',SECRET_READ_CLIENT_NOT_STARTED:'This permission has not started yet.',SECRET_READ_CLIENT_EXPIRED:'This permission has expired.',SECRET_READ_CLIENT_SPENT:'All reads of this permission are used.',SECRET_READ_CLIENT_REVOKED:'This permission was revoked.',SECRET_DELETED:'The secret was deleted.',SECRET_READ_CLIENT_ISSUER_GONE:'The person who issued this permission can no longer issue it.',SECRET_READ_CLIENT_SUPERSEDED:'The secret was rewritten after this permission was issued.'};
go.addEventListener('click',async()=>{
 go.disabled=true;say('');
 if(!(navigator.credentials&&navigator.credentials.get&&window.PublicKeyCredential)){say('This browser cannot use a passkey here. Open this page in a current browser that supports passkeys.');go.disabled=false;return;}
 let sent=false;
 try{
  const c=await post('challenge');if(!c.ok)throw new Error('refused');const o=await c.json();
  const cred=await navigator.credentials.get({publicKey:{challenge:u2b(o.challenge),rpId:o.rpId,userVerification:'required',timeout:120000}});
  const r=cred.response;sent=true;
  const x=await post('reveal',{ceremonyId:o.ceremonyId,credentialId:b2u(cred.rawId),authenticatorData:b2u(r.authenticatorData),clientDataJson:b2u(r.clientDataJSON),signature:b2u(r.signature)});
  if(x.status>=500)throw new Error('uncertain');
  const j=await x.json().catch(()=>null);if(j===null)throw new Error('uncertain');
  if(!x.ok){say(W[j.error]||'This could not be revealed. Nothing was shown.');go.disabled=false;return;}
  start.hidden=true;view.hidden=false;view.replaceChildren();
  view.appendChild(el('h2',j.secretName));view.appendChild(el('pre',j.value));
  view.appendChild(el('p',j.readsLeft===null?'No limit on reads.':'Reads left: '+j.readsLeft));
  const hide=el('button','Hide');hide.type='button';hide.addEventListener('click',()=>{view.replaceChildren();view.appendChild(el('p','Hidden. Reload this page to read again.'));});
  view.appendChild(hide);say('');
 }catch(e){
  if(sent){say('We could not confirm whether the value was revealed. A read may have been used. Reload this page before trying again.');}
  else{say('That did not work and nothing was revealed. You can try again.');go.disabled=false;}
 }
});
})();`;

/** Mount the person reveal page when the signing switch is on; the switch is read once, at mount. */
export function mountSecretRevealRoutes(app: Express, env: NodeJS.ProcessEnv = process.env): void {
  if (!signingSurfacePolicy(env).signing) return;
  const limited = (req: Request, res: Response) => {
    if (req.method === 'GET' && req.route?.path === `${PATH}/:id`) res.status(429).set({ ...PAGE_HEADERS, 'Retry-After': '60' }).type('html').send(TOO_MANY_SHELL);
    else res.status(429).end();
  };
  const limiter = rateLimit({ windowMs: 60_000, limit: SIGNING_CEREMONY_RATE_LIMIT_PER_MINUTE, standardHeaders: false, legacyHeaders: false, handler: limited });
  const perClient = rateLimit({
    windowMs: 15 * 60_000, limit: SIGNING_CEREMONY_PER_REQUEST_LIMIT, standardHeaders: false, legacyHeaders: false,
    keyGenerator: (req) => `secret-reveal:${req.ip ?? 'unknown'}:${sha256Hex(String(req.params.id))}`,
    validate: { keyGeneratorIpFallback: false },
    handler: (_req, res) => { res.status(429).end(); },
  });
  const body = express.json({ limit: '16kb' });

  app.get(`${PATH}/ceremony.js`, limiter, (_req, res) => { res.set(PAGE_HEADERS).type('application/javascript').status(200).send(SCRIPT); });
  app.get(`${PATH}/:id`, limiter, (_req, res) => { res.set(PAGE_HEADERS).type('html').status(200).send(SHELL); });

  app.post(`${PATH}/:id/challenge`, limiter, async (req: Request, res: Response) => {
    try {
      const clientId = idOf(req.params.id);
      if (!originAllowed(req) || !clientId) return void refuse(res);
      const nonce = randomBytes(32).toString('base64url');
      const { ceremonyId, challenge } = await openSecretRevealCeremony(db, { clientId, browserNonceHash: sha256Hex(nonce) });
      res.cookie(COOKIE, nonce, {
        httpOnly: true, sameSite: 'strict', path: PATH, maxAge: SECRET_REVEAL_TTL_SECONDS * 1000,
        secure: req.secure || req.headers.origin?.startsWith('https://') === true,
      });
      json(res, 200, { ceremonyId, challenge, rpId: passkeyRpId() });
    } catch { refuse(res); }
  });

  app.post(`${PATH}/:id/reveal`, limiter, perClient, body, async (req: Request, res: Response) => {
    try {
      const clientId = idOf(req.params.id);
      const nonce = cookieValue(req);
      const b = (req.body ?? {}) as Record<string, unknown>;
      const ceremonyId = ceremonyIdOf(b.ceremonyId);
      const credentialId = b64(b.credentialId, 512);
      const authenticatorData = b64(b.authenticatorData);
      const clientDataJson = b64(b.clientDataJson);
      const signature = b64(b.signature);
      if (!originAllowed(req) || !clientId || !nonce || !ceremonyId || !credentialId || !authenticatorData || !clientDataJson || !signature) return void refuse(res);
      const out = await revealForPasskeyPerson(db, {
        clientId, ceremonyId, browserNonceHash: sha256Hex(nonce), credentialId, assertion: { authenticatorData, clientDataJson, signature },
        rpId: passkeyRpId(), origins: signingCeremonyOrigins(),
      });
      // The value is JSON text of the stored value; the page shows it as text. Never cached.
      json(res, 200, { secretName: out.secretName, value: out.value, readsLeft: out.readsLeft });
    } catch (e) {
      if (e instanceof GraphQLError) {
        const code = String(e.extensions?.code ?? '');
        if (code.startsWith('SECRET_READ_CLIENT_') && code !== SECRET_READ_CLIENT_NOT_FOUND || code === 'SECRET_DELETED') return void json(res, 409, { error: code });
      }
      if (e instanceof CeremonyRefused) return void refuse(res);
      refuse(res);
    }
  });
}
