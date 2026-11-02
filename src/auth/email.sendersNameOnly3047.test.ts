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
  // `cause` is asserted directly: JSON.stringify of an Error drops its message, so scanning a serialized cause
  // proves nothing (§10 Rico, #3155: a regression attaching the SDK error as the cause passed every pin).
  expect((err as { cause?: unknown }).cause).toBeUndefined();
  expect(JSON.stringify([err!.message, err!.stack])).not.toContain(RECIPIENT);
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

  it('a missing API key is a configuration error and keeps its own message, not a send failure (Gloria P3-1)', async () => {
    // getResend() caches its client, so load a fresh module with the key absent.
    vi.resetModules();
    delete process.env.RESEND_API_KEY;
    const { sendAccountDeletionNotice, sendCeremonySignInLink, sendPasskeyRegisteredNotice } = await import('./email.js');
    const calls = [
      () => sendAccountDeletionNotice(RECIPIENT),
      () => sendCeremonySignInLink(RECIPIENT, 'https://example.test/v?t=1'),
      () => sendPasskeyRegisteredNotice(RECIPIENT, { kind: 'later', label: 'laptop', registeredAt: new Date('2026-11-01T10:00:00Z') }),
    ];
    for (const call of calls) {
      const err = await call().then(() => null, (e: unknown) => e as Error);
      expect(err!.message).toBe('RESEND_API_KEY env var is required');
    }
    expect(send).not.toHaveBeenCalled();
  });

  it('a send that resolves still works and a resolved refusal stays name-only (unchanged)', async () => {
    const { sendAccountDeletionNotice } = await import('./email.js');
    send.mockResolvedValueOnce({ data: { id: 'em_1' }, error: null });
    await expect(sendAccountDeletionNotice(RECIPIENT)).resolves.toBeUndefined();
    send.mockResolvedValueOnce({ data: null, error: { message: `bad address ${RECIPIENT}`, name: 'validation_error' } });
    await expect(sendAccountDeletionNotice(RECIPIENT)).rejects.toThrow('mail provider did not acknowledge: validation_error');
  });
});

/**
 * #3166 (residual of #3047): when the provider resolves with no error NAME (nothing, no data, or an error carrying only
 * free text), the fallback reads `unknown`, the word the thrown-error path already uses, not `no data`, which reads like a
 * provider error name. A named error still carries its name, and the provider's free-text message is never carried.
 */
describe('assertProviderAck fallback (#3166)', () => {
  it.each([
    ['no result at all', null],
    ['an undefined result', undefined],
    ['neither error nor data', { data: null, error: null }],
    ['an empty object', {}],
    ['an error with no name, only free text naming the recipient', { data: null, error: { message: `bad address ${RECIPIENT}` } }],
  ])('%s: says unknown, never the free text', async (_label, result) => {
    const { assertProviderAck } = await import('./email.js');
    let thrown: Error | null = null;
    try { assertProviderAck(result as never); } catch (e) { thrown = e as Error; }
    expect(thrown?.message).toBe('mail provider did not acknowledge: unknown');
  });

  it('a named provider error still carries its name', async () => {
    const { assertProviderAck } = await import('./email.js');
    expect(() => assertProviderAck({ data: null, error: { name: 'validation_error', message: `bad ${RECIPIENT}` } }))
      .toThrow('mail provider did not acknowledge: validation_error');
  });

  it('an acknowledgement carrying data does not throw', async () => {
    const { assertProviderAck } = await import('./email.js');
    expect(() => assertProviderAck({ data: { id: 'em_1' }, error: null })).not.toThrow();
  });
});
