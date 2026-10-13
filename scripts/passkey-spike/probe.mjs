/** Synthetic protocol evidence only: no real human presence, sync or production leg. */
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { startSpike } from './preview.mjs';

const primary = await startSpike();
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
  await page.goto(primary.origin);
  await page.waitForFunction(() => window.spike?.ready);
  const fixture = await page.evaluate(() => window.spike.fixture);
  const registration = await page.evaluate(() => window.spike.register());
  assert.equal(registration.verified, true);
  assert.equal(registration.userVerified, true);
  const { credentials } = await cdp.send('WebAuthn.getCredentials', { authenticatorId });
  assert.equal(credentials.length, 1);
  assert.equal(credentials[0].isResidentCredential, true);
  assert.equal(credentials[0].rpId, 'localhost');

  const options = await page.evaluate(() => window.spike.request('/authentication/options', {}));
  assert.equal(options.options.challenge, fixture.challengeBase64url);
  assert.equal(options.options.userVerification, 'required');
  const response = await page.evaluate(options => window.spike.assertion(options), options.options);
  const accepted = await page.evaluate(body => window.spike.post('/authentication/verify', body), { id: options.id, response });
  assert.equal(accepted.status, 200);
  assert.equal(accepted.body.verified, true);
  assert.equal(accepted.body.userVerified, true);
  assert.equal(accepted.body.rpID, 'localhost');
  assert.equal(accepted.body.origin, primary.origin);
  assert.equal(accepted.body.payloadUtf8, fixture.payloadUtf8);

  const replay = await page.evaluate(body => window.spike.post('/authentication/verify', body), { id: options.id, response });
  assert.equal(replay.status, 400);
  assert.equal(replay.body.code, 'CEREMONY_SPENT');
  const next = await page.evaluate(() => window.spike.request('/authentication/options', {}));
  const replayNew = await page.evaluate(body => window.spike.post('/authentication/verify', body), { id: next.id, response });
  assert.equal(replayNew.status, 400);
  assert.equal(replayNew.body.code, 'REPLAY_REFUSED');

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
  const refusedOrigin = await context.request.post(primary.origin + '/authentication/verify', { data: { id: foreignOptions.id, response: foreign } });
  assert.equal(refusedOrigin.status(), 400);
  assert.equal((await refusedOrigin.json()).code, 'VERIFICATION_REFUSED');

  // The library independently refuses a valid assertion under wrong RP/challenge expectations.
  await assert.rejects(primary.verifyControl(foreign, { expectedOrigin: otherOrigin.origin, expectedRPID: 'wrong.invalid' }));
  await assert.rejects(primary.verifyControl(foreign, { expectedOrigin: otherOrigin.origin, expectedChallenge: Buffer.alloc(32, 9).toString('base64url') }));
  console.log(JSON.stringify({ localLeg: 'PASS', browser: await browser.version(), rpID: 'localhost',
    origin: primary.origin, fixture: 'spec-retention-example', discoverable: true,
    registrationUV: true, authenticationUV: true, customChallengeMatchesS0: true,
    refusals: ['UV=false', 'wrong origin', 'spent ceremony replay', 'new ceremony stored assertion replay', 'wrong RP control', 'wrong challenge control'],
    limits: ['synthetic authenticator', 'no production/device/sync/hybrid proof', 'deterministic payload replay contract is outside this spike'] }, null, 2));
} finally {
  await browser?.close();
  await Promise.all([primary.close(), otherOrigin.close()]);
}
