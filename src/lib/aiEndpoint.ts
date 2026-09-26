/**
 * #1373 — where an AI config's requests go.
 *
 * `AiServiceConfig.endpoint` is the one editable place a provider base URL
 * lives. Nothing else hardcodes one: the suggestion list below is the single
 * server-owned catalogue the portal and the CLI render, and the provider
 * defaults the LLM client falls back to are its `isDefault` entries.
 *
 * DRAFT: the glm default (D1), the `params.baseUrl` migration (D2), an
 * `apiStyle` field (D3) and a self-hosted private-network opt-in (D4) are
 * open decisions on #1373; this module takes none of them. The glm default is
 * today's host, and `params.baseUrl` stays a read fallback for the providers
 * that honoured it before.
 */

import { isIP } from 'node:net';
import { isForbiddenAddress } from './webFetch.js';
import { AiConfigValidationError, type AiProvider } from './aiConfig.js';

export interface AiProviderEndpoint {
  url: string;
  label: string;
  /** The endpoint a config with no `endpoint` uses. At most one per provider. */
  isDefault: boolean;
  /** Facts a chooser needs that the URL does not say (billing, terms). */
  note: string | null;
}

/**
 * The single catalogue of known endpoints. Bedrock has none: its endpoint is
 * derived from the credential's region.
 */
export const AI_PROVIDER_ENDPOINTS: Record<AiProvider, readonly AiProviderEndpoint[]> = {
  anthropic: [{ url: 'https://api.anthropic.com/v1', label: 'Anthropic', isDefault: true, note: null }],
  openai: [{ url: 'https://api.openai.com/v1', label: 'OpenAI', isDefault: true, note: null }],
  glm: [
    {
      url: 'https://open.bigmodel.cn/api/paas/v4',
      label: 'Zhipu BigModel (China)',
      isDefault: true,
      note: 'Pay-as-you-go on a Zhipu BigModel account.',
    },
    {
      url: 'https://api.z.ai/api/paas/v4',
      label: 'Z.ai (general)',
      isDefault: false,
      note: 'Pay-as-you-go: draws on the Z.ai account balance.',
    },
    {
      url: 'https://api.z.ai/api/coding/paas/v4',
      label: 'Z.ai Coding Plan',
      isDefault: false,
      note: "Draws on a Z.ai Coding Plan subscription. Z.ai's terms limit the plan to officially supported tools.",
    },
  ],
  bedrock: [],
};

/** The provider's default base URL, or null when the SDK derives it (bedrock). */
export function defaultEndpoint(provider: string): string | null {
  return AI_PROVIDER_ENDPOINTS[provider as AiProvider]?.find((e) => e.isDefault)?.url ?? null;
}

/** Providers whose client honoured `params.baseUrl` before `endpoint` existed. */
const LEGACY_BASE_URL_PROVIDERS = new Set(['openai', 'glm']);

/**
 * The explicit override a config carries, or null for the provider default:
 * `endpoint`, else — only for the providers that already honoured it —
 * `params.baseUrl`, so no existing config changes host (#1373 acceptance).
 */
export function explicitEndpoint(config: { provider: string; endpoint?: string | null; params?: unknown }): string | null {
  if (config.endpoint) return config.endpoint;
  if (!LEGACY_BASE_URL_PROVIDERS.has(config.provider)) return null;
  const baseUrl = (config.params as { baseUrl?: unknown } | null | undefined)?.baseUrl;
  return typeof baseUrl === 'string' && baseUrl !== '' ? baseUrl : null;
}

/** What a request for this config is sent to: the override, else the default. */
export function effectiveEndpoint(config: { provider: string; endpoint?: string | null; params?: unknown }): string | null {
  return explicitEndpoint(config) ?? defaultEndpoint(config.provider);
}

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1']);

export function isLoopbackAddress(ip: string): boolean {
  return ip === '::1' || /^127\./.test(ip);
}

/** Dev and test may target a local server (Ollama, a capture server); production never. */
export function loopbackAllowed(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.NODE_ENV !== 'production';
}

/**
 * Write-time validation for `endpoint`. Static checks only: whether a HOSTNAME
 * resolves to a private address can change after the write, so that is the
 * connect-time guard's job (`guardedEndpointFetch`), which also covers the
 * legacy `params.baseUrl`. Returns the stored form (no trailing slash).
 */
export function validateEndpoint(raw: string, env: NodeJS.ProcessEnv = process.env): string {
  const refuse = (why: string): never => {
    throw new AiConfigValidationError(`Invalid endpoint '${raw}': ${why}`);
  };
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return refuse('not an absolute URL.');
  }
  if (url.username || url.password) refuse('credentials in the URL are not allowed; store the key in apiKey.');
  if (url.search || url.hash) refuse('a query string or fragment is not allowed.');
  const host = url.hostname.replace(/^\[|\]$/g, '');
  const loopback = LOOPBACK_HOSTS.has(host) || (isIP(host) !== 0 && isLoopbackAddress(host));
  if (loopback) {
    if (!loopbackAllowed(env)) refuse('a loopback host is not allowed on this server.');
  } else {
    if (url.protocol !== 'https:') refuse('use https.');
    if (isIP(host) && isForbiddenAddress(host)) refuse('a private or reserved address is not allowed.');
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') refuse('use https.');
  return url.toString().replace(/\/+$/, '');
}
