import { GraphQLError } from 'graphql';

/**
 * Client for the SMS capability tool (hadrontool-twilio). Mirrors
 * mcpToolClient.ts / slackClient.ts: hadron-server stays the front door —
 * the policy chain, the sms.send quota counters, and the comm.outbound
 * ticket ledger have all run before anything here is called — and this
 * module only ships already-authorized send requests to the internal tool,
 * which calls the Twilio REST API (stateless; platform account in the
 * tool's env).
 *
 * Configured by env:
 *   TWILIO_TOOL_URL    e.g. http://hadrontool-twilio:8080 (required)
 *   TWILIO_TOOL_TOKEN  shared bearer token (optional; sent when set)
 *
 * Error surface: SMS_TOOL_NOT_CONFIGURED / SMS_TOOL_UNREACHABLE /
 * SMS_TOOL_ERROR as GraphQL extensions.code — plus pass-through of the
 * tool's own typed codes (validation_error, provider_not_configured,
 * provider_unauthorized, provider_rejected, provider_rate_limited,
 * upstream_unreachable, upstream_timeout) via extensions.smsErrorCode.
 *
 * NEVER auto-retry a send from this module or any caller: the tool is
 * stateless (no idempotency ledger) and an SMS send is non-idempotent —
 * a retry can double-message a human.
 */

const SEND_TIMEOUT_MS = 30_000;

/** Successful send: the Twilio message SID + status at creation time. */
export interface SmsSendResult {
  sid: string;
  status: string;
}

/**
 * Cheap config preflight for callers that consume scarce resources (quota
 * counters, comm.outbound tickets) BEFORE a send — an unconfigured
 * deployment must fail before any governance is touched (PR-642 review).
 */
export function isSmsConfigured(): boolean {
  return Boolean(process.env.TWILIO_TOOL_URL);
}

/**
 * Redact E.164-looking sequences from provider text before it enters the
 * GraphQL error surface — Twilio messages can echo the destination number,
 * and error messages end up in run outputs and logs (PR-642 review,
 * Copilot; the trail-masking posture applied to the error path).
 */
function redactPhoneNumbers(text: string): string {
  return text.replace(/\+\d{5,15}/g, (m) => `${m.slice(0, 2)}•••`);
}

function tool(): { baseUrl: string; token?: string } {
  const baseUrl = process.env.TWILIO_TOOL_URL;
  if (!baseUrl) {
    throw new GraphQLError('SMS sending is not configured (TWILIO_TOOL_URL unset).', {
      extensions: { code: 'SMS_TOOL_NOT_CONFIGURED' },
    });
  }
  return { baseUrl: baseUrl.replace(/\/+$/, ''), token: process.env.TWILIO_TOOL_TOKEN || undefined };
}

/**
 * Send ONE SMS through the tool's platform Twilio account. v1 passes no
 * credentials — the BYO inline-credential seam on the tool's contract is
 * exercised only once the deferred org-scoped registry lands.
 */
export async function sendSms(message: { to: string; body: string }): Promise<SmsSendResult> {
  const { baseUrl, token } = tool();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SEND_TIMEOUT_MS);
  let res: Response;
  let payload: Record<string, unknown> | null;
  try {
    res = await fetch(`${baseUrl}/ops/send-sms`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify({ to: message.to, body: message.body }),
      signal: controller.signal,
    });
    // The body read stays INSIDE the timeout window (slackClient posture).
    try {
      payload = (await res.json()) as Record<string, unknown> | null;
    } catch (err) {
      if (controller.signal.aborted) throw err; // timed out mid-body → outer catch
      payload = null;
    }
  } catch (err) {
    const timedOut = controller.signal.aborted;
    throw new GraphQLError(timedOut ? 'SMS tool timed out.' : 'SMS tool is unreachable.', {
      extensions: { code: 'SMS_TOOL_UNREACHABLE', cause: String(err) },
    });
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok) {
    const smsErrorCode = typeof payload?.error === 'string' ? payload.error : undefined;
    const message_ =
      typeof payload?.message === 'string'
        ? redactPhoneNumbers(payload.message.slice(0, 500))
        : `SMS tool error (${res.status}).`;
    throw new GraphQLError(message_, {
      extensions: {
        code: 'SMS_TOOL_ERROR',
        ...(smsErrorCode ? { smsErrorCode } : {}),
        ...(typeof payload?.providerCode === 'number' ? { providerCode: payload.providerCode } : {}),
        status: res.status,
      },
    });
  }

  if (!payload || typeof payload.sid !== 'string') {
    throw new GraphQLError('SMS tool returned an unexpected response.', {
      extensions: { code: 'SMS_TOOL_ERROR' },
    });
  }
  return {
    sid: payload.sid,
    status: typeof payload.status === 'string' ? payload.status : 'unknown',
  };
}
