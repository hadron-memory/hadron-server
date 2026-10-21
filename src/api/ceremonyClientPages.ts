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
import type { Express, Response } from 'express';
import { page } from './ceremonyPages.js';
import { passkeyRpId } from '../lib/signing/config.js';

export const CEREMONY_SCRIPT_PATH = '/passkeys/assets/ceremony.js';

const CLIENT_PAGE_HEADERS = {
  'Cache-Control': 'no-store',
  'Referrer-Policy': 'no-referrer',
  'Content-Security-Policy': [
    "default-src 'none'", "script-src 'self'", "connect-src 'self'", "style-src 'unsafe-inline'",
    "form-action 'self' https://github.com https://accounts.google.com https://appleid.apple.com",
    "frame-ancestors 'none'", "base-uri 'none'",
  ].join('; '),
  'X-Frame-Options': 'DENY',
};

const signInForms = (next: 'register' | 'window') => `
<div class="signin">
${(['github', 'google', 'apple'] as const).map((p) => `<form method="post" action="/passkeys/sign-in/${p}/start"><input type="hidden" name="next" value="${next}"><button type="submit">Confirm with ${p === 'github' ? 'GitHub' : p === 'google' ? 'Google' : 'Apple'}</button></form>`).join('\n')}
<form id="email-form"><input type="hidden" name="next" value="${next}"><label>Or email me a link <input type="email" name="email" required maxlength="320" autocomplete="email"></label> <button type="submit">Send link</button></form>
<p class="hint">Open the link in this browser. It confirms who you are to this page only, and does not sign you in.</p>
</div>`;

function send(res: Response, title: string, body: string): void {
  res.status(200).set(CLIENT_PAGE_HEADERS).type('html')
    .send(page(title, `${body}\n<p id="status" role="status" aria-live="polite"></p>\n<script src="${CEREMONY_SCRIPT_PATH}" defer></script>`));
}

/** Mount the pages; called from the dark ceremony mount only. */
export function mountCeremonyClientPages(app: Express): void {
  app.get('/passkeys/register', (_req, res) => {
    send(res, 'Add a passkey', `<main data-page="register" data-rp-id="${passkeyRpId()}">
<h1>Add a passkey</h1>
<h2>Your first passkey</h2>
<p>First confirm who you are, within the last 10 minutes, in this browser.</p>
${signInForms('register')}
<p><label>Name for this passkey <input id="label" maxlength="64" value="Passkey"></label></p>
<p><button id="add-first">Add my first passkey</button></p>
<h2>Already have a passkey?</h2>
<p>Use it to vouch for the new one. A passkey still in its cooling-off window can't vouch.</p>
<p><button id="add-later">Use my passkey, then add another</button></p>
<p id="account" hidden></p>
<p><button id="confirm-account" hidden>Continue</button></p>
</main>`);
  });

  app.get('/passkeys/window/end', (_req, res) => {
    send(res, 'End the cooling-off window', `<main data-page="window">
<h1>End your first passkey's cooling-off window early</h1>
<p>Confirm who you are with a method you did <strong>not</strong> use to add the passkey. Then anything it signed stops being pending.</p>
${signInForms('window')}
<p><button id="end-window">End the window now</button></p>
<p id="window-passkey" hidden></p>
<p><button id="confirm-window" hidden>Yes, I added this passkey: end the window</button></p>
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
  var status = function (msg) { var s = $('status'); if (s) s.textContent = msg; };
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
  var post = function (path, body) {
    return fetch(path, { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body || {}) });
  };
  var main = document.querySelector('main');
  var emailForm = $('email-form');
  if (emailForm) emailForm.addEventListener('submit', function (e) {
    e.preventDefault();
    var f = new FormData(emailForm);
    post('/passkeys/sign-in/email', { email: f.get('email'), next: f.get('next') }).then(function () {
      status('If that address belongs to an account, a link is on its way. Open it in this browser.');
    });
  });

  var challenge = function () {
    return post('/passkeys/register/challenge').then(function (r) { if (!r.ok) throw new Error('refused'); return r.json(); });
  };
  var confirmAccount = function (handle) {
    return new Promise(function (resolve) {
      var a = $('account'); var b = $('confirm-account');
      a.textContent = 'You are adding a passkey to the Hadron account @' + handle + '. Continue only if that is your account.';
      a.hidden = false; b.hidden = false;
      b.onclick = function () { b.hidden = true; resolve(); };
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
      return post('/passkeys/register/finish', { ceremonyId: ceremonyId, response: response, label: ($('label') || {}).value || 'Passkey' });
    });
  };
  var register = function (vouch) {
    status('');
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
      if (!r.ok) throw new Error(vouch ? 'That passkey can\'t vouch: it may be revoked or still in its cooling-off window.' : 'Confirm who you are first (above), in this browser, within the last 10 minutes.');
      return r.json();
    }).then(function (options) {
      return confirmAccount(options.account.handle).then(function () { return create(ceremonyId, options); });
    }).then(function (r) {
      if (!r.ok) throw new Error('The passkey was not added. Start again.');
      return r.json();
    }).then(function (done) {
      status(done.kind === 'first'
        ? 'Passkey added. Anything it signs stays pending for its cooling-off window. We emailed you a link to cancel it if this wasn\'t you.'
        : 'Passkey added. We emailed you a notice.');
    }).catch(function (e) { status(e && e.message && e.message !== 'refused' ? e.message : 'That didn\'t work. Start again.'); });
  };
  if ($('add-first')) $('add-first').addEventListener('click', function () { register(false); });
  if ($('add-later')) $('add-later').addEventListener('click', function () { register(true); });
  if ($('end-window')) $('end-window').addEventListener('click', function () {
    status('');
    post('/passkeys/window/preview').then(function (r) {
      if (!r.ok) throw new Error('none');
      return r.json();
    }).then(function (p) {
      var w = $('window-passkey'); var b = $('confirm-window');
      w.textContent = 'This ends the cooling-off window of the passkey "' + p.label + '", added ' + new Date(p.registeredAt).toLocaleString() + '. Anything it signed then counts. Continue only if you added it.';
      w.hidden = false; b.hidden = false;
      b.onclick = function () {
        b.hidden = true;
        post('/passkeys/window/end').then(function (r) {
          status(r.ok ? 'The cooling-off window has ended. Anything the passkey signed is no longer pending.' : 'Not ended. Start again.');
        });
      };
    }).catch(function () {
      status('Nothing to end. Confirm who you are first, with a different method than you used to add the passkey, within 10 minutes.');
    });
  });
})();
`;
