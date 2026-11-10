/**
 * #1378 — test a SAVED AI config through the path a run uses (the server half
 * of hadron-portal#937).
 *
 * The portal's old Test called the PORTAL's own LLM client with a hardcoded
 * endpoint, and resolved App/Agent configs by NAME through the resolution
 * walk, so a green Test proved nothing about a run (org `hadronmemory.com`'s
 * `zai_glm53` passed while every run failed). This operation instead:
 *
 *   - takes the config by ID — the exact row being edited, never whichever
 *     same-named config the walk would pick;
 *   - makes ONE small call through `generateText`, the client runs use, so the
 *     endpoint, wire protocol and connect-time egress guard are the run's own;
 *   - keeps the key server-side: the stored key is decrypted in-process only,
 *     and provider error text is scrubbed of it before it is returned;
 *   - reports, field by field, whether the SAVED value or a caller OVERRIDE was
 *     used, so "it works" can never be misread as "the saved config works".
 *
 * Metering (Holger, 2026-09-26, recorded on #1378): every test that reaches
 * a provider is recorded (pre-call failures, NO_API_KEY and KEY_UNREADABLE,
 * make no call and record nothing) (`type: 'ai-config-test'`). A BYOK test uses the
 * owner's provider account; a caller-supplied override key is the caller's
 * own and never debits. The only PLATFORM-funded test is a platform admin
 * testing a HADRON_SERVER config (only they pass the gate for one, and an
 * org/App/Agent config with no key is NO_API_KEY, never the platform key,
 * exactly as a run refuses it since #1390): it
 * is recorded with keyOwnerType HADRON_SERVER, attributed to the caller's
 * active org when the request carries one (and counted against that org's
 * daily token quota, which must have headroom before the call, as a run's
 * launch gate requires), otherwise recorded as the platform's own usage. That
 * includes a HADRON_SERVER config with no stored key at a default host that
 * issued the server's own credential (the AWS chain for Bedrock, say): a run
 * uses that credential, so the test does too (`key: PLATFORM`). Small fixed
 * prompt, tight token cap, and the rate limit (charged only for calls that
 * reach a provider) bound every path.
 */

import { GraphQLError } from 'graphql';
import type { AiServiceConfig } from '../../generated/prisma/index.js';
import type { Context } from '../../api/graphql/schema/resolvers.helpers.js';
import { aiConfigOwnerOf, requireAiConfigOwnerAdmin } from '../../api/graphql/schema/resolvers.helpers.js';
import { AiServiceConfigNotFoundError, validateParamRanges, validateProviderAndParams, type AiConfigOwnerType } from '../../lib/aiConfig.js';
import {
  defaultEndpoint,
  effectiveApiStyle,
  effectiveEndpoint,
  explicitEndpoint,
  validateApiStyle,
  usesProcessCredential,
  validateEndpoint,
  refuseLegacyBaseUrl,
  type AiApiStyle,
} from '../../lib/aiEndpoint.js';
import { assertModelBuildable, generateText, LlmInvocationError, type KnobReport, type LlmRequest, type LlmResult } from '../../lib/llm/index.js';
import { recordLlmUsage } from '../../lib/metering/index.js';
import { decryptToken, encryptToken } from '../../lib/tokenCrypto.js';
import { defaultQuotaLimit, reserveQuota, settleReservation } from '../../jobs/appRuns.js';
import { forbiddenError } from '../../lib/refusals.js';

export interface AiConfigTestOverride {
  provider?: string | null;
  model?: string | null;
  /** Omitted = the saved endpoint; null or '' = the provider default. */
  endpoint?: string | null;
  /** Omitted = the saved style; null = the provider default. */
  apiStyle?: AiApiStyle | null;
  /**
   * Tests with this key instead of the stored one. Never stored, never echoed.
   * Omitted = the stored key; null or '' = NO key, as updateAiServiceConfig
   * reads them (it clears the key), so an edit that removes the key tests as one.
   */
  apiKey?: string | null;
  /**
   * Edited params to test instead of the saved ones (#1413), validated
   * exactly as a save validates them — including the legacy params.baseUrl
   * refusal — against the EFFECTIVE provider, before anything outbound.
   * Used for the call, never stored. Omitted = the saved params; null = the
   * edit clears them (the provider defaults), as updateAiServiceConfig
   * reads params.
   */
  params?: unknown;
}

type Source = 'SAVED' | 'OVERRIDE';
/** PLATFORM: no stored key, and the server's own credential served the call, as it would a run's. */
type KeySource = Source | 'PLATFORM' | 'NONE';

export interface AiConfigTestResult {
  ok: boolean;
  provider: string;
  model: string;
  endpoint: string | null;
  apiStyle: AiApiStyle | null;
  used: { provider: Source; model: Source; endpoint: Source; apiStyle: Source; params: Source; key: KeySource };
  latencyMs: number;
  reply: string | null;
  error: { code: string; message: string; transient: boolean } | null;
  /**
   * #1417: what each provider knob in the effective params did on the call.
   * Additive: `used.params` still says only whether those params were the
   * saved ones or the override. Empty unless the call completed: a failed
   * call's adapter warnings are unknown, so its knobs cannot be reported truthfully.
   */
  knobs: KnobReport[];
}

/** The fixed probe: a one-word answer, so a test costs a few dozen tokens. */
export const AI_CONFIG_TEST_REQUEST: LlmRequest = {
  prompt: 'Reply with the single word OK.',
  maxTokens: 16,
};

/**
 * #1413: the probe's hard output cap, independent of the params under test —
 * the effective maxTokens may not exceed it. Held at #1378's original 16
 * pending an explicit cost ruling on raising it (QA #2596): the one argument
 * for more is that thinking models spend reasoning tokens against
 * max_tokens, so 16 can truncate a healthy config's single-word reply into
 * a false failure. Like the probe's one-word prompt, the cap is the probe's
 * own, not part of the config being tested.
 */
export const AI_CONFIG_TEST_PROBE_MAX_TOKENS = 16;

// ── Rate limit ───────────────────────────────────────────────────────────
// A test is a real provider call, so the button must not be a free relay.
// Per caller per config, in-process: the server runs as one instance today;
// a multi-instance deployment gets a per-instance allowance, still bounded.

export const AI_CONFIG_TEST_LIMIT = 5;
export const AI_CONFIG_TEST_WINDOW_MS = 60_000;
const recentTests = new Map<string, number[]>();

/** Past this many tracked pairs, every stale one is dropped (#1385 review). */
const LIMITER_SWEEP_AT = 1_000;

/** Admit one test for `key` at `now`; the seconds to wait when refused. Exported for tests. */
export function admitTest(key: string, now: number): number | null {
  if (recentTests.size >= LIMITER_SWEEP_AT) {
    for (const [k, times] of recentTests) {
      if (times.every((t) => now - t >= AI_CONFIG_TEST_WINDOW_MS)) recentTests.delete(k);
    }
  }
  const kept = (recentTests.get(key) ?? []).filter((t) => now - t < AI_CONFIG_TEST_WINDOW_MS);
  if (kept.length >= AI_CONFIG_TEST_LIMIT) {
    recentTests.set(key, kept);
    return Math.ceil((AI_CONFIG_TEST_WINDOW_MS - (now - kept[0])) / 1000);
  }
  kept.push(now);
  recentTests.set(key, kept);
  return null;
}

/** Test-only: forget every recorded test. */
export function resetAiConfigTestLimiter(): void {
  recentTests.clear();
}

/** Test-only: how many caller/config pairs the limiter is tracking. */
export function aiConfigTestLimiterSize(): number {
  return recentTests.size;
}

// ── Secrets never leave ──────────────────────────────────────────────────

/** Every secret string a key may appear as in provider error text. */
function secretsOf(rawKey: string | null): string[] {
  if (!rawKey) return [];
  const out = [rawKey];
  try {
    // bedrock stores a JSON triple; its parts can be echoed individually.
    const triple = JSON.parse(rawKey) as Record<string, unknown>;
    for (const v of [triple.accessKeyId, triple.secretAccessKey]) if (typeof v === 'string' && v) out.push(v);
  } catch {
    // not JSON — the whole key is the only secret
  }
  // Every non-empty secret, however short: the write paths accept short keys,
  // and "never echoed" has no length exception (#1385 review).
  return out.filter((s) => s.length > 0);
}

const MAX_ERROR_CHARS = 500;

/** Exported for tests. */
export function scrub(message: string, secrets: string[]): string {
  let out = message;
  // Longest first: when one secret is a prefix of another (a Bedrock key id
  // and its secret, say), redacting the short one first would leave the long
  // one's tail behind (#1385 review).
  for (const s of [...new Set(secrets)].sort((a, b) => b.length - a.length)) out = out.split(s).join('[redacted]');
  return out.length > MAX_ERROR_CHARS ? `${out.slice(0, MAX_ERROR_CHARS)}…` : out;
}

/**
 * The process credentials an SDK falls back to with no stored key (the
 * variables @ai-sdk/openai, /anthropic and /amazon-bedrock read). A PLATFORM
 * test sends one of them, so a provider that echoes its Authorization header
 * must not hand it to the caller (#1385 review). Always included: a value
 * the call never sent can't be echoed, so this costs nothing otherwise.
 */
function bedrockRegionOf(rawKey: string | null): string | null {
  if (!rawKey) return null;
  try {
    const region = (JSON.parse(rawKey) as { region?: unknown }).region;
    return typeof region === 'string' && region ? region : null;
  } catch {
    return null;
  }
}

/**
 * Whether the process credential a keyless platform config would use exists.
 * OpenAI and Anthropic read one variable. Bedrock's AWS default chain (a
 * role, a profile, the metadata service) can't be known without resolving
 * it, so it's assumed present and a real failure surfaces from the call.
 */
function processCredentialPresent(provider: string, env: NodeJS.ProcessEnv): boolean {
  if (provider === 'openai') return !!env.OPENAI_API_KEY;
  if (provider === 'anthropic') return !!env.ANTHROPIC_API_KEY;
  return true;
}

function processSecrets(env: NodeJS.ProcessEnv): string[] {
  const keys = ['OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'AWS_SESSION_TOKEN', 'AWS_BEARER_TOKEN_BEDROCK']
    .map((name) => env[name] ?? '')
    .filter((v) => v.length > 0);
  // An operator base URL carrying userinfo, a query or a fragment may hold a
  // secret, and SDK errors echo the URL verbatim (#1385 review). A plain one
  // stays readable, since it's the most useful fact in a connection error.
  const urls = ['OPENAI_BASE_URL', 'ANTHROPIC_BASE_URL']
    .map((name) => env[name] ?? '')
    .filter((v) => /[@?#]/.test(v));
  // …and each secret part on its own: a provider can echo just the
  // password or a query value, which the whole-URL match would miss
  // (#1385 review).
  // Raw AND decoded, and one bad decode never drops the other form.
  const safeDecode = (v: string) => {
    try {
      return decodeURIComponent(v.replace(/\+/g, ' '));
    } catch {
      return v;
    }
  };
  const parts: string[] = [];
  for (const raw of urls) {
    let u: URL;
    try {
      u = new URL(raw);
    } catch {
      continue; // unparsable: the whole-string match above is all there is
    }
    const rawQueryValues = u.search.slice(1).split('&').map((kv) => kv.slice(kv.indexOf('=') + 1));
    for (const v of [u.username, u.password, u.hash.slice(1), ...rawQueryValues, ...u.searchParams.values()]) {
      if (v) parts.push(v, safeDecode(v));
    }
  }
  return [...keys, ...urls, ...parts];
}

/**
 * Where the probe actually went. With no explicit endpoint the SDK, not the
 * catalog, picks the host: OpenAI and Anthropic honour OPENAI_BASE_URL /
 * ANTHROPIC_BASE_URL, and Bedrock derives its host from the region. The
 * catalog default would claim the official host answered when a proxy did
 * (#1385 review).
 */
function probeTarget(config: { provider: string; endpoint?: string | null }, bedrockRegion: string | null, env: NodeJS.ProcessEnv): string | null {
  const explicit = explicitEndpoint(config);
  if (explicit) return explicit;
  // An operator's base URL is reported sanitized: origin and path only. A
  // deployment value carrying userinfo or a query token must not surface in
  // a GraphQL result (#1385 review). Unparsable is reported as unknown.
  const trimmed = (v: string | undefined) => {
    if (!v) return null;
    try {
      const u = new URL(v);
      return `${u.origin}${u.pathname}`.replace(/\/+$/, '');
    } catch {
      return null;
    }
  };
  switch (config.provider) {
    // Set-but-unparsable is reported as unknown (null), never as the catalog
    // host the SDK is not actually calling (#1385 review).
    case 'openai':
      return env.OPENAI_BASE_URL ? trimmed(env.OPENAI_BASE_URL) : defaultEndpoint('openai');
    case 'anthropic':
      return env.ANTHROPIC_BASE_URL ? trimmed(env.ANTHROPIC_BASE_URL) : defaultEndpoint('anthropic');
    case 'bedrock': {
      const region = bedrockRegion ?? env.AWS_REGION ?? null;
      return region ? `https://bedrock-runtime.${region}.amazonaws.com` : null;
    }
    default:
      return effectiveEndpoint(config);
  }
}

/**
 * The org a test's usage is attributed to: the config's own, else its owning
 * App's or Agent's, else the caller's active org IF the request carries one.
 * A platform admin's GraphQL request usually doesn't, and then a
 * HADRON_SERVER test is simply the platform's own usage (no org to charge).
 */
async function billableOrgOf(ctx: Context, row: AiServiceConfig): Promise<string | null> {
  if (row.organizationId) return row.organizationId;
  if (row.appId) {
    const app = await ctx.db.app.findUnique({ where: { id: row.appId }, select: { organizationId: true } });
    if (app?.organizationId) return app.organizationId;
  }
  if (row.agentId) {
    const agent = await ctx.db.agent.findUnique({ where: { id: row.agentId }, select: { organizationId: true } });
    if (agent?.organizationId) return agent.organizationId;
  }
  return ctx.organizationId ?? null;
}

export interface AiConfigTestDeps {
  generate: (resolved: Parameters<typeof generateText>[0], req: LlmRequest) => Promise<LlmResult>;
  now: () => number;
  /** The probe's hard deadline; an endpoint that never answers is a failed test, not a hung request. */
  timeoutMs: number;
  /** Local refusals (no network), run before anything is charged. */
  preflight: (resolved: Parameters<typeof assertModelBuildable>[0]) => void;
}

/**
 * Tokens reserved from the org's daily platform allowance BEFORE a
 * platform-funded probe, then settled to the real count. Reserving makes the
 * check and the spend one atomic step, so concurrent tests can't all pass the
 * check and overshoot (#1385 review). Sized to the probe's realistic bound,
 * a one-line prompt plus maxTokens 16 (a dozen or so tokens in, at most 16
 * out), so an operator's low stored limit stays testable (#1385 review). A
 * provider counting more than this still records the excess in the window.
 */
export const AI_CONFIG_TEST_TOKEN_RESERVE = 64;

/** Long enough for a slow model's first token, short enough for a button. */
export const AI_CONFIG_TEST_TIMEOUT_MS = 20_000;

const defaultDeps: AiConfigTestDeps = {
  generate: generateText,
  now: () => Date.now(),
  timeoutMs: AI_CONFIG_TEST_TIMEOUT_MS,
  preflight: assertModelBuildable,
};

export async function testAiServiceConfig(
  ctx: Context,
  id: string,
  override: AiConfigTestOverride = {},
  deps: AiConfigTestDeps = defaultDeps,
): Promise<AiConfigTestResult> {
  const row = await ctx.db.aiServiceConfig.findUnique({ where: { id } });
  if (!row) throw new AiServiceConfigNotFoundError(id);
  const owner = aiConfigOwnerOf(row);
  // The same gate as updateAiServiceConfig: only the owner's admins test it.
  // A config the caller can't manage reads exactly like a missing one, so the
  // mutation is no oracle for which ids exist (#1385 review, Copilot).
  try {
    await requireAiConfigOwnerAdmin(ctx, owner.ownerType, owner.ownerId);
  } catch (e) {
    if (e instanceof Error && e.message === 'Forbidden') throw new AiServiceConfigNotFoundError(id);
    throw e;
  }
  // Impersonation is a read-only support view (#876), and a test spends.
  if (ctx.impersonation || !ctx.userId) throw forbiddenError();

  // The config under test: saved values, overridden field by field, and
  // validated exactly as a write would validate them.
  const provider = override.provider ?? row.provider;
  const model = override.model ?? row.model;
  // #1413: the effective params — saved, or the edit under test — validated
  // ONCE, as a save judges the RESULTING pair (#1385 review, Codex): a
  // corrected override must be able to test a repair of stale invalid saved
  // params, exactly as updateAiServiceConfig would accept that edit. The
  // override runs Save's own two checks (the legacy params.baseUrl refusal
  // first, so it never reaches a provider) against the EFFECTIVE provider;
  // the no-override path keeps judging the saved pair only — its own save
  // time validated it, and legacy rows test as they run. Either way the
  // params reach the CALL, never the stored row.
  const params = override.params === undefined ? row.params : override.params;
  if (override.params === undefined) {
    validateProviderAndParams(provider, row.params ?? null);
  } else {
    refuseLegacyBaseUrl(override.params);
    validateProviderAndParams(provider, override.params);
  }
  // #1417: an edit under test is judged as its save would be; saved params
  // alone are not re-judged (a legacy row tests as it runs).
  if (override.params !== undefined || override.provider != null) validateParamRanges(provider, params ?? null);
  // #1413: the probe's output cap — the effective params' maxTokens (saved,
  // or the edit under test) bounded by the probe's hard cap, defaulting to
  // the probe's own 16. Used by both the call and the platform-funded
  // reservation, so a test can never spend past what it reserved.
  const paramsMaxTokens =
    params && typeof params === 'object' && 'maxTokens' in params
      ? (params as { maxTokens?: number }).maxTokens
      : undefined;
  const probeMaxTokens = Math.min(paramsMaxTokens ?? AI_CONFIG_TEST_REQUEST.maxTokens ?? 16, AI_CONFIG_TEST_PROBE_MAX_TOKENS);
  const endpoint =
    override.endpoint === undefined ? row.endpoint : override.endpoint ? validateEndpoint(override.endpoint) : null;
  const apiStyle = override.apiStyle === undefined ? row.apiStyle : override.apiStyle;
  validateApiStyle(provider, apiStyle);
  const tested = { provider, endpoint, apiStyle };

  const overrideKey = override.apiKey || null;
  // Omitted keeps the stored key; an explicit null/'' clears it, exactly as
  // the write would (#1385 review), so it tests as "no key".
  const keyCleared = override.apiKey !== undefined && !override.apiKey;
  const keySource: KeySource = overrideKey
    ? 'OVERRIDE'
    : !keyCleared && row.apiKeyEncrypted
      ? 'SAVED'
      : // The run's own rule (modelFor): only the platform's own config may
        // run on the platform's credential (#1390), and only if the server
        // HAS one: the SDKs load it lazily at call time, so a missing key
        // would otherwise pass every check and charge for a call that
        // never leaves (#1385 review).
        usesProcessCredential(tested, owner.ownerType) && processCredentialPresent(provider, process.env)
        ? 'PLATFORM'
        : 'NONE';
  const noServerCredential = keySource === 'NONE' && !keyCleared && usesProcessCredential(tested, owner.ownerType);
  const used: AiConfigTestResult['used'] = {
    // Presence, not truthiness: an empty model is still what gets sent.
    provider: override.provider != null ? 'OVERRIDE' : 'SAVED',
    model: override.model != null ? 'OVERRIDE' : 'SAVED',
    endpoint: override.endpoint === undefined ? 'SAVED' : 'OVERRIDE',
    apiStyle: override.apiStyle === undefined ? 'SAVED' : 'OVERRIDE',
    // #1413: presence again — a null params override (the edit clears them)
    // is still the override, and is what gets sent.
    params: override.params === undefined ? 'SAVED' : 'OVERRIDE',
    key: keySource,
  };
  const base = {
    provider,
    model,
    // Where it would go; refined below once the key (a Bedrock region) is known.
    endpoint: probeTarget(tested, null, process.env),
    apiStyle: effectiveApiStyle(tested),
    used,
    knobs: [] as KnobReport[],
  };
  if (keySource === 'NONE') {
    return {
      ...base,
      ok: false,
      latencyMs: 0,
      reply: null,
      error: {
        code: 'NO_API_KEY',
        message: keyCleared
          ? 'The edit clears this config\'s key; supply one to test with.'
          : noServerCredential
            ? `This config has no stored key, and the server has no ${provider === 'anthropic' ? 'ANTHROPIC_API_KEY' : 'OPENAI_API_KEY'} to fall back on; supply a key to test with.`
            : 'This config has no stored key; supply one to test with.',
        transient: false,
      },
    };
  }

  // Decrypted only when it is the key being used: an override replaces it, and
  // a stale ciphertext must not block testing a good new key (#1385 review).
  let savedKey: string | null = null;
  if (keySource === 'SAVED' && row.apiKeyEncrypted) {
    try {
      savedKey = decryptToken(row.apiKeyEncrypted);
    } catch {
      // A stored key written under an older HADRON_ENCRYPTION_KEY, or
      // malformed: a failed test with a reason, not an internal error
      // (#1385 review, Codex). No provider call, so nothing is metered.
      return {
        ...base,
        ok: false,
        latencyMs: 0,
        reply: null,
        error: {
          code: 'KEY_UNREADABLE',
          message: 'The stored key cannot be decrypted on this server; re-enter it to test and save.',
          transient: false,
        },
      };
    }
  }
  const secrets = [...secretsOf(overrideKey), ...secretsOf(savedKey), ...processSecrets(process.env)];
  const resolved = {
    config: {
      ...row,
      provider,
      model,
      endpoint,
      apiStyle,
      // #1413: the effective params — saved, or the edit under test.
      params,
      // PLATFORM runs keyless even when the edit is what cleared the key.
      apiKeyEncrypted: overrideKey ? encryptToken(overrideKey) : keySource === 'SAVED' ? row.apiKeyEncrypted : null,
    },
    ownerType: owner.ownerType,
  };

  // An override key is the caller's own; a platform credential, stored or the
  // process's, is the platform's.
  const keyOwnerType: AiConfigOwnerType | null = overrideKey ? null : keySource === 'PLATFORM' ? 'HADRON_SERVER' : owner.ownerType;
  const organizationId = await billableOrgOf(ctx, row);

  // Local refusals first (#1385 review, Codex): a config that can't even be
  // built (a malformed Bedrock key, say) never reaches a provider, so it
  // charges neither the rate limit nor the quota, and records no usage.
  try {
    deps.preflight(resolved);
  } catch (e) {
    return {
      ...base,
      ok: false,
      latencyMs: 0,
      reply: null,
      error: { code: 'CONFIG_INVALID', message: scrub(String((e as Error)?.message ?? e), secrets), transient: false },
    };
  }

  // A platform-funded probe RESERVES its tokens from the org's allowance
  // before the call, atomically (#1385 review): a check followed by a later
  // record let concurrent tests all pass and overshoot. Settled after. The
  // reservation covers prompt margin PLUS the probe's capped output (#1413,
  // QA #2596: base + cap, so a realistic prompt and the full capped reply
  // settle inside what was reserved).
  const quotaScope = keyOwnerType === 'HADRON_SERVER' && organizationId ? organizationId : null;
  const reserveTokens = AI_CONFIG_TEST_TOKEN_RESERVE + probeMaxTokens;
  const reservation = quotaScope
    ? await reserveQuota(ctx.db, 'org', quotaScope, 'llm.tokens', defaultQuotaLimit('org', 'llm.tokens'), reserveTokens)
    : null;
  if (quotaScope && !reservation) {
    return {
      ...base,
      ok: false,
      latencyMs: 0,
      reply: null,
      error: {
        code: 'QUOTA_EXCEEDED',
        message: "The organization's daily platform token allowance is used up; a platform-funded test would exceed it.",
        transient: true,
      },
    };
  }

  // Charged here, just before the provider call: a test refused locally (no
  // key, an unreadable key, an invalid override) costs nobody anything, so it
  // must not use up the caller's allowance either (#1385 review, Codex).
  const retryAfter = admitTest(`${ctx.userId}:${row.id}`, deps.now());
  if (retryAfter != null) {
    if (quotaScope && reservation) await settleReservation(ctx.db, 'org', quotaScope, 'llm.tokens', -reserveTokens, reservation);
    throw new GraphQLError(`Too many tests of this config; try again in ${retryAfter}s.`, {
      extensions: { code: 'RATE_LIMITED', retryAfterSeconds: retryAfter },
    });
  }

  const started = deps.now();
  let out: LlmResult | null = null;
  let error: AiConfigTestResult['error'] = null;
  try {
    // #1413: the probe's capped maxTokens (computed above, shared with the
    // reservation) — the wire carries min(edit, hard cap); validation
    // exercised the edit's real value.
    out = await deps.generate(resolved, {
      ...AI_CONFIG_TEST_REQUEST,
      maxTokens: probeMaxTokens,
      timeoutMs: deps.timeoutMs,
    });
  } catch (e) {
    error = {
      code: 'LLM_CALL_FAILED',
      // A keyless platform Bedrock probe signs with the AWS default credential
      // chain (an instance role, a profile, the metadata service), whose
      // secrets are not in hand to redact. Provider text is withheld there
      // rather than trusting a scrub that cannot see them (#1385 review).
      message:
        keySource === 'PLATFORM' && provider === 'bedrock'
          ? "The provider call failed. Its text is withheld: this test ran on the server's AWS credential chain, whose secrets can't be redacted from it."
          : scrub(String((e as Error)?.message ?? e), secrets),
      transient: e instanceof LlmInvocationError ? e.transient : false,
    };
  }
  const latencyMs = Math.max(0, deps.now() - started);

  // Every test is recorded; a failed call is recorded at zero tokens so the
  // attempt itself is on the ledger.
  const tokensIn = out?.tokensIn ?? 0;
  const tokensOut = out?.tokensOut ?? 0;
  await recordLlmUsage(ctx.db, {
    type: 'ai-config-test',
    userId: ctx.userId,
    organizationId,
    provider,
    model,
    tokensIn,
    tokensOut,
    keyOwnerType,
    createdBy: ctx.userId,
  });
  // Settle the reservation to what the probe really spent.
  if (quotaScope && reservation) {
    // Settled in the reservation's own window only: a rollover mid-probe
    // neither refunds into nor charges excess to the new day (#1385 review).
    await settleReservation(ctx.db, 'org', quotaScope, 'llm.tokens', tokensIn + tokensOut - reserveTokens, reservation);
  }

  return {
    ...base,
    endpoint: probeTarget(tested, bedrockRegionOf(overrideKey ?? savedKey), process.env),
    ok: out != null,
    latencyMs,
    reply: out ? scrub(out.text, secrets).slice(0, 200) : null,
    // Only a completed call knows the adapter's warnings, so only it reports.
    knobs: out?.knobs ?? [],
    error,
  };
}
