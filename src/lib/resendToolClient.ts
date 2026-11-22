import { GraphQLError } from 'graphql';

const SEND_TIMEOUT_MS = 30_000;
/**
 * #4865 — the bound on ONE domain-status lookup. A send may wait 30 s because its caller asked
 * for a send; a read field holds up the whole sender read, so it gets a tighter bound.
 * hadrontool-resend caps its own Resend call at 10 s, so 12 s lets the tool's typed timeout
 * answer instead of racing it.
 */
export const DOMAIN_STATUS_TIMEOUT_MS = 12_000;

export interface ResendEmailResult {
  id: string;
}

export interface ResendEmailInput {
  to: string;
  subject: string;
  text: string;
  idempotencyKey: string;
}

export interface ResendRequestCredentials {
  apiKey: string;
  from: string;
}

export function isResendToolConfigured(): boolean {
  return Boolean(process.env.RESEND_TOOL_URL);
}

export function maskEmailAddress(address: string): string {
  const [local, domain = ''] = address.split('@');
  return `${local.slice(0, 1)}•••@${domain.slice(0, 1)}•••`;
}

function redactEmailAddresses(text: string): string {
  return text.replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, maskEmailAddress);
}

function tool(): { baseUrl: string; token?: string } {
  const baseUrl = process.env.RESEND_TOOL_URL;
  if (!baseUrl) {
    throw new GraphQLError('Agent email sending is not configured (RESEND_TOOL_URL unset).', {
      extensions: { code: 'RESEND_TOOL_NOT_CONFIGURED' },
    });
  }
  return { baseUrl: baseUrl.replace(/\/+$/, ''), token: process.env.RESEND_TOOL_TOKEN || undefined };
}

/** What one POST to the tool came to: an HTTP answer, or a transport that delivered none. */
type ToolPost =
  | { answered: true; res: Response; payload: Record<string, unknown> | null }
  | { answered: false; failure: 'timeout' | 'unreachable'; cause: string };

/**
 * The one way core speaks to the capability tool: a JSON POST with the optional internal bearer,
 * abandoned after `timeoutMs`. Resolves even when the transport fails, so each op maps a missing
 * answer to its own contract. Only the not-configured refusal throws, before anything is sent.
 */
async function postToolOp(path: string, body: unknown, timeoutMs: number): Promise<ToolPost> {
  const { baseUrl, token } = tool();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let res: Response;
  let payload: Record<string, unknown> | null;
  try {
    res = await fetch(`${baseUrl}${path}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    try {
      payload = (await res.json()) as Record<string, unknown> | null;
    } catch (err) {
      // The timeout can fire while parsing after headers arrive; retain the
      // timeout classification instead of treating that as a malformed body.
      if (controller.signal.aborted) throw err;
      payload = null;
    }
  } catch (err) {
    return {
      answered: false,
      failure: controller.signal.aborted ? 'timeout' : 'unreachable',
      cause: String(err),
    };
  } finally {
    clearTimeout(timer);
  }
  return { answered: true, res, payload };
}

export async function sendResendEmail(
  input: ResendEmailInput,
  credentials?: ResendRequestCredentials,
): Promise<ResendEmailResult> {
  const posted = await postToolOp('/ops/send-email', { ...input, ...credentials }, SEND_TIMEOUT_MS);
  if (!posted.answered) {
    throw new GraphQLError(
      posted.failure === 'timeout' ? 'Resend tool timed out.' : 'Resend tool is unreachable.',
      { extensions: { code: 'RESEND_TOOL_UNREACHABLE', cause: posted.cause } },
    );
  }
  const { res, payload } = posted;

  if (!res.ok) {
    const emailErrorCode = typeof payload?.error === 'string' ? payload.error : undefined;
    const message =
      typeof payload?.message === 'string'
        ? redactEmailAddresses(payload.message.slice(0, 500))
        : `Resend tool error (${res.status}).`;
    throw new GraphQLError(message, {
      extensions: {
        code: 'RESEND_TOOL_ERROR',
        ...(emailErrorCode ? { emailErrorCode } : {}),
        status: res.status,
      },
    });
  }

  if (!payload || typeof payload.id !== 'string') {
    throw new GraphQLError('Resend tool returned an unexpected response.', {
      extensions: { code: 'RESEND_TOOL_ERROR' },
    });
  }
  return { id: payload.id };
}

/**
 * Why a domain-status lookup did not answer. These words are set by core, which makes them the
 * one thing about a failed lookup that may be logged: what the tool said is remote input, and
 * `lookupFailureOf` never returns any of it.
 */
const LOOKUP_FAILURE_REASONS = [
  'not_configured',
  'timeout',
  'unreachable',
  'tool_error',
  'malformed_answer',
] as const;
export type ResendLookupFailureReason = (typeof LOOKUP_FAILURE_REASONS)[number];

export interface ResendLookupFailure {
  reason: ResendLookupFailureReason;
  /** The HTTP status the tool answered, when it answered at all. */
  status?: number;
}

/** The lookup failure a thrown error carries, or undefined when the error is not one. */
export function lookupFailureOf(err: unknown): ResendLookupFailure | undefined {
  if (!(err instanceof GraphQLError)) return undefined;
  const { lookupFailure, status } = err.extensions as Partial<Record<string, unknown>>;
  const reason = LOOKUP_FAILURE_REASONS.find((word) => word === lookupFailure);
  if (!reason) return undefined;
  return { reason, ...(typeof status === 'number' ? { status } : {}) };
}

const DOMAIN_STATUSES = new Set(['verified', 'unverified', 'not_found']);

/**
 * #4865 — is `domain` verified at Resend, asked of the capability tool's `get-domain-status` op
 * (hadrontool-resend#3). Core never calls Resend itself
 * (hrn:node:hadronmemory.com:specs:cor:int:030:01): the org's key travels inline in this one
 * request, exactly as for a send, and is not kept.
 *
 * Resolves `true` for `verified`, and `false` for `unverified` and `not_found` alike: a domain
 * Resend has no record of is not verified. Throws for every other outcome, each carrying a
 * `lookupFailure` word for the caller to turn into its own answer — not configured, the
 * transport failed or ran past `DOMAIN_STATUS_TIMEOUT_MS`, the tool answered an error, or the
 * tool answered something that is not this op's answer.
 */
export async function lookupResendDomainVerified(domain: string, apiKey: string): Promise<boolean> {
  // Checked here, in the same synchronous run that resolves the tool's address, so "unset" is
  // always this typed failure and never a bare send-path refusal leaking out of a read.
  if (!isResendToolConfigured()) {
    throw new GraphQLError(
      'Resend domain-status lookup is not configured (RESEND_TOOL_URL unset).',
      { extensions: { code: 'RESEND_TOOL_NOT_CONFIGURED', lookupFailure: 'not_configured' } },
    );
  }
  const posted = await postToolOp(
    '/ops/get-domain-status',
    { domain, apiKey },
    DOMAIN_STATUS_TIMEOUT_MS,
  );
  if (!posted.answered) {
    throw new GraphQLError(
      posted.failure === 'timeout'
        ? 'Resend domain-status lookup timed out.'
        : 'Resend tool is unreachable.',
      { extensions: { code: 'RESEND_TOOL_UNREACHABLE', lookupFailure: posted.failure } },
    );
  }
  const { res, payload } = posted;
  const status = payload?.status;
  if (
    res.ok &&
    payload?.ok === true &&
    payload.domain === domain &&
    typeof status === 'string' &&
    DOMAIN_STATUSES.has(status)
  ) {
    return status === 'verified';
  }
  throw new GraphQLError('Resend tool returned an unexpected response.', {
    extensions: {
      code: 'RESEND_TOOL_ERROR',
      lookupFailure: res.ok ? 'malformed_answer' : 'tool_error',
      status: res.status,
    },
  });
}
