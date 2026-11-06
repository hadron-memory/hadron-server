/**
 * #1631 PR2 (cor:aut:040:02, 07): the server-hosted passkey pages a person uses, with no portal dependency.
 *
 * - `/passkeys/register`: confirm who you are (GitHub, Google, Apple, or an email link bound to this browser), then add
 *   a first passkey; or vouch with a passkey you already hold and add a later one. The page names the account the
 *   passkey is being added to before the authenticator prompt (Rook, #1631 6316353964, Q2.3).
 * - `/passkeys/window/end`: confirm who you are by a method other than the registration's, then end a first passkey's
 *   cooling-off window early.
 *
 * The script is served from this origin (`/passkeys/assets/ceremony.js`), so the CSP allows no inline script. Forms
 * may post to the identity providers' authorize pages, because the sign-in start answers with a redirect there.
 */
import type { Express, Request, Response } from 'express';
import { db } from '../integrations/db/client.js';
import { peekFreshSignIn } from '../lib/passkeys/freshSignIn.js';
import { createHash } from 'node:crypto';
import { page } from './ceremonyPages.js';
import { passkeyRpId } from '../lib/signing/config.js';

export const CEREMONY_SCRIPT_PATH = '/passkeys/assets/ceremony.js';

const CLIENT_PAGE_HEADERS = {
  'Cache-Control': 'no-store',
  // Not no-referrer: that makes a browser send Origin: null on the pages' POSTs (see ceremonyPages.ts).
  'Referrer-Policy': 'same-origin',
  'Content-Security-Policy': [
    "default-src 'none'", "script-src 'self'", "connect-src 'self'", "style-src 'unsafe-inline'",
    "form-action 'self' https://github.com https://accounts.google.com https://appleid.apple.com",
    "frame-ancestors 'none'", "base-uri 'none'",
  ].join('; '),
  'X-Frame-Options': 'DENY',
};

const signInForms = (next: 'register' | 'window' | 'revoke' | 'sign-in', providersOnly = false) => `
<div class="signin">
${(['github', 'google', 'apple'] as const).map((p) => `<form method="post" action="/passkeys/sign-in/${p}/start"><input type="hidden" name="next" value="${next}"><button type="submit">Confirm with ${p === 'github' ? 'GitHub' : p === 'google' ? 'Google' : 'Apple'}</button></form>`).join('\n')}
${providersOnly ? '<p class="hint">An email link can\'t be used to remove a passkey.</p>' : `<form id="email-form"><input type="hidden" name="next" value="${next}"><label>Or email me a link <input type="email" name="email" required maxlength="320" autocomplete="email"></label> <button type="submit">Send link</button></form>
<p class="hint">Open the link in this browser. It confirms who you are to this page only, and does not sign you in.</p>`}
</div>`;

function send(res: Response, title: string, body: string): void {
  res.status(200).set(CLIENT_PAGE_HEADERS).type('html')
    .send(page(title, `${body}\n<script src="${CEREMONY_SCRIPT_PATH}" defer></script>`));
}

const METHOD_NAMES: Record<string, string> = { github: 'GitHub', google: 'Google', apple: 'Apple', email: 'an email link' };

/** This browser's live fresh sign-in, if exactly one (spends nothing). */
async function liveSignIn(req: Request) {
  const raw = /(?:^|;\s*)hadron_ceremony_browser=([^;]+)/.exec(req.headers.cookie ?? '')?.[1];
  return raw ? peekFreshSignIn(db, { browserNonceHash: createHash('sha256').update(raw).digest('hex') }) : null;
}

/** Mount the pages; called from the dark ceremony mount only. */
export function mountCeremonyClientPages(app: Express, opts: { windowHours: number }): void {
  app.get('/passkeys/register', async (req, res) => {
    // #1897 B2: a person sent here from an email sign-in with no passkey is led back to it once the passkey is added.
    const next: 'register' | 'sign-in' = req.query.next === 'sign-in' ? 'sign-in' : 'register';
    // Uma P2-1: show step 1 as done when this browser holds a live confirmation, and gate step 2 on it.
    const live = await liveSignIn(req).catch(() => null);
    const step1 = live
      ? `<p class="done" role="status"><strong>Confirmed with ${METHOD_NAMES[live.method] ?? live.method}</strong>, ${Math.max(1, Math.ceil(live.secondsLeft / 60))} minute(s) left to add your passkey.</p>`
      : `<p>Confirm who you are in this browser. The confirmation lasts 10 minutes.</p>\n${signInForms(next)}`;
    send(res, 'Add a passkey', `<main data-page="register" data-next="${next}" data-rp-id="${passkeyRpId()}">
<h1>Add a passkey</h1>
<p>A passkey lets you sign Hadron changes with your fingerprint, face or device PIN. Your first passkey goes through a
<strong>cooling-off window of ${opts.windowHours} hours</strong>: anything it signs stays pending until the window ends, and we email you a link to remove it if you didn't add it.</p>
<h2>Your first passkey</h2>
<h3>1. Confirm who you are</h3>
${step1}
<h3>2. Name and add it</h3>
<p><label>Name for this passkey <input id="label" maxlength="64" placeholder="for example, Work laptop"></label></p>
<p><button id="add-first"${live ? '' : ' disabled aria-describedby="add-first-why"'}>Add my first passkey</button></p>
${live ? '' : '<p id="add-first-why" class="hint">Available once step 1 is done.</p>'}
<p id="status-first" role="status" aria-live="polite"></p>
${next === 'sign-in' ? '<p id="continue-signin" hidden><a href="/auth/passkey/sign-in">Continue signing in</a></p>' : ''}
<h2>Already have a passkey?</h2>
<p>Use it to vouch for the new one. A passkey still in its cooling-off window can't vouch.</p>
<p><button id="add-later">Use my passkey, then add another</button></p>
<p id="status-later" role="status" aria-live="polite"></p>
<div id="account-check" hidden>
<p id="account" role="alert" tabindex="-1"></p>
<p><button id="confirm-account">Continue</button> <button id="stop-account">Not my account: stop</button></p>
</div>
</main>`);
  });

  app.get('/passkeys/window/end', (_req, res) => {
    send(res, 'End the cooling-off window', `<main data-page="window">
<h1>End your first passkey's cooling-off window early</h1>
<p>Confirm who you are with a method you did <strong>not</strong> use to add the passkey. Then anything it signed stops being pending.</p>
${signInForms('window')}
<p><button id="end-window">Continue</button></p>
<p id="window-passkey" role="alert" tabindex="-1" hidden></p>
<p><button id="confirm-window" hidden>Yes, I added this passkey: end the window</button> <button id="not-mine-window" hidden>I didn't add this passkey</button></p>
<p id="status-window" role="status" aria-live="polite"></p>
</main>`);
  });

  // #1631 PR3 (cor:aut:040:08): remove a passkey after proving who you are with ANOTHER passkey or an identity
  // provider (never an email link). Removing it signs out the sessions it signed in (Holger, 2026-10-21, #29507).
  app.get('/passkeys/revoke', async (req, res) => {
    const live = await liveSignIn(req).catch(() => null);
    const viaProvider = live && live.method !== 'email'
      // Uma #2230 P2-1: start spends this one confirmation, so the provider buttons wait hidden for the script to swap in.
      ? `<p class="done" role="status" id="revoke-idp-confirmed"><strong>Confirmed with ${METHOD_NAMES[live.method] ?? live.method}</strong>. <button id="revoke-idp">Show my passkeys</button></p>
<div id="revoke-idp-again" hidden><p class="hint">That confirmation is used up. Confirm again to remove another passkey.</p>${signInForms('revoke', true)}</div>`
      : signInForms('revoke', true);
    send(res, 'Remove a passkey', `<main data-page="revoke" data-rp-id="${passkeyRpId()}">
<h1>Remove a passkey</h1>
<p>Prove it's you, then choose the passkey to remove. Anything it already signed keeps its state, except a first passkey still in its
cooling-off window, whose pending signatures then never count. <strong>Removing a passkey also signs out the sessions it signed in.</strong></p>
<h2>1. Prove it's you</h2>
<p><button id="revoke-passkey">Use another of my passkeys</button></p>
<p>Or confirm with the identity provider linked to your account:</p>
${viaProvider}
<p class="hint">Lost every passkey and have no linked GitHub, Google or Apple account? Contact Hadron support.</p>
<p id="status-revoke" role="status" aria-live="polite"></p>
<h2>2. Choose the passkey to remove</h2>
<ul id="passkey-list" tabindex="-1" aria-live="polite"></ul>
</main>`);
  });

  app.get(CEREMONY_SCRIPT_PATH, (_req, res) => {
    res.status(200).set({ 'Cache-Control': 'no-store', 'Content-Type': 'application/javascript; charset=utf-8', 'X-Content-Type-Options': 'nosniff' })
      .send(CEREMONY_SCRIPT);
  });
}

/** The page script: WebAuthn calls and same-origin JSON requests; nothing else. */
const CEREMONY_SCRIPT = String.raw`'use strict';
(function () {
  var $ = function (id) { return document.getElementById(id); };
  var say = function (id, msg) { var s = $(id); if (s) s.textContent = msg; };
  var enc = function (buf) {
    var s = ''; var b = new Uint8Array(buf);
    for (var i = 0; i < b.length; i++) s += String.fromCharCode(b[i]);
    return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  };
  var dec = function (s) {
    s = s.replace(/-/g, '+').replace(/_/g, '/'); while (s.length % 4) s += '=';
    var bin = atob(s); var out = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  };
  var TOO_MANY = 'Too many attempts. Wait a minute and try again.';
  var post = function (path, body) {
    return fetch(path, { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body || {}) })
      .then(function (r) { if (r.status === 429) throw new Error(TOO_MANY); return r; });
  };
  var main = document.querySelector('main');
  var emailForm = $('email-form');
  if (emailForm) emailForm.addEventListener('submit', function (e) {
    e.preventDefault();
    var f = new FormData(emailForm);
    // Andi P3: the status line of THIS page, for the result and for an error alike.
    var out = main.dataset.page === 'window' ? 'status-window' : 'status-first';
    post('/passkeys/sign-in/email', { email: f.get('email'), next: f.get('next') }).then(function (r) {
      // Dorian P3: a refused or failed request is not a sent link.
      if (!r.ok) throw new Error(r.status === 400 ? 'Enter a valid email address.' : 'That didn\'t work. Try again.');
      say(out, 'If that address belongs to an account, a link is on its way. Open it in this browser.');
    }).catch(function (e) { say(out, e && e.message ? e.message : 'That didn\'t work. Try again.'); });
  });

  var challenge = function () {
    return post('/passkeys/register/challenge').then(function (r) { if (!r.ok) throw new Error('refused'); return r.json(); });
  };
  // Uma P2-2: the account check takes focus, and offers a way out that clears the ceremony.
  var confirmAccount = function (handle) {
    return new Promise(function (resolve, reject) {
      var box = $('account-check'); var a = $('account');
      a.textContent = 'You are adding a passkey to the Hadron account @' + handle + '. Continue only if that is your account.';
      box.hidden = false; a.focus();
      $('confirm-account').onclick = function () { box.hidden = true; resolve(); };
      $('stop-account').onclick = function () {
        box.hidden = true;
        // Dorian P3: stop always ends with a visible result, even when the request fails; nothing was added either way.
        post('/passkeys/register/stop').then(function (r) {
          reject(new Error(r.ok ? 'Stopped. Nothing was added, and this page forgot the confirmation.'
            : 'Stopped. Nothing was added. Close this page to make sure the confirmation is forgotten.'));
        }, function (e) {
          reject(new Error(e && e.message === TOO_MANY ? TOO_MANY + ' Nothing was added.' : 'Stopped. Nothing was added. Close this page to make sure the confirmation is forgotten.'));
        });
      };
    });
  };
  var create = function (ceremonyId, options) {
    var pk = options.publicKey;
    pk.challenge = dec(pk.challenge);
    pk.user.id = dec(pk.user.id);
    pk.excludeCredentials = pk.excludeCredentials.map(function (c) { return { type: c.type, id: dec(c.id) }; });
    return navigator.credentials.create({ publicKey: pk }).then(function (cred) {
      var response = {
        id: cred.id, rawId: enc(cred.rawId), type: cred.type,
        response: {
          clientDataJSON: enc(cred.response.clientDataJSON), attestationObject: enc(cred.response.attestationObject),
          transports: cred.response.getTransports ? cred.response.getTransports() : []
        },
        clientExtensionResults: cred.getClientExtensionResults()
      };
      var label = (($('label') || {}).value || '').trim() || 'Passkey';
      return post('/passkeys/register/finish', { ceremonyId: ceremonyId, response: response, label: label });
    });
  };
  var register = function (vouch) {
    var out = vouch ? 'status-later' : 'status-first';
    say('status-first', ''); say('status-later', '');
    var ceremonyId;
    challenge().then(function (c) {
      ceremonyId = c.ceremonyId;
      if (!vouch) return post('/passkeys/register/start', { ceremonyId: ceremonyId });
      return navigator.credentials.get({ publicKey: { challenge: dec(c.challenge), rpId: main.dataset.rpId, userVerification: 'required', allowCredentials: [] } })
        .then(function (a) {
          return post('/passkeys/register/start', { ceremonyId: ceremonyId, vouch: {
            credentialId: enc(a.rawId), authenticatorData: enc(a.response.authenticatorData),
            clientDataJson: enc(a.response.clientDataJSON), signature: enc(a.response.signature) } });
        });
    }).then(function (r) {
      if (!r.ok) throw new Error(vouch ? 'That passkey can\'t vouch: it may be removed or still in its cooling-off window.' : 'Confirm who you are first (step 1), in this browser, within the last 10 minutes.');
      return r.json();
    }).then(function (options) {
      return confirmAccount(options.account.handle).then(function () { return create(ceremonyId, options); });
    }).then(function (r) {
      if (!r.ok) throw new Error('The passkey was not added. Start again.');
      return r.json();
    }).then(function (done) {
      say(out, done.kind === 'first'
        ? 'Passkey added. Anything it signs stays pending for its cooling-off window. We emailed you a link to remove it if this wasn\'t you.'
        : 'Passkey added. We emailed you a notice.');
      if (done.kind === 'first' && main.dataset.next === 'sign-in' && $('continue-signin')) $('continue-signin').hidden = false;
    }).catch(function (e) { say(out, e && e.message && e.message !== 'refused' ? e.message : 'That didn\'t work. Start again.'); });
  };
  // #1631 PR3: the revocation page.
  var revokeCeremony = null;
  var renderList = function (passkeys) {
    var ul = $('passkey-list'); ul.textContent = '';
    passkeys.forEach(function (p) {
      var li = document.createElement('li');
      var text = p.label + ', added ' + new Date(p.registeredAt).toLocaleString();
      if (p.revokedAt) text += ' (removed)';
      else if (p.inWindow) text += ' (in its cooling-off window)';
      if (p.cancel) text += '. Removed by its email link at ' + new Date(p.cancel.at).toLocaleString() + ' from ' + (p.cancel.ip || 'an unknown address') + ' (' + (p.cancel.userAgent || 'unknown browser') + ')';
      li.textContent = text;
      if (!p.revokedAt && !p.prover) {
        var b = document.createElement('button');
        b.textContent = 'Remove';
        b.setAttribute('aria-label', 'Remove the passkey ' + p.label);
        b.onclick = function () {
          if (!window.confirm('Remove the passkey "' + p.label + '"? This also signs out the sessions it signed in.')) return;
          post('/passkeys/revoke/finish', { ceremonyId: revokeCeremony, credentialId: p.credentialId }).then(function (r) {
            say('status-revoke', r.ok ? 'Removed "' + p.label + '".' + ' Start again to remove another.' : 'Not removed. Start again.');
            if (r.ok) { $('passkey-list').textContent = ''; revokeCeremony = null; }
          }).catch(function (e) { say('status-revoke', e.message); });
        };
        li.appendChild(document.createTextNode(' '));
        li.appendChild(b);
      } else if (p.prover) {
        li.appendChild(document.createTextNode(' (used to prove it is you; use another passkey or a provider to remove it)'));
      }
      ul.appendChild(li);
    });
  };
  // The identity-provider confirmation is spent (or was refused) at start: offer the providers again (Uma #2230 P2-1).
  var idpSpent = function () {
    if (!$('revoke-idp-confirmed') || !$('revoke-idp-again')) return;
    $('revoke-idp-confirmed').hidden = true;
    $('revoke-idp-again').hidden = false;
  };
  var revokeStart = function (viaPasskey) {
    say('status-revoke', '');
    post('/passkeys/revoke/challenge').then(function (r) { if (!r.ok) throw new Error('refused'); return r.json(); }).then(function (c) {
      revokeCeremony = c.ceremonyId;
      if (!viaPasskey) return post('/passkeys/revoke/start', { ceremonyId: c.ceremonyId });
      return navigator.credentials.get({ publicKey: { challenge: dec(c.challenge), rpId: main.dataset.rpId, userVerification: 'required', allowCredentials: [] } })
        .then(function (a) {
          return post('/passkeys/revoke/start', { ceremonyId: c.ceremonyId,
            credentialId: enc(a.rawId), authenticatorData: enc(a.response.authenticatorData),
            clientDataJson: enc(a.response.clientDataJSON), signature: enc(a.response.signature) });
        });
    }).then(function (r) {
      if (!viaPasskey) idpSpent();
      if (!r.ok) throw new Error(viaPasskey ? 'That passkey can\'t prove it: it may be removed.' : 'Confirm with your identity provider first, in this browser, within the last 10 minutes.');
      return r.json();
    }).then(function (b) { renderList(b.passkeys); $('passkey-list').focus && $('passkey-list').focus(); })
      .catch(function (e) {
        if (e && e.name === 'NotAllowedError') return say('status-revoke', 'Cancelled. Nothing was removed.');
        say('status-revoke', e && e.message && e.message !== 'refused' ? e.message : 'That didn\'t work. Start again.');
      });
  };
  if ($('revoke-passkey')) $('revoke-passkey').addEventListener('click', function () { revokeStart(true); });
  if ($('revoke-idp')) $('revoke-idp').addEventListener('click', function () { revokeStart(false); });
  if ($('add-first')) $('add-first').addEventListener('click', function () { register(false); });
  if ($('add-later')) $('add-later').addEventListener('click', function () { register(true); });
  if ($('end-window')) $('end-window').addEventListener('click', function () {
    say('status-window', '');
    post('/passkeys/window/preview').then(function (r) {
      if (!r.ok) throw new Error('Confirm who you are first, with a different method than you used to add the passkey, within the last 10 minutes. If you have, no passkey of yours is in its cooling-off window.');
      return r.json();
    }).then(function (p) {
      var w = $('window-passkey'); var b = $('confirm-window');
      w.textContent = 'This ends the cooling-off window of the passkey "' + p.label + '", added ' + new Date(p.registeredAt).toLocaleString() + ' after confirming with ' + p.method + '. Anything it has signed stops being pending and counts as signed by you. Continue only if you added it.';
      var n = $('not-mine-window');
      w.hidden = false; b.hidden = false; n.hidden = false; w.focus();
      // Uma P2-4: the case this preview exists to catch.
      n.onclick = function () {
        b.hidden = true; n.hidden = true;
        say('status-window', 'Nothing was changed. Remove that passkey now: use the "Remove this passkey" link in the email we sent when it was added (no sign-in needed), or sign in and remove it from the passkeys in your account. Contact Hadron support if you need help.');
      };
      b.onclick = function () {
        b.hidden = true; $('not-mine-window').hidden = true;
        post('/passkeys/window/end').then(function (r) {
          say('status-window', r.ok ? 'The cooling-off window has ended. Anything the passkey signed is no longer pending.' : 'Not ended. Start again.');
        }).catch(function (e) { say('status-window', e.message); });
      };
    }).catch(function (e) { say('status-window', e.message); });
  });
})();
`;
