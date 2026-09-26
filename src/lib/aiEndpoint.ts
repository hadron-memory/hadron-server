/**
 * #1373 — where an AI config's requests go.
 *
 * `AiServiceConfig.endpoint` is the one editable place a provider base URL
 * lives. Nothing else hardcodes one: the suggestion list below is the single
 * server-owned catalogue the portal and the CLI render, and the provider
 * defaults the LLM client falls back to are its `isDefault` entries.
 *
 * Holger's rulings on #1373 (2026-09-26, recorded in team chat #2078):
 *   - D1: glm's default is Z.ai's general endpoint (pay-as-you-go), not the
 *     Coding Plan, whose terms limit it to officially supported tools.
 *   - D2: an unset `endpoint` ALWAYS means the provider default. The legacy
 *     `params.baseUrl` is not read; the few existing configs are fixed by hand,
 *     so there is no migration.
 *   - D3: `apiStyle` picks the wire protocol for OpenAI-compatible providers.
 *   - D4: private/loopback endpoints need a self-hosted operator's opt-in,
 *     `AI_ENDPOINT_ALLOW_PRIVATE_NETWORKS=true`, off by default.
 */

import { isIP } from 'node:net';
import { embeddedIpv4, isForbiddenAddress } from './webFetch.js';
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
      url: 'https://api.z.ai/api/paas/v4',
      label: 'Z.ai (general)',
      isDefault: true,
      note: 'Pay-as-you-go: draws on the Z.ai account balance.',
    },
    {
      url: 'https://api.z.ai/api/coding/paas/v4',
      label: 'Z.ai Coding Plan',
      isDefault: false,
      note: "Draws on a Z.ai Coding Plan subscription. Z.ai's terms limit the plan to officially supported tools.",
    },
    {
      url: 'https://open.bigmodel.cn/api/paas/v4',
      label: 'Zhipu BigModel (China)',
      isDefault: false,
      note: 'Pay-as-you-go on a Zhipu BigModel account.',
    },
  ],
  bedrock: [],
};

/** The provider's default base URL, or null when the SDK derives it (bedrock). */
export function defaultEndpoint(provider: string): string | null {
  return AI_PROVIDER_ENDPOINTS[provider as AiProvider]?.find((e) => e.isDefault)?.url ?? null;
}

/** The config's own endpoint, or null for the provider default (D2: nothing else is read). */
export function explicitEndpoint(config: { provider?: string; endpoint?: string | null }): string | null {
  return config.endpoint || null;
}

/** What a request for this config is sent to: its endpoint, else the default. */
export function effectiveEndpoint(config: { provider: string; endpoint?: string | null }): string | null {
  return explicitEndpoint(config) ?? defaultEndpoint(config.provider);
}

/**
 * D2: `params.baseUrl` is not read any more, so accepting it would store a
 * setting that silently does nothing. Refused where params are WRITTEN, not on
 * every edit, so an unrelated change to a legacy row is not blocked.
 */
export function refuseLegacyBaseUrl(params: unknown): void {
  if (params && typeof params === 'object' && 'baseUrl' in params) {
    throw new AiConfigValidationError("params.baseUrl is no longer read; set the config's endpoint instead.");
  }
}

// ── apiStyle (D3) ────────────────────────────────────────────────────────

/** The wire protocol an OpenAI-compatible provider speaks. */
export const AI_API_STYLES = ['CHAT_COMPLETIONS', 'RESPONSES'] as const;
export type AiApiStyle = (typeof AI_API_STYLES)[number];

/**
 * Per-provider default, and the set of providers where a style applies at all.
 * Anthropic and Bedrock have one protocol each, so a style there is refused
 * rather than stored and ignored.
 */
const DEFAULT_API_STYLE: Partial<Record<string, AiApiStyle>> = {
  openai: 'RESPONSES',
  glm: 'CHAT_COMPLETIONS',
};

export function defaultApiStyle(provider: string): AiApiStyle | null {
  return DEFAULT_API_STYLE[provider] ?? null;
}

export function effectiveApiStyle(config: { provider: string; apiStyle?: string | null }): AiApiStyle | null {
  return (config.apiStyle as AiApiStyle | null | undefined) ?? defaultApiStyle(config.provider);
}

/** Validate a (provider, apiStyle) pair as it will be stored. */
export function validateApiStyle(provider: string, apiStyle: string | null | undefined): void {
  if (apiStyle == null) return;
  if (!(AI_API_STYLES as readonly string[]).includes(apiStyle)) {
    throw new AiConfigValidationError(`Unknown apiStyle '${apiStyle}'.`);
  }
  if (!(provider in DEFAULT_API_STYLE)) {
    throw new AiConfigValidationError(`apiStyle applies to OpenAI-compatible providers only, not '${provider}'.`);
  }
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
 * D4: a self-hosted operator may let configs reach PRIVATE-NETWORK and
 * loopback addresses (a LAN Ollama or vLLM). Off by default; the hosted
 * platform leaves it unset. It also admits plain http, which LAN model servers
 * usually speak. It never admits link-local (the cloud metadata service lives
 * at 169.254.169.254), multicast, unspecified or other reserved ranges: the
 * opt-in widens to a LAN, not to everything the egress policy forbids
 * (#1380 review, Copilot).
 */
export function privateEndpointsAllowed(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.AI_ENDPOINT_ALLOW_PRIVATE_NETWORKS === 'true';
}

/**
 * Cloud metadata that sits INSIDE a private range, so the private-network
 * exception must never admit it (#1380 review, Codex P1): AWS reserves
 * fd00:ec2::/32 for its Nitro services, and fd00:ec2::254 is the IPv6
 * instance-metadata endpoint. (The IPv4 one, 169.254.169.254, is link-local
 * and never private.) Matched on the canonical form, so any spelling of an
 * address in the block is caught.
 */
export function isCloudMetadataAddress(ip: string): boolean {
  if (isIP(ip) !== 6) return false;
  const canonical = new URL(`http://[${ip}]`).hostname.replace(/^\[|\]$/g, '');
  return canonical.startsWith('fd00:ec2:');
}

/**
 * RFC 1918, IPv6 ULA (fc00::/7) and loopback, including IPv4-mapped forms —
 * minus cloud metadata inside those ranges. Loopback is included on purpose:
 * the canonical self-hosted setup is a model server on the same host
 * (Ollama on localhost:11434), and it is admitted ONLY under the operator's
 * explicit opt-in, which the hosted platform never sets.
 */
export function isPrivateNetworkAddress(ip: string): boolean {
  if (isCloudMetadataAddress(ip)) return false;
  const v4 = isIP(ip) === 4 ? ip : embeddedIpv4(ip);
  if (v4) {
    const [a, b] = v4.split('.').map(Number);
    return a === 10 || a === 127 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
  }
  const lower = ip.toLowerCase();
  return lower === '::1' || /^f[cd][0-9a-f]{0,2}:/.test(lower);
}

/**
 * Write-time validation for `endpoint`. Static checks only: whether a HOSTNAME
 * resolves to a private address can change after the write, so that is the
 * connect-time guard's job (`guardedEndpointFetch`), which also covers the
 * legacy `params.baseUrl`. Returns the stored form (no trailing slash).
 */
export function validateEndpoint(raw: string, env: NodeJS.ProcessEnv = process.env): string {
  // The raw value is never echoed: it may carry credentials or a secret in a
  // query string, and this message reaches GraphQL clients and logs (#1380
  // review). The parsed host alone identifies which endpoint was refused.
  let shownHost = '';
  const refuse = (why: string): never => {
    throw new AiConfigValidationError(`Invalid endpoint${shownHost ? ` for host '${shownHost}'` : ''}: ${why}`);
  };
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return refuse('not an absolute URL.');
  }
  shownHost = url.host;
  if (url.username || url.password) refuse('credentials in the URL are not allowed; store the key in apiKey.');
  if (url.search || url.hash) refuse('a query string or fragment is not allowed.');
  const host = url.hostname.replace(/^\[|\]$/g, '');
  const loopback = LOOPBACK_HOSTS.has(host) || (isIP(host) !== 0 && isLoopbackAddress(host));
  if (privateEndpointsAllowed(env)) {
    // D4 opt-in: a private network, http included, but never a reserved range.
    if (isIP(host) && isForbiddenAddress(host) && !isPrivateNetworkAddress(host)) {
      refuse('a link-local, multicast or reserved address is never allowed.');
    }
    // Plain http only to a private network. A hostname's class is known only
    // when it resolves, so the connect-time guard enforces that case.
    if (url.protocol === 'http:' && isIP(host) && !isPrivateNetworkAddress(host)) {
      refuse('plain http is allowed only to a private-network address; use https.');
    }
  } else if (loopback) {
    if (!loopbackAllowed(env)) refuse('a loopback host is not allowed on this server.');
  } else {
    if (url.protocol !== 'https:') refuse('use https.');
    if (isIP(host) && isForbiddenAddress(host)) refuse('a private or reserved address is not allowed.');
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') refuse('use https.');
  return url.toString().replace(/\/+$/, '');
}
