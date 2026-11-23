import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GraphQLError } from 'graphql';
import { isResendToolConfigured, sendResendEmail } from './resendToolClient.js';

const TOOL_URL = 'http://hadrontool-resend.test:8080';
const INPUT = {
  to: 'person@example.net',
  subject: 'Deploy finished',
  text: 'Everything is healthy.',
  idempotencyKey: 'email:run_123:abc',
};
const CREDENTIALS = { apiKey: 're_org_secret', from: 'Acme Agent <agent@acme.example>' };

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

beforeEach(() => {
  process.env.RESEND_TOOL_URL = TOOL_URL;
});

afterEach(() => {
  delete process.env.RESEND_TOOL_URL;
  delete process.env.RESEND_TOOL_TOKEN;
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('isResendToolConfigured', () => {
  it('tracks RESEND_TOOL_URL presence', () => {
    expect(isResendToolConfigured()).toBe(true);
    delete process.env.RESEND_TOOL_URL;
    expect(isResendToolConfigured()).toBe(false);
  });
});

describe('sendResendEmail', () => {
  it('throws before fetch when the tool URL is unset', async () => {
    delete process.env.RESEND_TOOL_URL;
    await expect(sendResendEmail(INPUT)).rejects.toMatchObject({
      extensions: { code: 'RESEND_TOOL_NOT_CONFIGURED' },
    });
  });

  it('POSTs one request, includes the bearer when set, and returns the provider id', async () => {
    process.env.RESEND_TOOL_TOKEN = 'shared-token';
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(200, { ok: true, id: 'email_123' }));
    vi.stubGlobal('fetch', fetchMock);
    await expect(sendResendEmail(INPUT)).resolves.toEqual({ id: 'email_123' });
    expect(fetchMock).toHaveBeenCalledExactlyOnceWith(
      `${TOOL_URL}/ops/send-email`,
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({ authorization: 'Bearer shared-token' }),
        body: JSON.stringify(INPUT),
      }),
    );
  });

  it('passes org-owned credentials only in the authenticated internal request body', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(200, { ok: true, id: 'email_456' }));
    vi.stubGlobal('fetch', fetchMock);
    await expect(sendResendEmail(INPUT, CREDENTIALS)).resolves.toEqual({ id: 'email_456' });
    const init = fetchMock.mock.calls[0][1] as RequestInit;
    expect(JSON.parse(String(init.body))).toEqual({ ...INPUT, ...CREDENTIALS });
  });

  it('redacts addresses from tool errors and preserves the stable provider code', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        jsonResponse(502, {
          error: 'provider_rejected',
          message: 'Resend rejected person@example.net.',
        }),
      ),
    );
    const err = await sendResendEmail(INPUT).catch((value: GraphQLError) => value);
    expect(err).toBeInstanceOf(GraphQLError);
    expect((err as GraphQLError).message).not.toContain(INPUT.to);
    expect((err as GraphQLError).extensions).toMatchObject({
      code: 'RESEND_TOOL_ERROR',
      emailErrorCode: 'provider_rejected',
    });
  });

  it('maps network failures to RESEND_TOOL_UNREACHABLE', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('ECONNREFUSED')));
    await expect(sendResendEmail(INPUT)).rejects.toMatchObject({
      extensions: { code: 'RESEND_TOOL_UNREACHABLE' },
    });
  });

  // #4865 moved the transport behind one helper shared with the domain-status lookup. This pins
  // the send's own bound, which no test had stated, so the refactor is held to it.
  it('gives up a send that hangs at 30 s, as the timeout spelling of RESEND_TOOL_UNREACHABLE', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const hang = (_url: string, init: RequestInit) =>
      new Promise<Response>((_, reject) => {
        init.signal?.addEventListener('abort', () => {
          reject(new DOMException('This operation was aborted', 'AbortError'));
        });
      });
    const fetchMock = vi.fn(hang);
    vi.stubGlobal('fetch', fetchMock);
    const pending = sendResendEmail(INPUT, CREDENTIALS);
    await vi.advanceTimersByTimeAsync(29_999);
    let answered = false;
    void pending.then(() => { answered = true; }, () => { answered = true; });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(answered, 'given up before 30 s').toBe(false);

    await vi.advanceTimersByTimeAsync(1);
    const err = (await pending.catch((value: unknown) => value)) as GraphQLError;
    expect(err).toBeInstanceOf(GraphQLError);
    expect(err.message).toBe('Resend tool timed out.');
    expect(err.extensions).toMatchObject({ code: 'RESEND_TOOL_UNREACHABLE' });
    expect(String(err.extensions.cause)).toContain('aborted');
    expect(fetchMock.mock.calls[0][1].signal?.aborted).toBe(true);
  });
});
