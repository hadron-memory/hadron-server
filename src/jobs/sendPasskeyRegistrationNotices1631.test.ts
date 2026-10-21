/** #1631 PR2 (cor:aut:040:02, 07, 08): every registration's email notice, from the outbox. */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../integrations/db/client.js';
import { cleanDb } from '../test/helpers.js';
import { insertSoftPasskey, softPasskey } from '../test/softPasskey.js';
import { generateId } from '../lib/id.js';
import { encryptToken } from '../lib/tokenCrypto.js';
import { cancelFirstPasskey, issueCancelToken } from '../lib/passkeys/cancel.js';
import { passkeyNoticeEmail, type PasskeyNoticeContent } from '../auth/email.js';
import { MAX_NOTICE_ATTEMPTS } from './sendUserDeletionNotices.js';
import { processPasskeyRegistrationNotices, type PasskeyNoticeSender } from './sendPasskeyRegistrationNotices.js';

let ana: string;
let sent: Array<{ to: string; notice: PasskeyNoticeContent }>;
let failNext: number;
const sender: PasskeyNoticeSender = {
  configured: () => true,
  send: async (to, notice) => {
    if (failNext > 0) { failNext--; throw new Error('provider down'); }
    sent.push({ to, notice });
  },
};

beforeEach(async () => {
  await cleanDb(db);
  vi.stubEnv('BASE_URL', 'https://api.example.test');
  sent = [];
  failNext = 0;
  ana = (await db.user.create({ data: { handle: 'notice-ana', email: 'ana@example.test', roles: [] } })).id;
});

async function firstNotice(userId = ana, label = 'Laptop') {
  const passkeyId = await insertSoftPasskey(db, userId, softPasskey(), { firstWindow: true, label });
  const token = await db.$transaction((tx) => issueCancelToken(tx, passkeyId));
  await db.$executeRaw`INSERT INTO passkey_registration_notices (id, passkey_id, user_id, kind, cancel_token_enc)
    VALUES (${generateId()}, ${passkeyId}, ${userId}, 'first', ${encryptToken(token)})`;
  return { passkeyId, token };
}
async function laterNotice(userId = ana) {
  const passkeyId = await insertSoftPasskey(db, userId, softPasskey(), { label: 'Security key' });
  await db.$executeRaw`INSERT INTO passkey_registration_notices (id, passkey_id, user_id, kind) VALUES (${generateId()}, ${passkeyId}, ${userId}, 'later')`;
  return { passkeyId };
}
const notice = (passkeyId: string) => db.passkeyRegistrationNotice.findUniqueOrThrow({ where: { passkeyId } });

describe('first passkey notice', () => {
  it('emails the owner a cancel link that cancels the passkey, then clears the token', async () => {
    const { passkeyId } = await firstNotice();
    expect(await processPasskeyRegistrationNotices(db, sender)).toBe(1);
    expect(sent).toHaveLength(1);
    expect(sent[0].to).toBe('ana@example.test');
    expect(sent[0].notice).toMatchObject({ kind: 'first', label: 'Laptop' });
    const url = new URL(sent[0].notice.cancelUrl!);
    expect(url.origin + url.pathname).toBe('https://api.example.test/passkeys/cancel');
    const n = await notice(passkeyId);
    expect(n.sentAt).not.toBeNull();
    expect(n.cancelTokenEnc).toBeNull();
    expect(await cancelFirstPasskey(db, { token: url.searchParams.get('token')!, ip: '203.0.113.1', userAgent: 'x' })).toBe(true);
  });

  it('a sent notice is never sent again', async () => {
    await firstNotice();
    await processPasskeyRegistrationNotices(db, sender);
    expect(await processPasskeyRegistrationNotices(db, sender)).toBe(0);
    expect(sent).toHaveLength(1);
  });
});

describe('later passkey notice', () => {
  it('is informational: no cancel link', async () => {
    const { passkeyId } = await laterNotice();
    await processPasskeyRegistrationNotices(db, sender);
    expect(sent[0].notice).toMatchObject({ kind: 'later', label: 'Security key' });
    expect(sent[0].notice.cancelUrl).toBeUndefined();
    expect((await notice(passkeyId)).sentAt).not.toBeNull();
  });
});

describe('delivery', () => {
  it('retries a failure, then settles failed at the ceiling with the token cleared and no further send', async () => {
    const { passkeyId } = await firstNotice();
    failNext = MAX_NOTICE_ATTEMPTS;
    for (let i = 0; i < MAX_NOTICE_ATTEMPTS + 2; i++) await processPasskeyRegistrationNotices(db, sender);
    const n = await notice(passkeyId);
    expect(n).toMatchObject({ attempts: MAX_NOTICE_ATTEMPTS, sentAt: null, cancelTokenEnc: null });
    expect(n.failedAt).not.toBeNull();
    expect(sent).toHaveLength(0);
  });

  it('the last failed try settles failed at once, with no extra pass', async () => {
    const { passkeyId } = await firstNotice();
    failNext = MAX_NOTICE_ATTEMPTS;
    for (let i = 0; i < MAX_NOTICE_ATTEMPTS; i++) await processPasskeyRegistrationNotices(db, sender);
    expect((await notice(passkeyId)).failedAt).not.toBeNull();
  });

  it('a crashed final attempt (ceiling reached, lease expired) settles failed without a further send', async () => {
    const { passkeyId } = await firstNotice();
    await db.passkeyRegistrationNotice.update({ where: { passkeyId }, data: { attempts: MAX_NOTICE_ATTEMPTS, leaseUntil: new Date(Date.now() - 1000), claimToken: 'crashed' } });
    await processPasskeyRegistrationNotices(db, sender);
    expect(sent).toHaveLength(0);
    expect((await notice(passkeyId)).failedAt).not.toBeNull();
  });

  it('a notice under another pass\'s live lease is not sent', async () => {
    const { passkeyId } = await firstNotice();
    await db.passkeyRegistrationNotice.update({ where: { passkeyId }, data: { attempts: 1, leaseUntil: new Date(Date.now() + 60_000), claimToken: 'other-pass' } });
    await processPasskeyRegistrationNotices(db, sender);
    expect(sent).toHaveLength(0);
  });

  it('a failed try that later succeeds is sent', async () => {
    const { passkeyId } = await firstNotice();
    failNext = 1;
    await processPasskeyRegistrationNotices(db, sender);
    expect((await notice(passkeyId)).sentAt).toBeNull();
    await processPasskeyRegistrationNotices(db, sender);
    expect((await notice(passkeyId)).sentAt).not.toBeNull();
    expect(sent).toHaveLength(1);
  });

  it('a user with no email address, or no mail sender, settles failed at once without sending', async () => {
    const bea = (await db.user.create({ data: { handle: 'notice-bea', roles: [] } })).id;
    const { passkeyId } = await laterNotice(bea);
    await processPasskeyRegistrationNotices(db, sender);
    expect((await notice(passkeyId)).failedAt).not.toBeNull();
    const second = await firstNotice();
    await processPasskeyRegistrationNotices(db, { ...sender, configured: () => false });
    expect(await notice(second.passkeyId)).toMatchObject({ sentAt: null, cancelTokenEnc: null });
    expect(sent).toHaveLength(0);
  });

  it('two concurrent passes send once', async () => {
    await firstNotice();
    await Promise.all([processPasskeyRegistrationNotices(db, sender), processPasskeyRegistrationNotices(db, sender)]);
    expect(sent).toHaveLength(1);
  });
});

describe('the email', () => {
  const at = new Date('2026-10-21T09:00:00Z');
  it('a first passkey\'s carries the cancel link and the window end, and escapes the label', () => {
    const { subject, html } = passkeyNoticeEmail({
      kind: 'first', label: '<img src=x onerror=alert(1)>', registeredAt: at, cancelUrl: 'https://api.example.test/passkeys/cancel?token=T', windowEndsAt: new Date('2026-10-24T09:00:00Z'),
    });
    expect(subject).toMatch(/passkey/i);
    expect(html).toContain('href="https://api.example.test/passkeys/cancel?token=T"');
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
    expect(html).not.toContain('<img');
    expect(html).toContain('2026-10-24');
  });
  it('a later passkey\'s says to revoke it if it was not you, with no cancel link', () => {
    const { html } = passkeyNoticeEmail({ kind: 'later', label: 'Key "A" & B', registeredAt: at });
    expect(html).toContain('Key &quot;A&quot; &amp; B');
    expect(html).not.toContain('/passkeys/cancel');
    expect(html).toMatch(/revoke/i);
  });
});
