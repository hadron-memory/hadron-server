/**
 * smsClient — typed error surface over a stubbed global fetch. Pins the
 * PR-642 review hardenings: phone numbers are redacted from tool-provided
 * error text before it enters the GraphQL error surface, and the config
 * preflight callers gate governance on.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { GraphQLError } from 'graphql';
import { isSmsConfigured, sendSms } from './smsClient.js';

const TOOL_URL = 'http://hadrontool-twilio.test:8080';

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

beforeEach(() => {
  process.env.TWILIO_TOOL_URL = TOOL_URL;
});

afterEach(() => {
  delete process.env.TWILIO_TOOL_URL;
  delete process.env.TWILIO_TOOL_TOKEN;
  vi.unstubAllGlobals();
});

describe('isSmsConfigured', () => {
  it('tracks TWILIO_TOOL_URL presence', () => {
    expect(isSmsConfigured()).toBe(true);
    delete process.env.TWILIO_TOOL_URL;
    expect(isSmsConfigured()).toBe(false);
  });
});

describe('sendSms', () => {
  it('throws SMS_TOOL_NOT_CONFIGURED when the URL is unset', async () => {
    delete process.env.TWILIO_TOOL_URL;
    await expect(sendSms({ to: '+15551234567', body: 'hi' })).rejects.toMatchObject({
      extensions: { code: 'SMS_TOOL_NOT_CONFIGURED' },
    });
  });

  it('returns sid/status on success and POSTs the ops plane', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(200, { ok: true, sid: 'SM9', status: 'queued' }));
    vi.stubGlobal('fetch', fetchMock);
    const result = await sendSms({ to: '+15551234567', body: 'hi' });
    expect(result).toEqual({ sid: 'SM9', status: 'queued' });
    expect(fetchMock).toHaveBeenCalledWith(`${TOOL_URL}/ops/send-sms`, expect.objectContaining({ method: 'POST' }));
  });

  it('REDACTS phone numbers from tool error messages before they enter the error surface', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        jsonResponse(502, {
          error: 'provider_rejected',
          message: "The 'To' number +15551234567 is not a valid phone number.",
          providerCode: 21211,
        }),
      ),
    );
    const err = await sendSms({ to: '+15551234567', body: 'hi' }).catch((e: GraphQLError) => e);
    expect(err).toBeInstanceOf(GraphQLError);
    expect((err as GraphQLError).message).not.toContain('+15551234567');
    expect((err as GraphQLError).message).toContain('+1•••');
    expect((err as GraphQLError).extensions).toMatchObject({
      code: 'SMS_TOOL_ERROR',
      smsErrorCode: 'provider_rejected',
      providerCode: 21211,
    });
  });

  it('maps a network failure to SMS_TOOL_UNREACHABLE', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('ECONNREFUSED')));
    await expect(sendSms({ to: '+15551234567', body: 'hi' })).rejects.toMatchObject({
      extensions: { code: 'SMS_TOOL_UNREACHABLE' },
    });
  });
});
