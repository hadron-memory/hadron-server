import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { db } from '../integrations/db/client.js';
import { cleanDb } from '../test/helpers.js';
import { generateId } from './id.js';
import { encryptToken } from './tokenCrypto.js';
import { softPasskey, insertSoftPasskey } from '../test/softPasskey.js';
import { getMicrosoftRedirectUri } from '../integrations/exchange/auth.js';
import { getGmailRedirectUri } from '../integrations/gmail/auth.js';
import { getGoogleCalRedirectUri } from '../integrations/googleCal/auth.js';
import { getGoogleDriveRedirectUri } from '../integrations/googleDrive/auth.js';
import { buildAuthUrl } from '../auth/github.js';
import { buildGoogleAuthUrl } from '../auth/google.js';
import { buildAppleAuthUrl } from '../auth/apple.js';
import { sendMagicLink } from '../auth/email.js';
import { mountFreshSignInRoutes } from '../api/freshSignInRoutes.js';
import { processPasskeyRegistrationNotices } from '../jobs/sendPasskeyRegistrationNotices.js';

const { send } = vi.hoisted(() => ({ send: vi.fn().mockResolvedValue({ data: { id: 'synthetic' } }) }));
vi.mock('resend', () => ({ Resend: class { emails = { send }; } }));
let server: Server | undefined;
beforeEach(async () => {
  await cleanDb(db);
  send.mockClear();
  vi.stubEnv('NODE_ENV', 'test');
  vi.stubEnv('PORT', '4001');
  vi.stubEnv('RESEND_API_KEY', 'synthetic-key');
  vi.stubEnv('PASSKEY_RP_ID', 'example.test');
  vi.stubEnv('GITHUB_OAUTH_APP_AUTH_CALLBACK_URL', undefined);
  vi.stubEnv('SIGNING_CEREMONY_ORIGINS', 'https://portal.example.test');
});
afterEach(async () => {
  if (server) { await new Promise<void>((resolve, reject) => server!.close(e => e ? reject(e) : resolve())); server = undefined; }
  vi.unstubAllEnvs();
});
const providers = [
  ['microsoft', getMicrosoftRedirectUri], ['gmail', getGmailRedirectUri],
  ['google-cal', getGoogleCalRedirectUri], ['google-drive', getGoogleDriveRedirectUri],
] as const;
const cases = [
  { name: 'unset with PORT', value: undefined, base: 'http://localhost:4001' },
  { name: 'empty with PORT', value: '', base: 'http://localhost:4001' },
  { name: 'test sentinel', value: '/', base: 'http://localhost:4001' },
  { name: 'configured raw trailing slash', value: 'https://api.example.test/prefix/', base: 'https://api.example.test/prefix/' },
  { name: 'configured raw whitespace', value: ' https://api.example.test ', base: ' https://api.example.test ' },
  { name: 'production slash unchanged', value: '/', base: '/', mode: 'production' },
  { name: 'empty PORT', value: '', base: 'http://localhost:4000', port: '' },
  { name: 'unset PORT', value: undefined, base: 'http://localhost:4000', port: undefined },
];
describe('BASE_URL first-slice callers (#164)', () => {
  for (const tc of cases) {
    describe(tc.name, () => {
      beforeEach(() => {
        vi.stubEnv('BASE_URL', tc.value);
        if ('port' in tc) vi.stubEnv('PORT', tc.port);
        if ('mode' in tc) vi.stubEnv('NODE_ENV', tc.mode);
      });
      for (const [path, get] of providers) it(`${path} redirect`, () => {
        expect(get()).toBe(`${tc.base}/auth/${path}/callback`);
      });
      it('three login callbacks keep configured bytes', () => {
        for (const [path, url] of [
          ['github', buildAuthUrl('state')], ['google', buildGoogleAuthUrl('state', 'nonce')],
          ['apple', buildAppleAuthUrl('state', 'nonce')],
        ]) expect(new URL(url).searchParams.get('redirect_uri')).toBe(`${tc.base}/auth/${path}/callback`);
      });
      it('magic link uses the same base', async () => {
        await sendMagicLink('person@example.test', db);
        const token = await db.emailVerificationToken.findFirstOrThrow();
        expect(send).toHaveBeenCalledTimes(1);
        expect(send.mock.calls[0][0].html).toContain(`href="${tc.base}/auth/email/verify?token=${token.token}"`);
      });
      it('fresh sign-in email uses the same base', async () => {
        await db.user.create({ data: { handle: 'base-url-fresh', email: 'fresh@example.test', roles: [] } });
        const app = express();
        const pass: express.RequestHandler = (_req, _res, next) => next();
        mountFreshSignInRoutes(app, { emailSendPerIpRateLimit: pass, emailRecipientRateLimit: pass }, {
          PASSKEY_SIGNING_ENABLED: 'true', PASSKEY_REGISTRATION_ENABLED: 'true',
        });
        server = createServer(app);
        await new Promise<void>(resolve => server!.listen(0, '127.0.0.1', resolve));
        const res = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/passkeys/sign-in/email`, {
          method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'https://portal.example.test' },
          body: JSON.stringify({ email: 'fresh@example.test' }),
        });
        expect(res.status).toBe(200);
        expect(send).toHaveBeenCalledTimes(1);
        expect(send.mock.calls[0][0].html).toContain(`${tc.base}/passkeys/sign-in/email/verify?token=`);
      });
      it('passkey notice uses the same base', async () => {
        const user = await db.user.create({ data: { handle: 'base-url-notice', email: 'notice@example.test', roles: [] } });
        const passkey = await insertSoftPasskey(db, user.id, softPasskey(), { firstWindow: true });
        await db.passkeyRegistrationNotice.create({ data: { id: generateId(), passkeyId: passkey,
          userId: user.id, kind: 'first', cancelTokenEnc: encryptToken('synthetic-cancel') } });
        const deliver = vi.fn().mockResolvedValue(undefined);
        expect(await processPasskeyRegistrationNotices(db, { configured: () => true, send: deliver })).toBe(1);
        expect(deliver).toHaveBeenCalledTimes(1);
        expect(deliver.mock.calls[0][1].cancelUrl).toBe(`${tc.base}/passkeys/cancel?token=synthetic-cancel`);
      });
    });
  }
});
