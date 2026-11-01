/**
 * #3047 (from §10 Rook's P3 on #3028; same class as #3012 item 1): a thrown mail-SDK error's free text can name the
 * recipient, and these errors reach the fault log, Sentry and the deletion-notice job's console.error. Every sender
 * rethrows NAME-ONLY, as sendMagicLink already does. One pin per sender; the thrown message below names the recipient.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const send = vi.fn();
vi.mock('resend', () => ({ Resend: class { emails = { send }; } }));

const RECIPIENT = 'victim.person@example.com';
class NetworkFault extends Error {
  constructor() {
    super(`connect ECONNRESET while sending to ${RECIPIENT}`);
    this.name = 'NetworkFault';
  }
}

beforeEach(() => {
  process.env.RESEND_API_KEY = 'test-key';
  send.mockReset();
  send.mockRejectedValue(new NetworkFault());
});

/** The error carries the machine name only: no recipient, no free text, nothing in `cause`. */
async function expectNameOnly(call: () => Promise<unknown>) {
  const err = await call().then(() => null, (e: unknown) => e as Error);
  expect(err).toBeInstanceOf(Error);
  expect(err!.message).toBe('mail provider send failed: NetworkFault');
  expect(JSON.stringify([err!.message, err!.stack, (err as { cause?: unknown }).cause])).not.toContain(RECIPIENT);
  expect(err!.message).not.toContain('ECONNRESET');
}

describe('thrown mail-SDK errors are rethrown name-only (#3047)', () => {
  it('sendAccountDeletionNotice', async () => {
    const { sendAccountDeletionNotice } = await import('./email.js');
    await expectNameOnly(() => sendAccountDeletionNotice(RECIPIENT));
  });

  it('sendCeremonySignInLink (the passkey-confirm link)', async () => {
    const { sendCeremonySignInLink } = await import('./email.js');
    await expectNameOnly(() => sendCeremonySignInLink(RECIPIENT, 'https://example.test/v?t=1'));
  });

  it('sendPasskeyRegisteredNotice', async () => {
    const { sendPasskeyRegisteredNotice } = await import('./email.js');
    await expectNameOnly(() => sendPasskeyRegisteredNotice(RECIPIENT, { kind: 'later', label: 'laptop', registeredAt: new Date('2026-11-01T10:00:00Z') }));
  });

  it('a non-Error throw carries "unknown", never its text', async () => {
    const { sendAccountDeletionNotice } = await import('./email.js');
    send.mockRejectedValueOnce(`socket hang up for ${RECIPIENT}`);
    const err = await sendAccountDeletionNotice(RECIPIENT).then(() => null, (e: unknown) => e as Error);
    expect(err!.message).toBe('mail provider send failed: unknown');
  });

  it('a send that resolves still works and a resolved refusal stays name-only (unchanged)', async () => {
    const { sendAccountDeletionNotice } = await import('./email.js');
    send.mockResolvedValueOnce({ data: { id: 'em_1' }, error: null });
    await expect(sendAccountDeletionNotice(RECIPIENT)).resolves.toBeUndefined();
    send.mockResolvedValueOnce({ data: null, error: { message: `bad address ${RECIPIENT}`, name: 'validation_error' } });
    await expect(sendAccountDeletionNotice(RECIPIENT)).rejects.toThrow('mail provider did not acknowledge: validation_error');
  });
});
