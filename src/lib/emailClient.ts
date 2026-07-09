import { GraphQLError } from 'graphql';

/**
 * Client for the email provider capability tools (#396; spec 002). Mirrors
 * pdfClient.ts: hadron-server stays the front door — authorization has
 * already run before anything here is called — and this module only ships
 * already-authorized requests to the internal, per-provider tool.
 *
 * PROVIDER DISPATCH: one capability tool per provider (decided 2026-07-08).
 * Every call takes the connection's `provider` and routes to that provider's
 * tool config; v1 knows `ms-exchange` (hadrontool-ms-exchange). Adding Gmail
 * later = a new entry in PROVIDER_TOOLS, no caller changes (spec 002 US4).
 *
 * Configured by env (per provider):
 *   MS_EXCHANGE_TOOL_URL    e.g. http://hadrontool-ms-exchange:8080 (required)
 *   MS_EXCHANGE_TOOL_TOKEN  shared bearer token (optional; sent when set)
 *
 * Error surface: EMAIL_TOOL_NOT_CONFIGURED / EMAIL_TOOL_UNREACHABLE /
 * EMAIL_TOOL_ERROR as GraphQL extensions.code — plus pass-through of the
 * tool's own typed spec-002 codes (connection_not_found,
 * connection_unauthorized, provider_rate_limited, not_found,
 * validation_error, …) via extensions.emailErrorCode, so callers and clients
 * can react to the stable contract codes.
 */

const DEFAULT_TIMEOUT_MS = 30_000;

interface ProviderToolConfig {
  urlEnv: string;
  tokenEnv: string;
}

const PROVIDER_TOOLS: Record<string, ProviderToolConfig> = {
  'ms-exchange': { urlEnv: 'MS_EXCHANGE_TOOL_URL', tokenEnv: 'MS_EXCHANGE_TOOL_TOKEN' },
};

/** Resolve a provider's tool base URL + token; typed error when unknown/unconfigured. */
function toolFor(provider: string): { baseUrl: string; token?: string } {
  const cfg = PROVIDER_TOOLS[provider];
  if (!cfg) {
    throw new GraphQLError(`Unknown email provider "${provider}".`, {
      extensions: { code: 'EMAIL_TOOL_NOT_CONFIGURED', provider },
    });
  }
  const baseUrl = process.env[cfg.urlEnv];
  if (!baseUrl) {
    throw new GraphQLError(`Email operations are not configured (${cfg.urlEnv} unset).`, {
      extensions: { code: 'EMAIL_TOOL_NOT_CONFIGURED', provider },
    });
  }
  return { baseUrl: baseUrl.replace(/\/+$/, ''), token: process.env[cfg.tokenEnv] || undefined };
}

/** POST a JSON body to the provider tool with timeout + typed error mapping. */
async function postToTool<T>(provider: string, path: string, body: unknown): Promise<T> {
  const { baseUrl, token } = toolFor(provider);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);
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
    // The body read stays INSIDE the timeout window — a tool that sends
    // headers and then stalls mid-body must abort too, not hang the resolver.
    try {
      payload = (await res.json()) as Record<string, unknown> | null;
    } catch (err) {
      if (controller.signal.aborted) throw err; // timed out mid-body → outer catch
      payload = null; // malformed/empty body — surfaced via the !payload path below
    }
  } catch (err) {
    const timedOut = controller.signal.aborted;
    throw new GraphQLError(timedOut ? 'Email service timed out.' : 'Email service is unreachable.', {
      extensions: { code: 'EMAIL_TOOL_UNREACHABLE', provider, cause: String(err) },
    });
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok) {
    // The tool's typed spec-002 error body: { error: <code>, message, ...fields }.
    // Surface the stable code so GraphQL/MCP clients react to the contract,
    // not to HTTP statuses.
    const emailErrorCode = typeof payload?.error === 'string' ? payload.error : undefined;
    // Cap the propagated message — a misbehaving tool/proxy must not inflate
    // GraphQL responses (mirrors pdfClient's detail.slice pattern).
    const message =
      typeof payload?.message === 'string'
        ? payload.message.slice(0, 500)
        : `Email service error (${res.status}).`;
    throw new GraphQLError(message, {
      extensions: {
        code: 'EMAIL_TOOL_ERROR',
        ...(emailErrorCode ? { emailErrorCode } : {}),
        status: res.status,
        provider,
      },
    });
  }

  if (!payload) {
    throw new GraphQLError('Email service returned an unexpected response.', {
      extensions: { code: 'EMAIL_TOOL_ERROR', provider },
    });
  }
  return payload as T;
}

/** Provider-neutral message shape the tool returns (spec 002). */
export interface ToolEmailMessage {
  id: string;
  conversationId: string | null;
  subject: string | null;
  from: { name: string | null; address: string } | null;
  to: { name: string | null; address: string }[];
  receivedAt: string;
  isRead: boolean;
  snippet: string;
  body: { contentType: string; content: string } | null;
  hasAttachments: boolean;
}

export interface ToolEmailFolder {
  id: string;
  name: string;
  totalCount: number;
  unreadCount: number;
}

/**
 * Run a spec-002 operation on the provider tool (`POST /ops/<operation>`).
 * `input` always includes the TOOL's connectionId; mutating operations may
 * carry an `idempotencyKey`.
 */
export async function runEmailOperation<T = Record<string, unknown>>(
  provider: string,
  operation: string,
  input: Record<string, unknown>,
): Promise<T> {
  return postToTool<T>(provider, `/ops/${operation}`, input);
}

export interface ToolConnectionIdentity {
  id: string;
  provider: string;
  mailboxEmail: string;
  displayName: string | null;
  status: string;
}

/**
 * Create a connection on the provider tool from an OAuth authorization code
 * (the tool holds the client secret and derives the mailbox identity), or —
 * the one-time migration path — from a raw refresh token core still holds.
 * The identity is shape-validated: it becomes a DB unique key and an
 * ownership anchor, so a buggy tool response must fail loudly here, never
 * propagate an empty mailboxEmail into the connection upsert.
 */
export async function createToolConnection(
  provider: string,
  input:
    | { code: string; redirectUri: string }
    | { refreshToken: string; mailboxEmail: string; displayName?: string },
): Promise<ToolConnectionIdentity> {
  const identity = await postToTool<ToolConnectionIdentity>(provider, '/connections', input);
  if (
    typeof identity.id !== 'string' ||
    identity.id === '' ||
    typeof identity.mailboxEmail !== 'string' ||
    identity.mailboxEmail.trim() === '' ||
    identity.provider !== provider
  ) {
    throw new GraphQLError('Email service returned an invalid connection identity.', {
      extensions: { code: 'EMAIL_TOOL_ERROR', provider },
    });
  }
  return identity;
}

/**
 * Best-effort disconnect on the provider tool (subscription teardown + soft
 * delete). NEVER throws — the caller's DB effect has already committed (or a
 * fresh connection superseded this one), so a misconfigured provider or an
 * unreachable tool must log, not fail the surrounding operation. Callers
 * therefore fire-and-forget (`void deleteToolConnection(...)`).
 */
export async function deleteToolConnection(provider: string, toolConnectionId: string): Promise<void> {
  try {
    const { baseUrl, token } = toolFor(provider);
    await fetch(`${baseUrl}/connections/${encodeURIComponent(toolConnectionId)}`, {
      method: 'DELETE',
      headers: token ? { authorization: `Bearer ${token}` } : {},
      signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
    });
  } catch (err) {
    console.error(`[emailClient] tool disconnect failed for ${provider}/${toolConnectionId}:`, err);
  }
}

/** Subscribe a folder to provider change notifications (the event plane). */
export async function subscribeToolFolder(
  provider: string,
  toolConnectionId: string,
  folder: 'inbox' | 'sentitems',
): Promise<{ folder: string; expiresAt: string }> {
  return postToTool(provider, `/connections/${encodeURIComponent(toolConnectionId)}/subscriptions`, { folder });
}
