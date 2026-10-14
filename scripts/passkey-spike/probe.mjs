/** Synthetic protocol evidence only: no real human presence, sync or production leg. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
const failures=[];
const pin=(name,run)=>{try {run();} catch(e){failures.push(name+': '+e.message);}};
import { chromium } from 'playwright';
import { startSpike } from './preview.mjs';

const primary = await startSpike({basePath:'/__passkey-al/'});
const otherOrigin = await startSpike();
let browser;
try {
  browser = await chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE } : {}) });
  const context = await browser.newContext();
  const page = await context.newPage();
  const cdp = await context.newCDPSession(page);
  await cdp.send('WebAuthn.enable');
  const { authenticatorId } = await cdp.send('WebAuthn.addVirtualAuthenticator', { options: {
    protocol: 'ctap2', transport: 'internal', hasResidentKey: true,
    hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true,
  } });
  await page.goto(primary.url);
  await page.waitForFunction(() => window.spike?.ready);
  const fixture = await page.evaluate(() => window.spike.fixture);
  const firstOptions = await page.evaluate(() => window.spike.request('/registration/options', {}));
  const preissuedReplacement = await page.evaluate(() => window.spike.request('/registration/options', {}));
  const registration = await page.evaluate(() => window.spike.register());
  assert.equal(registration.verified, true);
  assert.equal(registration.userVerified, true);
  const { credentials } = await cdp.send('WebAuthn.getCredentials', { authenticatorId });
  assert.equal(credentials.length, 1);
  assert.equal(credentials[0].isResidentCredential, true);
  assert.equal(credentials[0].rpId, 'localhost');
  const credentialIdHash = createHash('sha256').update(Buffer.from(credentials[0].credentialId,'base64')).digest('hex');
  pin('registration identifies credential',()=>assert.equal(registration.credentialIdHash,credentialIdHash));

  const cookie = (await context.cookies()).find(c => c.name === 'spike_sid');
  const regOptions = firstOptions;
  const secondRegistration = await page.evaluate(() => window.spike.post('/registration/options', {}));
  pin('second registration options refused',()=>{assert.equal(secondRegistration.status,400);assert.equal(secondRegistration.body.code,'ALREADY_REGISTERED');});
  assert.notEqual(Buffer.from(regOptions.options.user.id, 'base64url').toString(), cookie.value,
    'WebAuthn user handle must not expose the session cookie');

  const parallelOptions = await page.evaluate(() => Promise.all([
    window.spike.request('/authentication/options', {}), window.spike.request('/authentication/options', {}),
  ]));
  const parallelResponse = await page.evaluate(options => window.spike.assertion(options), parallelOptions[0].options);
  const parallelResults = await page.evaluate(({options,response}) => Promise.all(options.map(o =>
    window.spike.post('/authentication/verify', {id:o.id,response}))), {options:parallelOptions,response:parallelResponse});
  assert.deepEqual(parallelResults.map(r=>r.status).sort(), [200,400], 'one concurrent replay must be refused');
  assert.equal(parallelResults.find(r=>r.status===400).body.code, 'REPLAY_REFUSED');

  const options = await page.evaluate(() => window.spike.request('/authentication/options', {}));
  assert.equal(options.options.challenge, fixture.challengeBase64url);
  assert.equal(options.options.userVerification, 'required');
  pin('discoverable authentication',()=>assert.deepEqual(options.options.allowCredentials,[]));
  const response = await page.evaluate(options => window.spike.assertion(options), options.options);
  const accepted = await page.evaluate(body => window.spike.post('/authentication/verify', body), { id: options.id, response });
  assert.equal(accepted.status, 200);
  assert.equal(accepted.body.verified, true);
  assert.equal(accepted.body.userVerified, true);
  assert.equal(accepted.body.rpID, 'localhost');
  assert.equal(accepted.body.origin, primary.origin);
  assert.equal(accepted.body.payloadUtf8, fixture.payloadUtf8);
  pin('authentication identifies same credential',()=>assert.equal(accepted.body.credentialIdHash,credentialIdHash));

  const replay = await page.evaluate(body => window.spike.post('/authentication/verify', body), { id: options.id, response });
  assert.equal(replay.status, 400);
  assert.equal(replay.body.code, 'CEREMONY_SPENT');
  const next = await page.evaluate(() => window.spike.request('/authentication/options', {}));
  const replayNew = await page.evaluate(body => window.spike.post('/authentication/verify', body), { id: next.id, response });
  assert.equal(replayNew.status, 400);
  assert.equal(replayNew.body.code, 'REPLAY_REFUSED');

  const aliasOptions = await page.evaluate(() => window.spike.request('/authentication/options', {}));
  const alias = structuredClone(response);
  for (const field of ['clientDataJSON', 'authenticatorData', 'signature']) {
    alias.response[field] += '=';
    assert.deepEqual(Buffer.from(alias.response[field], 'base64url'), Buffer.from(response.response[field], 'base64url'));
  }
  const replayAlias = await page.evaluate(body => window.spike.post('/authentication/verify', body), { id: aliasOptions.id, response: alias });
  assert.equal(replayAlias.status, 400);
  assert.equal(replayAlias.body.code, 'REPLAY_REFUSED');

  // Synthetic cross-browser preparation only: copying a virtual credential is not iCloud sync.
  const pair = await page.evaluate(() => window.spike.request('/pairing/options', {}));
  const secondContext = await browser.newContext();
  const secondPage = await secondContext.newPage();
  const secondCdp = await secondContext.newCDPSession(secondPage);
  await secondCdp.send('WebAuthn.enable');
  const secondAuthenticator = await secondCdp.send('WebAuthn.addVirtualAuthenticator', {options:{
    protocol:'ctap2',transport:'internal',hasResidentKey:true,hasUserVerification:true,isUserVerified:true,automaticPresenceSimulation:true,
  }});
  const shared = (await cdp.send('WebAuthn.getCredentials',{authenticatorId})).credentials[0];
  await secondCdp.send('WebAuthn.addCredential',{authenticatorId:secondAuthenticator.authenticatorId,credential:shared});
  await secondPage.goto(primary.url);
  await secondPage.waitForFunction(()=>window.spike?.ready);
  const isolated = await secondPage.evaluate(()=>window.spike.post('/authentication/options',{}));
  assert.equal(isolated.body.code,'SESSION_REQUIRED');
  const joined = await secondPage.evaluate(code=>window.spike.request('/pairing/join',{code}),pair.code);
  assert.equal(joined.joined,true);
  const pairReplay = await secondPage.evaluate(code=>window.spike.post('/pairing/join',{code}),pair.code);
  assert.equal(pairReplay.body.code,'PAIRING_REFUSED');
  const syncedDryRun = await secondPage.evaluate(()=>window.spike.sign());
  assert.equal(syncedDryRun.userVerified,true);
  assert.equal(syncedDryRun.origin,primary.origin);
  assert.equal(syncedDryRun.rpID,'localhost');
  pin('paired browser identifies same credential',()=>assert.equal(syncedDryRun.credentialIdHash,credentialIdHash));
  await secondContext.close();
  // Sync the virtual counter back for the subsequent negative controls.
  await cdp.send('WebAuthn.removeCredential',{authenticatorId,credentialId:shared.credentialId});
  shared.signCount = syncedDryRun.counter;
  await cdp.send('WebAuthn.addCredential',{authenticatorId,credential:shared});

  // A hostile client weakens its browser preference. The verifier must still require UV.
  await cdp.send('WebAuthn.setUserVerified', { authenticatorId, isUserVerified: false });
  const noUv = await page.evaluate(() => window.spike.request('/authentication/options', {}));
  const noUvResponse = await page.evaluate(options => window.spike.assertion({ ...options, userVerification: 'discouraged' }), noUv.options);
  assert.equal((Buffer.from(noUvResponse.response.authenticatorData, 'base64url')[32] & 4), 0);
  assert.equal((await primary.verifyControl(noUvResponse, { requireUserVerification: false })).verified, true);
  const refusedUv = await page.evaluate(body => window.spike.post('/authentication/verify', body), { id: noUv.id, response: noUvResponse });
  assert.equal(refusedUv.status, 400);
  assert.equal(refusedUv.body.code, 'VERIFICATION_REFUSED');
  await cdp.send('WebAuthn.setUserVerified', { authenticatorId, isUserVerified: true });

  const foreignOptions = await page.evaluate(() => window.spike.request('/authentication/options', {}));
  await page.goto(otherOrigin.origin);
  await page.waitForFunction(() => window.spike?.ready);
  const foreign = await page.evaluate(options => window.spike.assertion(options), foreignOptions.options);
  assert.equal(JSON.parse(Buffer.from(foreign.response.clientDataJSON, 'base64url')).origin, otherOrigin.origin);
  assert.equal((await primary.verifyControl(foreign, { expectedOrigin: otherOrigin.origin })).verified, true);
  const refusedOrigin = await context.request.post(primary.url + 'authentication/verify', { data: { id: foreignOptions.id, response: foreign } });
  assert.equal(refusedOrigin.status(), 400);
  assert.equal((await refusedOrigin.json()).code, 'VERIFICATION_REFUSED');

  // The library independently refuses a valid assertion under wrong RP/challenge expectations.
  await assert.rejects(primary.verifyControl(foreign, { expectedOrigin: otherOrigin.origin, expectedRPID: 'wrong.invalid' }));
  await assert.rejects(primary.verifyControl(foreign, { expectedOrigin: otherOrigin.origin, expectedChallenge: Buffer.alloc(32, 9).toString('base64url') }));
  // Even a valid registration pre-issued before the first completion cannot replace it.
  await page.goto(primary.url);
  await page.waitForFunction(()=>window.spike?.ready);
  const replacementResponse = await page.evaluate(options=>window.SimpleWebAuthnBrowser.startRegistration({optionsJSON:options}),preissuedReplacement.options);
  const replacement = await page.evaluate(body=>window.spike.post('/registration/verify',body),{id:preissuedReplacement.id,response:replacementResponse});
  pin('preissued second registration verify refused',()=>{assert.equal(replacement.status,400);assert.equal(replacement.body.code,'ALREADY_REGISTERED');});
  if(failures.length) throw new Error(failures.join('\n'));
  console.log(JSON.stringify({ localLeg: 'PASS', browser: await browser.version(), rpID: 'localhost',
    origin: primary.origin, fixture: 'spec-retention-example', discoverable: true,
    registrationUV: true, authenticationUV: true, customChallengeMatchesS0: true,
    hostedPrep: {independentUserHandle:true,atomicReservation:true,pairingIsolation:true,oneUsePair:true,secondBrowserSyntheticSigning:true,discoverableSigning:true,credentialIdentityMatches:true,oneRegistration:true},
    legDryRuns: ['iCloud workflow: copied virtual credential in paired second browser', 'QR/hybrid workflow: browser assertion and verification UI exercised; real QR unavailable', '1Password workflow: UV/BE/BS/counter reporting exercised; real provider unavailable'],
    refusals: ['UV=false', 'wrong origin', 'spent ceremony replay', 'new ceremony stored assertion replay (canonical and encoding alias)', 'wrong RP control', 'wrong challenge control'],
    limits: ['synthetic authenticator', 'no production/device/sync/hybrid proof', 'deterministic payload replay contract is outside this spike'] }, null, 2));
} finally {
  await browser?.close();
  await Promise.all([primary.close(), otherOrigin.close()]);
}
