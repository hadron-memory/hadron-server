/** #1630 loopback-only experiment. No Hadron auth, DB, routes or durable credentials. */
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { generateRegistrationOptions, verifyRegistrationResponse, generateAuthenticationOptions, verifyAuthenticationResponse } from '@simplewebauthn/server';

const fixture = JSON.parse(readFileSync(new URL('../../src/lib/signaturePayload.fixture.json', import.meta.url)));
const example = fixture.cases.find(c => c.name === 'spec-retention-example');
const bytes = Buffer.from(example.canonical, 'base64');
if (createHash('sha256').update(bytes).digest('hex') !== example.challengeHex || bytes.toString('utf8') !== example.payloadUtf8) throw new Error('S0 fixture mismatch');
const json = (res, status, value) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(value)); };
async function bodyOf(req) {
  let data = '';
  for await (const chunk of req) { data += chunk; if (Buffer.byteLength(data) > 65536) throw new Error('Too large'); }
  return JSON.parse(data);
}

export async function startSpike({ port = 0 } = {}) {
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('Invalid PASSKEY_SPIKE_PORT');
  const sessions = new Map();
  let origin;
  const server = createServer(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Content-Security-Policy', "default-src 'none'; script-src 'self'; connect-src 'self'; style-src 'self'; frame-ancestors 'none'");
    res.setHeader('X-Content-Type-Options', 'nosniff');
    if (req.headers.host !== new URL(origin).host) return json(res, 403, { code: 'HOST_REFUSED' });
    // No persistent state; expiry and caps prevent an unattended demo accumulating credentials.
    for (const [id, s] of sessions) if (s.expiresAt < Date.now()) sessions.delete(id);
    const url = new URL(req.url, origin);
    const files = { '/': ['index.html', 'text/html'], '/page.js': ['page.js', 'text/javascript'], '/style.css': ['style.css', 'text/css'],
      '/browser.js': ['node_modules/@simplewebauthn/browser/dist/bundle/index.umd.min.js', 'text/javascript'] };
    if (req.method === 'GET' && files[url.pathname]) {
      const [file, type] = files[url.pathname]; res.writeHead(200, { 'Content-Type': type });
      return res.end(readFileSync(new URL(file, import.meta.url)));
    }
    if (req.method === 'GET' && url.pathname === '/fixture') return json(res, 200, example);
    if (req.method !== 'POST') return json(res, 404, { code: 'NOT_FOUND' });
    if (req.headers.origin && req.headers.origin !== origin) return json(res, 403, { code: 'ORIGIN_REFUSED' });
    let sid = req.headers.cookie?.match(/(?:^|;\s*)spike_sid=([A-Za-z0-9_-]+)/)?.[1];
    let session = sessions.get(sid);
    if (!session) {
      if (url.pathname !== '/registration/options' || sessions.size >= 32) return json(res, 400, { code: 'SESSION_REQUIRED' });
      sid = randomBytes(24).toString('base64url');
      session = { expiresAt: Date.now() + 300000, pending: new Map(), usedAssertions: new Set(), credential: null };
      sessions.set(sid, session);
      res.setHeader('Set-Cookie', `spike_sid=${sid}; HttpOnly; SameSite=Strict; Path=/; Max-Age=300`);
    }
    try {
      const body = await bodyOf(req);
      if (url.pathname === '/registration/options' || url.pathname === '/authentication/options') {
        if (session.pending.size >= 16 || session.usedAssertions.size >= 128) return json(res, 400, { code: 'DEMO_LIMIT' });
        const registration = url.pathname === '/registration/options';
        if (!registration && !session.credential) return json(res, 400, { code: 'REGISTER_FIRST' });
        const options = registration
          ? await generateRegistrationOptions({ rpName: 'Hadron local spike', rpID: 'localhost', userName: 'synthetic-retention-user',
            userID: Buffer.from(sid), attestationType: 'none', timeout: 20000,
            authenticatorSelection: { residentKey: 'required', userVerification: 'required' } })
          : await generateAuthenticationOptions({ rpID: 'localhost', challenge: Buffer.from(example.challengeHex, 'hex'), timeout: 20000,
            userVerification: 'required', allowCredentials: [{ id: session.credential.id, transports: session.credential.transports }] });
        const id = randomBytes(24).toString('base64url');
        session.pending.set(id, { type: registration ? 'registration' : 'authentication', challenge: options.challenge, expiresAt: Date.now() + 60000 });
        return json(res, 200, { id, options });
      }
      if (!['/registration/verify', '/authentication/verify'].includes(url.pathname)) return json(res, 404, { code: 'NOT_FOUND' });
      const pending = session.pending.get(body.id);
      // Consume before async verification: failed attempts and concurrent retries cannot reuse it.
      session.pending.delete(body.id);
      if (!pending || pending.expiresAt < Date.now() || url.pathname !== `/${pending.type}/verify`) return json(res, 400, { code: 'CEREMONY_SPENT' });
      if (pending.type === 'registration') {
        const result = await verifyRegistrationResponse({ response: body.response, expectedChallenge: pending.challenge,
          expectedOrigin: origin, expectedRPID: 'localhost', requireUserVerification: true });
        if (!result.verified) throw new Error('Refused');
        session.credential = result.registrationInfo.credential;
        return json(res, 200, { verified: true, userVerified: result.registrationInfo.userVerified,
          deviceType: result.registrationInfo.credentialDeviceType, backedUp: result.registrationInfo.credentialBackedUp });
      }
      const assertionHash = createHash('sha256');
      for (const value of [body.response.response.clientDataJSON, body.response.response.authenticatorData, body.response.response.signature]) {
        const field = Buffer.from(value, 'base64url');
        const length = Buffer.alloc(4); length.writeUInt32BE(field.length);
        assertionHash.update(length).update(field);
      }
      const fingerprint = assertionHash.digest('hex');
      if (session.usedAssertions.has(fingerprint)) return json(res, 400, { code: 'REPLAY_REFUSED' });
      if (!session.credential || body.response.id !== session.credential.id) throw new Error('Unknown credential');
      const result = await verifyAuthenticationResponse({ response: body.response, expectedChallenge: pending.challenge,
        expectedOrigin: origin, expectedRPID: 'localhost', credential: session.credential, requireUserVerification: true });
      if (!result.verified) throw new Error('Refused');
      session.usedAssertions.add(fingerprint);
      session.credential.counter = result.authenticationInfo.newCounter;
      return json(res, 200, { verified: true, userVerified: result.authenticationInfo.userVerified,
        origin: result.authenticationInfo.origin, rpID: result.authenticationInfo.rpID, payloadUtf8: example.payloadUtf8 });
    } catch { return json(res, 400, { code: 'VERIFICATION_REFUSED' }); }
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
  origin = `http://localhost:${server.address().port}`;
  return { origin,
    // In-process probe control only, never an HTTP bypass. Demonstrates that rejected responses
    // are cryptographically valid under weakened expectations, isolating each refusal's cause.
    verifyControl(response, overrides = {}) {
      const credential = [...sessions.values()].find(s => s.credential?.id === response.id)?.credential;
      if (!credential) throw new Error('Probe credential missing');
      return verifyAuthenticationResponse({ response, expectedChallenge: example.challengeBase64url,
        expectedOrigin: origin, expectedRPID: 'localhost', credential, requireUserVerification: true, ...overrides });
    },
    close: () => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); sessions.clear(); }),
  };
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const spike = await startSpike({ port: Number(process.env.PASSKEY_SPIKE_PORT ?? 4380) });
  console.log(`Local passkey spike: ${spike.origin}`);
  for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, async () => { await spike.close(); process.exit(0); });
}
