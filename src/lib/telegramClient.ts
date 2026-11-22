import { GraphQLError } from 'graphql';
import { toolRegistrationKey } from './toolRegistrationKey.js';

/**
 * Client for the Telegram capability tool (#597; hadrontool-telegram). On the emailClient / slackClient pattern:
 * hadron-server stays the front door, authorization has already run before anything here is called, and this module
 * only ships already-authorized requests to the internal tool.
 *
 * PROVIDER DISPATCH follows the PROVIDER_TOOLS pattern; v1 knows `telegram`.
 *
 * Configured by env:
 *   TELEGRAM_TOOL_URL    e.g. http://hadrontool-telegram:8080 (required)
 *   TELEGRAM_TOOL_TOKEN  shared bearer token (optional; sent when set)
 *
 * Error surface: TELEGRAM_TOOL_NOT_CONFIGURED / TELEGRAM_TOOL_UNREACHABLE / TELEGRAM_TOOL_ERROR as GraphQL
 * extensions.code, plus the tool's own typed code as extensions.telegramErrorCode.
 *
 * The BOT TOKEN is a write-only input: it goes to the tool in `createTelegramToolConnection` and nowhere else. A tool
 * (or a network error) that echoes it back must not carry it into a message or an extension, so every error built
 * from tool or transport text is scrubbed of it first.
 */

const DEFAULT_TIMEOUT_MS = 30_000;

interface ProviderToolConfig {
  urlEnv: string;
  tokenEnv: string;
}

const PROVIDER_TOOLS: Record<string, ProviderToolConfig> = {
  telegram: { urlEnv: 'TELEGRAM_TOOL_URL', tokenEnv: 'TELEGRAM_TOOL_TOKEN' },
};

/** Resolve a provider's tool base URL + token; typed error when unknown or unconfigured. */
function toolFor(provider: string): { baseUrl: string; token?: string } {
  const cfg = PROVIDER_TOOLS[provider];
  if (!cfg) {
    throw new GraphQLError(`Unknown Telegram provider "${provider}".`, {
      extensions: { code: 'TELEGRAM_TOOL_NOT_CONFIGURED', provider },
    });
  }
  const baseUrl = process.env[cfg.urlEnv];
  if (!baseUrl) {
    throw new GraphQLError(`Telegram operations are not configured (${cfg.urlEnv} unset).`, {
      extensions: { code: 'TELEGRAM_TOOL_NOT_CONFIGURED', provider },
    });
  }
  return { baseUrl: baseUrl.replace(/\/+$/, ''), token: process.env[cfg.tokenEnv] || undefined };
}

/** Replace every occurrence of each secret in `text` (a secret is a short opaque string, so a plain split is exact). */
function scrub(text: string, secrets: readonly string[]): string {
  let out = text;
  for (const secret of secrets) if (secret) out = out.split(secret).join('[redacted]');
  return out;
}

/** POST a JSON body to the provider tool with timeout + typed error mapping. `secrets` never reach an error. */
async function postToTool<T>(provider: string, path: string, body: unknown, secrets: readonly string[] = []): Promise<T> {
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
    // The body read stays INSIDE the timeout window: a tool that sends headers and then stalls must abort too.
    try {
      payload = (await res.json()) as Record<string, unknown> | null;
    } catch (err) {
      if (controller.signal.aborted) throw err;
      payload = null;
    }
  } catch (err) {
    const timedOut = controller.signal.aborted;
    throw new GraphQLError(timedOut ? 'Telegram service timed out.' : 'Telegram service is unreachable.', {
      extensions: { code: 'TELEGRAM_TOOL_UNREACHABLE', provider, cause: scrub(String(err), secrets) },
    });
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok) {
    const telegramErrorCode = typeof payload?.error === 'string' ? scrub(payload.error, secrets).slice(0, 100) : undefined;
    const message =
      typeof payload?.message === 'string'
        ? scrub(payload.message, secrets).slice(0, 500)
        : `Telegram service error (${res.status}).`;
    throw new GraphQLError(message, {
      extensions: {
        code: 'TELEGRAM_TOOL_ERROR',
        ...(telegramErrorCode ? { telegramErrorCode } : {}),
        status: res.status,
        provider,
      },
    });
  }

  if (!payload) {
    throw new GraphQLError('Telegram service returned an unexpected response.', {
      extensions: { code: 'TELEGRAM_TOOL_ERROR', provider },
    });
  }
  return payload as T;
}

/**
 * Run an operation on the provider tool (`POST /ops/<operation>`). `input` carries the TOOL's connectionId. No v1
 * caller; the later phases (DM bindings, group bridge) dispatch through here.
 */
export async function runTelegramOperation<T = Record<string, unknown>>(
  provider: string,
  operation: string,
  input: Record<string, unknown>,
): Promise<T> {
  return postToTool<T>(provider, `/ops/${operation}`, input);
}

/** The bot identity the tool derives at registration. */
export interface TelegramToolConnectionIdentity {
  id: string;
  provider: string;
  botId: string;
  botUsername: string;
  displayName: string;
  status: string;
}

/**
 * Register a bot on the provider tool from its token (the tool validates it live and stores it encrypted). The
 * identity is shape-validated: `id` becomes a DB unique routing key and `botId` the bot's identity, so a buggy tool
 * response must fail loudly here and never put an empty identity into the connection row.
 */
export async function createTelegramToolConnection(
  provider: string,
  input: { botToken: string; appId: string },
): Promise<TelegramToolConnectionIdentity> {
  // #4829: a core-derived registrationKey lets a tool that supports it recognise a retry after a lost response as the
  // SAME registration. A tool that does not know the field ignores it and behaves exactly as before (the 400 on a
  // duplicate bot). The key is scrubbed from any error like the token.
  const body = { botToken: input.botToken, registrationKey: toolRegistrationKey(provider, input.appId, [input.botToken]) };
  const identity = await postToTool<TelegramToolConnectionIdentity>(provider, '/connections', body, [input.botToken, body.registrationKey]);
  const required: (keyof TelegramToolConnectionIdentity)[] = ['id', 'botId', 'botUsername', 'displayName'];
  const invalid = required.some((k) => typeof identity[k] !== 'string' || (identity[k] as string).trim() === '');
  if (invalid || identity.provider !== provider) {
    // The tool already holds the token and a poll loop under this id: tear it down, or nothing in core can reach it.
    if (typeof identity.id === 'string' && identity.id.trim() !== '') void deleteTelegramToolConnection(provider, identity.id);
    throw new GraphQLError('Telegram service returned an invalid connection identity.', {
      extensions: { code: 'TELEGRAM_TOOL_ERROR', provider },
    });
  }
  return identity;
}

/**
 * Best-effort disconnect on the provider tool (poll teardown + soft delete). NEVER throws: the caller's DB effect has
 * already committed, so a misconfigured provider or an unreachable tool must log, not fail the surrounding operation.
 */
export async function deleteTelegramToolConnection(provider: string, toolConnectionId: string): Promise<void> {
  try {
    const { baseUrl, token } = toolFor(provider);
    const res = await fetch(`${baseUrl}/connections/${encodeURIComponent(toolConnectionId)}`, {
      method: 'DELETE',
      headers: token ? { authorization: `Bearer ${token}` } : {},
      signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
    });
    // fetch resolves on 4xx/5xx: a refusal (wrong bearer, tool error) leaves the tool holding the token, so say so.
    if (!res.ok) console.error(`[telegramClient] tool disconnect refused for ${provider}/${toolConnectionId}: HTTP ${res.status}`);
  } catch (err) {
    console.error(`[telegramClient] tool disconnect failed for ${provider}/${toolConnectionId}:`, err);
  }
}
