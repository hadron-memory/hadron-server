/** Synthetic protocol evidence only: no real human presence, sync or production leg. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
const failures=[];
const pin=(name,run)=>{try {run();} catch(e){failures.push(name+': '+e.message);}};
import { chromium } from 'playwright';
import { startSpike } from './preview.mjs';

const timingEnvKeys = ['PASSKEY_SPIKE_SESSION_TTL_SECONDS','PASSKEY_SPIKE_PAIRING_TTL_SECONDS','PASSKEY_SPIKE_CEREMONY_EXPIRY_SECONDS','PASSKEY_SPIKE_BROWSER_TIMEOUT_MS'];
const savedTimingEnv = timingEnvKeys.map(key => process.env[key]);
for (const key of timingEnvKeys) delete process.env[key];
const primary = await startSpike({basePath:'/__passkey-al/',sessionTtlSeconds:1800,pairingTtlSeconds:300});
const otherOrigin = await startSpike();
let releaseRegistration, firstEnteredResolve, secondEnteredResolve;
let registrationCalls=0;
const gate=new Promise(resolve=>{releaseRegistration=resolve;});
const firstEntered=new Promise(resolve=>{firstEnteredResolve=resolve;});
const secondEntered=new Promise(resolve=>{secondEnteredResolve=resolve;});
const registrationRace=await startSpike({beforeRegistrationVerify:async()=>{
  registrationCalls++;
  if(registrationCalls===1)firstEnteredResolve();else secondEnteredResolve();
  await gate;
}});
let browser;
try {
  browser = await chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE } : {}) });
  // Real SDK verification with virtual credentials and a deterministic server clock.
  // Each case checks BOTH generators; no physical provider or elapsed-time claim.
  for (const configured of [false, true]) {
    const expiry = configured ? 120 : 600;
    const hint = configured ? 60000 : 300000;
    const timing = await startSpike({sessionTtlSeconds:1800,
      ...(configured ? {ceremonyExpirySeconds:expiry,browserTimeoutMs:hint} : {})});
    const tc = await browser.newContext();
    const tp = await tc.newPage();
    const tcdp = await tc.newCDPSession(tp);
    const realNow = Date.now;
    let clock = realNow();
    try {
      await tcdp.send('WebAuthn.enable');
      await tcdp.send('WebAuthn.addVirtualAuthenticator',{options:{protocol:'ctap2',transport:'internal',hasResidentKey:true,hasUserVerification:true,isUserVerified:true,automaticPresenceSimulation:true}});
      await tp.goto(timing.url);
      await tp.waitForFunction(()=>window.spike?.ready);
      Date.now=()=>clock;
      const reg=await tp.evaluate(()=>window.spike.request('/registration/options',{}));
      assert.equal(reg.options.timeout,hint);
      const response=await tp.evaluate(options=>window.SimpleWebAuthnBrowser.startRegistration({optionsJSON:options}),reg.options);
      clock+=61000;
      assert.equal((await tp.evaluate(body=>window.spike.post('/registration/verify',body),{id:reg.id,response})).status,200,'registration survives old deadline');
      assert.equal((await tp.evaluate(body=>window.spike.post('/registration/verify',body),{id:reg.id,response})).body.code,'CEREMONY_SPENT');
      const auth=await tp.evaluate(()=>window.spike.request('/authentication/options',{}));
      assert.equal(auth.options.timeout,hint);
      const assertion=await tp.evaluate(options=>window.spike.assertion(options),auth.options);
      clock+=61000;
      assert.equal((await tp.evaluate(body=>window.spike.post('/authentication/verify',body),{id:auth.id,response:assertion})).status,200,'authentication survives old deadline');
      assert.equal((await tp.evaluate(body=>window.spike.post('/authentication/verify',body),{id:auth.id,response:assertion})).body.code,'CEREMONY_SPENT');
      const replay=await tp.evaluate(()=>window.spike.request('/authentication/options',{}));
      assert.equal((await tp.evaluate(body=>window.spike.post('/authentication/verify',body),{id:replay.id,response:assertion})).body.code,'REPLAY_REFUSED');
      const expired=await tp.evaluate(()=>window.spike.request('/authentication/options',{}));
      const fresh=await tp.evaluate(options=>window.spike.assertion(options),expired.options);
      clock+=expiry*1000;
      assert.equal((await tp.evaluate(body=>window.spike.post('/authentication/verify',body),{id:expired.id,response:fresh})).body.code,'CEREMONY_SPENT','expiry equality refuses');
      clock-=1000;
      assert.equal((await tp.evaluate(body=>window.spike.post('/authentication/verify',body),{id:expired.id,response:fresh})).body.code,'CEREMONY_SPENT','expiry consumes permanently');
    } finally { Date.now=realNow; await tc.close(); await timing.close(); }
  }
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
  assert.equal(await page.locator('#pairing-lifetime').textContent(), '5 minutes');
  assert.equal(await page.locator('.session-lifetime').first().textContent(), '30 minutes');
  assert.equal(await page.getByLabel('Pairing code from the other device').isVisible(), true);
  assert.equal(await page.locator('#pair-code').evaluate(el => getComputedStyle(el).borderTopStyle), 'solid');
  assert.deepEqual(await (await fetch(otherOrigin.url+'config')).json(), {sessionTtlSeconds:300,pairingTtlSeconds:60,ceremonyExpirySeconds:600,browserTimeoutMs:300000});
  process.env.PASSKEY_SPIKE_SESSION_TTL_SECONDS='1800';
  process.env.PASSKEY_SPIKE_PAIRING_TTL_SECONDS='300';
  process.env.PASSKEY_SPIKE_CEREMONY_EXPIRY_SECONDS='900';
  process.env.PASSKEY_SPIKE_BROWSER_TIMEOUT_MS='420000';
  const envSpike = await startSpike();
  try { assert.deepEqual(await (await fetch(envSpike.url+'config')).json(), {sessionTtlSeconds:1800,pairingTtlSeconds:300,ceremonyExpirySeconds:900,browserTimeoutMs:420000}); }
  finally { await envSpike.close(); for (const key of timingEnvKeys) delete process.env[key]; }
  for (const value of [0,-1,1.5,Infinity,86401]) {
    await assert.rejects(startSpike({sessionTtlSeconds:value}), /Invalid sessionTtlSeconds/);
    await assert.rejects(startSpike({pairingTtlSeconds:value}), /Invalid pairingTtlSeconds/);
  }
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
  assert.ok(cookie.expires - Date.now()/1000 > 1790 && cookie.expires - Date.now()/1000 <= 1800);
  const defaultOptions = await fetch(otherOrigin.url+'registration/options', {method:'POST',headers:{'Content-Type':'application/json'},body:'{}'});
  assert.match(defaultOptions.headers.get('set-cookie'), /Max-Age=300(?:;|$)/);
  const regOptions = firstOptions;
  pin('per-session picker name',()=>assert.match(firstOptions.options.user.name,/^synthetic-retention-user-[A-Za-z0-9_-]+$/));
  const compose = readFileSync(new URL('./al.compose.yml',import.meta.url),'utf8');
  pin('configured router path',()=>{assert.ok(compose.includes('PathPrefix(`${AL_BASE_PATH:?'));assert.ok(compose.includes('PASSKEY_SPIKE_BASE_PATH: ${AL_BASE_PATH:?'));});
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
  const raceContext=await browser.newContext();
  const racePage=await raceContext.newPage();
  const raceCdp=await raceContext.newCDPSession(racePage);
  await raceCdp.send('WebAuthn.enable');
  await raceCdp.send('WebAuthn.addVirtualAuthenticator',{options:{protocol:'ctap2',transport:'internal',hasResidentKey:true,hasUserVerification:true,isUserVerified:true,automaticPresenceSimulation:true}});
  await racePage.goto(registrationRace.url);
  await racePage.waitForFunction(()=>window.spike?.ready);
  const raceOptions=await racePage.evaluate(async()=>[await window.spike.request('/registration/options',{}),await window.spike.request('/registration/options',{})]);
  pin('different sessions have different names',()=>assert.notEqual(raceOptions[0].options.user.name,firstOptions.options.user.name));
  const raceResponses=[];
  for(const o of raceOptions)raceResponses.push(await racePage.evaluate(options=>window.SimpleWebAuthnBrowser.startRegistration({optionsJSON:options}),o.options));
  const firstCompletion=racePage.evaluate(body=>window.spike.post('/registration/verify',body),{id:raceOptions[0].id,response:raceResponses[0]});
  await firstEntered;
  const secondCompletion=racePage.evaluate(body=>window.spike.post('/registration/verify',body),{id:raceOptions[1].id,response:raceResponses[1]});
  // A working reservation refuses immediately; the removed-reservation mutant enters the barrier.
  await Promise.race([secondCompletion,secondEntered]);
  releaseRegistration();
  const raceResults=await Promise.all([firstCompletion,secondCompletion]);
  pin('in-flight registration reservation',()=>{
    assert.equal(registrationCalls,1);
    assert.deepEqual(raceResults.map(r=>r.status),[200,400]);
    assert.equal(raceResults[1].body.code,'ALREADY_REGISTERED');
  });
  await raceContext.close();
  // Advance only the server process clock: no real waits and browser cookies remain intact.
  const realNow = Date.now;
  const started = realNow();
  const direct = async (path, body = {}, sid = cookie.value) => fetch(primary.url + path, {
    method:'POST', headers:{'Content-Type':'application/json',Cookie:`spike_sid=${sid}`}, body:JSON.stringify(body),
  });
  try {
    Date.now = () => started + 6 * 60000;
    const latePair = await (await direct('pairing/options')).json();
    assert.equal(latePair.expiresInSeconds,300, 'session survives old five-minute deadline');
    Date.now = () => started + 8 * 60000;
    const lateJoin = await direct('pairing/join',{code:latePair.code},'');
    assert.equal(lateJoin.status,200, 'pair survives old sixty-second deadline');
    assert.match(lateJoin.headers.get('set-cookie'), /Max-Age=1[23]\d\d(?:;|$)/, 'join cookie is bounded by remaining session');
    assert.equal((await (await direct('pairing/join',{code:latePair.code},'')).json()).code,'PAIRING_REFUSED');
    const expiredPair = await (await direct('pairing/options')).json();
    Date.now = () => started + 14 * 60000;
    assert.equal((await (await direct('pairing/join',{code:expiredPair.code},'')).json()).code,'PAIRING_REFUSED');
    Date.now = () => started + 29 * 60000;
    const nearEndPair = await (await direct('pairing/options')).json();
    assert.ok(nearEndPair.expiresInSeconds > 0 && nearEndPair.expiresInSeconds <= 60, 'pair lifetime capped by original session');
    Date.now = () => started + 30 * 60000 + 1000;
    assert.equal((await (await direct('pairing/join',{code:nearEndPair.code},'')).json()).code,'PAIRING_REFUSED');
    assert.equal((await (await direct('authentication/options')).json()).code,'SESSION_REQUIRED');
  } finally { Date.now = realNow; }
  if(failures.length) throw new Error(failures.join('\n'));
  console.log(JSON.stringify({ localLeg: 'PASS', browser: await browser.version(), rpID: 'localhost',
    origin: primary.origin, fixture: 'spec-retention-example', discoverable: true,
    registrationUV: true, authenticationUV: true, customChallengeMatchesS0: true,
    ceremonyTiming: {defaultExpirySeconds:600,defaultBrowserHintMs:300000,overrideExpirySeconds:120,overrideBrowserHintMs:60000,bothGenerators:true,validVerificationsAfterOldDeadline:true,expiryEqualityRefused:true,expiredAndAttemptedRemainConsumed:true},
    hostedPrep: {independentUserHandle:true,atomicReservation:true,pairingIsolation:true,oneUsePair:true,secondBrowserSyntheticSigning:true,discoverableSigning:true,credentialIdentityMatches:true,oneRegistration:true},
    legDryRuns: ['iCloud workflow: copied virtual credential in paired second browser', 'QR/hybrid workflow: browser assertion and verification UI exercised; real QR unavailable', '1Password workflow: UV/BE/BS/counter reporting exercised; real provider unavailable'],
    refusals: ['UV=false', 'wrong origin', 'spent ceremony replay', 'new ceremony stored assertion replay (canonical and encoding alias)', 'wrong RP control', 'wrong challenge control'],
    limits: ['synthetic authenticator', 'no production/device/sync/hybrid proof', 'deterministic payload replay contract is outside this spike'] }, null, 2));
} finally {
  for (const [i,key] of timingEnvKeys.entries()) { if (savedTimingEnv[i] === undefined) delete process.env[key]; else process.env[key] = savedTimingEnv[i]; }
  releaseRegistration();
  await browser?.close();
  await Promise.all([primary.close(), otherOrigin.close(),registrationRace.close()]);
}
