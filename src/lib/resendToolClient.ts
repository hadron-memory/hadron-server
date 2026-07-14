import { GraphQLError } from 'graphql';

const SEND_TIMEOUT_MS = 30_000;

export interface ResendEmailResult {
  id: string;
}

export interface ResendEmailInput {
  to: string;
  subject: string;
  text: string;
  idempotencyKey: string;
}

export function isResendToolConfigured(): boolean {
  return Boolean(process.env.RESEND_TOOL_URL);
}

function redactEmailAddresses(text: string): string {
  return text.replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, (address) => {
    const [local, domain = ''] = address.split('@');
    return `${local.slice(0, 1)}•••@${domain.slice(0, 1)}•••`;
  });
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

export async function sendResendEmail(input: ResendEmailInput): Promise<ResendEmailResult> {
  const { baseUrl, token } = tool();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SEND_TIMEOUT_MS);
  let res: Response;
  let payload: Record<string, unknown> | null;
  try {
    res = await fetch(`${baseUrl}/ops/send-email`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify(input),
      signal: controller.signal,
    });
    try {
      payload = (await res.json()) as Record<string, unknown> | null;
    } catch (err) {
      if (controller.signal.aborted) throw err;
      payload = null;
    }
  } catch (err) {
    const timedOut = controller.signal.aborted;
    throw new GraphQLError(timedOut ? 'Resend tool timed out.' : 'Resend tool is unreachable.', {
      extensions: { code: 'RESEND_TOOL_UNREACHABLE', cause: String(err) },
    });
  } finally {
    clearTimeout(timer);
  }

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
