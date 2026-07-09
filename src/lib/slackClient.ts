import { GraphQLError } from 'graphql';

/**
 * Client for the Slack capability tool (spec 043; hadrontool-slack). Mirrors
 * emailClient.ts / the telegram plan: hadron-server stays the front door —
 * authorization has already run before anything here is called — and this
 * module only ships already-authorized requests to the internal tool.
 *
 * PROVIDER DISPATCH follows the emailClient PROVIDER_TOOLS pattern; v1 knows
 * `slack` (hadrontool-slack). The chat-bridge worker (spec 043 Phase 3)
 * dispatches through the same table via `ChatBinding.provider`.
 *
 * Configured by env:
 *   SLACK_TOOL_URL    e.g. http://hadrontool-slack:8080 (required)
 *   SLACK_TOOL_TOKEN  shared bearer token (optional; sent when set)
 *
 * Error surface: SLACK_TOOL_NOT_CONFIGURED / SLACK_TOOL_UNREACHABLE /
 * SLACK_TOOL_ERROR as GraphQL extensions.code — plus pass-through of the
 * tool's own typed spec-043 codes (connection_not_found,
 * connection_unauthorized, channel_not_found, not_in_channel,
 * provider_rate_limited, not_found, validation_error, …) via
 * extensions.slackErrorCode, so callers and clients can react to the stable
 * contract codes.
 */

const DEFAULT_TIMEOUT_MS = 30_000;

interface ProviderToolConfig {
  urlEnv: string;
  tokenEnv: string;
}

const PROVIDER_TOOLS: Record<string, ProviderToolConfig> = {
  slack: { urlEnv: 'SLACK_TOOL_URL', tokenEnv: 'SLACK_TOOL_TOKEN' },
};

/** Resolve a provider's tool base URL + token; typed error when unknown/unconfigured. */
function toolFor(provider: string): { baseUrl: string; token?: string } {
  const cfg = PROVIDER_TOOLS[provider];
  if (!cfg) {
    throw new GraphQLError(`Unknown Slack provider "${provider}".`, {
      extensions: { code: 'SLACK_TOOL_NOT_CONFIGURED', provider },
    });
  }
  const baseUrl = process.env[cfg.urlEnv];
  if (!baseUrl) {
    throw new GraphQLError(`Slack operations are not configured (${cfg.urlEnv} unset).`, {
      extensions: { code: 'SLACK_TOOL_NOT_CONFIGURED', provider },
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
    throw new GraphQLError(timedOut ? 'Slack service timed out.' : 'Slack service is unreachable.', {
      extensions: { code: 'SLACK_TOOL_UNREACHABLE', provider, cause: String(err) },
    });
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok) {
    // The tool's typed spec-043 error body: { error: <code>, message, ...fields }.
    const slackErrorCode = typeof payload?.error === 'string' ? payload.error : undefined;
    const message =
      typeof payload?.message === 'string' ? payload.message.slice(0, 500) : `Slack service error (${res.status}).`;
    throw new GraphQLError(message, {
      extensions: {
        code: 'SLACK_TOOL_ERROR',
        ...(slackErrorCode ? { slackErrorCode } : {}),
        status: res.status,
        provider,
      },
    });
  }

  if (!payload) {
    throw new GraphQLError('Slack service returned an unexpected response.', {
      extensions: { code: 'SLACK_TOOL_ERROR', provider },
    });
  }
  return payload as T;
}

/** One neutral choice element (rendered tool-side as Block Kit). */
export interface SlackChoice {
  value: string;
  label: string;
}

/**
 * Run a spec-043 operation on the provider tool (`POST /ops/<operation>`).
 * `input` always includes the TOOL's connectionId (except `respond`, whose
 * credential is the responseUrl); mutating operations may carry an
 * `idempotencyKey`.
 */
export async function runSlackOperation<T = Record<string, unknown>>(
  provider: string,
  operation: string,
  input: Record<string, unknown>,
): Promise<T> {
  return postToTool<T>(provider, `/ops/${operation}`, input);
}

/** The workspace identity the tool derives at registration. */
export interface SlackToolConnectionIdentity {
  id: string;
  provider: string;
  teamId: string;
  teamName: string;
  botUserId: string;
  botId: string;
  status: string;
}

/**
 * Register a workspace install on the provider tool from the bot + app
 * tokens (the tool validates both live and stores them encrypted). The
 * identity is shape-validated: teamId becomes a DB unique key and BOTH bot
 * ids feed the bridge loop filter, so a buggy tool response must fail
 * loudly here, never propagate empty identity into the connection row.
 */
export async function createSlackToolConnection(
  provider: string,
  input: { botToken: string; appToken: string },
): Promise<SlackToolConnectionIdentity> {
  const identity = await postToTool<SlackToolConnectionIdentity>(provider, '/connections', input);
  const required: (keyof SlackToolConnectionIdentity)[] = ['id', 'teamId', 'teamName', 'botUserId', 'botId'];
  const invalid = required.some((k) => typeof identity[k] !== 'string' || (identity[k] as string).trim() === '');
  if (invalid || identity.provider !== provider) {
    throw new GraphQLError('Slack service returned an invalid connection identity.', {
      extensions: { code: 'SLACK_TOOL_ERROR', provider },
    });
  }
  return identity;
}

/**
 * Best-effort disconnect on the provider tool (socket teardown + soft
 * delete). NEVER throws — the caller's DB effect has already committed, so
 * a misconfigured provider or an unreachable tool must log, not fail the
 * surrounding operation. Callers fire-and-forget (`void deleteSlackToolConnection(...)`).
 */
export async function deleteSlackToolConnection(provider: string, toolConnectionId: string): Promise<void> {
  try {
    const { baseUrl, token } = toolFor(provider);
    await fetch(`${baseUrl}/connections/${encodeURIComponent(toolConnectionId)}`, {
      method: 'DELETE',
      headers: token ? { authorization: `Bearer ${token}` } : {},
      signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
    });
  } catch (err) {
    console.error(`[slackClient] tool disconnect failed for ${provider}/${toolConnectionId}:`, err);
  }
}
